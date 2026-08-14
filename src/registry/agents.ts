/**
 * src/registry/agents.ts — pure agent discovery (.md frontmatter) ported from
 * the ZOB harness (`.pi/extensions/zob-harness/src/domains/delegation/agents.ts`).
 *
 * Zero `@earendil-works/*` imports.
 *
 * Friction point resolved:
 *   The harness resolved agent directories via `getAgentDir()` (global pi agent
 *   dir) and `readableZobResourcePaths(cwd, "agents")` (project agent dirs).
 *   In pi-subagents that resolution is INJECTABLE through the `resolveAgentDirs`
 *   parameter (default: project → `[<cwd>/.pi/agents]`, user → `[]`). Nothing is
 *   ever imported from Pi; the caller (e.g. an extension adapter) supplies the
 *   dirs it wants searched.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentScope, ChildThinkingLevel } from "../core/types.js";
import { parseMemoryScope, type MemoryScope } from "../engine/memory.js";

/** Local mirror of the harness `HarnessAgent`. Not present in src/core/types.ts. */
export interface AgentCard {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ChildThinkingLevel | string;
  /** C5: persistent memory scope (frontmatter `memory: project|local|user`). */
  memory?: MemoryScope;
  /**
   * C1 nested subagents: strict allowlist (frontmatter `allowed_subagents`,
   * CSV agent names or `all`). An agent NOT on the list is refused — there is
   * NEVER a fallback to another agent. Undefined/empty = no declarative
   * allowlist (nesting must then be enabled with an explicit dispatch option).
   */
  allowedSubagents?: string[];
  prompt: string;
  source: "project" | "user";
  filePath: string;
}

export type AgentSource = AgentCard["source"];

/**
 * Resolves the agent directories to scan for a given source kind.
 * `(cwd, source) => dirs[]`. Injectable — replaces the harness `getAgentDir()`
 * / `readableZobResourcePaths()` calls (which depend on @earendil-works/pi-*).
 */
export type ResolveAgentDirs = (cwd: string, source: AgentSource) => string[];

/** Default resolver: project agents under `<cwd>/.pi/agents`, no user dir. */
const defaultResolveAgentDirs: ResolveAgentDirs = (cwd, source) =>
  source === "user" ? [] : [join(cwd, ".pi", "agents")];

/**
 * Parse YAML-like frontmatter delimited by `---\n ... \n---\n`. Fields are
 * simple `key: value` pairs (quotes stripped). The trailing body becomes the
 * prompt. Malformed / absent frontmatter degrades to `{ frontmatter: {}, body }`.
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + 5).trim();
  const frontmatter: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "");
  }
  return { frontmatter, body };
}

/** Load all `*.md` agents from a single directory. Unreadable files are skipped. */
export function loadAgentsFromDir(dir: string, source: AgentSource): AgentCard[] {
  if (!existsSync(dir)) return [];
  const agents: AgentCard[] = [];
  const entries = readDirSafe(dir);
  for (const fileName of entries) {
    if (!fileName.endsWith(".md")) continue;
    const filePath = join(dir, fileName);
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = frontmatter.name ?? basename(fileName, ".md");
    if (!name) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
    const allowedSubagents = frontmatter.allowed_subagents
      ?.split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    agents.push({
      name,
      description: frontmatter.description ?? "",
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      memory: parseMemoryScope(frontmatter.memory),
      allowedSubagents: allowedSubagents && allowedSubagents.length > 0 ? allowedSubagents : undefined,
      prompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Discover agents by scope, using the injectable `resolveAgentDirs`.
 *
 * - `scope === "project"` → project dirs only.
 * - `scope === "user"`    → user dirs only.
 * - `scope === "both"`    → user first, then project (user → project order).
 *
 * Deduplicates case-insensitively by `name.toLowerCase()` — **last wins** via
 * a Map, so a project agent overrides a user agent of the same name.
 */
export function discoverAgents(
  cwd: string,
  scope: AgentScope,
  resolveAgentDirs: ResolveAgentDirs = defaultResolveAgentDirs,
): AgentCard[] {
  const projectAgents =
    scope === "user" ? [] : resolveAgentDirs(cwd, "project").flatMap((dir) => loadAgentsFromDir(dir, "project"));
  const userAgents =
    scope === "project" ? [] : resolveAgentDirs(cwd, "user").flatMap((dir) => loadAgentsFromDir(dir, "user"));
  const ordered = scope === "both" ? [...userAgents, ...projectAgents] : scope === "user" ? userAgents : projectAgents;
  const byName = new Map<string, AgentCard>();
  for (const agent of ordered) byName.set(agent.name.toLowerCase(), agent);
  return [...byName.values()];
}

/** Plain-text listing for the CLI / debugging. */
export function formatAgentList(agents: AgentCard[]): string {
  if (agents.length === 0) return "No agents found.";
  return agents
    .map((agent) => `- ${agent.name} [${agent.source}] tools=${agent.tools?.join(",") ?? "default"}: ${agent.description}`)
    .join("\n");
}
