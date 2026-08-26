// test/extension/registration.test.ts — the adapter registers exactly the 6
// tools + 3 commands with harness-compatible metadata (names, params schemas,
// non-empty promptSnippet) and returns {content, details} tool results.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import subagentsExtension from "../../src/extension/index.js";
import { registerCommands } from "../../src/extension/commands.js";
import { registerTools } from "../../src/extension/tools.js";
import { fakeCtx, stubApi } from "./stub-api.js";

describe("extension/registration: 5 tools via default extension", () => {
  it("registers all 5 delegation tools with non-empty snippets and schema params", () => {
    const { api, tools } = stubApi();
    subagentsExtension(api);

    const names = [...tools.keys()].sort();
    assert.deepEqual(names, [
      "await_delegation_run",
      "continue_run",
      "delegate_agent",
      "delegate_task",
      "get_delegation_run",
    ]);

    for (const tool of tools.values()) {
      assert.ok(tool.name.length > 0, `name missing for ${tool.name}`);
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, `description empty for ${tool.name}`);
      assert.ok(typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0, `promptSnippet empty for ${tool.name}`);
      // Plain JSON Schema object with type:object + properties.
      assert.equal(tool.parameters.type, "object");
      assert.ok(tool.parameters.properties && typeof tool.parameters.properties === "object");
      assert.equal(typeof tool.execute, "function");
    }
    // Harness-parity: only the two routing/freeform tools carry guidelines.
    for (const name of ["delegate_agent", "delegate_task"]) {
      const tool = tools.get(name);
      assert.ok(tool && Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0, `promptGuidelines empty for ${name}`);
    }
  });

  it("registers the /agents, /runs and /subagents commands", () => {
    const { api, commands } = stubApi();
    subagentsExtension(api);
    assert.deepEqual([...commands.keys()].sort(), ["agents", "runs", "subagents"]);
    for (const def of commands.values()) {
      assert.ok(def.description.length > 0);
      assert.equal(typeof def.handler, "function");
    }
  });

  it("each tool execute returns a harness-compatible {content, details} result", async () => {
    const { api, tools } = stubApi();
    subagentsExtension(api);
    const ctx = fakeCtx("/tmp/pi-subagents-nocwd");
    for (const tool of tools.values()) {
      // Call with empty params; must not throw and must return {content:[{type:"text"}]}.
      const result = await tool.execute("call", {}, undefined, undefined, ctx);
      assert.ok(Array.isArray(result.content), `${tool.name} content array`);
      assert.equal(result.content[0]?.type, "text");
      assert.ok(typeof result.content[0]?.text === "string");
    }
  });
});

describe("extension/registration: direct registerTools + registerCommands", () => {
  it("registerTools registers 5 tools; registerCommands registers 3 commands", () => {
    const toolsApi = stubApi();
    const commandsApi = stubApi();
    const ensure = () => { throw new Error("no runtime in registration test"); };
    registerTools(toolsApi.api, ensure);
    registerCommands(commandsApi.api, ensure);
    assert.equal(toolsApi.tools.size, 5);
    assert.equal(commandsApi.commands.size, 3);
  });
});
