/**
 * src/engine/steer.ts — engine-level mid-run steering API (B2, parent side).
 *
 * `steerRun` validates that a run is currently steerable (running or already
 * steered — i.e. active and non-terminal), refuses non-running runs, writes the
 * `<runId>.steer` file via the lanes steer channel, and marks the run view with
 * the `steered` status.
 *
 * SPIKE STATUS (B2): the child-side injection is BLOCKED (see src/lanes/steer.ts
 * and child/README.md). This module delivers the parent half: the engine API +
 * `steered` status + steer-file write. Recommended path for true steering: F1
 * (SDK in-process AgentSession.steer).
 *
 * Zero @earendil-works/* imports.
 */
import { steer as writeSteerFile } from "../lanes/steer.js";
import type { DelegationMonitorState, DelegationRunStatus } from "./runs.js";

/** Outcome of a steer attempt. */
export type SteerOutcome =
  | { ok: true; runId: string; status: "steered"; steerFile: string }
  | { ok: false; runId: string; error: string; status?: DelegationRunStatus };

/** Statuses a run may be in to accept a steering message (active, non-terminal). */
const STEERABLE_STATUSES: ReadonlySet<DelegationRunStatus> = new Set(["running", "steered"]);

/**
 * Steer a run: refuse unknown or non-running runs, write the steer file, and
 * mark the run view `steered`. Returns a structured outcome (never throws).
 */
export function steerRun(
  state: DelegationMonitorState,
  runId: string,
  message: string,
  steerDir: string,
): SteerOutcome {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (!run) return { ok: false, runId, error: `unknown run: ${runId}` };
  if (!STEERABLE_STATUSES.has(run.status)) {
    return { ok: false, runId, error: `run not running (status: ${run.status})`, status: run.status };
  }
  const steerFile = writeSteerFile(runId, message, steerDir);
  run.status = "steered";
  return { ok: true, runId, status: "steered", steerFile };
}
