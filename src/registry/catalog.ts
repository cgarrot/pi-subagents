/**
 * src/registry/catalog.ts — body-free agent catalog built on discovery.
 *
 * Mirrors the metadata-only/no-body safety property of the harness capability
 * index (manifest A.2): the `hasForbiddenBodyKeys` guard is preserved, entries
 * store a `promptHash` instead of the prompt body, and the catalog declares
 * `noExecution: true`, `childDispatchAllowed: false`, `bodyStored: false`,
 * `promptBodiesStored: false`.
 *
 * Scope / dedupe / ordering come from `discoverAgents` (see src/registry/agents.ts):
 * case-insensitive dedupe by name (last wins), `user → project` order for scope
 * `both`. Only the **agent** facet (kind `agent`) is covered — factory / chain /
 * output-contract facets are out of scope for pi-subagents.
 */
import { sha256 } from "../core/hashing.js";
import type { AgentScope } from "../core/types.js";
import { discoverAgents, type AgentCard, type ResolveAgentDirs } from "./agents.js";

/** Body-like keys that must never be stored in a catalog entry. */
const FORBIDDEN_BODY_KEYS = new Set(["task", "prompt", "output", "body", "content"]);

/**
 * Deep guard that rejects any object graph containing a string value under a
 * body-like key. Preserved verbatim from the harness safety posture.
 */
export function hasForbiddenBodyKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => hasForbiddenBodyKeys(v));
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_BODY_KEYS.has(key.toLowerCase()) && typeof val === "string") return true;
      if (hasForbiddenBodyKeys(val)) return true;
    }
  }
  return false;
}

/** A body-free catalog entry — prompt is stored only as a sha-256 hash. */
export interface AgentCatalogEntry {
  id: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  /** Model class hint parsed from the card frontmatter (`model_class`). */
  modelClass?: string;
  source: "project" | "user";
  filePath: string;
  promptHash: string;
}

export interface AgentCatalog {
  schema: "zob.agent-catalog.v1";
  scope: AgentScope;
  counts: { total: number; project: number; user: number };
  entries: AgentCatalogEntry[];
  noExecution: true;
  childDispatchAllowed: false;
  bodyStored: false;
  promptBodiesStored: false;
}

export interface BuildAgentCatalogInput {
  cwd: string;
  scope: AgentScope;
  /** Optional override for agent-dir resolution (default: project → `[<cwd>/.pi/agents]`). */
  resolveAgentDirs?: ResolveAgentDirs;
}

function toCatalogEntry(card: AgentCard): AgentCatalogEntry {
  return {
    id: card.name,
    description: card.description,
    tools: card.tools,
    model: card.model,
    thinking: card.thinking,
    modelClass: card.modelClass,
    source: card.source,
    filePath: card.filePath,
    promptHash: sha256(card.prompt),
  };
}

/** Build a body-free agent catalog by scope (dedupe + user→project order). */
export function buildAgentCatalog(input: BuildAgentCatalogInput): AgentCatalog {
  const cards = discoverAgents(input.cwd, input.scope, input.resolveAgentDirs);
  const entries = cards.map(toCatalogEntry);
  const counts = {
    total: entries.length,
    project: entries.filter((e) => e.source === "project").length,
    user: entries.filter((e) => e.source === "user").length,
  };
  return {
    schema: "zob.agent-catalog.v1",
    scope: input.scope,
    counts,
    entries,
    noExecution: true,
    childDispatchAllowed: false,
    bodyStored: false,
    promptBodiesStored: false,
  };
}

/** Keyword search over the catalog. `limit` is clamped to [1, 20] (default 10). */
export function searchAgentCatalog(catalog: AgentCatalog, query: string, limit = 10): AgentCatalogEntry[] {
  const clamped = Math.min(Math.max(limit, 1), 20);
  const q = query.trim().toLowerCase();
  if (!q) return catalog.entries.slice(0, clamped);
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = catalog.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, clamped).map((x) => x.entry);
}

function scoreEntry(entry: AgentCatalogEntry, tokens: string[]): number {
  const haystack = [entry.id, entry.description, entry.model ?? "", ...(entry.tools ?? [])]
    .join(" ")
    .toLowerCase();
  return tokens.reduce((acc, token) => acc + (haystack.includes(token) ? 1 : 0), 0);
}
