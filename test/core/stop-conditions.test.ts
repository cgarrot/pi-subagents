// test/core/stop-conditions.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyChildStopCondition,
  classifyDelegationChronicleCompletion,
  detectOracleFail,
  outputHasEvidenceMarker,
  summarizeRunawayGuard,
} from "../../src/core/index.js";

describe("stop-conditions: detectOracleFail", () => {
  it("detects FAIL verdict", () => {
    const r = detectOracleFail("<verdict>FAIL</verdict>");
    assert.equal(r.oracleFailed, true);
    assert.equal(r.noShip, false);
    assert.equal(r.stopCondition, "oracle_fail");
  });

  it("detects no_ship", () => {
    const r = detectOracleFail("no_ship: true");
    assert.equal(r.noShip, true);
    assert.equal(r.stopCondition, "no_ship");
  });
});

describe("stop-conditions: outputHasEvidenceMarker", () => {
  it("matches evidence markers", () => {
    assert.equal(outputHasEvidenceMarker("<evidence>abc</evidence>"), true);
    assert.equal(outputHasEvidenceMarker("plain output"), false);
  });
});

describe("stop-conditions: classifyChildStopCondition", () => {
  it("returns none for a clean successful run", () => {
    const r = classifyChildStopCondition({
      assistantTurnSeen: true,
      outputHash: "abc",
      outputCaptured: true,
      outputValidated: true,
      evidenceChecked: true,
    });
    assert.equal(r.stopCondition, "none");
    assert.equal(r.shouldStop, false);
  });

  it("fail_loop has highest precedence", () => {
    const r = classifyChildStopCondition({ failLoopExceeded: true, assistantTurnSeen: true });
    assert.equal(r.stopCondition, "fail_loop");
  });

  it("missing output hash => incomplete_no_evidence", () => {
    const r = classifyChildStopCondition({ assistantTurnSeen: true, evidenceChecked: true });
    assert.equal(r.stopCondition, "incomplete_no_evidence");
  });

  it("failed validation", () => {
    const r = classifyChildStopCondition({
      assistantTurnSeen: true,
      outputHash: "abc",
      outputValidated: false,
      evidenceChecked: true,
    });
    assert.equal(r.stopCondition, "failed_validation");
  });
});

describe("stop-conditions: summarizeRunawayGuard", () => {
  it("stops when failures reach threshold", () => {
    const r = summarizeRunawayGuard({ failures: 3, failLoopThreshold: 3 });
    assert.equal(r.shouldStop, true);
    assert.equal(r.stopCondition, "fail_loop");
  });

  it("does not stop below threshold", () => {
    const r = summarizeRunawayGuard({ failures: 1 });
    assert.equal(r.shouldStop, false);
  });
});

describe("stop-conditions: classifyDelegationChronicleCompletion", () => {
  it("classifies a passing delegation as complete", () => {
    const r = classifyDelegationChronicleCompletion({
      runId: "run_1",
      source: "delegate_task",
      mode: "implement",
      agent: "x",
      tools: [],
      status: "done",
      gatePassed: true,
      assistantTurnSeen: true,
      outputHash: "abc",
      latencyMs: 10,
      startedAt: "t0",
      endedAt: "t1",
    });
    assert.equal(r.state, "complete");
    assert.equal(r.complete, true);
  });
});
