import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseToolList, validateToolList } from "../../src/gates/tools.js";
import type { HarnessAgent } from "../../src/gates/types.js";

const agent: HarnessAgent = {
  name: "implementer",
  description: "implements",
  tools: ["read", "write", "edit", "bash"],
  prompt: "prompt",
  source: "project",
  filePath: "/tmp/agent.md",
};

describe("parseToolList", () => {
  it("parses a comma-separated list", () => {
    assert.deepEqual(parseToolList(" read , write ,edit "), ["read", "write", "edit"]);
  });
  it("drops empty entries", () => {
    assert.deepEqual(parseToolList("read,,write,"), ["read", "write"]);
  });
  it("returns undefined for empty input", () => {
    assert.equal(parseToolList(undefined), undefined);
    assert.equal(parseToolList(""), undefined);
    assert.deepEqual(parseToolList("   "), []);
  });
});

describe("validateToolList", () => {
  it("accepts no requested tools", () => {
    assert.deepEqual(validateToolList(agent, undefined), []);
    assert.deepEqual(validateToolList(agent, []), []);
  });
  it("accepts allowed tools", () => {
    assert.deepEqual(validateToolList(agent, ["read", "write"]), []);
  });
  it("rejects tools not in the allowlist", () => {
    const errors = validateToolList(agent, ["bash", "rm"]);
    assert.ok(errors.some((e) => e.includes("'rm' is not allowed")), JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes("Allowed: read, write, edit, bash")), JSON.stringify(errors));
  });
  it("rejects invalid tool names", () => {
    const errors = validateToolList(agent, ["bad tool!"]);
    assert.ok(errors.some((e) => e.includes("Invalid tool name 'bad tool!'")), JSON.stringify(errors));
  });
  it("refuses override when agent has no allowlist", () => {
    const noTools: HarnessAgent = { ...agent, tools: [] };
    const errors = validateToolList(noTools, ["read"]);
    assert.deepEqual(errors, ["Agent 'implementer' has no declared tool allowlist; refusing tool override."]);
  });
});
