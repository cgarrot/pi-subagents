/**
 * src/engine/runs.ts — delegation run lifecycle (pure, node-only).
 *
 * Ported/adapted from the ZOB harness `delegation-monitor.ts` types +
 * `startDelegationRun`/`updateDelegationRun`/`finishDelegationRun`. This is
 * the engine-pure lifecycle: a run moves queued -> running -> complete |
 * failed | aborted | preflight_failed. The monitor (bounded state, trimming,
 * liveness, list/sort) and ledger (hash-only persistence) live in sibling
 * engine modules and consume these types.
 *
 * Zero @earendil-works/* imports, zero fs side effects (state is in-memory).
 */

import type { ChildChangedPathRef, ChildResult, DelegationFailureKind } from "../core/types.js";
import { sha256 } from "../core/hashing.js";
import { newRunId } from "../core/paths.js";

export type DelegationRunSource = "delegate_agent" | "delegate_task";
export type DelegationRunMode = "single" | "parallel" | "chain";
export type DelegationRunStatus = "queued" | "running" | "steered" | "preflight_failed" | "complete" | "failed" | "aborted" | "escalated";

/**
 * B5 escalated runs are TERMINAL (the child exited) but actionable: the master
 * holds the consumed ask_master message and may `continueRun` with an answer.
 */
export function terminalRank(status: DelegationRunStatus): number {
  switch (status) {
    case "running": return 0;
    case "steered": return 0;
    case "queued": return 1;
    case "escalated": return 2;
    case "failed": return 2;
    case "preflight_failed": return 3;
    case "aborted": return 4;
    case "complete": return 5;
  }
}

/** True for the five terminal (non-retryable) statuses. */
export function isTerminalStatus(status: DelegationRunStatus): boolean {
  return status === "preflight_failed" || status === "complete" || status === "failed" || status === "aborted" || status === "escalated";
}

/** True while a run is active and can still accept a steering message. */
export function isSteerableStatus(status: DelegationRunStatus): boolean {
  return status === "running" || status === "steered";
}

/**
 * A read-consistent snapshot of one delegation run. `agent`/`model`/`exitCode`
 * identify the child; `outputHash` is the sha-256 of the full child output
 * (hash-only ledger posture); `durationMs` is captured on finish.
 */
export interface DelegationRunView {
  id: string;
  parentToolCallId: string;
  source: DelegationRunSource;
  mode: DelegationRunMode;
  index?: number;
  agent: string;
  taskPreview: string;
  status: DelegationRunStatus;
  startedAtMs: number;
  endedAtMs?: number;
  outputPreview: string;
  stderrPreview: string;
  cwd?: string;
  sessionPath?: string;
  exitCode?: number;
  gatePassed?: boolean;
  gateErrors?: string[];
  failureKind?: DelegationFailureKind;
  stopReason?: string;
  stopCondition?: string;
  errorMessage?: string;
  childChangedPaths?: ChildChangedPathRef[];
  usage?: ChildResult["usage"];
  model?: string;
  outputHash?: string;
  durationMs?: number;
  background?: boolean;
  /** Run id this run continues from (continue). Links the continuation chain. */
  continuedFromRunId?: string;
  /** 1-based continuation turn count (1 for a fresh run, incremented on continue). */
  turnCount?: number;
  /**
   * B5: sha-256 of the consumed ask_master escalation message (hash-only —
   * the body is NEVER stored on the run view, ledger, or events; it lives
   * only in the in-memory ChildResult.escalationMessage held by the caller).
   */
  escalationHash?: string;
  /** Session-local authority marker. Restored ledger projections omit it. */
  authoritativeCurrentRuntime?: true;
  /**
   * LIVE mid-run usage snapshot streamed from child `kind=turn` events
   * (cumulative turns, current contextTokens, model). Written by the engine
   * while the run is ACTIVE so widgets can show tokens before settle; the
   * settle path stays authoritative (`usage` overwrites the display at the
   * terminal transition). In-memory monitor view only — never persisted to
   * the ledger or attestations (explicit-field posture keeps it out).
   */
  liveUsage?: { turns: number; contextTokens?: number; model?: string; atMs: number };
  /**
   * C3 model-scope warnings (non-blocking preflight notices, e.g. an
   * agent/class/inherited model outside the enabledModels allowlist).
   * Recorded on the run view only; never flips a status or gate.
   */
  warnings?: string[];
  /**
   * C4: path of the hash-only attestation sidecar
   * (`<ledgerDir>/attestations/<runId>.json`, schema
   * `pi-subagents.attestation.v1`) written best-effort at settle. Undefined
   * when ledger persistence is off or the write failed (never blocking).
   */
  attestationRef?: string;
}

