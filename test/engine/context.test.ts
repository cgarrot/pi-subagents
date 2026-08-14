// test/engine/context.test.ts — C2 `--main` context projection (condensed
// projection + REQUEST/HISTORY hierarchy + injectable provider + dispatch modes).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GENERAL_INSTRUCTION_HEADER,
  HISTORY_HEADER,
  HISTORY_SOURCE_HEADER,
  MAIN_CONTEXT_MESSAGE_MAX_CHARS,
  MAIN_CONTEXT_RECENT_MESSAGE_COUNT,
  REQUEST_HEADER,
  SUBAGENT_RESULT_MAX_CHARS,
  buildMainContextText,
  projectMainContext,
  stripTaskEcho,
  wrapTaskWithContext,
  type ContextProvider,
} from "../../src/engine/context.js";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { sha256 } from "../../src/core/hashing.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

const SESSION_PATH = "/tmp/pi-main-session-42.jsonl";
const FILE_CONTENT_SENTINEL = "SECRET-MAIN-SESSION-BODY-NEVER-PROJECTED";

function provider(overrides: Partial<ReturnType<ContextProvider["getMainContext"]>> = {}): ContextProvider {
  return {
    getMainContext: () => ({
      compactionSummary: "Earlier we refactored the parser and fixed 3 bugs.",
      recentMessages: [
        { role: "user", text: "Please investigate the failing login flow." },
        { role: "assistant", text: "I found the root cause in auth.ts." },
      ],
      sessionFilePath: SESSION_PATH,
      ...overrides,
    }),
  };
}

describe("engine/context: buildMainContextText projection", () => {
  it("projects compaction summary + recent messages + file pointer (path, not content)", () => {
    const text = buildMainContextText(provider());
    assert.ok(text.includes("[COMPACTION SUMMARY]"), "compaction summary block present");
    assert.ok(text.includes("refactored the parser"));
    assert.ok(text.includes("[user] Please investigate the failing login flow."));
    assert.ok(text.includes("[assistant] I found the root cause in auth.ts."));
    assert.ok(text.includes(SESSION_PATH), "session file path (pointer) present");
    assert.ok(!text.includes(FILE_CONTENT_SENTINEL), "file content never projected");
    assert.ok(text.includes(HISTORY_SOURCE_HEADER), "pointer carries the reference-only header");
  });

  it("projects only the last MAIN_CONTEXT_RECENT_MESSAGE_COUNT messages", () => {
    const messages = Array.from({ length: MAIN_CONTEXT_RECENT_MESSAGE_COUNT + 5 }, (_, i) => ({
      role: "user",
      text: `unique-msg-token-${String(i + 1).padStart(2, "0")}`,
    }));
    const text = projectMainContext({ recentMessages: messages });
    assert.ok(!text.includes("unique-msg-token-01"));
    assert.ok(!text.includes("unique-msg-token-05"));
    assert.ok(text.includes("unique-msg-token-06"));
    assert.ok(text.includes(`unique-msg-token-${String(MAIN_CONTEXT_RECENT_MESSAGE_COUNT + 5).padStart(2, "0")}`));
  });

  it("truncates ordinary messages and subagent results at their named bounds", () => {
    const long = "x".repeat(MAIN_CONTEXT_MESSAGE_MAX_CHARS + 500);
    const subagent = "y".repeat(SUBAGENT_RESULT_MAX_CHARS + 500);
    const text = projectMainContext({
      recentMessages: [
        { role: "assistant", text: long },
        { role: "assistant", text: subagent, subagentResult: true },
      ],
    });
    assert.ok(text.includes(`[truncated 500 chars]`), "ordinary message truncated at MESSAGE_MAX_CHARS");
    assert.ok(!text.includes("x".repeat(MAIN_CONTEXT_MESSAGE_MAX_CHARS + 1)), "ordinary message body bounded");
    const subagentLine = text.split("\n").find((line) => line.includes("y".repeat(100)))!;
    assert.ok(subagentLine.length <= SUBAGENT_RESULT_MAX_CHARS + 200, "subagent result truncated at SUBAGENT_RESULT_MAX_CHARS");
  });

  it("skips toolResult messages (texts + toolCalls only)", () => {
    const text = projectMainContext({
      recentMessages: [
        { role: "assistant", text: "let me read the file", kind: "text" },
        { role: "tool", text: "read auth.ts", kind: "toolCall" },
        { role: "tool", text: "FILE-TOOL-RESULT-BODY", kind: "toolResult" },
      ],
    });
    assert.ok(text.includes("let me read the file"));
    assert.ok(text.includes("read auth.ts"));
    assert.ok(!text.includes("FILE-TOOL-RESULT-BODY"));
  });

  it("returns an empty projection when there is nothing to project", () => {
    assert.equal(projectMainContext({ recentMessages: [] }), "");
    assert.equal(buildMainContextText({ getMainContext: () => ({ recentMessages: [] }) }), "");
  });
});

