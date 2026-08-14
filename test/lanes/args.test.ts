// test/lanes/args.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildFlags, buildIsolatedChildArgs } from "../../src/lanes/args.js";

describe("lanes/args: buildIsolatedChildArgs", () => {
  it("builds the fixed isolated prefix without extensions", () => {
    assert.deepEqual(buildIsolatedChildArgs(), ["--mode", "json", "-p", "--no-extensions"]);
  });

  it("appends -e once per deduplicated non-empty extension", () => {
    const args = buildIsolatedChildArgs({
      providerExtension: "/ext/provider.ts",
      codexFastModeExtension: "/ext/codex.ts",
      childSafetyExtension: "/ext/safety.ts",
    });
    assert.deepEqual(args, [
      "--mode", "json", "-p", "--no-extensions",
      "-e", "/ext/provider.ts",
      "-e", "/ext/codex.ts",
      "-e", "/ext/safety.ts",
    ]);
  });

  it("deduplicates identical extensions", () => {
    const args = buildIsolatedChildArgs({
      providerExtension: "/ext/shared.ts",
      childSafetyExtension: "/ext/shared.ts",
    });
    const count = args.filter((a) => a === "/ext/shared.ts").length;
    assert.equal(count, 1);
  });

  it("ignores empty/undefined extensions", () => {
    const args = buildIsolatedChildArgs({ providerExtension: "" });
    assert.deepEqual(args, ["--mode", "json", "-p", "--no-extensions"]);
  });
});

describe("lanes/args: buildChildFlags", () => {
  it("always includes --session and adds optional flags", () => {
    const flags = buildChildFlags({
      sessionPath: "/sessions/chain.jsonl",
      model: "openai/gpt-5.5",
      thinking: "high",
      tools: "read,grep",
      agentPrompt: "You are a subagent.",
    });
    assert.deepEqual(flags, [
      "--session", "/sessions/chain.jsonl",
      "--model", "openai/gpt-5.5",
      "--thinking", "high",
      "--tools", "read,grep",
      "--append-system-prompt", "You are a subagent.",
    ]);
  });

  it("omits optional flags when absent", () => {
    const flags = buildChildFlags({ sessionPath: "/sessions/x.jsonl" });
    assert.deepEqual(flags, ["--session", "/sessions/x.jsonl"]);
  });

  it("never emits --session-offset (pi resumes the session file as-is)", () => {
    // pi >= 0.84 rejects the unknown option (`Error: Unknown option:
    // --session-offset`, exit 1) — continuations must pass --session only.
    const flags = buildChildFlags({ sessionPath: "/sessions/continue.jsonl", model: "openai/gpt-5.5" });
    assert.ok(!flags.includes("--session-offset"));
  });
});
