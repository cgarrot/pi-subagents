/**
 * src/engine/monitor.ts — bounded delegation monitor: state, trimming,
 * liveness proof, listing/sorting.
 *
 * Ported/adapted from the ZOB harness `delegation-monitor.ts` (state,
 * bounded-`maxRuns` trimming, liveness proof, list/sort). The liveness
 * assessment is reworked to a LOCAL attempt shape (`ChildDelegationAttempt`)
 * and local proof schema — no harness goal-todo types.
 *
 * Zero @earendil-works/* imports, zero fs side effects.
 */

import { sha256 } from "../core/hashing.js";
import {
  delegationDurationMs,
  isTerminalStatus,
  terminalRank,
  type DelegationRunStatus,
  type DelegationRunView,
  type DelegationMonitorState,
} from "./runs.js";

export type DelegationSortMode = "active" | "latest" | "duration" | "agent";
export type DelegationVerdict = "pass" | "warn" | "fail" | "inconclusive";
export type DelegationConfidence = "high" | "medium" | "low";

export interface DelegationSignalBadge {
  verdict?: DelegationVerdict;
  confidence?: DelegationConfidence;
}

export interface DelegationGroupView {
  parentToolCallId: string;
  source: string;
  mode: string;
  startedAtMs: number;
  running: number;
  complete: number;
  failed: number;
  runs: DelegationRunView[];
}

export interface DelegationSummary {
  total: number;
  queued: number;
  running: number;
  steered: number;
  complete: number;
  failed: number;
  preflightFailed: number;
  aborted: number;
  /** B5: runs that escalated to the master via ask_master (terminal, actionable). */
  escalated: number;
}

/** Create a bounded delegation monitor state (default maxRuns 60). */
export function createDelegationMonitorState(maxRuns = 60): DelegationMonitorState {
  return { runs: [], maxRuns };
}

/** True while any run is still queued, running, or steered (active). */
export function hasActiveDelegations(state: DelegationMonitorState): boolean {
  return state.runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "steered");
}

/** Count runs per status. */
export function summarizeDelegations(state: DelegationMonitorState): DelegationSummary {
  const summary: DelegationSummary = { total: state.runs.length, queued: 0, running: 0, steered: 0, complete: 0, failed: 0, preflightFailed: 0, aborted: 0, escalated: 0 };
  for (const run of state.runs) {
    if (run.status === "queued") summary.queued++;
    else if (run.status === "running") summary.running++;
    else if (run.status === "steered") summary.steered++;
    else if (run.status === "complete") summary.complete++;
    else if (run.status === "failed") summary.failed++;
    else if (run.status === "preflight_failed") summary.preflightFailed++;
    else if (run.status === "aborted") summary.aborted++;
    else if (run.status === "escalated") summary.escalated++;
  }
  return summary;
}

/**
 * Trim the run collection to `maxRuns`. Terminal runs are evicted first
 * (oldest-first); if still over budget, the oldest runs of any status are
 * evicted. Non-terminal runs are kept whenever possible.
 */
export function trimDelegationRuns(state: DelegationMonitorState): void {
  if (state.runs.length <= state.maxRuns) return;
  const terminal = state.runs.filter((run) => isTerminalStatus(run.status)).sort((a, b) => a.startedAtMs - b.startedAtMs);
  const toRemove = new Set<string>();
  while (state.runs.length - toRemove.size > state.maxRuns && terminal.length > 0) {
    const next = terminal.shift();
    if (next) toRemove.add(next.id);
  }
  if (state.runs.length - toRemove.size > state.maxRuns) {
    for (const run of [...state.runs].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
      if (state.runs.length - toRemove.size <= state.maxRuns) break;
      toRemove.add(run.id);
    }
  }
  state.runs = state.runs.filter((run) => !toRemove.has(run.id));
}

/** Sort a snapshot of runs by the requested mode. */
export function listDelegationRuns(state: DelegationMonitorState, sort: DelegationSortMode = "active", nowMs = Date.now()): DelegationRunView[] {
  const runs = [...state.runs];
  runs.sort((a, b) => {
    if (sort === "agent") return a.agent.localeCompare(b.agent) || b.startedAtMs - a.startedAtMs;
    if (sort === "duration") return delegationDurationMs(b, nowMs) - delegationDurationMs(a, nowMs) || b.startedAtMs - a.startedAtMs;
    if (sort === "latest") return b.startedAtMs - a.startedAtMs || (a.index ?? 0) - (b.index ?? 0);
    return terminalRank(a.status) - terminalRank(b.status) || b.startedAtMs - a.startedAtMs || (a.index ?? 0) - (b.index ?? 0);
  });
  return runs;
}