/** The engine's run collection: bounded in-memory state. */
export interface DelegationMonitorState {
  runs: DelegationRunView[];
  maxRuns: number;
}

const PREVIEW_LIMIT = 48_000;

/** Head/tail-capped preview helper (copied from the harness). */
export function capPreview(text: string | undefined, limit = PREVIEW_LIMIT): string {
  const value = text ?? "";
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.6);
  const tail = Math.max(0, limit - head);
  return `${value.slice(0, head)}\n\n[… ${value.length - limit} chars omitted from delegation preview …]\n\n${value.slice(-tail)}`;
}

/** Whitespace-compacted short task preview (copied from the harness). */
export function taskPreview(task: string, limit = 180): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

/** Elapsed duration of a run (ends now if not yet finished). */
export function delegationDurationMs(run: DelegationRunView, nowMs = Date.now()): number {
  return Math.max(0, (run.endedAtMs ?? nowMs) - run.startedAtMs);
}

/** Generate a run id with a prefix (delegate by default). */
export function makeRunId(prefix = "delegate"): string {
  return newRunId(prefix);
}

/** Input accepted by `startDelegationRun`. */
export interface StartRunInput {
  id: string;
  parentToolCallId: string;
  source: DelegationRunSource;
  mode: DelegationRunMode;
  index?: number;
  agent: string;
  task: string;
  startedAtMs: number;
  cwd?: string;
  sessionPath?: string;
  background?: boolean;
  continuedFromRunId?: string;
  turnCount?: number;
}

/**
 * Create a run in the QUEUED state and register it in the collection. A run
 * id that already exists is replaced (latest wins), matching the harness.
 */
export function startDelegationRun(state: DelegationMonitorState, input: StartRunInput): DelegationRunView {
  const run: DelegationRunView = {
    id: input.id,
    parentToolCallId: input.parentToolCallId,
    source: input.source,
    mode: input.mode,
    index: input.index,
    agent: input.agent,
    taskPreview: taskPreview(input.task),
    status: "queued",
    startedAtMs: input.startedAtMs,
    outputPreview: "",
    stderrPreview: "",
    cwd: input.cwd,
    sessionPath: input.sessionPath,
    background: input.background,
    continuedFromRunId: input.continuedFromRunId,
    turnCount: input.turnCount,
    authoritativeCurrentRuntime: true,
  };
  const existingIndex = state.runs.findIndex((candidate) => candidate.id === input.id);
  if (existingIndex >= 0) state.runs[existingIndex] = run;
  else state.runs.push(run);
  return run;
}

/** Advance a queued run to the running state (no-op unless queued). */
export function markRunRunning(state: DelegationMonitorState, id: string): DelegationRunView | undefined {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) return undefined;
  if (run.status === "queued") run.status = "running";
  return run;
}

/** Patchable fields (id/startedAtMs are immutable after creation). */
export type DelegationRunPatch = Partial<Omit<DelegationRunView, "id" | "startedAtMs">>;

