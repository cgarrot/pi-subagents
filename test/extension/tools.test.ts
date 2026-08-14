// test/extension/tools.test.ts — the 5 tools wire onto the real engine
// (single/parallel/chain, structured delegate_task, background get/await,
// catalog) using a fake child spawner + a stub ExtensionAPI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition } from "../../src/extension/pi-types.js";
import { createSubagentsRuntime, registerTools, type SubagentsRuntime } from "../../src/extension/tools.js";
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
