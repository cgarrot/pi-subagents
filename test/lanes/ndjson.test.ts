// test/lanes/ndjson.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChildResult } from "../../src/core/types.js";
import { NdjsonStreamParser } from "../../src/lanes/ndjson.js";

function makeResult(task: string): ChildResult {
  return {
    agent: "lane",
    task,
    exitCode: 0,
    output: "",
    stderr: "",
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
  };
}

// Mirrors the exact NDJSON sequence of the stdin spike.
function spikeLines(task: string): string[] {
  const answer = `answer:${task}`;
  return [
    JSON.stringify({ type: "session", version: 3, id: "s" }),
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: task }] } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ans" } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wer:" } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: task } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], model: "gpt-5.5", provider: "openai-codex" } }),
    JSON.stringify({ type: "turn_end" }),
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }] }),
    JSON.stringify({ type: "agent_settled" }),
  ];
}

describe("lanes/ndjson: NdjsonStreamParser", () => {
  it("parses the full spike sequence, streaming output and setting settled", () => {
    const result = makeResult("hello");
    const parser = new NdjsonStreamParser(result);
    // Feed in arbitrary chunk boundaries to prove the buffering works.
    const lines = spikeLines("hello");
    const blob = lines.join("\n") + "\n";
    for (let i = 0; i < blob.length; i += 7) parser.push(blob.slice(i, i + 7));
    parser.flush();

    assert.equal(parser.hasSettled, true);
    assert.equal(result.output, "answer:hello");
    assert.equal(result.model, "openai-codex/gpt-5.5");
    assert.equal(result.exitCode, 0);
  });

  it("streams output incrementally via onUpdate for each text_delta", () => {
    const result = makeResult("x");
    const updates: string[] = [];
    const parser = new NdjsonStreamParser(result, {
      onUpdate: (r) => updates.push(r.output),
    });
    parser.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "he" } }) + "\n");
    parser.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "llo" } }) + "\n");
    assert.deepEqual(updates, ["he", "hello"]);
  });

  it("ignores non-NDJSON lines and unrelated events", () => {
    const result = makeResult("y");
    const parser = new NdjsonStreamParser(result);
    parser.push("not json\n");
    parser.push(JSON.stringify({ type: "turn_start" }) + "\n");
    parser.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "no" } }) + "\n");
    assert.equal(parser.hasSettled, false);
    assert.equal(result.output, "");
  });

  it("does not mark settled when agent_settled is absent", () => {
    const result = makeResult("z");
    const parser = new NdjsonStreamParser(result);
    const lines = spikeLines("z").slice(0, -1); // drop agent_settled
    parser.push(lines.join("\n") + "\n");
    parser.flush();
    assert.equal(parser.hasSettled, false);
  });
});

describe("lanes/ndjson: toolCall capture (ephemeral actions feed)", () => {
  it("captures content[].toolCall parts into actions[] as name(args) with ~80-char truncated args", () => {
    const result = makeResult("tools");
    const parser = new NdjsonStreamParser(result);
    const longPath = "/a/very/long/path/".repeat(20);
    parser.push(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "working" },
            { type: "toolCall", toolCall: { id: "t1", name: "bash", arguments: { command: "npm test" } } },
            { type: "toolCall", toolCall: { id: "t2", name: "read", arguments: { path: longPath } } },
          ],
          model: "gpt-5.5",
          provider: "openai-codex",
        },
      }) + "\n",
    );
    const longArgs = JSON.stringify({ path: longPath });
    assert.deepEqual(result.actions, [
      `bash(${JSON.stringify({ command: "npm test" })})`,
      `read(${longArgs.slice(0, 80)}…)`,
    ]);
    assert.ok(longArgs.length > 80, "fixture must exercise truncation");
    // The capture never disturbs the turn/usage accounting.
    assert.equal(result.usage.turns, 1);
    assert.equal(result.output, "working");
  });

  it("fires action update infos before the turn info on message_end", () => {
    const result = makeResult("order");
    const kinds: string[] = [];
    const parser = new NdjsonStreamParser(result, {
      onUpdate: (_r, info) => kinds.push(info?.action ?? info?.kind ?? "?"),
    });
    parser.push(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", toolCall: { name: "grep", arguments: { pattern: "x" } } }],
          model: "gpt-5.5",
        },
      }) + "\n",
    );
    assert.deepEqual(kinds, [`grep(${JSON.stringify({ pattern: "x" })})`, "turn"]);
  });

  it("accepts a flat toolCall part shape and non-object args", () => {
    const result = makeResult("flat");
    const parser = new NdjsonStreamParser(result);
    parser.push(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", arguments: "echo hi" },
            { type: "toolCall", toolCall: { name: "read" } },
          ],
        },
      }) + "\n",
    );
    assert.deepEqual(result.actions, ["bash(echo hi)", "read()"]);
  });

  it("keeps actions undefined when the child emits no toolCalls", () => {
    const result = makeResult("none");
    const parser = new NdjsonStreamParser(result);
    parser.push(spikeLines("none").join("\n") + "\n");
    assert.equal(result.actions, undefined);
  });
});