/** Group runs by parent tool call id (chain keeps step order by index). */
export function buildDelegationGroups(state: DelegationMonitorState, sort: DelegationSortMode = "active", nowMs = Date.now()): DelegationGroupView[] {
  const groupsById = new Map<string, DelegationGroupView>();
  for (const run of state.runs) {
    const existing = groupsById.get(run.parentToolCallId);
    const group = existing ?? {
      parentToolCallId: run.parentToolCallId,
      source: run.source,
      mode: run.mode,
      startedAtMs: run.startedAtMs,
      running: 0,
      complete: 0,
      failed: 0,
      runs: [],
    };
    group.startedAtMs = Math.min(group.startedAtMs, run.startedAtMs);
    group.runs.push(run);
    groupsById.set(run.parentToolCallId, group);
  }
  const groups = [...groupsById.values()].map((group) => {
    group.running = group.runs.filter((run) => run.status === "queued" || run.status === "running").length;
    group.complete = group.runs.filter((run) => run.status === "complete").length;
    group.failed = group.runs.filter((run) => run.status === "failed" || run.status === "preflight_failed" || run.status === "aborted").length;
    group.runs = group.mode === "chain"
      ? [...group.runs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      : listDelegationRuns({ runs: group.runs, maxRuns: group.runs.length }, sort, nowMs);
    return group;
  });
  groups.sort((a, b) => {
    if (a.running !== b.running) return b.running - a.running;
    if (a.failed !== b.failed) return b.failed - a.failed;
    return b.startedAtMs - a.startedAtMs;
  });
  return groups;
}

/** Icon per status (copied from the harness). */
export function statusIcon(status: DelegationRunStatus): string {
  switch (status) {
    case "queued": return "○";
    case "running": return "●";
    case "steered": return "➤";
    case "preflight_failed": return "▲";
    case "complete": return "✓";
    case "failed": return "✗";
    case "aborted": return "■";
    case "escalated": return "☝";
  }
}

// --- per-run usage formatting (B4 cost tracking) ---

/** Compact token count: 340 -> "340", 1234 -> "1.2k", 2500000 -> "2.5M". */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.trunc(value)));
}

/**
 * Human wall-clock duration: 940 -> "940ms", 5000 -> "5s", 74000 -> "1m14s",
 * 3700000 -> "1h01m". Used by the HUD/Fleet widgets for honest active-run
 * durations (replaces the old ever-growing runtime uptime line).
 */
