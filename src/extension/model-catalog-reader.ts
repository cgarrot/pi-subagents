/**
 * src/extension/model-catalog-reader.ts — concrete VerifiedModelCatalog source
 * reading `<repoRoot>/.pi/model-catalog.json` (F2 verified model overrides).
 *
 * The pure gate (src/models/catalog.ts) stays fs-free: it only consumes an
 * injected `VerifiedModelCatalog`. THIS module is the extension-layer reader
 * the subagents runtime wires into the DispatchEngine (evaluated at every
 * preflight, so a catalog created/updated mid-session is honored without
 * rebuilding the engine).
 *
 * Catalog file format (schema zob.model-catalog.v1, same as the harness):
 *
 * ```json
 * {
 *   "schema": "zob.model-catalog.v1",
 *   "models": {
 *     "ollama-cloud/deepseek-v4-flash:preview": { "resolutionStatus": "verified" },
 *     "openai/gpt-4o": { "resolutionStatus": "verified" }
 *   }
 * }
 * ```
 *
 * Semantics (never throws — a broken catalog degrades to a BLOCKING gate
 * result with remediation, never to a dispatch crash or a silent pass):
 *   - file missing          -> { present: false }   (gate: 'catalog is missing')
 *   - file not JSON         -> { present: true, readError }
 *   - readable              -> catalogFromParsed(JSON.parse(raw))
 *
 * Extension layer only: models/engine stay fs-free.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogFromParsed, type VerifiedModelCatalog } from "../models/index.js";

/** Options for {@link readVerifiedModelCatalog} (path injectable for tests). */
export interface ModelCatalogReaderOptions {
  /** Catalog path override (default `<repoRoot>/.pi/model-catalog.json`). */
  catalogPath?: string;
}

/** Expected catalog path for a repo root: `<repoRoot>/.pi/model-catalog.json`. */
export function modelCatalogPath(repoRoot: string): string {
  return join(repoRoot, ".pi", "model-catalog.json");
}

/**
 * Read + parse the verified model catalog for a repo root. NEVER throws.
 * See the module header for the mapping from file state to catalog value.
 */
export function readVerifiedModelCatalog(repoRoot: string, opts: ModelCatalogReaderOptions = {}): VerifiedModelCatalog {
  const path = opts.catalogPath ?? modelCatalogPath(repoRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Missing/unreadable file: the catalog is simply absent (gate blocks
    // overrides with 'catalog is missing' + remediation naming this path).
    return { present: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { present: true, readError: error instanceof Error ? error.message : String(error) };
  }
  return catalogFromParsed(parsed);
}

/**
 * Build a per-preflight catalog source for a repo root (what the runtime
 * injects as the engine's `verifiedCatalogReader`). Pure wrapper: reads the
 * file on every call so mid-session catalog changes are honored.
 */
export function createModelCatalogReader(repoRoot: string, opts: ModelCatalogReaderOptions = {}): () => VerifiedModelCatalog {
  return () => readVerifiedModelCatalog(repoRoot, opts);
}
