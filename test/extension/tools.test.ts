// test/extension/tools.test.ts — the 5 tools wire onto the real engine
// (single/parallel/chain, structured delegate_task, background get/await,
// catalog) using a fake child spawner + a stub ExtensionAPI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition, ToolResult } from "../../src/extension/pi-types.js";
import {
  createSubagentsRuntime,
  formatChildProgressLine,
  formatChildResultText,
  formatTokenCount,
  makeChildEventFeed,
  registerTools,
  type SubagentsRuntime,
} from "../../src/extension/tools.js";
import { DELEGATE_TASK_PARAMS } from "../../src/extension/schemas.js";
import type { ChildProgressEvent, ChildResult } from "../../src/core/types.js";
import type { SpawnFn } from "../../src/lanes/index.js";
import type { SessionContext } from "../../src/extension/pi-types.js";
import { fakeCtx, stubApi } from "./stub-api.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha", "beta"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-ext-${label}-`));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const agent of agents) writeFileSync(join(agentsDir, `${agent}.md`), AGENT_MD(agent), "utf8");
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

/** Fake child that echoes the task with a compliant output-contract suffix. */
function compliantSpawn(): SpawnFn {
  const script = [
    'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { data += c; });',
    'process.stdin.on("end", () => {',
    '  const task = data.trim();',
    `  const out = "answer:" + task + ${JSON.stringify(SUFFIX)};`,
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5", provider:"openai-codex"}});',
    '  emit({type:"agent_settled"});',
    "  process.exit(0);",
    "});",
  ].join("\n");
  return ({ cwd, env }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
}

function setup(dir: string): { ctx: SessionContext; getTool: (name: string) => ToolDefinition } {
  const runtime: SubagentsRuntime = createSubagentsRuntime(dir, { spawn: compliantSpawn() });
  const { api, tools } = stubApi();
  registerTools(api, () => runtime);
  const ctx = fakeCtx(dir);
  const getTool = (name: string): ToolDefinition => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} not registered`);
    return tool;
  };
  return { ctx, getTool };
}

const run = (tool: ToolDefinition, params: Record<string, unknown>, ctx: SessionContext) =>
  tool.execute("call", params, undefined, undefined, ctx);

/** run with a live onUpdate spy collecting streamed partials. */
const runWithUpdate = (
  tool: ToolDefinition,
  params: Record<string, unknown>,
  ctx: SessionContext,
): { promise: Promise<ToolResult>; updates: ToolResult[] } => {
  const updates: ToolResult[] = [];
  const promise = tool.execute("call", params, undefined, (partial) => updates.push(partial), ctx);
  return { promise, updates };
};