export function formatDurationMs(ms: number): string {
  const value = Math.max(0, Math.trunc(ms));
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.floor(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Readable per-run usage line for the monitor (B4). Distinguishes the two
 * usage semantics: cumulative run totals (delta-based input/output) and the
 * current-context snapshot (`ctx`), e.g. `3t · 6.0k in · 150 out · ctx 11.1k
 * · $0.0090`. "usage n/a" when the run carries no usage (preflight stubs).
 */
export function formatRunUsage(usage: DelegationRunView["usage"]): string {
  if (!usage) return "usage n/a";
  const parts = [
    `${usage.turns}t`,
    `${compactTokens(usage.input)} in`,
    `${compactTokens(usage.output)} out`,
  ];
  if (usage.contextTokens > 0) parts.push(`ctx ${compactTokens(usage.contextTokens)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" · ");
}

// --- liveness (reworked to local shapes; no harness goal-todo imports) ---

export type ChildDelegationAttemptStatus =
  | "queued"
  | "running"
  | "claim_returned"
  | "accepted"
  | "rejected"
  | "failed_preflight"
  | "failed_runtime"
  | "cancelled"
  | "failed_output_gate_format"
  | "failed_output_gate_semantic"
  | "output_declared_incomplete"
  | "liveness_unknown";

/** Local durable-attempt shape consumed by the liveness assessment. */
export interface ChildDelegationAttempt {
  attemptId: string;
  runId: string;
  status: ChildDelegationAttemptStatus;
  updatedAt: number;
  finalizedAt?: number;
  failureHash?: string;
  gateHash?: string;
  outputHash?: string;
  boundGoalRevision?: number;
  boundGraphRevision?: number;
  boundTodoRevision?: number;
}

export type ChildAttemptLivenessStatus = "active" | "inactive" | "unknown";
export type ChildAttemptLivenessSource = "current_monitor" | "restored_monitor" | "durable_attempt" | "none";
export type ChildAttemptLivenessCode =
  | "monitor_active_exact"
  | "monitor_terminal_exact"
  | "attempt_id_mismatch"
  | "run_id_mismatch"
  | "monitor_attempt_run_mismatch"
  | "durable_preflight_terminal"
  | "durable_child_terminal"
  | "durable_output_terminal"
  | "restored_nonterminal_without_controller"
  | "terminal_proof_incomplete"
  | "nonterminal_without_authoritative_status";

/** Local hash-only liveness proof (mirror of the harness schema shape). */
export interface ChildAttemptLivenessProof {
  schema: string;
  status: ChildAttemptLivenessStatus;
  source: ChildAttemptLivenessSource;
  code: ChildAttemptLivenessCode;
  attemptId: string;
  runId: string;
  attemptStatus: string;
  monitorStatus?: string;
  proofAt: number;
  proofTimestampHash: string;
  proofHash: string;
  bodyStored: false;
}

function buildDelegationLivenessProof(input: {
  status: ChildAttemptLivenessProof["status"];
  source: ChildAttemptLivenessProof["source"];
  code: ChildAttemptLivenessProof["code"];
  attempt: ChildDelegationAttempt;
  proofAt: number;
  monitorStatus?: DelegationRunStatus;
}): ChildAttemptLivenessProof {
  const proofAt = Math.max(0, Math.trunc(input.proofAt));
  const proofTimestampHash = sha256(String(proofAt));
  const proofHash = sha256(JSON.stringify([
    input.status,
    input.source,
    input.code,
    input.attempt.attemptId,
    input.attempt.runId,
    input.attempt.status,
    input.monitorStatus ?? "",
    proofAt,
    proofTimestampHash,
    input.attempt.boundGoalRevision,
    input.attempt.boundGraphRevision,
    input.attempt.boundTodoRevision,
  ]));
  return {
    schema: "zob.child-delegation-liveness-proof.v1",
    status: input.status,
    source: input.source,
    code: input.code,
    attemptId: input.attempt.attemptId,
    runId: input.attempt.runId,
    attemptStatus: input.attempt.status,
    ...(input.monitorStatus ? { monitorStatus: input.monitorStatus } : {}),
    proofAt,
    proofTimestampHash,
    proofHash,
    bodyStored: false,
  };
}

const TERMINAL_MONITOR_STATUSES = new Set<DelegationRunStatus>(["preflight_failed", "complete", "failed", "aborted", "escalated"]);

function durableAttemptProofCode(attempt: ChildDelegationAttempt): ChildAttemptLivenessCode | undefined {
  if (attempt.finalizedAt === undefined) return undefined;
  if (attempt.status === "failed_preflight" && attempt.failureHash) return "durable_preflight_terminal";
  if ((attempt.status === "failed_runtime" || attempt.status === "cancelled") && attempt.failureHash) return "durable_child_terminal";
  if ((attempt.status === "failed_output_gate_format" || attempt.status === "failed_output_gate_semantic") && (attempt.gateHash || attempt.outputHash)) return "durable_output_terminal";
  if (attempt.status === "output_declared_incomplete" && attempt.outputHash) return "durable_output_terminal";
  return undefined;
}

/**
 * Pure, fail-closed liveness assessment for one exact durable attempt.
 * Missing controllers, PIDs, elapsed time, and restored active-looking monitor
 * rows never prove inactivity.
 */
export function assessDelegationAttemptLiveness(
  state: DelegationMonitorState,
  attempt: ChildDelegationAttempt,
  expected: { attemptId: string; runId: string } = { attemptId: attempt.attemptId, runId: attempt.runId },
): ChildAttemptLivenessProof {
  if (expected.attemptId !== attempt.attemptId) {
    return buildDelegationLivenessProof({ status: "unknown", source: "none", code: "attempt_id_mismatch", attempt, proofAt: attempt.updatedAt });
  }
  if (expected.runId !== attempt.runId) {
    return buildDelegationLivenessProof({ status: "unknown", source: "none", code: "run_id_mismatch", attempt, proofAt: attempt.updatedAt });
  }

  const monitorByAttemptId = attempt.attemptId !== attempt.runId
    ? state.runs.find((run) => run.id === attempt.attemptId)
    : undefined;
  if (monitorByAttemptId) {
    return buildDelegationLivenessProof({ status: "unknown", source: "current_monitor", code: "monitor_attempt_run_mismatch", attempt, monitorStatus: monitorByAttemptId.status, proofAt: monitorByAttemptId.endedAtMs ?? monitorByAttemptId.startedAtMs });
  }

  const monitor = state.runs.find((run) => run.id === attempt.runId);
  const monitorActive = monitor?.status === "queued" || monitor?.status === "running";
  if (monitor && monitorActive && monitor.authoritativeCurrentRuntime === true) {
    return buildDelegationLivenessProof({ status: "active", source: "current_monitor", code: "monitor_active_exact", attempt, monitorStatus: monitor.status, proofAt: monitor.startedAtMs });
  }
  if (monitor && TERMINAL_MONITOR_STATUSES.has(monitor.status)) {
    return buildDelegationLivenessProof({ status: "inactive", source: "current_monitor", code: "monitor_terminal_exact", attempt, monitorStatus: monitor.status, proofAt: monitor.endedAtMs ?? monitor.startedAtMs });
  }

  const durableCode = durableAttemptProofCode(attempt);
  if (durableCode) {
    return buildDelegationLivenessProof({ status: "inactive", source: "durable_attempt", code: durableCode, attempt, monitorStatus: monitor?.status, proofAt: attempt.finalizedAt ?? attempt.updatedAt });
  }
  if (monitor && monitorActive) {
    return buildDelegationLivenessProof({ status: "unknown", source: "restored_monitor", code: "restored_nonterminal_without_controller", attempt, monitorStatus: monitor.status, proofAt: monitor.startedAtMs });
  }
  const terminalLooking = !["queued", "running", "claim_returned", "accepted", "rejected", "liveness_unknown"].includes(attempt.status);
  return buildDelegationLivenessProof({
    status: "unknown",
    source: "none",
    code: terminalLooking ? "terminal_proof_incomplete" : "nonterminal_without_authoritative_status",
    attempt,
    proofAt: attempt.finalizedAt ?? attempt.updatedAt,
  });
}
