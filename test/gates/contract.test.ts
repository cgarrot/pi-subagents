import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatContractTemplate, validateSixPartContract } from "../../src/gates/contract.js";

describe("formatContractTemplate", () => {
  it("includes all six contract sections", () => {
    const template = formatContractTemplate("Porter les gates");
    assert.ok(template.includes("TASK: Porter les gates"));
    for (const section of ["EXPECTED OUTCOME", "REQUIRED TOOLS", "MUST DO", "MUST NOT DO", "CONTEXT"]) {
      assert.ok(template.includes(section), `missing section ${section}`);
    }
    assert.ok(template.includes("deliverable_delivered"));
  });

  it("defaults the task to [atomic goal]", () => {
    assert.ok(formatContractTemplate().includes("TASK: [atomic goal]"));
  });
});

describe("validateSixPartContract", () => {
  const valid = `1. TASK: Do the thing
2. EXPECTED OUTCOME: a file set
3. REQUIRED TOOLS: read, write
4. MUST DO:
   - Restate constraints.
5. MUST NOT DO:
   - No commits.
6. CONTEXT:
   - Paths: /tmp
   - Evidence: none`;

  it("accepts a complete in-order contract", () => {
    assert.deepEqual(validateSixPartContract(valid), []);
  });

  it("flags a missing section", () => {
    const withoutContext = valid.replace(/6\. CONTEXT:[\s\S]*$/, "");
    const errors = validateSixPartContract(withoutContext);
    assert.ok(errors.some((e) => e.includes("Missing contract section: CONTEXT")), JSON.stringify(errors));
  });

  it("flags empty/placeholder sections", () => {
    const emptyBody = `1. TASK: [atomic goal]
2. EXPECTED OUTCOME: [placeholder]
3. REQUIRED TOOLS: [placeholder]
4. MUST DO: [placeholder]
5. MUST NOT DO: [placeholder]
6. CONTEXT: [placeholder]`;
    const errors = validateSixPartContract(emptyBody);
    assert.ok(errors.length >= 6, JSON.stringify(errors));
    assert.ok(errors.every((e) => e.startsWith("Empty contract section")));
  });

  it("flags out-of-order sections", () => {
    const reordered = `1. TASK: a
2. MUST NOT DO: none
3. EXPECTED OUTCOME: b
4. REQUIRED TOOLS: read
5. MUST DO: c
6. CONTEXT: d`;
    const errors = validateSixPartContract(reordered);
    assert.ok(errors.some((e) => e.includes("out of order")), JSON.stringify(errors));
  });

  it("accepts non-numbered section headers", () => {
    const unnumbered = `TASK: a
EXPECTED OUTCOME: b
REQUIRED TOOLS: read
MUST DO: c
MUST NOT DO: none
CONTEXT: d`;
    assert.deepEqual(validateSixPartContract(unnumbered), []);
  });
});
