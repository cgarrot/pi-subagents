// test/engine/monitor.test.ts — bounded monitor, trim, liveness, list/sort.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finishDelegationRun, markRunRunning, startDelegationRun, type DelegationRunStatus } from "../../src/engine/runs.js";
import {
  assessDelegationAttemptLiveness,
  buildDelegationGroups,
  compactTokens,
  createDelegationMonitorState,
  formatRunUsage,
  hasActiveDelegations,
  listDelegationRuns,
  summarizeDelegations,
  trimDelegationRuns,
  type ChildDelegationAttempt,
} from "../../src/engine/monitor.js";

const TASK = "1. TASK: a\n2. EXPECTED OUTCOME: b\n3. REQUIRED TOOLS: read\n4. MUST DO: restate\n5. MUST NOT DO: none\n6. CONTEXT: paths";

function addRun(state: ReturnType<typeof createDelegationMonitorState>, id: string, status: DelegationRunStatus, agent = "alpha", startedAtMs = 1000, endedAtMs?: number): void {
  startDelegationRun(state, { id, parentToolCallId: "parent", source: "delegate_agent", mode: "single", agent, task: TASK, startedAtMs });
  if (status === "running") {
    markRunRunning(state, id);
  } else if (status !== "queued") {
    finishDelegationRun(state, id, { status, endedAtMs: endedAtMs ?? startedAtMs + 500 });
  }
}

describe("engine/monitor: bounded state + trim", () => {
  it("trims terminal runs first and preserves active runs within maxRuns", () => {
    const state = createDelegationMonitorState(3);
    // 4 terminal runs + 1 running.
    addRun(state, "c1", "complete", "a", 1000);
    addRun(state, "c2", "complete", "b", 2000);
    addRun(state, "c3", "complete", "c", 3000);
    addRun(state, "c4", "complete", "d", 4000);
    addRun(state, "run", "running", "z", 5000);
    assert.equal(state.runs.length, 5);
    trimDelegationRuns(state);
    assert.equal(state.runs.length, 3);
    assert.equal(state.runs.some((r) => r.id === "run"), true, "active run must be preserved");
    assert.equal(state.runs.some((r) => r.id === "c1"), false, "oldest terminal evicted first");
  });

  it("summarize + hasActive reflect the current collection", () => {
    const state = createDelegationMonitorState(10);
    addRun(state, "a", "running");
    addRun(state, "b", "complete");
    addRun(state, "c", "preflight_failed");
    const summary = summarizeDelegations(state);
    assert.deepEqual(summary, { total: 3, queued: 0, running: 1, steered: 0, complete: 1, failed: 0, preflightFailed: 1, aborted: 0, escalated: 0 });
    assert.equal(hasActiveDelegations(state), true);
  });
});

describe("engine/monitor: list/sort", () => {
  it("sorts active first, then by startedAt", () => {
    const state = createDelegationMonitorState(10);
    addRun(state, "old-complete", "complete", "alpha", 1000, 1500);
    addRun(state, "running", "running", "beta", 2000);
    addRun(state, "new-complete", "complete", "gamma", 3000, 3500);
    const sorted = listDelegationRuns(state, "active", 4000);
    assert.equal(sorted[0]?.id, "running");
  });

  it("sorts by agent, duration, and latest", () => {
    const state = createDelegationMonitorState(10);
    addRun(state, "r1", "complete", "alpha", 1000, 2000);
    addRun(state, "r2", "complete", "beta", 1000, 1200);
    const byAgent = listDelegationRuns(state, "agent");
    assert.equal(byAgent[0]?.id, "r1"); // alpha before beta
    const byDuration = listDelegationRuns(state, "duration", 3000);
    assert.equal(byDuration[0]?.id, "r1"); // alpha ran 1000ms vs beta 200ms
    const byLatest = listDelegationRuns(state, "latest", 3000);
    assert.equal(byLatest.length, 2);
  });

  it("builds groups by parentToolCallId and keeps chain order by index", () => {
    const state = createDelegationMonitorState(10);
    startDelegationRun(state, { id: "s1", parentToolCallId: "chain", source: "delegate_agent", mode: "chain", index: 1, agent: "a", task: TASK, startedAtMs: 2000 });
    finishDelegationRun(state, "s1", { status: "complete", endedAtMs: 2500 });
    startDelegationRun(state, { id: "s0", parentToolCallId: "chain", source: "delegate_agent", mode: "chain", index: 0, agent: "b", task: TASK, startedAtMs: 1000 });
    finishDelegationRun(state, "s0", { status: "complete", endedAtMs: 1500 });
    const groups = buildDelegationGroups(state, "active", 3000);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.runs[0]?.id, "s0"); // chain ordered by index
    assert.equal(groups[0]?.runs[1]?.id, "s1");
  });
});

