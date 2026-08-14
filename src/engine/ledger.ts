/**
 * src/engine/ledger.ts — hash-only, body-free delegation ledger (node/fs).
 *
 * Ported/adapted from the ZOB harness `tools-delegation/helpers.ts` ledger
 * helpers: `DELEGATION_LEDGER_RAW_KEYS`, `bodyFreeDelegationLedgerEntry`,
 * `appendLedgerFile`, `delegationLedgerMeta`. The ledger is I1 hash-only:
 * every persisted entry has `bodyStored:false` and replaces raw-body keys
 * (`body|prompt|task|output|stderr|error|errorMessage|errors|gateErrors`)
 * with `<key>Hashes` (sha-256) + `<key>Count`.
 *
 * The ledger dir is injectable (default `<repoRoot>/.pi/logs/runs`), so tests
 * write to a temp dir and never touch the real `.pi/logs/runs`.
 *
 * Zero @earendil-works/* imports; uses only node:fs and node:path.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../core/hashing.js";
import type { DelegationRunMode, DelegationRunSource } from "./runs.js";

/** Raw-body keys that must never be persisted to a ledger entry. */
export const DELEGATION_LEDGER_RAW_KEYS = new Set(["body", "prompt", "task", "output", "stderr", "error", "errorMessage", "errors", "gateErrors"]);

/**
 * Recursively strip raw-body keys from an entry, replacing each with
 * `<key>Hashes: string[]` (sha-256 of each string body) and `<key>Count`.
 * Always appends `bodyStored:false`, `promptBodiesStored:false`,
 * `outputBodiesStored:false`. Never mutates the input.
 */
export function bodyFreeDelegationLedgerEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (DELEGATION_LEDGER_RAW_KEYS.has(key)) {
        const bodies = Array.isArray(nested)
          ? nested.filter((item): item is string => typeof item === "string")
          : typeof nested === "string"
            ? [nested]
            : [];
        if (bodies.length > 0) {
          output[`${key}Hashes`] = bodies.map((body) => sha256(body));
          output[`${key}Count`] = bodies.length;
        }
        continue;
      }
      output[key] = sanitize(nested);
    }
    return output;
  };
  return {
    ...(sanitize(entry) as Record<string, unknown>),
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
  };
}

export interface AppendLedgerOptions {
  /** Override the ledger directory (default `<repoRoot>/.pi/logs/runs`). */
  dir?: string;
  /** Inject a clock for deterministic test file names / timestamps. */
  now?: () => Date;
}

/**
 * Append one body-free ledger entry as a JSONL line to
 * `<dir>/<day>.jsonl` (day = UTC YYYY-MM-DD). The dir is injectable via
 * `options.dir`; the default is `<repoRoot>/.pi/logs/runs`. The persisted
 * line is `{...bodyFree(entry), timestamp: ISO}`.
 */
export function appendLedgerFile(repoRoot: string, entry: Record<string, unknown>, options: AppendLedgerOptions = {}): void {
  const dir = options.dir ?? join(repoRoot, ".pi", "logs", "runs");
  mkdirSync(dir, { recursive: true });
  const now = options.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const bodyFree = bodyFreeDelegationLedgerEntry(entry);
  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify({ ...bodyFree, timestamp: now.toISOString() })}\n`, "utf8");
}

/** Metadata prefix identifying a delegation ledger entry's source and mode. */
export function delegationLedgerMeta(
  source: DelegationRunSource,
  parentToolCallId: string | undefined,
  delegationMode: DelegationRunMode,
  index?: number,
): Record<string, unknown> {
  return { source, parentToolCallId, delegationMode, index };
}

/** True when a ledger entry contains any raw-body-like key (post-sanitize). */
export function hasRawBodyKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => DELEGATION_LEDGER_RAW_KEYS.has(key));
}
