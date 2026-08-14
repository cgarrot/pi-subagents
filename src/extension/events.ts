/**
 * src/extension/events.ts — B7: lifecycle event bus on `pi.events`.
 *
 * Publishes the subagents run lifecycle so OTHER Pi extensions (pi-mesh,
 * Mission Control, dashboards…) can react to our runs without polling:
 *
 *   subagents:created    — a run entered the monitor (queued -> dispatch)
 *   subagents:started    — the run transitioned to running
 *   subagents:completed  — terminal status complete
 *   subagents:failed     — terminal status failed / preflight_failed
 *   subagents:aborted    — terminal status aborted
 *   subagents:steered    — a mid-run steering message was accepted
 *   subagents:escalated  — B5: the child escalated to the master (ask_master)
 *
 * HOOK (zero engine changes): the DispatchEngine already emits a hash-only
 * ledger stream (`onLedger` engine option) at every lifecycle transition it
 * owns — `start`/`continue_start` (dispatch, background executor), `end`
 * (settle: complete/failed/aborted) and `preflight_failed`. This bus maps that
 * stream onto the event channels above. Out-of-band transitions that bypass
 * the ledger (steer via `engine.steer`, abort via `abortDelegationRun` in
 * FleetView/RPC stop) are covered by `steerRunWithEvents` / `emitAborted`.
 *
 * PAYLOAD POSTURE (I1, hash-only): payloads carry runId, agent, status,
 * durationMs, tokens/cost when available, taskHash/outputHash — NEVER a raw
 * body (no output, stderr, task text, gate errors, or error messages). Every
 * payload carries `bodyStored:false`.
 *
 * Zero @earendil-works/* imports (I9); degrades to a no-op without `pi.events`.
 */

import type { DelegationRunView } from "../engine/runs.js";
import { delegationDurationMs } from "../engine/runs.js";
import type { EventBusApi } from "./pi-types.js";

/** Payload schema id (mirror of the hash-only ledger posture). */
export const SUBAGENTS_EVENT_SCHEMA = "zob.subagents-event.v1";

/** Lifecycle event channel names published on `pi.events`. */
export type SubagentsLifecycleEvent =
  | "created"
  | "started"
  | "completed"
  | "failed"
  | "aborted"
  | "steered"
  | "escalated";

export const SUBAGENTS_EVENT_CHANNEL: Record<SubagentsLifecycleEvent, string> = {
  created: "subagents:created",
  started: "subagents:started",
  completed: "subagents:completed",
  failed: "subagents:failed",
  aborted: "subagents:aborted",
  steered: "subagents:steered",
  escalated: "subagents:escalated",
};

/** Channel for one lifecycle event (helper for consumers). */
export function subagentsEventChannel(event: SubagentsLifecycleEvent): string {
  return SUBAGENTS_EVENT_CHANNEL[event];
}

/** Hash-only, body-free lifecycle payload (NEVER carries a raw body). */
export interface SubagentsLifecyclePayload {
  schema: string;
  event: SubagentsLifecycleEvent;
  runId: string;
  agent: string;
  status: string;
  mode?: string;
  source?: string;
  model?: string;
  background?: boolean;
  continuedFromRunId?: string;
  turnCount?: number;
  durationMs?: number;
  /** input+output token sum, only when usage is already available. */
  tokens?: number;
  cost?: number;
  taskHash?: string;
  outputHash?: string;
  /** B5: sha-256 of the consumed ask_master message (hash-only, never a body). */
  escalationHash?: string;
  failureKind?: string;
  bodyStored: false;
}

/** Minimal emit sink (the `pi.events` bus or a test double). */
export interface EventSink {
  emit(channel: string, payload?: unknown): void;
}

/** Token/cost summary from a ledger `usage` object (0s when absent). */
function usageSummary(usage: unknown): { tokens?: number; cost?: number } {
  if (!usage || typeof usage !== "object") return {};
  const record = usage as { input?: unknown; output?: unknown; cost?: unknown };
  const input = typeof record.input === "number" ? record.input : 0;
  const output = typeof record.output === "number" ? record.output : 0;
  return {
    tokens: input + output,
    ...(typeof record.cost === "number" ? { cost: record.cost } : {}),
  };
}

/** Build the hash-only payload from a raw engine ledger entry. */
export function lifecyclePayloadFromLedgerEntry(
  event: SubagentsLifecycleEvent,
  entry: Record<string, unknown>,
): SubagentsLifecyclePayload | undefined {
  const runId = typeof entry.runId === "string" ? entry.runId : "";
  if (!runId) return undefined;
  const usage = usageSummary(entry.usage);
  const payload: SubagentsLifecyclePayload = {
    schema: SUBAGENTS_EVENT_SCHEMA,
    event,
    runId,
    agent: typeof entry.agent === "string" ? entry.agent : "",
    // `start`/`continue_start` fire right after markRunRunning; `end` carries
    // the terminal status; `preflight_failed` entries carry no status key.
    status:
      typeof entry.status === "string"
        ? entry.status
        : entry.event === "preflight_failed"
          ? "preflight_failed"
          : event === "created" || event === "started"
            ? "running"
            : event,
    bodyStored: false,
  };
  const mode = entry.delegationMode ?? entry.mode;
  if (typeof mode === "string") payload.mode = mode;
  if (typeof entry.source === "string") payload.source = entry.source;
  if (typeof entry.model === "string") payload.model = entry.model;
  if (entry.background === true) payload.background = true;
  if (typeof entry.continuedFromRunId === "string") payload.continuedFromRunId = entry.continuedFromRunId;
  if (typeof entry.turnCount === "number") payload.turnCount = entry.turnCount;
  if (typeof entry.latencyMs === "number") payload.durationMs = entry.latencyMs;
  if (usage.tokens !== undefined) payload.tokens = usage.tokens;
  if (usage.cost !== undefined) payload.cost = usage.cost;
  if (typeof entry.taskHash === "string") payload.taskHash = entry.taskHash;
  if (typeof entry.outputHash === "string") payload.outputHash = entry.outputHash;
  if (typeof entry.escalationHash === "string") payload.escalationHash = entry.escalationHash;
  if (typeof entry.failureKind === "string") payload.failureKind = entry.failureKind;
  return payload;
}

