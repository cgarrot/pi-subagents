/**
 * src/lanes/escalation.ts — B5 escalation channel (parent side, ask_master).
 *
 * Mirror of the B2 steer file channel, direction child -> parent (benchmark
 * ryan_nookpi escalation.ts, pi-small-dense.md §2.3):
 *   - the child `ask_master` tool (child/escalation.ts) atomically writes
 *     `<dir>/<runId>.escalation.json` and exits with code 42;
 *   - the LanePool detects exit 42 and calls `consumeEscalation` — the file
 *     is read AND deleted IMMEDIATELY (consume-once: the same escalation can
 *     never be surfaced twice, and a stale file cannot leak into a later run);
 *   - a missing or invalid file still yields an `escalated` outcome without a
 *     message (clean fallback — the exit code is the source of truth).
 *
 * The message body lives only in the consumed file + the in-memory
 * ChildResult.escalationMessage; the ledger/events persist the sha-256
 * `escalationHash` only (hash-only posture, invariant I1).
 *
 * Zero @earendil-works/* imports.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Exit code signaling a child escalation (mirror of child/escalation.ts —
 * duplicated on purpose so the child adapter keeps zero src/ imports).
 */
export const ESCALATION_EXIT_CODE = 42;

/** Env var marking a child lane as a subagent session (ask_master gate). */
export const ESCALATION_RUN_ID_ENV = "PI_SUBAGENTS_RUN_ID";

/** Env var carrying the escalation dir (the parent's steer dir). */
export const ESCALATION_DIR_ENV = "PI_SUBAGENTS_ESCALATION_DIR";

/** Payload of a `<runId>.escalation.json` file (mirror of the child shape). */
export interface EscalationFilePayload {
  runId: string;
  message: string;
  timestamp: number;
}

/** Resolve the escalation file path for a run id. */
export function escalationFilePath(runId: string, dir: string): string {
  return join(dir, `${runId}.escalation.json`);
}

/** Outcome of a consume-once escalation read. */
export interface ConsumedEscalation {
  /** True when an escalation file was found (and consumed/deleted). */
  consumed: boolean;
  /** The escalated message; absent when no file existed or it was invalid. */
  message?: string;
}

/**
 * Consume the escalation file for `runId` (read + IMMEDIATE delete). Never
 * throws: a missing file returns `{ consumed: false }`, and an invalid payload
 * is still consumed (deleted) so a corrupt file cannot wedge a lane.
 */
export function consumeEscalation(runId: string | undefined, dir: string | undefined): ConsumedEscalation {
  if (!runId || !dir) return { consumed: false };
  const file = escalationFilePath(runId, dir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { consumed: false };
  }
  try {
    unlinkSync(file);
  } catch {
    /* already consumed by a concurrent path */
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EscalationFilePayload>;
    if (typeof parsed?.message !== "string" || !parsed.message.trim()) return { consumed: true };
    return { consumed: true, message: parsed.message };
  } catch {
    return { consumed: true };
  }
}