describe("engine/context: stripTaskEcho", () => {
  it("removes the immediate task echo (whitespace-normalized equality), keeps the rest", () => {
    const task = "1. TASK: build the widget\n2. EXPECTED OUTCOME: artifact";
    const messages = [
      { role: "user", text: "earlier discussion" },
      { role: "user", text: `  ${task.replace(/\n/g, "   ")}  ` },
      { role: "assistant", text: "working on it" },
    ];
    const stripped = stripTaskEcho(task, messages);
    assert.equal(stripped.length, 2);
    assert.ok(stripped.every((m) => normalize(m.text) !== normalize(task)));
    assert.ok(stripped.some((m) => m.text === "earlier discussion"));
  });

  it("keeps everything when the task is empty or absent from history", () => {
    const messages = [{ role: "user", text: "a" }, { role: "user", text: "b" }];
    assert.equal(stripTaskEcho("", messages).length, 2);
    assert.equal(stripTaskEcho("not-in-history", messages).length, 2);
  });
});

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("engine/context: wrapTaskWithContext hierarchy", () => {
  const TASK = "1. TASK: ship the report";

  /** Line index of a block header matched as a STANDALONE line (the rules
   * text legitimately cites header names inline, so substring search lies). */
  const headerLineIndexOf = (wrapped: string, header: string): number =>
    wrapped.split("\n").findIndex((line) => line.trim() === header);

  it("emits the exact REQUEST/HISTORY block order with anti-persona rules", () => {
    const contextText = projectMainContext(provider().getMainContext());
    const wrapped = wrapTaskWithContext(TASK, contextText, SESSION_PATH);
    const order = [GENERAL_INSTRUCTION_HEADER, HISTORY_HEADER, HISTORY_SOURCE_HEADER, REQUEST_HEADER].map(
      (header) => headerLineIndexOf(wrapped, header),
    );
    assert.ok(order.every((i) => i >= 0), "all four block headers present as standalone lines");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "headers appear in authority order");
    // Anti-persona rules live in the GENERAL INSTRUCTION block (before history).
    const lines = wrapped.split("\n");
    const gi = lines.slice(0, headerLineIndexOf(wrapped, HISTORY_HEADER)).join("\n");
    assert.ok(gi.includes("NEVER adopt the persona"), "anti-persona rule present");
    assert.ok(gi.toLowerCase().includes("authoritative block wins"), "authority precedence stated");
    // REQUEST is the last block and carries the task verbatim.
    const request = lines.slice(headerLineIndexOf(wrapped, REQUEST_HEADER)).join("\n");
    assert.ok(request.endsWith(TASK), "task is the verbatim tail of the wrap");
  });

  it("pointer block carries the path only, never the file content", () => {
    const wrapped = wrapTaskWithContext(TASK, "history text", SESSION_PATH);
    const lines = wrapped.split("\n");
    const source = lines
      .slice(headerLineIndexOf(wrapped, HISTORY_SOURCE_HEADER), headerLineIndexOf(wrapped, REQUEST_HEADER))
      .join("\n");
    assert.ok(source.includes(SESSION_PATH));
    assert.ok(!source.includes(FILE_CONTENT_SENTINEL));
  });

  it("omits the HISTORY SOURCE block without a path and the HISTORY block without context", () => {
    const noPath = wrapTaskWithContext(TASK, "history text");
    assert.equal(headerLineIndexOf(noPath, HISTORY_SOURCE_HEADER), -1);
    const noContext = wrapTaskWithContext(TASK, "   ", SESSION_PATH);
    assert.equal(headerLineIndexOf(noContext, HISTORY_HEADER), -1);
    assert.ok(headerLineIndexOf(noContext, HISTORY_SOURCE_HEADER) >= 0);
    assert.ok(headerLineIndexOf(noContext, REQUEST_HEADER) >= 0);
  });
});

