/**
 * src/engine/background.ts — background delegation run registry (node-only).
 *
 * A run id is returned IMMEDIATELY (synchronous register); the actual child
 * work runs in the background via an executor promise. `getDelegationRun`
 * reads the current state; `awaitDelegationRun` waits for settlement with a
 * BOUNDED timeout (never blocks forever). State is hash-only (result output
 * is never stored raw on the state; only a status + the settled ChildResult
 * which lives with the caller).
 *
 * Zero @earendil-works/* imports.
 */

import { sha256 } from "../core/hashing.js";
import type { ChildResult } from "../core/types.js";
import { makeRunId, type DelegationRunMode, type DelegationRunStatus } from "./runs.js";

/** Background run status set (subset of DelegationRunStatus). */
export type BackgroundRunStatus = "queued" | "running" | "complete" | "failed" | "aborted";

/** Registry-visible snapshot of a background run (body-free metadata only). */
export interface BackgroundRunState {
  runId: string;
  agent: string;
  mode: DelegationRunMode;
  source: string;
  status: BackgroundRunStatus;
  startedAtMs: number;
  endedAtMs?: number;
  taskHash?: string;
  outputHash?: string;
  exitCode?: number;
  errorMessage?: string;
}

/** Internal entry: the body-free state plus the settlement promise. */
interface BackgroundEntry {
  state: BackgroundRunState;
  settled: Promise<void>;
}

export const DEFAULT_AWAIT_TIMEOUT_MS = 300_000;

/** Bounded background run registry. */
export class BackgroundRunRegistry {
  private readonly entries = new Map<string, BackgroundEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Register a background run and immediately return its run id. The executor
   * runs in the background; its resolution updates the state. Never throws.
   */
  register(input: {
    agent: string;
    mode: DelegationRunMode;
    source: string;
    executor: Promise<ChildResult>;
    runId?: string;
    taskHash?: string;
  }): string {
    const runId = input.runId ?? makeRunId("delegate");
    const state: BackgroundRunState = {
      runId,
      agent: input.agent,
      mode: input.mode,
      source: input.source,
      status: "running",
      startedAtMs: this.now(),
      taskHash: input.taskHash,
    };
    const settled = input.executor.then(
      (result) => {
        state.status = result.exitCode === 0 && result.stopReason !== "aborted" ? "complete" : result.stopReason === "aborted" ? "aborted" : "failed";
        state.endedAtMs = this.now();
        state.outputHash = result.output ? sha256(result.output) : undefined;
        state.exitCode = result.exitCode;
        state.errorMessage = result.errorMessage;
      },
      (error: unknown) => {
        state.status = "failed";
        state.endedAtMs = this.now();
        state.errorMessage = error instanceof Error ? error.message : String(error);
      },
    );
    this.entries.set(runId, { state, settled });
    return runId;
  }

  /** Read the current body-free state of a background run. */
  getDelegationRun(runId: string): BackgroundRunState | undefined {
    return this.entries.get(runId)?.state;
  }

  /**
   * Await settlement of a background run with a BOUNDED timeout. Resolves with
   * the current state on success, or with the state marked failed + a timeout
   * error message when the timeout elapses first.
   */
  async awaitDelegationRun(runId: string, timeoutMs = DEFAULT_AWAIT_TIMEOUT_MS): Promise<BackgroundRunState> {
    const entry = this.entries.get(runId);
    if (!entry) throw new Error(`Unknown background run: ${runId}`);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    await Promise.race([entry.settled, timeout]);
    const state = this.entries.get(runId)!.state;
    if (state.status === "running" || state.status === "queued") {
      state.status = "failed";
      state.errorMessage = `await_delegation_run timed out after ${timeoutMs}ms`;
      state.endedAtMs = this.now();
    }
    return state;
  }

  /** All registered background runs (body-free states). */
  list(): BackgroundRunState[] {
    return [...this.entries.values()].map((entry) => entry.state);
  }

  /** Number of registered background runs. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