/** Build the hash-only payload from a monitor run view. */
export function lifecyclePayloadFromRun(
  event: SubagentsLifecycleEvent,
  run: DelegationRunView,
  nowMs = Date.now(),
): SubagentsLifecyclePayload {
  const input = run.usage?.input ?? 0;
  const output = run.usage?.output ?? 0;
  const payload: SubagentsLifecyclePayload = {
    schema: SUBAGENTS_EVENT_SCHEMA,
    event,
    runId: run.id,
    agent: run.agent,
    status: run.status,
    mode: run.mode,
    source: run.source,
    bodyStored: false,
  };
  if (run.model) payload.model = run.model;
  if (run.background) payload.background = true;
  if (run.continuedFromRunId) payload.continuedFromRunId = run.continuedFromRunId;
  if (run.turnCount !== undefined) payload.turnCount = run.turnCount;
  payload.durationMs = delegationDurationMs(run, nowMs);
  if (run.usage) {
    payload.tokens = input + output;
    if (typeof run.usage.cost === "number") payload.cost = run.usage.cost;
  }
  if (run.outputHash) payload.outputHash = run.outputHash;
  if (run.escalationHash) payload.escalationHash = run.escalationHash;
  return payload;
}

/**
 * The lifecycle event bus. Feed it the engine's `onLedger` stream
 * (`handleLedgerEntry`); call `steerRunWithEvents`/`emitAborted` for the
 * out-of-band transitions. No-op (never throws) when no sink is available.
 */
export class SubagentsEventBus {
  private readonly sink: EventSink | undefined;

  constructor(events?: EventBusApi | EventSink) {
    this.sink = events;
  }

  /** Map one raw engine ledger entry onto lifecycle events (never throws). */
  handleLedgerEntry(entry: Record<string, unknown>): void {
    try {
      const event = entry.event;
      if (event === "start" || event === "continue_start") {
        // The ledger start fires right after the run is registered AND marked
        // running; emit both transitions in order for consumer state machines.
        this.emitPayload("created", lifecyclePayloadFromLedgerEntry("created", entry));
        this.emitPayload("started", lifecyclePayloadFromLedgerEntry("started", entry));
      } else if (event === "preflight_failed") {
        this.emitPayload("failed", lifecyclePayloadFromLedgerEntry("failed", entry));
      } else if (event === "end") {
        const status = entry.status;
        if (status === "complete") {
          this.emitPayload("completed", lifecyclePayloadFromLedgerEntry("completed", entry));
        } else if (status === "failed") {
          this.emitPayload("failed", lifecyclePayloadFromLedgerEntry("failed", entry));
        } else if (status === "aborted") {
          this.emitPayload("aborted", lifecyclePayloadFromLedgerEntry("aborted", entry));
        } else if (status === "escalated") {
          // B5: hash-only payload (runId + escalationHash, never the message).
          this.emitPayload("escalated", lifecyclePayloadFromLedgerEntry("escalated", entry));
        }
        // Defensive: unknown terminal statuses are ignored (never mislabeled).
      }
    } catch {
      // I10: event emission must never break a dispatch.
    }
  }

  /** Emit `subagents:aborted` for an out-of-band abort (FleetView/RPC stop). */
  emitAborted(run: DelegationRunView, nowMs = Date.now()): void {
    // The event itself asserts the abort transition; force the terminal status
    // so the payload is honest even if the caller emits before the monitor
    // patch becomes visible to it (rpc stop aborts first, then emits).
    this.emitPayload("aborted", { ...lifecyclePayloadFromRun("aborted", run, nowMs), status: "aborted" });
  }

  /** Emit `subagents:steered` after a successful engine steer. */
  emitSteered(run: DelegationRunView, nowMs = Date.now()): void {
    this.emitPayload("steered", lifecyclePayloadFromRun("steered", run, nowMs));
  }

  private emitPayload(event: SubagentsLifecycleEvent, payload: SubagentsLifecyclePayload | undefined): void {
    if (!payload || !this.sink) return;
    try {
      this.sink.emit(subagentsEventChannel(event), payload);
    } catch {
      // I10: a failing consumer must never break the dispatch path.
    }
  }
}

/**
 * Steer a run through the engine AND emit `subagents:steered` on success.
 * Extension-side wrapper so steering stays observable on the event bus
 * without touching the engine. Returns the engine outcome unchanged.
 */
export function steerRunWithEvents(
  engine: { steer(runId: string, message: string): { ok: boolean } },
  monitor: { runs: DelegationRunView[] },
  runId: string,
  message: string,
  bus: SubagentsEventBus,
  nowMs = Date.now(),
): { ok: boolean } {
  const outcome = engine.steer(runId, message);
  if (outcome.ok) {
    const run = monitor.runs.find((candidate) => candidate.id === runId);
    if (run) bus.emitSteered(run, nowMs);
  }
  return outcome;
}
