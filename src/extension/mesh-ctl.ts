/**
 * src/extension/mesh-ctl.ts — remote control of controller-owned RPC workers
 * from pi-mesh (the TARGET side).
 *
 * pi-mesh never imports pi-subagents: it emits `mesh-ctl` on the local event
 * bus after its own policy check. This handler answers on
 * `mesh-ctl:reply:<ctlId>` with an honest status. The runId is opaque; no
 * prompt is ever interpolated into a shell.
 */
import type { ExtensionAPI } from "./pi-types.js";
import type { RpcWorkerRegistry } from "../rpc/registry.js";

interface MeshCtlRequest {
  ctlId?: unknown;
  action?: unknown;
  target?: unknown;
  message?: unknown;
}

interface MeshCtlReply {
  status: string;
  reason?: string;
  settled?: boolean;
}

function asRequest(raw: unknown): { ctlId: string; action: string; target: string; message?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const req = raw as MeshCtlRequest;
  if (typeof req.ctlId !== "string" || typeof req.action !== "string" || typeof req.target !== "string") return undefined;
  return {
    ctlId: req.ctlId,
    action: req.action,
    target: req.target,
    ...(typeof req.message === "string" ? { message: req.message } : {}),
  };
}

async function handleRequest(
  req: { ctlId: string; action: string; target: string; message?: string },
  events: NonNullable<ExtensionAPI["events"]>,
  registry: RpcWorkerRegistry,
): Promise<void> {
  const reply = (payload: MeshCtlReply): void => {
    try {
      events.emit(`mesh-ctl:reply:${req.ctlId}`, payload);
    } catch {
      // The sender will report an honest timeout if the bus is gone.
    }
  };

  if (!req.action.startsWith("run_")) return; // not a run action: another extension owns it

  if (registry.get(req.target) === undefined) {
    reply({ status: "not_found" });
    return;
  }

  if (req.action === "run_stop") {
    await registry.stop(req.target);
    reply({ status: "stopped", settled: true });
    return;
  }

  if (req.action === "run_steer") {
    const worker = registry.worker(req.target);
    if (worker === undefined || !worker.alive) {
      reply({ status: "not_found", reason: "worker is not running" });
      return;
    }
    if (req.message === undefined || req.message.trim() === "") {
      reply({ status: "error", reason: "run_steer requires a message" });
      return;
    }
    try {
      // Bound the probe too: a worker whose event loop is blocked must not
      // consume the default 30 s and blow the mesh dispatcher's 12 s budget.
      const state = await worker.getState(10_000);
      // Bound the RPC request so the local dispatcher (12 s) gets an answer:
      // a 30 s default would be reported as a target-side timeout.
      if (state.isStreaming === true) {
        // Mid-turn: inject at the next reflection boundary (no abort).
        await worker.steer(req.message, 10_000);
      } else {
        // Idle: the instruction starts a fresh turn.
        await worker.prompt(req.message, { timeoutMs: 10_000 });
      }
      reply({ status: "steered", settled: true });
    } catch (err) {
      reply({ status: "error", reason: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  reply({ status: "unsupported" });
}

/** Register the mesh-ctl handler (no-op when the host has no event bus). */
export function registerMeshCtl(pi: ExtensionAPI, getRegistry: () => RpcWorkerRegistry): void {
  const events = pi.events;
  if (events === undefined || typeof events.on !== "function") return;
  events.on("mesh-ctl", (raw) => {
    const req = asRequest(raw);
    if (req === undefined) return;
    void handleRequest(req, events, getRegistry()).catch(() => {
      try {
        events.emit(`mesh-ctl:reply:${req.ctlId}`, { status: "error", reason: "handler crashed" });
      } catch {
        // best effort
      }
    });
  });
}
