/**
 * src/extension/rpc-tools.ts — the controller-owned worker tools.
 *
 * One tool = one action:
 *   rpc_start    spawn + readiness probe
 *   rpc_prompt   prompt (or steer/follow-up while streaming)
 *   rpc_abort    abort the current TURN (history preserved)
 *   rpc_redirect abort → settle → prompt, atomically
 *   rpc_state    inspect one worker (live) or list all
 *   rpc_stop     stop the worker and its process tree
 *
 * Honest statuses, never "delivered": started / accepted / aborted /
 * redirected / stopped / not_streaming / not_found / error. A local worker is
 * not a mesh peer and this module never claims otherwise.
 */
import type { ExtensionAPI, SessionContext, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";
import { RPC_MAX_MESSAGE_BYTES, RPC_SETTLE_TIMEOUT_MS } from "../rpc/limits.js";
import { RpcWorkerRegistry, type RpcRunInfo } from "../rpc/registry.js";
import { discoverAgents } from "../registry/index.js";
import type { RpcWorker } from "../rpc/worker.js";

export type GetRpcRegistry = () => RpcWorkerRegistry;

const SCHEMA = "subagents.rpc.v1";

function details(partial: Record<string, unknown>): Record<string, unknown> {
  return { schema: SCHEMA, ...partial };
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v === "" ? undefined : v;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length > 0 ? out : undefined;
}

function asTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 600_000
    ? value
    : undefined;
}

function badParams(reason: string): ToolResult {
  return textResult(`error: ${reason}`, details({ status: "error", reason }));
}

function messageError(message: string | undefined): string | undefined {
  if (message === undefined) return "message is required";
  if (Buffer.byteLength(message, "utf8") > RPC_MAX_MESSAGE_BYTES) {
    return `message exceeds ${RPC_MAX_MESSAGE_BYTES} bytes`;
  }
  return undefined;
}

function runSummary(run: RpcRunInfo): string {
  const pid = run.pid !== undefined ? ` pid=${run.pid}` : "";
  const model = run.model !== undefined ? ` model=${run.model}` : "";
  const tail = run.status === "failed" && run.error !== undefined ? ` error=${run.error}` : "";
  return `${run.runId} ${run.status}${pid} cwd=${run.cwd}${model}${tail}`;
}

const RPC_START_PARAMS: Record<string, unknown> = {
  type: "object",
  properties: {
    cwd: { type: "string", description: "Worker working directory (default: this session's cwd)." },
    model: { type: "string", description: "Optional --model for the worker (overrides the agent card)." },
    name: { type: "string", description: "Optional --name for the worker." },
    agent: {
      type: "string",
      description:
        "Optional specialist agent card (e.g. implementer, oracle, qa): its prompt is passed with " +
        "--append-system-prompt and its tools become the allowlist. guard defaults to true; pass " +
        "allowed_paths/forbidden_paths to actually restrict writes.",
    },
    task: {
      type: "string",
      description: "Optional first task: prompted immediately after a successful start (the worker starts a turn).",
    },
    scope: {
      type: "string",
      enum: ["project", "user", "both"],
      description: "agent lookup scope (default both; a project card overrides a user card).",
    },
    guard: {
      type: "boolean",
      description:
        "Load the child write-safety adapter (-e child/index.ts) with allowed_paths/forbidden_paths. " +
        "Default false: the worker has the same trust as your own bash/edit tools. " +
        "The worker always runs with --no-extensions --no-mcp (never a mesh peer).",
    },
    allowed_paths: {
      type: "array",
      items: { type: "string" },
      description: "guard=true: writable repo-relative paths (empty = no allowlist).",
    },
    forbidden_paths: {
      type: "array",
      items: { type: "string" },
      description: "guard=true: deny-only path patterns.",
    },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, description: "Command timeout (default 30000)." },
  },
};

const RPC_PROMPT_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["runId", "message"],
  properties: {
    runId: { type: "string", description: "Worker id from rpc_start." },
    message: { type: "string", description: "Prompt body (1..32 KiB)." },
    streamingBehavior: {
      type: "string",
      enum: ["steer", "followUp"],
      description: "While the worker is streaming, pi requires steer or followUp (a plain prompt is rejected).",
    },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
  },
};

