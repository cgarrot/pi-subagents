#!/usr/bin/env node
// scripts/mesh-run-smoke.mjs — cross-package E2E (dev only, not CI):
// pi-mesh ctl handler -> local event bus -> pi-subagents run handler -> ack.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleCtlFrame } from "../../pi-mesh/dist/src/extension/ctl.js";
import { buildFrame } from "../../pi-mesh/dist/src/protocol/envelope.js";
import { RpcWorker } from "../dist/src/rpc/worker.js";
import { RpcWorkerRegistry } from "../dist/src/rpc/registry.js";
import { registerMeshCtl } from "../dist/src/extension/mesh-ctl.js";

const FAKE = fileURLToPath(new URL("../test/fixtures/fake-rpc-worker.mjs", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-mesh-smoke-"));

function bus() {
  const handlers = new Map();
  return {
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
  };
}

async function main() {
  const events = bus();
  const registry = new RpcWorkerRegistry(
    (opts) =>
      new RpcWorker({
        ...opts,
        command: { bin: process.execPath, args: [FAKE] },
        env: { ...(opts.env ?? {}), FAKE_RPC_BUSY_MS: "30000" },
      }),
    4,
  );
  registerMeshCtl({ events }, () => registry);
  const run = await registry.start({ cwd });
  console.log("started", run.runId, "pid", run.pid);

  const acks = [];
  const rt = { client: { alias: "bob", sendCtlAck: (ack) => acks.push(ack) }, ctx: null };
  const pi = { sendMessage: () => {}, events };

  const stop = buildFrame({
    type: "ctl",
    id: "m_run_stop",
    from: "alice",
    to: "bob",
    room: "default",
    action: "run_stop",
    target: run.runId,
  });
  await handleCtlFrame(rt, stop, pi, { localTimeoutMs: 5_000 });
  console.log("stop ack:", JSON.stringify(acks[0]));
  assert.equal(acks[0]?.status, "stopped");
  assert.equal(registry.get(run.runId)?.status, "stopped");

  // steer on a fresh worker
  const run2 = await registry.start({ cwd });
  const worker = registry.worker(run2.runId);
  assert.ok(worker);
  await worker.prompt("old plan");
  for (let i = 0; i < 100 && !(await worker.getState()).isStreaming; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const steer = buildFrame({
    type: "ctl",
    id: "m_run_steer",
    from: "alice",
    to: "bob",
    room: "default",
    action: "run_steer",
    target: run2.runId,
    body: "new plan",
  });
  await handleCtlFrame(rt, steer, pi, { localTimeoutMs: 5_000 });
  console.log("steer ack:", JSON.stringify(acks[1]));
  assert.equal(acks[1]?.status, "steered");
  const state = await worker.getState();
  assert.equal(state.lastMessage, "new plan");
  console.log("PASS: pi-mesh ctl -> pi-subagents run control -> ctl_ack");

  await registry.disposeAll();
  rmSync(cwd, { recursive: true, force: true });
}

main().catch(async (err) => {
  console.error("SMOKE FAILED:", err);
  rmSync(cwd, { recursive: true, force: true });
  process.exit(1);
});
