// test/engine/runs.test.ts — delegation run lifecycle.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  abortDelegationRun,
  classifyChildFailure,
  detectProviderQuotaFailure,
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

const USAGE = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };

const classifyBase = { agent: "alpha", task: "t", exitCode: 1, output: "", stderr: "", usage: USAGE };

describe("engine/runs: classifyChildFailure (F4 provider_quota)", () => {
  it("classifies a usage-limit stderr crash as provider_quota (not child_runtime)", () => {
    assert.equal(
      classifyChildFailure({ ...classifyBase, stderr: "Codex error: The usage limit has been reached" }),
      "provider_quota",
    );
  });

  it("matches rate limit / quota case-insensitively in stderr, output, or errorMessage", () => {
    assert.equal(classifyChildFailure({ ...classifyBase, stderr: "RATE LIMIT exceeded" }), "provider_quota");
    assert.equal(classifyChildFailure({ ...classifyBase, output: "provider Quota exhausted" }), "provider_quota");
    assert.equal(classifyChildFailure({ ...classifyBase, errorMessage: "rate limit hit" }), "provider_quota");
  });

  it("classifies a quota-named gate failure (empty output, exit 0) as provider_quota, not output_gate", () => {
    assert.equal(
      classifyChildFailure({ ...classifyBase, exitCode: 0, gatePassed: false, stderr: "usage limit reached for today" }),
      "provider_quota",
    );
  });

  it("does not classify a successful result whose output merely mentions quota", () => {
    assert.equal(
      classifyChildFailure({ ...classifyBase, exitCode: 0, gatePassed: true, output: "we discussed the quota policy" }),
      undefined,
    );
    assert.equal(detectProviderQuotaFailure({ ...classifyBase, exitCode: 0, gatePassed: true, stderr: "quota talk" }), false);
  });

  it("keeps child_runtime for a plain crash and output_gate for a plain gate failure", () => {
    assert.equal(classifyChildFailure({ ...classifyBase, stderr: "boom" }), "child_runtime");
    assert.equal(classifyChildFailure({ ...classifyBase, exitCode: 0, gatePassed: false, gateErrors: ["empty"] }), "output_gate");
  });
});