describe("engine/monitor: liveness (fail-closed)", () => {
  const attempt: ChildDelegationAttempt = {
    attemptId: "att-1",
    runId: "run-1",
    status: "running",
    updatedAt: 1000,
  };

  it("reports active for a current authoritative running monitor row", () => {
    const state = createDelegationMonitorState(10);
    startDelegationRun(state, { id: "run-1", parentToolCallId: "p", source: "delegate_agent", mode: "single", agent: "alpha", task: TASK, startedAtMs: 1000 });
    const proof = assessDelegationAttemptLiveness(state, attempt);
    assert.equal(proof.status, "active");
    assert.equal(proof.code, "monitor_active_exact");
    assert.equal(proof.bodyStored, false);
  });

  it("reports inactive for a terminal monitor row", () => {
    const state = createDelegationMonitorState(10);
    addRun(state, "run-1", "complete", "alpha", 1000, 1500);
    const proof = assessDelegationAttemptLiveness(state, attempt);
    assert.equal(proof.status, "inactive");
    assert.equal(proof.code, "monitor_terminal_exact");
  });

  it("reports unknown for a restored (non-authoritative) running row without controller", () => {
    const state = createDelegationMonitorState(10);
    startDelegationRun(state, { id: "run-1", parentToolCallId: "p", source: "delegate_agent", mode: "single", agent: "alpha", task: TASK, startedAtMs: 1000 });
    // Simulate a restored projection that omits the authority marker.
    state.runs[0]!.authoritativeCurrentRuntime = undefined;
    const proof = assessDelegationAttemptLiveness(state, attempt);
    assert.equal(proof.status, "unknown");
    assert.equal(proof.code, "restored_nonterminal_without_controller");
  });

  it("reports unknown on attempt id mismatch", () => {
    const state = createDelegationMonitorState(10);
    const proof = assessDelegationAttemptLiveness(state, attempt, { attemptId: "other", runId: "run-1" });
    assert.equal(proof.status, "unknown");
    assert.equal(proof.code, "attempt_id_mismatch");
  });
});

describe("engine/monitor: formatRunUsage (B4 per-run cost exposure)", () => {
  it("renders delta-based run totals plus the current-context snapshot", () => {
    const line = formatRunUsage({ turns: 3, input: 6_000, output: 350, cacheRead: 5_000, cacheWrite: 0, cost: 0.009, contextTokens: 11_350 });
    assert.equal(line, "3t · 6.0k in · 350 out · ctx 11.3k · $0.0090");
  });

  it("omits ctx/cost when zero and reports n/a when usage is absent", () => {
    assert.equal(formatRunUsage({ turns: 1, input: 800, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 }), "1t · 800 in · 40 out");
    assert.equal(formatRunUsage(undefined), "usage n/a");
  });

  it("compacts token counts", () => {
    assert.equal(compactTokens(340), "340");
    assert.equal(compactTokens(1_234), "1.2k");
    assert.equal(compactTokens(2_500_000), "2.5M");
  });

  it("is exposed on DelegationRunView via finishDelegationRun usage patch", () => {
    const state = createDelegationMonitorState(10);
    startDelegationRun(state, { id: "u1", parentToolCallId: "p", source: "delegate_agent", mode: "single", agent: "beta", task: TASK, startedAtMs: 1_000 });
    finishDelegationRun(state, "u1", {
      status: "complete",
      endedAtMs: 2_000,
      usage: { turns: 2, input: 2_000, output: 120, cacheRead: 0, cacheWrite: 0, cost: 0.002, contextTokens: 2_120 },
    });
    const run = state.runs.find((candidate) => candidate.id === "u1");
    assert.equal(formatRunUsage(run?.usage), "2t · 2.0k in · 120 out · ctx 2.1k · $0.0020");
  });
});
