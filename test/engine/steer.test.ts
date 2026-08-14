// test/engine/steer.test.ts — engine-level mid-run steering API (B2, parent side).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { steerRun } from "../../src/engine/steer.js";
import { startDelegationRun, markRunRunning, finishDelegationRun, abortDelegationRun } from "../../src/engine/runs.js";
import { createDelegationMonitorState, summarizeDelegations, statusIcon, hasActiveDelegations } from "../../src/engine/monitor.js";
import type { DelegationMonitorState } from "../../src/engine/runs.js";

const TASK = "1. TASK: a\n2. EXPECTED OUTCOME: b\n3. REQUIRED TOOLS: read\n4. MUST DO: restate\n5. MUST NOT DO: none\n6. CONTEXT: paths";

function makeState(): DelegationMonitorState {
  return createDelegationMonitorState();
}

function startRunning(state: DelegationMonitorState, id: string): void {
  startDelegationRun(state, {
    id,
    parentToolCallId: "parent",
    source: "delegate_agent",
    mode: "single",
    agent: "alpha",
    task: TASK,
    startedAtMs: 1000,
    cwd: "/repo",
  });
  markRunRunning(state, id);
}

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-engine-steer-${label}-`));
}

describe("engine/steer: steerRun marks a running run steered and writes the file", () => {
  it("accepts a running run, writes the steer file, and sets status steered", () => {
    const state = makeState();
    const dir = tempDir("ok");
    try {
      startRunning(state, "r1");
      const outcome = steerRun(state, "r1", "steer toward the oracle gate", dir);

      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.status, "steered");
      assert.equal(outcome.steerFile, join(dir, "r1.steer"));
      assert.equal(existsSync(outcome.steerFile), true);
      assert.equal(state.runs[0]?.status, "steered");

      const payload = JSON.parse(readFileSync(outcome.steerFile, "utf8")) as { runId: string; message: string };
      assert.equal(payload.runId, "r1");
      assert.equal(payload.message, "steer toward the oracle gate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows steering an already-steered (still active) run again", () => {
    const state = makeState();
    const dir = tempDir("resteer");
    try {
      startRunning(state, "r2");
      steerRun(state, "r2", "first", dir);
      const again = steerRun(state, "r2", "second", dir);
      assert.equal(again.ok, true);
      if (!again.ok) return;
      assert.equal(again.status, "steered");
      const payload = JSON.parse(readFileSync(again.steerFile, "utf8")) as { message: string };
      assert.equal(payload.message, "second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/steer: refuses non-running runs", () => {
  it("refuses a queued run", () => {
    const state = makeState();
    const dir = tempDir("queued");
    try {
      startDelegationRun(state, { id: "q1", parentToolCallId: "p", source: "delegate_task", mode: "single", agent: "beta", task: TASK, startedAtMs: 100 });
      const outcome = steerRun(state, "q1", "msg", dir);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.status, "queued");
      assert.ok(outcome.error.includes("not running"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a complete run", () => {
    const state = makeState();
    const dir = tempDir("complete");
    try {
      startRunning(state, "c1");
      finishDelegationRun(state, "c1", { status: "complete", endedAtMs: 2000, exitCode: 0 });
      const outcome = steerRun(state, "c1", "msg", dir);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.status, "complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an aborted run", () => {
    const state = makeState();
    const dir = tempDir("aborted");
    try {
      startRunning(state, "a1");
      abortDelegationRun(state, "a1", "cancelled", 2000);
      const outcome = steerRun(state, "a1", "msg", dir);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.status, "aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown run id", () => {
    const state = makeState();
    const dir = tempDir("unknown");
    try {
      const outcome = steerRun(state, "nope", "msg", dir);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.ok(outcome.error.includes("unknown run"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/steer: monitor wiring for the steered status", () => {
  it("summarizeDelegations counts steered runs and hasActiveDelegations stays true", () => {
    const state = makeState();
    const dir = tempDir("monitor");
    try {
      startRunning(state, "m1");
      steerRun(state, "m1", "msg", dir);
      const summary = summarizeDelegations(state);
      assert.equal(summary.steered, 1);
      assert.equal(summary.running, 0);
      assert.equal(hasActiveDelegations(state), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("statusIcon renders a distinct steered icon", () => {
    assert.equal(statusIcon("steered"), "➤");
  });
});