// --- dispatch integration (main vs isolated) ---

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-context-${label}-`));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "alpha.md"), AGENT_MD("alpha"), "utf8");
  return dir;
}

function contractTask(task: string): string {
  return `1. TASK: ${task}
2. EXPECTED OUTCOME: an artifact
3. REQUIRED TOOLS: read, bash
4. MUST DO:
   - Restate the task.
   - Produce evidence.
5. MUST NOT DO:
   - No destructive commands.
6. CONTEXT:
   - Paths: reports/
   - Evidence:
   - Downstream use:`;
}

const SUFFIX = "\nEvidence: proof provided\nRisks/blockers: none\nCompliance: satisfied\ndeliverable_delivered: yes";

/** Spawn a child that echoes the received stdin task into a compliant output. */
function echoSpawn(): SpawnFn {
  const script = [
    "const emit = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { data += c; });',
    'process.stdin.on("end", () => {',
    "  const task = data.trim();",
    `  const out = "answer:" + task + ${JSON.stringify(SUFFIX)};`,
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5", provider:"openai-codex"}});',
    '  emit({type:"agent_settled"});',
    "  process.exit(0);",
    "});",
  ].join("\n");
  return ({ cwd, env }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
}

describe("engine/dispatch: contextMode main vs isolated", () => {
  it("main mode sends the wrapped task to the child; monitor/ledger/result keep the original task", async () => {
    const dir = tempRepo("main");
    try {
      const ledger: Record<string, unknown>[] = [];
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: echoSpawn(),
        sessionDir: join(dir, "sessions"),
        contextProvider: provider(),
        onLedger: (entry) => ledger.push(entry),
      });
      const task = contractTask("analyze the main session");
      const result = await engine.single("alpha", task, { contextMode: "main", outputContract: "base.v1" });
      engine.close();

      assert.equal(result.exitCode, 0);
      // The CHILD saw the wrapped envelope (history + hierarchy + request).
      assert.ok(result.output.includes(GENERAL_INSTRUCTION_HEADER), "child received GENERAL INSTRUCTION block");
      assert.ok(result.output.includes(HISTORY_HEADER), "child received HISTORY block");
      assert.ok(result.output.includes("refactored the parser"), "child received the compaction summary");
      assert.ok(result.output.includes(SESSION_PATH), "child received the file pointer");
      assert.ok(result.output.includes(REQUEST_HEADER), "child received REQUEST block");
      assert.ok(result.output.includes("analyze the main session"), "task text present in REQUEST");
      // Parent-side views stay on the ORIGINAL task.
      assert.equal(result.task, task, "result view keeps the original task");
      const run = engine.monitor.runs.find((r) => r.agent === "alpha")!;
      assert.ok(run.taskPreview.startsWith("1. TASK: analyze the main session"), "monitor run keeps the original task (compact preview)");
      const startEntry = ledger.find((e) => e.event === "start")!;
      assert.equal(startEntry.taskHash, sha256(task), "ledger hashes the original task only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolated mode (default) sends the task verbatim with no context markers", async () => {
    const dir = tempRepo("isolated");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: echoSpawn(),
        sessionDir: join(dir, "sessions"),
        contextProvider: provider(), // provider present but mode is isolated
      });
      const task = contractTask("stay isolated");
      const result = await engine.single("alpha", task, { outputContract: "base.v1" });
      engine.close();

      assert.equal(result.exitCode, 0);
      assert.ok(result.output.startsWith("answer:" + task), "task passed through verbatim");
      for (const marker of [GENERAL_INSTRUCTION_HEADER, HISTORY_HEADER, HISTORY_SOURCE_HEADER, REQUEST_HEADER, "refactored the parser", SESSION_PATH]) {
        assert.ok(!result.output.includes(marker), `isolated dispatch must not contain ${marker}`);
      }
      assert.equal(result.task, task);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main mode without a provider degrades gracefully to an unwrapped dispatch", async () => {
    const dir = tempRepo("noprovider");
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: echoSpawn(), sessionDir: join(dir, "sessions") });
      const task = contractTask("no provider available");
      const result = await engine.single("alpha", task, { contextMode: "main", outputContract: "base.v1" });
      engine.close();

      assert.equal(result.exitCode, 0);
      assert.ok(result.output.startsWith("answer:" + task), "task unwrapped without a provider");
      assert.ok(!result.output.includes(REQUEST_HEADER));
      assert.equal(result.task, task);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
