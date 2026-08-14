// test/engine/runs.test.ts — delegation run lifecycle.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortDelegationRun,
  finishDelegationRun,
  makeRunId,
  markRunRunning,
  outputHashOf,
  startDelegationRun,
  delegationDurationMs,
  type DelegationMonitorState,
} from "../../src/engine/runs.js";
import { createDelegationMonitorState } from "../../src/engine/monitor.js";

const TASK = "1. TASK: a\n2. EXPECTED OUTCOME: b\n3. REQUIRED TOOLS: read\n4. MUST DO: restate\n5. MUST NOT DO: none\n6. CONTEXT: paths";

function makeState(): DelegationMonitorState {
  return createDelegationMonitorState();
}

describe("engine/runs: lifecycle queued -> running -> terminal", () => {
  it("moves a run queued -> running -> complete with agent/model/exitCode/outputHash/duration", () => {
    const state = makeState();
    startDelegationRun(state, {
      id: "r1",
      parentToolCallId: "parent",
      source: "delegate_agent",
      mode: "single",
      index: 0,
      agent: "alpha",
      task: TASK,
      startedAtMs: 1000,
      cwd: "/repo",
    });
    assert.equal(state.runs[0]?.status, "queued");

    markRunRunning(state, "r1");
    assert.equal(state.runs[0]?.status, "running");

    finishDelegationRun(state, "r1", {
      status: "complete",
      endedAtMs: 2500,
      exitCode: 0,
      model: "openai/gpt-5.5",
      outputHash: "deadbeef",
      outputPreview: "done",
      gatePassed: true,
      gateErrors: [],
    });

    const run = state.runs[0]!;
    assert.equal(run.status, "complete");
    assert.equal(run.agent, "alpha");
    assert.equal(run.model, "openai/gpt-5.5");
    assert.equal(run.exitCode, 0);
    assert.equal(run.outputHash, "deadbeef");
    assert.equal(run.durationMs, 1500);
    assert.equal(delegationDurationMs(run), 1500);
    assert.equal(run.taskPreview.length > 0, true);
  });

  it("aborts a run to the aborted status", () => {
    const state = makeState();
    startDelegationRun(state, { id: "r2", parentToolCallId: "p", source: "delegate_task", mode: "single", agent: "beta", task: TASK, startedAtMs: 500 });
    const view = abortDelegationRun(state, "r2", "cancelled by owner", 800);
    assert.equal(view?.status, "aborted");
    assert.equal(view?.errorMessage, "cancelled by owner");
    assert.equal(view?.durationMs, 300);
  });

  it("supports a preflight_failed terminal status with gate errors", () => {
    const state = makeState();
    startDelegationRun(state, { id: "r3", parentToolCallId: "p", source: "delegate_agent", mode: "single", agent: "gamma", task: TASK, startedAtMs: 100 });
    finishDelegationRun(state, "r3", {
      status: "preflight_failed",
      endedAtMs: 200,
      gatePassed: false,
      gateErrors: ["Missing contract section: TASK"],
      failureKind: "preflight",
    });
    const run = state.runs[0]!;
    assert.equal(run.status, "preflight_failed");
    assert.equal(run.failureKind, "preflight");
    assert.equal(run.gatePassed, false);
  });

  it("makeRunId yields distinct ids and outputHashOf hashes the output", () => {
    const a = makeRunId("delegate");
    const b = makeRunId("delegate");
    assert.notEqual(a, b);
    assert.ok(a.startsWith("delegate_"));
    assert.equal(outputHashOf("hello"), outputHashOf("hello"));
    assert.notEqual(outputHashOf("hello"), outputHashOf("world"));
    assert.equal(outputHashOf(""), undefined);
  });
});
