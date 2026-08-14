// test/engine/background.test.ts — background run registry (get/await bounded).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackgroundRunRegistry } from "../../src/engine/background.js";
import type { ChildResult } from "../../src/core/types.js";

function result(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    agent: "alpha",
    task: "t",
    exitCode: 0,
    output: "done",
    stderr: "",
    usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
    ...overrides,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("engine/background: registry", () => {
  it("returns the run id immediately and settles to complete with an output hash", async () => {
    const registry = new BackgroundRunRegistry();
    let started = 0;
    const runId = registry.register({
      agent: "alpha",
      mode: "single",
      source: "delegate_task",
      executor: sleep(30).then(() => { started++; return result(); }),
    });
    assert.ok(runId.startsWith("delegate_"));
    // Immediate read shows running (no await yet).
    assert.equal(registry.getDelegationRun(runId)?.status, "running");

    const state = await registry.awaitDelegationRun(runId, 2000);
    assert.equal(state.status, "complete");
    assert.equal(started, 1);
    assert.equal(state.outputHash?.length, 64);
    assert.ok(state.endedAtMs !== undefined);
    assert.equal(registry.size, 1);
  });

  it("marks a non-zero exit run as failed", async () => {
    const registry = new BackgroundRunRegistry();
    const runId = registry.register({
      agent: "beta",
      mode: "single",
      source: "delegate_task",
      executor: Promise.resolve(result({ exitCode: 3, stderr: "err" })),
    });
    const state = await registry.awaitDelegationRun(runId, 1000);
    assert.equal(state.status, "failed");
    assert.equal(state.exitCode, 3);
  });

  it("awaitDelegationRun is BOUNDED: times out a never-settling run", async () => {
    const registry = new BackgroundRunRegistry();
    const runId = registry.register({
      agent: "gamma",
      mode: "single",
      source: "delegate_agent",
      executor: new Promise<ChildResult>(() => { /* never settles */ }),
    });
    // The registry's wait timeout is unref'd; keep the event loop alive so the
    // bounded race resolves before node's runner drains the loop.
    const keepAlive = setInterval(() => {}, 25);
    try {
      const state = await registry.awaitDelegationRun(runId, 40);
      assert.equal(state.status, "failed");
      assert.match(state.errorMessage ?? "", /timed out/);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("getDelegationRun returns undefined for an unknown id", () => {
    const registry = new BackgroundRunRegistry();
    assert.equal(registry.getDelegationRun("nope"), undefined);
  });
});