describe("lanes/ndjson: usage accumulation (B4 anti-double-counting)", () => {
  // One assistant message_end carrying a cumulative usage snapshot (pi
  // re-encodes the whole conversation each turn -> growing counters).
  function usageEndLine(input: number, output: number, cacheRead: number, totalTokens: number, cost: number): string {
    return JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `t:${input}` }],
        model: "gpt-5.5",
        usage: { input, output, cacheRead, cacheWrite: 0, totalTokens, cost: { total: cost } },
      },
    });
  }

  it("multi-turn growing usage accumulates DELTAS (== last cumulative), never the naive message_end sum", () => {
    const result = makeResult("cost");
    const parser = new NdjsonStreamParser(result);
    parser.push(usageEndLine(1_000, 100, 0, 1_100, 0.001) + "\n");
    parser.push(usageEndLine(3_000, 220, 2_000, 5_220, 0.004) + "\n");
    parser.push(usageEndLine(6_000, 350, 5_000, 11_350, 0.009) + "\n");

    const usage = result.usage;
    assert.equal(usage.turns, 3);
    // input deltas: 1000 + 2000 + 3000 = 6000 (== LAST cumulative snapshot).
    // Naive double-counting sum would be 1000+3000+6000 = 10000.
    assert.equal(usage.input, 6_000);
    assert.notEqual(usage.input, 10_000);
    // output deltas: 100 + 120 + 130 = 350 (== last), not 670.
    assert.equal(usage.output, 350);
    assert.notEqual(usage.output, 670);
    // cacheRead deltas: 0 + 2000 + 3000 = 5000 (== last), not 7000.
    assert.equal(usage.cacheRead, 5_000);
    assert.notEqual(usage.cacheRead, 7_000);
    // cost deltas: 0.001 + 0.003 + 0.005 == 0.009 (== last), not 0.014.
    assert.ok(Math.abs(usage.cost - 0.009) < 1e-9, `cost ${usage.cost}`);
    assert.ok(Math.abs(usage.cost - 0.014) > 1e-9);
    // current-context semantics: LAST totalTokens snapshot, never summed.
    assert.equal(usage.contextTokens, 11_350);
    assert.notEqual(usage.contextTokens, 1_100 + 5_220 + 11_350);
  });

  it("counts assistant turns even when message_end carries no usage; totals stay zero", () => {
    const result = makeResult("plain");
    const parser = new NdjsonStreamParser(result);
    parser.push(spikeLines("plain").join("\n") + "\n");
    assert.equal(result.usage.turns, 1);
    assert.equal(result.usage.input, 0);
    assert.equal(result.usage.cost, 0);
    assert.equal(result.usage.contextTokens, 0);
  });

  it("falls back to the LAST assistant message usage on agent_end when message_end carried none", () => {
    const result = makeResult("fb");
    const parser = new NdjsonStreamParser(result);
    parser.push(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\n");
    parser.push(
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 500, output: 50, cacheRead: 0, totalTokens: 550, cost: { total: 0.002 } } },
        ],
      }) + "\n",
    );
    assert.equal(result.usage.turns, 1);
    assert.equal(result.usage.input, 500);
    assert.equal(result.usage.output, 50);
    assert.equal(result.usage.contextTokens, 550);
    assert.ok(Math.abs(result.usage.cost - 0.002) < 1e-9);
  });
});