/** Apply a partial patch to an existing run; returns undefined when missing. */
export function updateDelegationRun(state: DelegationMonitorState, id: string, patch: DelegationRunPatch): DelegationRunView | undefined {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) return undefined;
  if (patch.parentToolCallId !== undefined) run.parentToolCallId = patch.parentToolCallId;
  if (patch.source !== undefined) run.source = patch.source;
  if (patch.mode !== undefined) run.mode = patch.mode;
  if (patch.index !== undefined) run.index = patch.index;
  if (patch.agent !== undefined) run.agent = patch.agent;
  if (patch.taskPreview !== undefined) run.taskPreview = patch.taskPreview;
  if (patch.status !== undefined) run.status = patch.status;
  if (patch.endedAtMs !== undefined) run.endedAtMs = patch.endedAtMs;
  if (patch.outputPreview !== undefined) run.outputPreview = capPreview(patch.outputPreview);
  if (patch.stderrPreview !== undefined) run.stderrPreview = capPreview(patch.stderrPreview);
  if (patch.cwd !== undefined) run.cwd = patch.cwd;
  if (patch.sessionPath !== undefined) run.sessionPath = patch.sessionPath;
  if (patch.exitCode !== undefined) run.exitCode = patch.exitCode;
  if (patch.gatePassed !== undefined) run.gatePassed = patch.gatePassed;
  if (patch.gateErrors !== undefined) run.gateErrors = patch.gateErrors;
  if (patch.failureKind !== undefined) run.failureKind = patch.failureKind;
  if (patch.stopReason !== undefined) run.stopReason = patch.stopReason;
  if (patch.stopCondition !== undefined) run.stopCondition = patch.stopCondition;
  if (patch.errorMessage !== undefined) run.errorMessage = patch.errorMessage;
  if (patch.usage !== undefined) run.usage = patch.usage;
  if (patch.model !== undefined) run.model = patch.model;
  if (patch.outputHash !== undefined) run.outputHash = patch.outputHash;
  if (patch.durationMs !== undefined) run.durationMs = patch.durationMs;
  if (patch.background !== undefined) run.background = patch.background;
  if (patch.continuedFromRunId !== undefined) run.continuedFromRunId = patch.continuedFromRunId;
  if (patch.turnCount !== undefined) run.turnCount = patch.turnCount;
  if (patch.escalationHash !== undefined) run.escalationHash = patch.escalationHash;
  if (patch.warnings !== undefined) run.warnings = patch.warnings;
  if (patch.attestationRef !== undefined) run.attestationRef = patch.attestationRef;
  if (patch.liveUsage !== undefined) run.liveUsage = patch.liveUsage;
  return run;
}

/**
 * Finish a run with a terminal status. Requires an `endedAtMs` timestamp and a
 * status; `durationMs` is derived from `endedAtMs` when not supplied.
 */
export function finishDelegationRun(
  state: DelegationMonitorState,
  id: string,
  patch: DelegationRunPatch & { endedAtMs: number; status: DelegationRunStatus },
): DelegationRunView | undefined {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) return undefined;
  updateDelegationRun(state, id, patch);
  if (run.durationMs === undefined) run.durationMs = Math.max(0, run.endedAtMs! - run.startedAtMs);
  return run;
}

/** Abort a run: marks it aborted with an optional message. */
export function abortDelegationRun(state: DelegationMonitorState, id: string, message = "Delegation run aborted", endedAtMs = Date.now()): DelegationRunView | undefined {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) return undefined;
  updateDelegationRun(state, id, { status: "aborted", endedAtMs, errorMessage: message, durationMs: Math.max(0, endedAtMs - run.startedAtMs) });
  return run;
}

/** sha-256 of the full child output (hash-only ledger / view posture). */
export function outputHashOf(output: string | undefined): string | undefined {
  return output ? sha256(output) : undefined;
}

/** F4: case-insensitive provider quota/rate-limit signal patterns. */
const PROVIDER_QUOTA_PATTERN = /usage limit|rate limit|quota/i;

/**
 * F4: detect a provider quota/rate-limit failure on an ALREADY-FAILED child
 * (non-zero exit, failed output gate, or runtime error). A successful child
 * whose output merely mentions quotas is never classified — the failure gate
 * keeps honest runs honest. Matches stderr, output, and errorMessage
 * case-insensitively against `usage limit` / `rate limit` / `quota`.
 */
export function detectProviderQuotaFailure(result: ChildResult): boolean {
  const failed = result.exitCode !== 0 || result.gatePassed === false || result.stopReason === "error";
  if (!failed) return false;
  return (
    PROVIDER_QUOTA_PATTERN.test(result.stderr ?? "") ||
    PROVIDER_QUOTA_PATTERN.test(result.output ?? "") ||
    PROVIDER_QUOTA_PATTERN.test(result.errorMessage ?? "")
  );
}

/** Compute an honest child failure kind from a settled child result. */
export function classifyChildFailure(result: ChildResult): DelegationFailureKind | undefined {
  // B5: an escalation is not a failure — the child deliberately handed
  // control back to the master (which may continue the run).
  if (result.stopReason === "escalated") return undefined;
  if (result.stopReason === "aborted") return "aborted";
  // F4: provider quota/rate-limit — the actionable kind instead of a generic
  // child_runtime/output_gate when the failed child's text names the limit
  // (e.g. "Codex error: The usage limit has been reached").
  if (detectProviderQuotaFailure(result)) return "provider_quota";
  if (result.exitCode !== 0 || result.stopReason === "error") return "child_runtime";
  if (result.gatePassed === false) return "output_gate";
  return undefined;
}
