/**
 * child/escalation.ts — B5 child-side escalation channel (ask_master).
 *
 * Benchmark reference (reports/pi-subagents/benchmark/deep/pi-small-dense.md
 * §2.3, ryan_nookpi escalation.ts): the `ask_master` tool exists ONLY in
 * subagent sessions, writes an IPC escalation FILE, returns terminate, and the
 * child process exits with the ESCALATION exit code. The parent runner
 * detects that exit code, reads AND deletes the file immediately
 * (consume-once), then surfaces the message to the master. Zero network.
 *
 * Our channel (mirror of the B2 steer file, direction child -> parent):
 *   - subagent marker: env `PI_SUBAGENTS_RUN_ID` (set by the parent LanePool;
 *     more reliable than a session-file path check — the env is injected per
 *     spawn, so a main session can never carry it);
 *   - escalation file: `<PI_SUBAGENTS_ESCALATION_DIR>/<runId>.escalation.json`
 *     written ATOMICALLY (temp file + rename in the same dir);
 *   - exit code: 42 (`ESCALATION_EXIT_CODE`), recorded via `process.exitCode`
 *     so the child drains its streams before exiting.
 *
 * Zero @earendil-works/* imports, zero src/ imports (child stays standalone).
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Env var marking this process as a pi-subagents child lane (set by the pool). */
export const RUN_ID_ENV = "PI_SUBAGENTS_RUN_ID";

/** Env var carrying the escalation dir (parent's steer dir). */
export const ESCALATION_DIR_ENV = "PI_SUBAGENTS_ESCALATION_DIR";

/**
 * Exit code signaling an escalation to the parent runner (ryan benchmark
 * §2.3). Mirrors src/lanes/escalation.ts — duplicated on purpose so the child
 * adapter keeps zero src/ imports.
 */
export const ESCALATION_EXIT_CODE = 42;

/** Payload written to a `<runId>.escalation.json` file. */
export interface EscalationFilePayload {
  runId: string;
  message: string;
  timestamp: number;
}

/** Resolve the escalation file path for a run id. */
export function escalationFilePath(runId: string, dir: string): string {
  return join(dir, `${runId}.escalation.json`);
}

/**
 * True when the current session is a pi-subagents subagent session (the env
 * marker is only ever injected by the parent LanePool at spawn time, so a
 * main/master session never qualifies — no self-escalation from the master).
 */
export function isSubagentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const runId = env[RUN_ID_ENV];
  return typeof runId === "string" && runId.trim().length > 0;
}

/** sha-256 hex of the escalation message (hash-only trace posture). */
export function escalationMessageHash(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

/**
 * Atomically write the escalation record for `runId` into `dir` (temp file +
 * rename, so the parent's consume-once read never observes a partial write).
 * Creates the dir if missing. Returns the absolute escalation file path.
 */
export function writeEscalationFile(runId: string, message: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const target = escalationFilePath(runId, dir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload: EscalationFilePayload = { runId, message, timestamp: Date.now() };
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, target);
  return target;
}
