// test/core/statuses.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHRONICLE_STATES,
  classifyChronicleCompletion,
  TERMINAL_CHRONICLE_FAILURE_STATES,
} from "../../src/core/index.js";

describe("statuses: CHRONICLE_STATES", () => {
  it("defines the ordered lifecycle states", () => {
    assert.ok(CHRONICLE_STATES.includes("created"));
    assert.ok(CHRONICLE_STATES.includes("complete"));
    assert.ok(CHRONICLE_STATES.includes("failed_preflight"));
  });

  it("marks terminal failure states", () => {
    assert.ok(TERMINAL_CHRONICLE_FAILURE_STATES.has("timeout"));
    assert.ok(TERMINAL_CHRONICLE_FAILURE_STATES.has("failed_validation"));
    assert.ok(!TERMINAL_CHRONICLE_FAILURE_STATES.has("complete"));
  });
});

describe("statuses: classifyChronicleCompletion", () => {
  it("classifies a successful run as complete", () => {
    const r = classifyChronicleCompletion({
      kind: "delegation",
      runId: "run_1",
      status: "done",
      outputHash: "abc",
      assistantTurnSeen: true,
      outputCaptured: true,
      outputValidated: true,
      evidenceChecked: true,
    });
    assert.equal(r.state, "complete");
    assert.equal(r.complete, true);
    assert.equal(r.terminalFailure, false);
    assert.equal((r.falseDoneGuard as { passed: boolean }).passed, true);
  });

  it("classifies no assistant turn as incomplete_no_assistant_turn", () => {
    const r = classifyChronicleCompletion({
      kind: "delegation",
      runId: "run_2",
      status: "done",
      outputHash: "abc",
      assistantTurnSeen: false,
      outputValidated: true,
      evidenceChecked: true,
    });
    assert.equal(r.state, "incomplete_no_assistant_turn");
    assert.equal(r.terminalFailure, true);
  });

  it("classifies failed_validation", () => {
    const r = classifyChronicleCompletion({
      kind: "delegation",
      runId: "run_3",
      status: "done",
      outputHash: "abc",
      assistantTurnSeen: true,
      outputValidated: false,
      evidenceChecked: true,
    });
    assert.equal(r.state, "failed_validation");
  });
});
