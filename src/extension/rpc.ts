/**
 * src/extension/rpc.ts — B7: cross-extension RPC over `pi.events`.
 *
 * Lets OTHER Pi extensions drive this one (mirror of the tintinweb
 * `cross-extension-rpc.ts` pattern, benchmark §4h):
 *
 *   subagents:rpc          — method envelope: {requestId, method, params}
 *   subagents:rpc:ping     — direct channel: {requestId}
 *   subagents:rpc:spawn    — direct channel: {requestId, agent, task, ...}
 *   subagents:rpc:stop     — direct channel: {requestId, run_id}
 *
 * Every request replies EXACTLY ONCE on the requestId-scoped channel
 * `subagents:rpc:reply:<requestId>` with a standardized envelope:
 *   {success:true,  requestId, data}   on success
 *   {success:false, requestId, error}  on refusal/unknown/failure
 * A payload without a usable requestId is reported on the fixed
 * `subagents:rpc:reply:_malformed` channel (no scope to reply into).
 *
 * SAFETY: `spawn` delegates to the SAME DispatchEngine preflight as the
 * delegate tools (six-part contract, write-scope, path policy, model gate) —
 * there is no bypass. Replies are hash-only/body-free: run metadata and
 * outputHash, NEVER the child output. `stop` mirrors the FleetView abort
 * (monitor-level abort of a queued/running run) and emits `subagents:aborted`.
 *
 * Zero @earendil-works/* imports (I9); no-op when the host has no `pi.events`.
 */

import { sha256 } from "../core/hashing.js";
import { verifyAttestationSidecar } from "../engine/attestation.js";
import { abortDelegationRun, type DelegationRunView } from "../engine/runs.js";
import type { EventSink } from "./events.js";
import type { SubagentsEventBus } from "./events.js";
import type { ExtensionAPI } from "./pi-types.js";
import type { GetRuntime } from "./tools.js";

/** Shared method-envelope channel (tintinweb parity). */
export const RPC_CHANNEL = "subagents:rpc";
/** Direct per-method channels. */
export const RPC_PING_CHANNEL = "subagents:rpc:ping";
export const RPC_SPAWN_CHANNEL = "subagents:rpc:spawn";
export const RPC_STOP_CHANNEL = "subagents:rpc:stop";
/** Version of this RPC protocol (bump on breaking envelope changes). */
export const RPC_PROTOCOL_VERSION = 1;
/** Fallback reply channel for requests without a usable requestId. */
export const RPC_MALFORMED_REQUEST_ID = "_malformed";

/** Reply channel scoped by requestId: `subagents:rpc:reply:<requestId>`. */
export function rpcReplyChannel(requestId: string): string {
  return `${RPC_CHANNEL}:reply:${requestId}`;
}

/** Standardized success envelope. */
export interface RpcSuccessEnvelope {
  success: true;
  requestId: string;
  data: Record<string, unknown>;
}

/** Standardized error envelope. */
export interface RpcErrorEnvelope {
  success: false;
  requestId: string;
  error: string;
}

export type RpcEnvelope = RpcSuccessEnvelope | RpcErrorEnvelope;

/** RPC methods exposed by this extension. */
export const RPC_METHODS = ["ping", "spawn", "stop"] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

/** Dependencies: reply sink, session runtime accessor, optional lifecycle bus. */
export interface SubagentsRpcDeps {
  sink: EventSink;
  getRuntime: GetRuntime;
  eventBus?: SubagentsEventBus;
}

/**
 * Register the RPC handlers on `pi.events`. Subscribes to the shared channel
 * plus the three direct per-method channels; each request replies exactly
 * once on its scoped reply channel. No-op when the host exposes no bus.
 */
export function registerSubagentsRpc(pi: ExtensionAPI, deps: Omit<SubagentsRpcDeps, "sink">): void {
  const events = pi.events;
  if (!events) return;
  const fullDeps: SubagentsRpcDeps = { ...deps, sink: events };
  events.on(RPC_CHANNEL, (payload) => handleRpcPayload(fullDeps, payload));
  events.on(RPC_PING_CHANNEL, (payload) => handleRpcPayload(fullDeps, payload, "ping"));
  events.on(RPC_SPAWN_CHANNEL, (payload) => handleRpcPayload(fullDeps, payload, "spawn"));
  events.on(RPC_STOP_CHANNEL, (payload) => handleRpcPayload(fullDeps, payload, "stop"));
}

/** Envelope before the reply closure stamps the scoped requestId. */
export type RpcPreEnvelope =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string };

/** Reply function bound to one scoped reply channel. */
type ReplyFn = (envelope: RpcPreEnvelope) => void;

/** Core dispatcher: validate scope, route the method, reply exactly once. */
export function handleRpcPayload(deps: SubagentsRpcDeps, payload: unknown, directMethod?: RpcMethod): void {
  let requestId = "";
  let method: string | undefined = directMethod;
  let params: Record<string, unknown> = {};

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.requestId === "string") requestId = record.requestId.trim();
    if (typeof record.method === "string") method = record.method;
    if (record.params && typeof record.params === "object" && !Array.isArray(record.params)) {
      params = record.params as Record<string, unknown>;
    } else {
      // Direct channels carry params inline (minus the envelope keys).
      params = { ...record };
      delete params.requestId;
      delete params.method;
    }
  }

  const scoped = requestId.length > 0;
  const replyId = scoped ? requestId : RPC_MALFORMED_REQUEST_ID;
  const reply: ReplyFn = (envelope) => {
    // Best-effort single reply on the scoped channel; RPC must never throw
    // into another extension's emit path.
    try {
      deps.sink.emit(rpcReplyChannel(replyId), { ...envelope, requestId: replyId });
    } catch {
      // ignore (I10)
    }
  };

  if (!scoped) {
    reply({ success: false, error: "malformed rpc request: missing non-empty string requestId" });
    return;
  }
  if (!method || !RPC_METHODS.includes(method as RpcMethod)) {
    reply({ success: false, error: `unknown method: ${String(method)} (valid: ${RPC_METHODS.join(", ")})` });
    return;
  }
  switch (method) {
    case "ping":
      handlePing(reply);
      return;
    case "spawn":
      void handleSpawn(deps, params, reply);
      return;
    case "stop":
      handleStop(deps, params, reply);
      return;
  }
}

