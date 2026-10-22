// test/extension/mesh-ctl.test.ts — remote run control, target side
// (pi-mesh -> pi-subagents). Uses the real RPC registry + fake worker.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { RpcWorker } from "../../src/rpc/worker.js";
import { RpcWorkerRegistry } from "../../src/rpc/registry.js";
import { registerMeshCtl } from "../../src/extension/mesh-ctl.js";
import { emitTo, stubApi, type CapturedApi } from "./stub-api.js";

const FAKE = fileURLToPath(new URL("../../../test/fixtures/fake-rpc-worker.mjs", import.meta.url));

const created: Array<{ dir: string; registry: RpcWorkerRegistry }> = [];

afterEach(async () => {
  while (created.length > 0) {
    const item = created.pop();
    if (item === undefined) continue;
    await item.registry.disposeAll();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

function harness(busyMs = 30_000): { captured: CapturedApi; registry: RpcWorkerRegistry; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-meshctl-"));
  const registry = new RpcWorkerRegistry(
    (opts) =>
      new RpcWorker({
        ...opts,
        command: { bin: process.execPath, args: [FAKE] },
        env: { ...(opts.env ?? {}), FAKE_RPC_BUSY_MS: String(busyMs) },
      }),
    4,
  );
  const captured = stubApi();
  registerMeshCtl(captured.api, () => registry);
  created.push({ dir: cwd, registry });
  return { captured, registry, cwd };
}

function waitEmitted(captured: CapturedApi, channel: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const hit = captured.emitted.find((e) => e.channel === channel);
      if (hit !== undefined) {
        clearInterval(timer);
        resolve(hit.payload as Record<string, unknown>);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`no emission on ${channel}`));
      }
    }, 20);
  });
}

async function waitStreaming(registry: RpcWorkerRegistry, runId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const worker = registry.worker(runId);
    assert.ok(worker);
    if ((await worker.getState()).isStreaming === true) return;
    if (Date.now() > deadline) throw new Error("worker never started streaming");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("mesh-ctl: remote RPC run control", () => {
  it("run_stop stops the worker and acks stopped", async () => {
    const { captured, registry, cwd } = harness();
    const run = await registry.start({ cwd });
    const reply = waitEmitted(captured, "mesh-ctl:reply:ctl_stop");
    emitTo(captured, "mesh-ctl", { ctlId: "ctl_stop", action: "run_stop", target: run.runId, from: "alice", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "stopped");
    assert.equal(registry.get(run.runId)?.status, "stopped");
  });

  it("run_steer injects mid-turn (steer, no abort)", async () => {
    const { captured, registry, cwd } = harness();
    const run = await registry.start({ cwd });
    const worker = registry.worker(run.runId);
    assert.ok(worker);
    await worker.prompt("old plan");
    await waitStreaming(registry, run.runId);

    const reply = waitEmitted(captured, "mesh-ctl:reply:ctl_steer");
    emitTo(captured, "mesh-ctl", { ctlId: "ctl_steer", action: "run_steer", target: run.runId, message: "new plan", from: "alice", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "steered");
    const state = await worker.getState();
    assert.equal(state.steerCount, 1);
    assert.equal(state.lastMessage, "new plan");
  });

  it("run_steer on an idle worker starts a fresh turn", async () => {
    const { captured, registry, cwd } = harness(80);
    const run = await registry.start({ cwd });
    const worker = registry.worker(run.runId);
    assert.ok(worker);
    const reply = waitEmitted(captured, "mesh-ctl:reply:ctl_idle");
    emitTo(captured, "mesh-ctl", { ctlId: "ctl_idle", action: "run_steer", target: run.runId, message: "start this", from: "alice", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "steered");
    const state = await worker.getState();
    assert.equal(state.promptCount, 1);
    assert.equal(state.lastMessage, "start this");
  });

  it("unknown run ids are not_found", async () => {
    const { captured } = harness();
    const reply = waitEmitted(captured, "mesh-ctl:reply:ctl_missing");
    emitTo(captured, "mesh-ctl", { ctlId: "ctl_missing", action: "run_stop", target: "rpc_nope", from: "alice", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "not_found");
  });
});