const RPC_ABORT_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["runId"],
  properties: {
    runId: { type: "string", description: "Worker id from rpc_start." },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, description: "Settle timeout (default 60000)." },
  },
};

const RPC_REDIRECT_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["runId", "message"],
  properties: {
    runId: { type: "string", description: "Worker id from rpc_start." },
    message: { type: "string", description: "New instruction to prompt after the abort settles." },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, description: "Settle timeout (default 60000)." },
  },
};

const RPC_STATE_PARAMS: Record<string, unknown> = {
  type: "object",
  properties: {
    runId: { type: "string", description: "One worker; omit to list every worker of this session." },
  },
};

const RPC_STOP_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["runId"],
  properties: {
    runId: { type: "string", description: "Worker id from rpc_start." },
  },
};

/** Subscribe to settlement BEFORE aborting, so a fast abort cannot be missed. */
async function abortAndWait(
  worker: Pick<RpcWorker, "abort" | "waitForSettled">,
  timeoutMs: number | undefined,
): Promise<{ ok: true; aborted: boolean } | { ok: false; reason: string }> {
  const settleMs = timeoutMs ?? RPC_SETTLE_TIMEOUT_MS;
  const settled = worker.waitForSettled(settleMs);
  // Attach a handler now: if abort itself fails we still must not leave an
  // unhandled rejection behind.
  settled.catch(() => {});
  try {
    await worker.abort(timeoutMs);
  } catch (err) {
    return { ok: false, reason: `abort_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const event = await settled;
    return { ok: true, aborted: event.aborted === true };
  } catch {
    return { ok: false, reason: `settle_timeout (${settleMs}ms) — the turn may still be running` };
  }
}

export function registerRpcTools(pi: ExtensionAPI, getRegistry: GetRpcRegistry): void {
  pi.registerTool({
    name: "rpc_start",
    label: "RPC Worker Start",
    description:
      "Start a controller-owned headless `pi --mode rpc` worker (max 4 per session). " +
      "It runs with --no-session --no-extensions --no-mcp: it is NOT a mesh peer. " +
      "Readiness is probed with get_state before 'started' is reported.",
    promptSnippet: "Start a headless pi worker you can steer, abort, or redirect.",
    parameters: RPC_START_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registry = getRegistry();
      const cwd = asString(params.cwd) ?? (ctx as SessionContext).cwd;
      const name = asString(params.name);
      const timeoutMs = asTimeout(params.timeoutMs);
      const allowedPaths = asStringArray(params.allowed_paths);
      const forbiddenPaths = asStringArray(params.forbidden_paths);
      const agentName = asString(params.agent);
      const task = asString(params.task);
      const scope = params.scope === "project" || params.scope === "user" ? params.scope : "both";
      let model = asString(params.model);
      let agentPrompt: string | undefined;
      let tools: string | undefined;
      let resolvedAgent: string | undefined;
      if (agentName !== undefined) {
        const agents = discoverAgents((ctx as SessionContext).cwd, scope);
        const card = agents.find((candidate) => candidate.name.toLowerCase() === agentName.toLowerCase());
        if (card === undefined) {
          return textResult(
            `error: unknown agent '${agentName}' (available: ${agents.map((a) => a.name).join(", ") || "none"})`,
            details({ status: "error", reason: "unknown_agent" }),
          );
        }
        resolvedAgent = card.name;
        agentPrompt = card.prompt;
        tools = card.tools?.join(",");
        model = model ?? card.model;
      }
      // A specialist worker gets the child write-safety adapter by default.
      const guard = params.guard === true || (agentName !== undefined && params.guard !== false);
      try {
        const run = await registry.start({
          cwd,
          ...(model !== undefined ? { model } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(agentPrompt !== undefined ? { agentPrompt } : {}),
          ...(tools !== undefined ? { tools } : {}),
          guard,
          ...(allowedPaths !== undefined ? { allowedPaths } : {}),
          ...(forbiddenPaths !== undefined ? { forbiddenPaths } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        if (task !== undefined) {
          const worker = registry.worker(run.runId);
          if (worker === undefined || !worker.alive) {
            await registry.stop(run.runId).catch(() => {});
            return textResult(
              "error: worker exited before the first task was dispatched",
              details({ status: "error", reason: "worker_exited", runId: run.runId }),
            );
          }
          try {
            await worker.prompt(task, timeoutMs !== undefined ? { timeoutMs } : {});
          } catch (err) {
            await registry.stop(run.runId).catch(() => {});
            const reason = err instanceof Error ? err.message : String(err);
            return textResult(
              `error: worker started but the first task was rejected — ${reason}`,
              details({ status: "error", reason: "task_rejected", runId: run.runId }),
            );
          }
        }
        const agentTag = resolvedAgent !== undefined ? ` agent=${resolvedAgent}` : "";
        const taskTag = task !== undefined ? " task=dispatched" : "";
        return textResult(
          `rpc worker started ${run.runId} pid=${run.pid ?? "?"} cwd=${run.cwd}${agentTag}${taskTag}`,
          details({ ...run, status: "started", agent: resolvedAgent, taskDispatched: task !== undefined }),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return textResult(`error: ${reason}`, details({ status: "error", reason }));
      }
    },
  });

  pi.registerTool({
    name: "rpc_prompt",
    label: "RPC Worker Prompt",
    description:
      "Send a prompt to a running worker. While it is streaming, pi requires " +
      "streamingBehavior=steer (mid-turn) or followUp (next turn); a plain prompt is rejected.",
    promptSnippet: "Prompt the worker (steer/followUp while it is streaming).",
    parameters: RPC_PROMPT_PARAMS,
    async execute(_toolCallId, params) {
      const registry = getRegistry();
      const runId = asString(params.runId);
      const message = asString(params.message);
      const err = messageError(message);
      if (runId === undefined) return badParams("runId is required");
      if (err !== undefined) return badParams(err);
      const behavior = params.streamingBehavior;
      if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
        return badParams("streamingBehavior must be steer|followUp");
      }
      const worker = registry.worker(runId);
      if (worker === undefined) return textResult(`not_found: no worker ${runId}`, details({ status: "not_found", runId }));
      try {
        const data = await worker.prompt(message!, {
          ...(behavior !== undefined ? { streamingBehavior: behavior } : {}),
          ...(asTimeout(params.timeoutMs) !== undefined ? { timeoutMs: asTimeout(params.timeoutMs) } : {}),
        });
        return textResult(`prompt accepted: ${JSON.stringify(data ?? "ok")}`, details({ status: "accepted", runId, data }));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return textResult(`error: ${reason}`, details({ status: "error", runId, reason }));
      }
    },
  });

  pi.registerTool({
    name: "rpc_abort",
    label: "RPC Worker Abort",
    description:
      "Abort the worker's current TURN and wait for agent_settled (history preserved). " +
      "abort_bash is NOT exposed: on real pi it only aborts a direct RPC bash command, " +
      "not the agent's bash tool. A worker that is not streaming returns not_streaming.",
    promptSnippet: "Abort the worker's running turn (history kept).",
    parameters: RPC_ABORT_PARAMS,
    async execute(_toolCallId, params) {
      const registry = getRegistry();
      const runId = asString(params.runId);
      if (runId === undefined) return badParams("runId is required");
      const worker = registry.worker(runId);
      if (worker === undefined) return textResult(`not_found: no worker ${runId}`, details({ status: "not_found", runId }));
      try {
        const state = await worker.getState(asTimeout(params.timeoutMs));
        if (state.isStreaming !== true) {
          return textResult(`not_streaming: ${runId} has no turn to abort`, details({ status: "not_streaming", runId }));
        }
        const outcome = await abortAndWait(worker, asTimeout(params.timeoutMs));
        if (!outcome.ok) return textResult(`error: ${outcome.reason}`, details({ status: "error", runId, reason: outcome.reason }));
        return textResult(
          `aborted ${runId} (settled, aborted=${outcome.aborted})`,
          details({ status: "aborted", runId, aborted: outcome.aborted }),
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return textResult(`error: ${reason}`, details({ status: "error", runId, reason }));
      }
    },
  });

  pi.registerTool({
    name: "rpc_redirect",
    label: "RPC Worker Redirect",
    description:
      "Atomically change the worker's plan: abort the current turn (only if streaming), " +
      "wait for agent_settled, then prompt the new instruction. History is preserved. " +
      "If settlement times out the new instruction is NOT sent.",
    promptSnippet: "Redirect the worker: abort its turn, then prompt the new plan.",
    parameters: RPC_REDIRECT_PARAMS,
    async execute(_toolCallId, params) {
      const registry = getRegistry();
      const runId = asString(params.runId);
      const message = asString(params.message);
      const err = messageError(message);
      if (runId === undefined) return badParams("runId is required");
      if (err !== undefined) return badParams(err);
      const worker = registry.worker(runId);
      if (worker === undefined) return textResult(`not_found: no worker ${runId}`, details({ status: "not_found", runId }));
      try {
        const state = await worker.getState(asTimeout(params.timeoutMs));
        let aborted = false;
        if (state.isStreaming === true) {
          const outcome = await abortAndWait(worker, asTimeout(params.timeoutMs));
          if (!outcome.ok) {
            return textResult(
              `error: ${outcome.reason} — redirect NOT sent`,
              details({ status: "error", runId, reason: outcome.reason, sent: false }),
            );
          }
          aborted = outcome.aborted;
        }
        const data = await worker.prompt(message!, {
          ...(asTimeout(params.timeoutMs) !== undefined ? { timeoutMs: asTimeout(params.timeoutMs) } : {}),
        });
        return textResult(
          `redirected ${runId} (aborted=${aborted}, history preserved): ${JSON.stringify(data ?? "ok")}`,
          details({ status: "redirected", runId, aborted, data }),
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return textResult(`error: ${reason}`, details({ status: "error", runId, reason }));
      }
    },
  });

  pi.registerTool({
    name: "rpc_state",
    label: "RPC Worker State",
    description:
      "Inspect one worker (live get_state: streaming/pending/steering) or list every " +
      "worker of this session with its honest terminal status.",
    promptSnippet: "Inspect worker state (streaming, pending, steering) or list workers.",
    parameters: RPC_STATE_PARAMS,
    async execute(_toolCallId, params) {
      const registry = getRegistry();
      const runId = asString(params.runId);
      if (runId === undefined) {
        const runs = registry.list();
        const text =
          runs.length === 0
            ? "rpc workers: none"
            : [`rpc workers (${runs.length}):`, ...runs.map((run) => `  ${runSummary(run)}`)].join("\n");
        return textResult(text, details({ status: "ok", count: runs.length, runs }));
      }
      const info = registry.get(runId);
      if (info === undefined) return textResult(`not_found: no worker ${runId}`, details({ status: "not_found", runId }));
      const worker = registry.worker(runId);
      if (worker === undefined || !worker.alive) {
        return textResult(runSummary(info), details({ ...info, status: info.status }));
      }
      try {
        const state = await worker.getState();
        return textResult(
          `${runSummary(info)} streaming=${state.isStreaming === true} pending=${state.pendingMessageCount ?? "?"} steering=${state.steeringMode ?? "?"}`,
          details({ ...info, status: info.status, state }),
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return textResult(`${runSummary(info)} (state unavailable: ${reason})`, details({ ...info, status: info.status, reason }));
      }
    },
  });

  pi.registerTool({
    name: "rpc_stop",
    label: "RPC Worker Stop",
    description:
      "Stop the worker and its process tree. POSIX: SIGTERM to the group, SIGKILL after the grace. " +
      "Windows: taskkill /T then /F (there is no graceful signal there).",
    promptSnippet: "Stop the worker and its process tree.",
    parameters: RPC_STOP_PARAMS,
    async execute(_toolCallId, params) {
      const registry = getRegistry();
      const runId = asString(params.runId);
      if (runId === undefined) return badParams("runId is required");
      const info = await registry.stop(runId);
      if (info === undefined) return textResult(`not_found: no worker ${runId}`, details({ status: "not_found", runId }));
      return textResult(`stopped ${runId}`, details({ ...info, status: "stopped" }));
    },
  });
}