/** `ping` — protocol/extension identity (no runtime needed). */
function handlePing(reply: ReplyFn): void {
  reply({
    success: true,
    data: {
      protocol: RPC_PROTOCOL_VERSION,
      extension: "pi-subagents",
      methods: [...RPC_METHODS],
    },
  });
}

/**
 * `spawn` — delegate to the DispatchEngine (same preflight as the delegate
 * tools). Foreground awaits the child and replies with hash-only run
 * metadata; `run_in_background:true` replies immediately with the runId.
 */
async function handleSpawn(deps: SubagentsRpcDeps, params: Record<string, unknown>, reply: ReplyFn): Promise<void> {
  const agent = typeof params.agent === "string" ? params.agent.trim() : "";
  const task = typeof params.task === "string" ? params.task : "";
  if (!agent || !task) {
    reply({ success: false, error: "spawn requires non-empty string params: agent, task" });
    return;
  }
  const rt = deps.getRuntime();
  if (!rt) {
    reply({ success: false, error: "no subagents runtime yet (spawn via a delegate tool first to bind the session)" });
    return;
  }
  const background = params.run_in_background === true;
  const model = typeof params.model === "string" && params.model.trim() !== "" ? params.model.trim() : undefined;

  try {
    const result = await rt.engine.single(agent, task, {
      model,
      background,
      source: "delegate_agent",
      parentToolCallId: "rpc",
    });
    const runId = typeof result.ledgerRunId === "string" ? result.ledgerRunId : "";

    if (background) {
      reply({
        success: true,
            data: { runId, status: "running", background: true, protocol: RPC_PROTOCOL_VERSION },
      });
      return;
    }

    if (result.gatePassed === false || result.failureKind === "preflight" || result.failureKind === "config") {
      // Spawn refused by the SAME preflight gates as the delegate tools.
      const reason = (result.gateErrors ?? result.contractErrors ?? []).slice(0, 3).join("; ");
      reply({
        success: false,
            error: `spawn refused by preflight gates${reason ? `: ${reason.slice(0, 300)}` : ` (failureKind: ${result.failureKind ?? "unknown"})`}`,
      });
      return;
    }

    const usage = result.usage;
    const tokens = usage ? (usage.input ?? 0) + (usage.output ?? 0) : undefined;
    // C4: verify the hash-only attestation sidecar when one exists against
    // the ACTUAL output (re-hash + compare). Non-blocking: an absent sidecar
    // adds nothing; a mismatch is reported via `verified:false` + mismatch
    // names, never as a refusal.
    const settledRun = runId ? rt.engine.monitor.runs.find((candidate) => candidate.id === runId) : undefined;
    const attestation = settledRun?.attestationRef
      ? verifyAttestationSidecar(settledRun.attestationRef, { output: result.output, sessionFile: result.sessionPath })
      : undefined;
    reply({
      success: true,
        data: {
        runId,
        status: result.stopReason === "aborted" ? "aborted" : "complete",
        exitCode: result.exitCode,
        outputHash: result.output ? sha256(result.output) : undefined, // hash-only, NEVER the output body
        ...(tokens !== undefined ? { tokens } : {}),
        ...(usage && typeof usage.cost === "number" ? { cost: usage.cost } : {}),
        ...(attestation ? { verified: attestation.verified, attestationMismatches: attestation.mismatches } : {}),
        protocol: RPC_PROTOCOL_VERSION,
      },
    });
  } catch (error: unknown) {
    reply({ success: false, error: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}

/** `stop` — abort a queued/running/steered run (mirror of the FleetView stop). */
function handleStop(deps: SubagentsRpcDeps, params: Record<string, unknown>, reply: ReplyFn): void {
  const runId =
    typeof params.run_id === "string" ? params.run_id.trim() : typeof params.runId === "string" ? params.runId.trim() : "";
  if (!runId) {
    reply({ success: false, error: "stop requires a non-empty string param: run_id" });
    return;
  }
  const rt = deps.getRuntime();
  if (!rt) {
    reply({ success: false, error: "no subagents runtime yet" });
    return;
  }
  const run: DelegationRunView | undefined = rt.engine.monitor.runs.find((candidate) => candidate.id === runId);
  if (!run) {
    reply({ success: false, error: `unknown run: ${runId}` });
    return;
  }
  if (run.status === "queued" || run.status === "running" || run.status === "steered") {
    abortDelegationRun(rt.engine.monitor, runId, "Stopped via subagents RPC");
    deps.eventBus?.emitAborted(run); // out-of-band abort -> lifecycle event
    reply({ success: true, data: { runId, status: "aborted", stopped: true, protocol: RPC_PROTOCOL_VERSION } });
    return;
  }
  reply({ success: true, data: { runId, status: run.status, stopped: false, protocol: RPC_PROTOCOL_VERSION } });
}