describe("extension/tools: zob_delegation_catalog", () => {
  it("returns a body-free catalog as content text + details", async () => {
    const dir = tempRepo("catalog");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(getTool("zob_delegation_catalog"), {}, ctx);
      assert.ok(result.content[0]!.text.includes("alpha"));
      assert.ok(result.content[0]!.text.includes("Valid output contracts:"));
      const details = result.details as Record<string, unknown>;
      assert.equal(details.schema, "zob.agent-catalog.v1");
      assert.equal(details.bodyStored, false);
      assert.equal(details.childDispatchAllowed, false);
      assert.equal(details.noExecution, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: delegate_agent", () => {
  it("single mode dispatches through the engine and returns output + details", async () => {
    const dir = tempRepo("single");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(getTool("delegate_agent"), { agent: "alpha", task: contractTask("build a widget") }, ctx);
      assert.ok(result.content[0]!.text.includes("deliverable_delivered: yes"));
      const details = result.details as { mode: string; results: Array<{ agent: string }> };
      assert.equal(details.mode, "single");
      assert.equal(details.results[0]!.agent, "alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects providing more than one mode", async () => {
    const dir = tempRepo("multimode");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(getTool("delegate_agent"), { agent: "alpha", task: contractTask("t"), tasks: [{ agent: "beta", task: contractTask("u") }] }, ctx);
      assert.match(result.content[0]!.text, /exactly one mode/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chain mode substitutes {previous} across steps", async () => {
    const dir = tempRepo("chain");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(
        getTool("delegate_agent"),
        {
          chain: [
            { agent: "alpha", task: contractTask("step one") },
            { agent: "beta", task: contractTask("step two uses {previous}") },
          ],
        },
        ctx,
      );
      assert.ok(result.content[0]!.text.includes("step two uses answer:1. TASK: step one"));
      const details = result.details as { mode: string; results: unknown[] };
      assert.equal(details.mode, "chain");
      assert.equal(details.results.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: delegate_task", () => {
  it("normalizes canonical params into a six-part task and returns output", async () => {
    const dir = tempRepo("task");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(
        getTool("delegate_task"),
        {
          agent: "alpha",
          task: "build a widget",
          expected_outcome: "an artifact",
          must_do: ["restate", "produce evidence"],
          must_not_do: ["no destructive"],
          context: "Paths: reports/",
          original_user_ask: "Please build a widget",
          allowed_paths: ["reports/"],
        },
        ctx,
      );
      assert.ok(result.content[0]!.text.includes("deliverable_delivered: yes"));
      const details = result.details as { mode: string; results: Array<{ task: string }> };
      assert.equal(details.mode, "single");
      assert.ok(details.results[0]!.task.includes("1. TASK: build a widget"));
      assert.ok(details.results[0]!.task.includes("2. EXPECTED OUTCOME: an artifact"));
      assert.ok(details.results[0]!.task.includes("ORIGINAL_USER_ASK: Please build a widget"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts safe aliases and blocks canonical/alias conflicts", async () => {
    const dir = tempRepo("alias");
    try {
      const { ctx, getTool } = setup(dir);
      // Safe aliases only.
      const ok = await run(
        getTool("delegate_task"),
        {
          agent: "alpha",
          task: "t",
          expectedOutcome: "artifact",
          mustDo: ["m"],
          mustNotDo: ["n"],
          context: "ctx",
        },
        ctx,
      );
      assert.ok(ok.content[0]!.text.includes("deliverable_delivered: yes"));

      // Conflict: canonical and alias disagree.
      const conflict = await run(
        getTool("delegate_task"),
        {
          agent: "alpha",
          task: "t",
          expected_outcome: "a",
          expectedOutcome: "b",
          must_do: ["m"],
          must_not_do: ["n"],
          context: "ctx",
        },
        ctx,
      );
      assert.match(conflict.content[0]!.text, /[Cc]onflict/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("background mode returns a run id and status running", async () => {
    const dir = tempRepo("bg");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(
        getTool("delegate_task"),
        {
          agent: "alpha",
          task: "t",
          expected_outcome: "artifact",
          must_do: ["m"],
          must_not_do: ["n"],
          context: "ctx",
          run_in_background: true,
        },
        ctx,
      );
      const details = result.details as { background: boolean; runId: string; status: string };
      assert.equal(details.background, true);
      assert.ok(details.runId.length > 0);
      assert.equal(details.status, "running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: get/await delegation run", () => {
  it("get_delegation_run reports running then complete for a background task", async () => {
    const dir = tempRepo("getawait");
    try {
      const { ctx, getTool } = setup(dir);
      const started = await run(
        getTool("delegate_task"),
        { agent: "alpha", task: "t", expected_outcome: "artifact", must_do: ["m"], must_not_do: ["n"], context: "ctx", run_in_background: true },
        ctx,
      );
      const runId = (started.details as { runId: string }).runId;

      const running = await run(getTool("get_delegation_run"), { run_id: runId }, ctx);
      assert.match(running.content[0]!.text, new RegExp(runId));

      const awaited = await run(getTool("await_delegation_run"), { run_id: runId, timeout_ms: 2000 }, ctx);
      assert.match(awaited.content[0]!.text, /complete/);
      assert.equal((awaited.details as { status: string }).status, "complete");

      const done = await run(getTool("get_delegation_run"), { run_id: runId }, ctx);
      assert.equal((done.details as { status: string }).status, "complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("await_delegation_run reports not_found for an unknown id", async () => {
    const dir = tempRepo("notfound");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(getTool("await_delegation_run"), { run_id: "nope" }, ctx);
      assert.equal((result.details as { status: string }).status, "not_found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const fmtUsage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
const fmtBase: ChildResult = { agent: "alpha", task: "t", exitCode: 0, output: "", stderr: "", usage: fmtUsage };

describe("extension/tools: formatChildResultText (F4 model + F5 honest exit code)", () => {
  it("F4: shows Model when present and omits the line when absent", () => {
    assert.ok(formatChildResultText({ ...fmtBase, model: "openai/gpt-5.5" }).includes("Model: openai/gpt-5.5"));
    assert.ok(!formatChildResultText(fmtBase).includes("Model:"));
  });

  it("F5: preflight/config failures (no child spawned) report Exit code: n/a (preflight)", () => {
    const preflight = formatChildResultText({ ...fmtBase, failureKind: "preflight", gatePassed: false, gateErrors: ["Missing contract section: TASK"] });
    assert.ok(preflight.includes("Exit code: n/a (preflight)"));
    assert.ok(!preflight.includes("Exit code: 0"));
    const config = formatChildResultText({ ...fmtBase, failureKind: "config", gatePassed: false });
    assert.ok(config.includes("Exit code: n/a (preflight)"));
    assert.ok(!config.includes("Exit code: 0"));
  });

  it("F5: gate failure with empty output and exit 0 reports Exit code: n/a (gate failure)", () => {
    const text = formatChildResultText({ ...fmtBase, gatePassed: false, gateErrors: ["empty output"] });
    assert.ok(text.includes("Exit code: n/a (gate failure)"));
    assert.ok(!text.includes("Exit code: 0"));
  });

  it("F5: a child that actually ran shows its real exit code", () => {
    const crashed = formatChildResultText({ ...fmtBase, exitCode: 1, stderr: "boom" });
    assert.ok(crashed.includes("Exit code: 1"));
    const okChild = formatChildResultText({ ...fmtBase, model: "m", output: "done", gatePassed: true });
    assert.ok(okChild.includes("Exit code: 0"));
    assert.ok(okChild.includes("Model: m"));
  });

  it("F4: provider_quota renders the failure kind plus the actionable message", () => {
    const text = formatChildResultText({ ...fmtBase, exitCode: 1, stderr: "usage limit reached", failureKind: "provider_quota" });
    assert.ok(text.includes("Failure kind: provider_quota"));
    assert.ok(text.includes("Provider quota/rate limit reached — retry later or switch model."));
    assert.ok(text.includes("Exit code: 1"));
  });
});

describe("extension/tools: F4 provider_quota end to end through the engine", () => {
  it("stamps provider_quota + message on a child quota crash", async () => {
    const dir = tempRepo("quota");
    try {
      const quotaSpawn: SpawnFn = ({ cwd }) => {
        const script = 'process.stderr.write("Codex error: The usage limit has been reached\\n"); process.exit(1);';
        return spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      };
      const runtime = createSubagentsRuntime(dir, { spawn: quotaSpawn });
      const result = await runtime.engine.single("alpha", contractTask("quota crash"));
      assert.equal(result.exitCode, 1);
      assert.equal(result.failureKind, "provider_quota");
      assert.ok(result.errorMessage?.toLowerCase().includes("quota"));
      const text = formatChildResultText(result);
      assert.ok(text.includes("Failure kind: provider_quota"));
      assert.ok(text.includes("Provider quota/rate limit reached — retry later or switch model."));
      assert.ok(text.includes("Exit code: 1"));
      // Run view + ledger classification stay consistent (settleRun path).
      const view = runtime.engine.monitor.runs.find((candidate) => candidate.id === result.ledgerRunId);
      assert.equal(view?.failureKind, "provider_quota");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Fake child that first performs one toolCall (action feed), then answers
 *  with a compliant output-contract suffix (turn feed). */
function feedSpawn(): SpawnFn {
  const script = [
    'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { data += c; });',
    'process.stdin.on("end", () => {',
    '  const task = data.trim();',
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"toolCall", toolCall:{name:"read", arguments:{path:"calc.js"}}}], model:"gpt-5.5"}});',
    `  const out = "answer:" + task + ${JSON.stringify(SUFFIX)};`,
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5"}});',
    '  emit({type:"agent_settled"});',
    "  process.exit(0);",
    "});",
  ].join("\n");
  return ({ cwd }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
}

function setupWith(dir: string, spawnFn: SpawnFn): { ctx: SessionContext; getTool: (name: string) => ToolDefinition } {
  const runtime: SubagentsRuntime = createSubagentsRuntime(dir, { spawn: spawnFn });
  const { api, tools } = stubApi();
  registerTools(api, () => runtime);
  const ctx = fakeCtx(dir);
  const getTool = (name: string): ToolDefinition => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} not registered`);
    return tool;
  };
  return { ctx, getTool };
}

describe("extension/tools: child progress feed formatting", () => {
  it("formats the header line for turn events with model + token count", () => {
    const line = formatChildProgressLine({
      runId: "r1",
      agent: "explore",
      kind: "turn",
      detail: "assistant turn 2",
      turns: 2,
      model: "zai/glm-5.3",
      contextTokens: 12_400,
    });
    assert.equal(line, "▸ explore · turn 2 · zai/glm-5.3 · 12.4k tok");
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(2_100_000), "2.1M");
  });

  it("renders no standalone line for action/text events (actions live inside the feed block)", () => {
    assert.equal(formatChildProgressLine({ runId: "r1", agent: "explore", kind: "action", detail: "read calc.js", turns: 1 }), undefined);
    assert.equal(formatChildProgressLine({ runId: "r1", agent: "explore", kind: "text", detail: "partial answer…", turns: 1 }), undefined);
  });
});

describe("extension/tools: live feed multi-line blocks (makeChildEventFeed)", () => {
  const collect = (): { feed: (event: ChildProgressEvent) => void; updates: string[] } => {
    const updates: string[] = [];
    const feed = makeChildEventFeed((partial) => updates.push(partial.content[0]!.text));
    assert.ok(feed, "feed wired when onUpdate present");
    return { feed: feed!, updates };
  };

  it("first turn renders a self-contained header-only block (zero actions)", () => {
    const { feed, updates } = collect();
    feed({ runId: "r1", agent: "planner", kind: "turn", detail: "assistant turn 1", turns: 1, model: "zai/glm-5.3", contextTokens: 7_000 });
    assert.equal(updates.length, 1);
    assert.equal(updates[0], "▸ planner · turn 1 · zai/glm-5.3 · 7.0k tok");
  });

  it("after 3 actions the block shows an aligned tree, most recent closed by └─", () => {
    const { feed, updates } = collect();
    feed({ runId: "r1", agent: "planner", kind: "turn", detail: "t", turns: 1, model: "m" });
    feed({ runId: "r1", agent: "planner", kind: "action", detail: "read calc.js", turns: 1 });
    feed({ runId: "r1", agent: "planner", kind: "action", detail: "grep TODO src/", turns: 1 });
    feed({ runId: "r1", agent: "planner", kind: "action", detail: "ls .pi/agents", turns: 1 });
    assert.equal(updates.length, 4, "exactly one update per event");
    assert.equal(
      updates[3],
      ["▸ planner · turn 1 · m", "  ├─ read calc.js", "  ├─ grep TODO src/", "  └─ ls .pi/agents"].join("\n"),
    );
  });

  it("after 7 actions the sliding window keeps only the last 5", () => {
    const { feed, updates } = collect();
    feed({ runId: "r1", agent: "planner", kind: "turn", detail: "t", turns: 1 });
    for (let i = 1; i <= 7; i++) feed({ runId: "r1", agent: "planner", kind: "action", detail: `act ${i}`, turns: 1 });
    const block = updates[updates.length - 1]!;
    const lines = block.split("\n");
    assert.equal(lines.length, 6, "header + 5 actions only");
    assert.deepEqual(lines.slice(1), ["  ├─ act 3", "  ├─ act 4", "  ├─ act 5", "  ├─ act 6", "  └─ act 7"]);
    assert.ok(!block.includes("act 1") && !block.includes("act 2"), "oldest actions slid out");
  });

  it("turn 2 header carries model + tokens while the action window persists", () => {
    const { feed, updates } = collect();
    feed({ runId: "r1", agent: "planner", kind: "turn", detail: "t1", turns: 1 });
    feed({ runId: "r1", agent: "planner", kind: "action", detail: "read calc.js", turns: 1 });
    feed({ runId: "r1", agent: "planner", kind: "turn", detail: "t2", turns: 2, model: "zai/glm-5.3", contextTokens: 12_400 });
    assert.equal(
      updates[updates.length - 1],
      ["▸ planner · turn 2 · zai/glm-5.3 · 12.4k tok", "  └─ read calc.js"].join("\n"),
    );
  });

  it("kind=text never emits an update (anti per-token spam)", () => {
    const { feed, updates } = collect();
    feed({ runId: "r1", agent: "a", kind: "turn", detail: "t", turns: 1 });
    feed({ runId: "r1", agent: "a", kind: "text", detail: "partial answer…", turns: 1 });
    feed({ runId: "r1", agent: "a", kind: "action", detail: "bash ls", turns: 1 });
    assert.equal(updates.length, 2, "turn + action only — text skipped");
  });

  it("bounds each action detail to a hard width inside the block", () => {
    const { feed, updates } = collect();
    feed({ runId: "r1", agent: "a", kind: "turn", detail: "t", turns: 1 });
    feed({ runId: "r1", agent: "a", kind: "action", detail: "x".repeat(300), turns: 1 });
    const lines = updates[updates.length - 1]!.split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[1]!.length <= 66, `action line too long: ${lines[1]}`);
    assert.ok(lines[1]!.endsWith("…"));
  });

  it("strips the fresh-lane runId suffix from the agent name in the header", () => {
    const { feed, updates } = collect();
    feed({ runId: "delegate-x1", agent: "explore-delegate-x1", kind: "turn", detail: "t", turns: 1 });
    assert.match(updates[0]!, /^▸ explore · turn 1/);
    assert.ok(!updates[0]!.includes("delegate-x1"));
  });

  it("parallel runIds keep independent self-contained blocks", () => {
    const { feed, updates } = collect();
    feed({ runId: "r1", agent: "alpha", kind: "action", detail: "read a", turns: 1 });
    feed({ runId: "r2", agent: "beta", kind: "action", detail: "read b", turns: 1 });
    assert.equal(updates.length, 2);
    assert.match(updates[0]!, /^▸ alpha · turn 1/);
    assert.ok(updates[0]!.includes("└─ read a"));
    assert.match(updates[1]!, /^▸ beta · turn 1/);
    assert.ok(updates[1]!.includes("└─ read b"));
  });
});

describe("extension/tools: live child-actions feed during dispatch", () => {
  it("streams self-contained action-tree blocks into onUpdate while a single delegation runs", async () => {
    const dir = tempRepo("feed");
    try {
      const { ctx, getTool } = setupWith(dir, feedSpawn());
      const { promise, updates } = runWithUpdate(getTool("delegate_agent"), { agent: "alpha", task: contractTask("feed me") }, ctx);
      const result = await promise;
      // final result unchanged (output contract path)
      assert.ok(result.content[0]!.text.includes("deliverable_delivered: yes"));
      // LIVE: every update is one bounded self-contained block — header first
      // line + at most 5 aligned action-tree lines (no accumulation, no spam)
      const texts = updates.map((u) => u.content[0]!.text);
      for (const t of texts) {
        const lines = t.split("\n");
        assert.ok(lines.length <= 6, `block too tall: ${JSON.stringify(t)}`);
        assert.match(lines[0]!, /^▸ alpha/, `bad block header: ${t}`);
        for (const line of lines) assert.ok(line.length <= 120, `line too long: ${line}`);
      }
      // at least one block carries the live action tree, one the turn header
      assert.ok(texts.some((t) => t.includes("└─ read(")), `action tree missing in ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => /^▸ alpha · turn 1/.test(t)), `turn header missing in ${JSON.stringify(texts)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel mode emits the running line BEFORE the await, then per-child lines", async () => {
    const dir = tempRepo("feedpar");
    try {
      const { ctx, getTool } = setupWith(dir, feedSpawn());
      const { promise, updates } = runWithUpdate(
        getTool("delegate_agent"),
        { tasks: [{ agent: "alpha", task: contractTask("p1") }, { agent: "beta", task: contractTask("p2") }] },
        ctx,
      );
      const result = await promise;
      assert.match(result.content[0]!.text, /Parallel delegation: 2\/2 succeeded/);
      const texts = updates.map((u) => u.content[0]!.text);
      // the running notice is the FIRST update — emitted before the await (the
      // old call sat after the await and was dead)
      assert.equal(texts[0], "Parallel delegation running…");
      // both children streamed at least one live line
      assert.ok(texts.some((t) => t.startsWith("▸ alpha")), `alpha lines missing in ${JSON.stringify(texts)}`);
      assert.ok(texts.some((t) => t.startsWith("▸ beta")), `beta lines missing in ${JSON.stringify(texts)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("feed: false keeps the dispatch completely silent", async () => {
    const dir = tempRepo("feedoff");
    try {
      const { ctx, getTool } = setupWith(dir, feedSpawn());
      const { promise, updates } = runWithUpdate(getTool("delegate_agent"), { agent: "alpha", task: contractTask("quiet"), feed: false }, ctx);
      const result = await promise;
      assert.ok(result.content[0]!.text.includes("deliverable_delivered: yes"));
      assert.equal(updates.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: formatChildResultText Actions summary line", () => {
  it("summarizes the last 5 recorded actions on one bounded line", () => {
    const actions = ["read a.ts", "grep foo", "find src", "bash ls", "edit b.ts", "bash test", "read c.ts"];
    const text = formatChildResultText({ ...fmtBase, output: "done", actions });
    assert.match(text, /Actions \(7\): /);
    assert.ok(text.includes("edit b.ts · bash test · read c.ts"));
    assert.ok(!text.includes("read a.ts · grep foo"), "only the LAST actions are shown");
  });

  it("omits the Actions line when the engine recorded no actions", () => {
    assert.ok(!formatChildResultText({ ...fmtBase, output: "done" }).includes("Actions"));
  });
});

describe("extension/tools: get_delegation_run reason line", () => {
  it("surfaces the first gate error for a failed run", async () => {
    const dir = tempRepo("reason");
    try {
      const { ctx, getTool } = setup(dir);
      const failed = await run(getTool("delegate_agent"), { agent: "ghost", task: contractTask("boom") }, ctx);
      const runId = ((failed.details as { results: Array<{ ledgerRunId?: string }> }).results[0]!.ledgerRunId) ?? "";
      assert.ok(runId.length > 0);
      const got = await run(getTool("get_delegation_run"), { run_id: runId }, ctx);
      assert.match(got.content[0]!.text, /Reason: Unknown agent 'ghost'/);
      assert.equal((got.details as { status: string }).status, "preflight_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds no reason line for a clean complete run", async () => {
    const dir = tempRepo("reason2");
    try {
      const runtime = createSubagentsRuntime(dir, { spawn: compliantSpawn() });
      const engineRun = await runtime.engine.single("alpha", contractTask("clean run"));
      const { api, tools } = stubApi();
      registerTools(api, () => runtime);
      const ctx = fakeCtx(dir);
      const tool = tools.get("get_delegation_run")!;
      const got = await tool.execute("c", { run_id: engineRun.ledgerRunId! }, undefined, undefined, ctx);
      assert.ok(got.content[0]!.text.includes("complete"));
      assert.ok(!got.content[0]!.text.includes("Reason:"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: isolation exposure (C6)", () => {
  it("exposes the isolation enum in the delegate_task schema", () => {
    const isolation = (DELEGATE_TASK_PARAMS.properties as Record<string, { enum?: string[] }>).isolation;
    assert.deepEqual(isolation?.enum, ["none", "worktree"]);
  });

  it("plumbs isolation=worktree into the engine preflight (non-git repo blocked)", async () => {
    const dir = tempRepo("isol");
    try {
      const { ctx, getTool } = setup(dir);
      const result = await run(
        getTool("delegate_task"),
        {
          agent: "alpha",
          task: "t",
          expected_outcome: "artifact",
          must_do: ["m"],
          must_not_do: ["n"],
          context: "ctx",
          isolation: "worktree",
        },
        ctx,
      );
      // the engine-level worktree gate fired => the option reached the engine
      assert.match(result.content[0]!.text, /worktree isolation requires a git repository/);
      assert.ok(!result.content[0]!.text.includes("fatal:"), "no raw git stderr in the parent message");
      const details = result.details as { results: Array<{ failureKind?: string; worktreeError?: { kind: string; detail: string } }> };
      assert.equal(details.results[0]!.failureKind, "preflight");
      assert.equal(details.results[0]!.worktreeError?.kind, "non_git_repo", "classified worktree failure rides details");
      assert.ok(details.results[0]!.worktreeError?.detail, "bounded git detail available in details");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: catalog model_class", () => {
  it("shows model_class per agent in the delegation catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-ext-catmc-"));
    try {
      const agentsDir = join(dir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "scout.md"),
        "---\nname: scout\ndescription: scout agent\ntools: read\nmodel_class: cheap\n---\nYou are scout.",
        "utf8",
      );
      const { ctx, getTool } = setup(dir);
      const result = await run(getTool("zob_delegation_catalog"), {}, ctx);
      assert.ok(result.content[0]!.text.includes("model_class=cheap"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: F6 persistLedger default in createSubagentsRuntime", () => {
  it("persists the hash-only ledger + attestation sidecar under <repoRoot>/.pi/logs/runs by default", async () => {
    const dir = tempRepo("ledger");
    try {
      const runtime = createSubagentsRuntime(dir, { spawn: compliantSpawn() });
      const result = await runtime.engine.single("alpha", contractTask("ledger check"));
      assert.equal(result.exitCode, 0);
      const ledgerDir = join(dir, ".pi", "logs", "runs");
      const day = new Date().toISOString().slice(0, 10);
      const ledgerFile = join(ledgerDir, `${day}.jsonl`);
      assert.ok(existsSync(ledgerFile), "ledger day file must exist by default");
      const entries = readFileSync(ledgerFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.ok(entries.some((entry) => entry.event === "start" && entry.bodyStored === false));
      assert.ok(entries.some((entry) => entry.event === "end" && entry.status === "complete"));
      assert.ok(existsSync(join(ledgerDir, "attestations", `${result.ledgerRunId}.json`)), "attestation sidecar must exist by default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persistLedger: false disables ledger + attestation persistence", async () => {
    const dir = tempRepo("nolger");
    try {
      const runtime = createSubagentsRuntime(dir, { spawn: compliantSpawn(), persistLedger: false });
      const result = await runtime.engine.single("alpha", contractTask("no ledger"));
      assert.equal(result.exitCode, 0);
      assert.ok(!existsSync(join(dir, ".pi", "logs", "runs")), "no ledger dir when persistLedger is false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- cycle-5 fixes (P3/P5/P6)

/** Fake child that answers with a compliant suffix AND a message_end usage
 *  snapshot (input/output/cost), so run-level usage is non-zero. */
function usageSpawn(): SpawnFn {
  const script = [
    'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { data += c; });',
    'process.stdin.on("end", () => {',
    `  const out = "answer:" + data.trim() + ${JSON.stringify(SUFFIX)};`,
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5", provider:"openai-codex", usage:{input:900, output:140, cacheRead:3000, cacheWrite:0, totalTokens:1040, cost:{total:0.0012}}}});',
    '  emit({type:"agent_settled"});',
    "  process.exit(0);",
    "});",
  ].join("\n");
  return ({ cwd }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
}

describe("extension/tools: P3 ledger end events carry usage.output", () => {
  it("the persisted end event keeps the full numeric usage (like the attestation)", async () => {
    const dir = tempRepo("p3usage");
    try {
      const runtime = createSubagentsRuntime(dir, { spawn: usageSpawn() });
      const result = await runtime.engine.single("alpha", contractTask("usage ledger"));
      assert.equal(result.exitCode, 0);
      assert.equal(result.gatePassed !== false, true);
      const ledgerDir = join(dir, ".pi", "logs", "runs");
      const day = new Date().toISOString().slice(0, 10);
      const entries = readFileSync(join(ledgerDir, `${day}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const end = entries.find((entry) => entry.event === "end" && entry.runId === result.ledgerRunId) as { usage?: Record<string, unknown> } | undefined;
      assert.ok(end, "end event persisted");
      assert.equal(end!.usage?.output, 140, "usage.output token counter must survive in the ledger end event (P3)");
      assert.equal(end!.usage?.input, 900);
      assert.equal(end!.usage?.turns, 1);
      assert.equal(end!.usage?.cost, 0.0012);
      // The attestation sidecar keeps the same totals — no more divergence.
      const attestation = JSON.parse(readFileSync(join(ledgerDir, "attestations", `${result.ledgerRunId}.json`), "utf8")) as { usage?: { output?: number } };
      assert.equal(attestation.usage?.output, 140);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/tools: P5 delegate_task success returns formatChildResultText", () => {
  it("success text carries Agent/Model/Exit/Usage/Output, not the raw output only", async () => {
    const dir = tempRepo("p5fmt");
    try {
      const { ctx, getTool } = setupWith(dir, usageSpawn());
      const result = await run(
        getTool("delegate_task"),
        { agent: "alpha", task: "build a widget", expected_outcome: "an artifact", must_do: ["restate"], must_not_do: ["no destructive"], context: "Paths: reports/" },
        ctx,
      );
      const text = result.content[0]!.text;
      assert.ok(text.startsWith("Agent: alpha"), `formatted header expected:\n${text}`);
      assert.ok(text.includes("Model:"));
      assert.ok(text.includes("Exit code: 0"));
      assert.ok(text.includes("Usage: 1 turn · in 900 · out 140 · cost $0.0012"), `usage line expected:\n${text}`);
      assert.ok(text.includes("Output:"));
      assert.ok(text.includes("deliverable_delivered: yes"), "child deliverable still present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P5: formatChildResultText adds a usage line only for non-zero usage", () => {
    assert.ok(!formatChildResultText({ ...fmtBase, output: "done" }).includes("Usage:"), "all-zero usage stays silent");
    const withUsage = formatChildResultText({
      ...fmtBase,
      output: "done",
      usage: { turns: 3, input: 2100, output: 640, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2740 },
    });
    assert.ok(withUsage.includes("Usage: 3 turns · in 2.1k · out 640"));
  });
});

describe("extension/tools: P6 continue_run documents the six-part contract gate", () => {
  it("description + promptGuidelines state the required contract with an example", () => {
    const { api, tools } = stubApi();
    registerTools(api, () => {
      throw new Error("runtime not needed for a description assertion");
    });
    const tool = tools.get("continue_run");
    assert.ok(tool, "continue_run registered");
    const description: string = tool!.description;
    assert.ok(description.includes("six-part"), `contract requirement documented:\n${description}`);
    assert.ok(description.includes("1. TASK:"));
    assert.ok(description.includes("6. CONTEXT:"));
    assert.match(description, /REJECT/i);
    const rawGuidelines = tool!.promptGuidelines;
    const guidelines = (typeof rawGuidelines === "string" ? [rawGuidelines] : (rawGuidelines ?? [])).join("\n");
    assert.ok(guidelines.includes("FULL six-part contract"));
    assert.ok(guidelines.includes("4. MUST DO:"), `example format present:\n${guidelines}`);
    assert.ok(guidelines.includes("5. MUST NOT DO:"));
  });
});
