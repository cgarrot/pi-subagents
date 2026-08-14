import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyChildGates,
  getOutputContractDefinitions,
  getOutputContractFinalMarker,
  inferOutputContract,
  listOutputContracts,
  OUTPUT_GATE_ISSUE_CODES,
  validateChildOutput,
  validateOutputContract,
  validateOutputContractId,
} from "../../src/gates/output-contracts.js";
import type { ChildResult } from "../../src/core/types.js";

const validBase = `TASK: Do it
Evidence: proof of work
Risks: none
Compliance: must not
deliverable_delivered: yes`;

function makeResult(output: string, agent = "implementer"): ChildResult {
  return {
    agent,
    task: "t",
    exitCode: 0,
    output,
    stderr: "",
    usage: { turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
  };
}

describe("contract registry", () => {
  it("lists known contracts including the ported markers", () => {
    const ids = listOutputContracts();
    for (const id of ["base.v1", "implement.v1", "oracle.v1", "qa.v1", "todo-child-result.v1", "todo-child-result.v2", "delegation-request.v1", "context-request.v1", "orchestration-profile.v1"]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });

  it("exposes definitions and final markers", () => {
    const implementDef = getOutputContractDefinitions().find((c) => c.id === "implement.v1");
    assert.ok(implementDef);
    assert.deepEqual(implementDef.required.slice(0, 3), [
      "deliverable_delivered",
      "evidence",
      "risks_blockers",
    ]);
    assert.equal(getOutputContractFinalMarker("todo-child-result.v1"), "FINAL_MARKER: TODO_CHILD_RESULT_END");
    assert.equal(getOutputContractFinalMarker("implement.v1"), "deliverable_delivered: yes");
    assert.equal(getOutputContractFinalMarker("does-not-exist"), undefined);
  });

  it("infers contracts from agent names", () => {
    assert.equal(inferOutputContract("implementer"), "implement.v1");
    assert.equal(inferOutputContract("qa"), "qa.v1");
    assert.equal(inferOutputContract("unknown-agent"), "base.v1");
  });

  it("validates contract ids", () => {
    assert.deepEqual(validateOutputContractId("base.v1"), []);
    const unknownError = validateOutputContractId("nope.v1")[0];
    assert.ok(unknownError?.includes("Unknown output contract 'nope.v1'"));
    assert.deepEqual(validateOutputContractId(undefined), []);
  });

  it("exports the issue codes", () => {
    assert.ok(OUTPUT_GATE_ISSUE_CODES.includes("missing_requirement"));
    assert.ok(OUTPUT_GATE_ISSUE_CODES.includes("deliverable_rejected"));
  });
});

describe("validateOutputContract", () => {
  it("accepts a conformant base.v1 output", () => {
    assert.deepEqual(validateOutputContract(validBase, "base.v1"), []);
  });

  it("rejects empty output", () => {
    const errors = validateOutputContract("", "base.v1");
    assert.ok(errors.some((e) => e.includes("Child produced no assistant output")));
  });

  it("rejects an unknown contract id", () => {
    const errors = validateOutputContract(validBase, "nope.v1");
    assert.ok(errors.some((e) => e.includes("Unknown output contract 'nope.v1'")));
  });

  it("flags missing common requirements", () => {
    const errors = validateOutputContract("just text", "base.v1");
    assert.ok(errors.some((e) => e.includes("Missing required final marker: deliverable_delivered")));
    assert.ok(errors.some((e) => e.includes("Missing evidence/proof section")));
  });

  it("rejects deliverable_delivered: no", () => {
    const errors = validateOutputContract(`${validBase.replace("deliverable_delivered: yes", "deliverable_delivered: no")}`, "base.v1");
    assert.ok(errors.some((e) => e.includes("Child reported deliverable_delivered: no")));
  });

  it("enforces implement.v1-specific requirements", () => {
    const errors = validateOutputContract(validBase, "implement.v1");
    assert.ok(errors.some((e) => e.includes("missing gap/no-change verdict")));
    assert.ok(errors.some((e) => e.includes("missing changed files or no-change evidence")));
  });
});

describe("validateChildOutput / applyChildGates", () => {
  it("infers the contract and passes a conformant result", () => {
    const result = makeResult(validBase, "implementer");
    result.output = `TASK: Do it
Evidence: proof of work
Risks: none
Compliance: must not
gap verdict: SUFFICIENT
changed files: no change
verification: commands
results: passed
deliverable_delivered: yes`;
    assert.deepEqual(validateChildOutput(result), []);
    const gated = applyChildGates(result);
    assert.equal(gated.gatePassed, true);
    assert.deepEqual(gated.gateErrors, []);
  });

  it("records gate failures on applyChildGates", () => {
    const result = makeResult("incomplete", "implementer");
    const gated = applyChildGates(result);
    assert.equal(gated.gatePassed, false);
    assert.ok(gated.gateIssues?.length);
    assert.ok(gated.gateErrors?.some((e) => e.includes("Missing required final marker")));
  });

  it("reports mismatched bound TODO id", () => {
    const result = makeResult(`${validBase}\ntodo_id: T-999`, "implementer");
    const errors = validateChildOutput(result, "todo-child-result.v1", { expectedTodoId: "T-1" });
    assert.ok(errors.some((e) => e.includes("todo_id mismatch: expected T-1")));
  });
});
