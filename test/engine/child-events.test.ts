// test/engine/child-events.test.ts — engine-level onChildEvent plumbing
// (per-run option forwarded to the LanePool with runId+agent filled,
// engine-level fallback, parallel batch forwarding) and the FINAL OUTPUT
// CONTRACT marker line appended to the agent system prompt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import type { ChildProgressEvent } from "../../src/engine/index.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha", "beta"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-events-${label}-`));
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

/** Child emitting one toolCall turn then a compliant final assistant turn. */
const TOOLCALL_SCRIPT = [
  "const emit = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
  'let data = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (c) => { data += c; });',
  'process.stdin.on("end", () => {',
  '  emit({type:"message_end", message:{role:"assistant", content:[',
  '    {type:"toolCall", toolCall:{id:"t1", name:"bash", arguments:{command:"ls"}}}],',
  '    model:"gpt-5.5", provider:"openai-codex"}});',
  `  const out = "answer:" + data.trim() + ${JSON.stringify(SUFFIX)};`,
  '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5", provider:"openai-codex",',
  '    usage:{input:10, output:5, cacheRead:0, cacheWrite:0, totalTokens:15, cost:{total:0.001}}}});',
  '  emit({type:"agent_settled"});',
  "  process.exit(0);",
  "});",
].join("\n");

/** Spawner recording child args and running the toolCall-echo child. */
function recordingSpawn(recorded: { args: string[][] }): SpawnFn {
  return ({ args, cwd, env }) => {
    recorded.args.push(args);
    return spawn(process.execPath, ["-e", TOOLCALL_SCRIPT], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

/** Extract the `--append-system-prompt` value from recorded child args. */
function systemPromptOf(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  const index = args.indexOf("--append-system-prompt");
  return index === -1 ? undefined : args[index + 1];
}

describe("engine/dispatch: onChildEvent plumbing", () => {
  it("per-run onChildEvent receives turn+action events with runId+agent filled", async () => {
    const dir = tempRepo("perrun");
    const recorded = { args: [] as string[][] };
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(recorded),
        sessionDir: join(dir, "sessions"),
        source: "delegate_agent",
      });
      const events: ChildProgressEvent[] = [];
      const result = await engine.single("alpha", contractTask("feed me"), {
        outputContract: "base.v1",
        runId: "delegate-run-events-1",
        onChildEvent: (event) => events.push(event),
      });
      engine.close();

      assert.equal(result.exitCode, 0);
      assert.ok(result.ledgerRunId);
      assert.deepEqual(result.actions, ['bash({"command":"ls"})']);

      const action = events.find((event) => event.kind === "action");
      assert.ok(action, "action event expected");
      assert.equal(action.runId, result.ledgerRunId);
      assert.equal(action.agent, "alpha");
      assert.equal(action.detail, 'bash({"command":"ls"})');

      const turns = events.filter((event) => event.kind === "turn");
      assert.equal(turns.length, 2, "one turn event per assistant message_end");
      assert.equal(turns[1]!.detail, "assistant turn 2");
      assert.equal(turns[1]!.turns, 2);
      assert.equal(turns[1]!.model, "openai-codex/gpt-5.5");
      assert.equal(turns[1]!.contextTokens, 15);

      // Cycle-4 live usage: every turn event patched a live snapshot onto the
      // run view (tokens visible in widgets DURING the run; settle keeps
      // authority via `usage`).
      const run = engine.monitor.runs.find((candidate) => candidate.id === result.ledgerRunId);
      assert.ok(run);
      assert.equal(run.liveUsage?.turns, 2);
      assert.equal(run.liveUsage?.contextTokens, 15);
      assert.equal(run.liveUsage?.model, "openai-codex/gpt-5.5");
      // Settle stays authoritative: the settled usage is the cumulative total.
      assert.equal(run.usage?.input, 10);
      assert.equal(run.usage?.output, 5);
      assert.equal(run.usage?.contextTokens, 15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("engine-level onChildEvent is the fallback when the run sets none", async () => {
    const dir = tempRepo("enginelevel");
    try {
      const events: ChildProgressEvent[] = [];
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn({ args: [] }),
        sessionDir: join(dir, "sessions"),
        source: "delegate_agent",
        onChildEvent: (event) => events.push(event),
      });
      const result = await engine.single("alpha", contractTask("fallback"), { outputContract: "base.v1" });
      engine.close();

      assert.equal(result.exitCode, 0);
      assert.ok(events.some((event) => event.kind === "action"));
      assert.ok(events.some((event) => event.kind === "turn"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel batch onChildEvent is forwarded to every task's run", async () => {
    const dir = tempRepo("parallel");
    try {
      const events: ChildProgressEvent[] = [];
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn({ args: [] }),
        sessionDir: join(dir, "sessions"),
        source: "delegate_agent",
      });
      const details = await engine.parallel(
        [
          { agent: "alpha", task: contractTask("p1"), outputContract: "base.v1" },
          { agent: "beta", task: contractTask("p2"), outputContract: "base.v1" },
        ],
        { concurrency: 2, onChildEvent: (event) => events.push(event) },
      );
      engine.close();

      assert.equal(details.mode, "parallel");
      const agents = new Set(events.map((event) => event.agent));
      assert.ok(agents.has("alpha") && agents.has("beta"), "both tasks must feed events");
      assert.ok(events.every((event) => event.runId));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/dispatch: live usage recording (cycle 4)", () => {
  /** Child emitting one turn, WAITING, then the final turn + settle. */
  const DELAYED_SCRIPT = [
    "const emit = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
    "let data = \"\";",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (c) => { data += c; });",
    "process.stdin.on(\"end\", () => {",
    "  emit({type:\"message_end\", message:{role:\"assistant\", content:[{type:\"text\",text:\"first\"}], model:\"gpt-5.5\", provider:\"openai-codex\"}});",
    "  setTimeout(() => {",
    "    const out = \"answer:\" + data.trim() + " + JSON.stringify(SUFFIX) + ";",
    "    emit({type:\"message_end\", message:{role:\"assistant\", content:[{type:\"text\",text:out}], model:\"gpt-5.5\", provider:\"openai-codex\",",
    "      usage:{input:10, output:5, cacheRead:0, cacheWrite:0, totalTokens:15, cost:{total:0.001}}}});",
    "    emit({type:\"agent_settled\"});",
    "    process.exit(0);",
    "  }, 300);",
    "});",
  ].join("\n");

  it("patches liveUsage on the run view WHILE the child is still running", async () => {
    const dir = tempRepo("liveusage");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: ({ cwd, env }) =>
          spawn(process.execPath, ["-e", DELAYED_SCRIPT], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env }),
        sessionDir: join(dir, "sessions"),
        source: "delegate_agent",
      });
      const dispatched = engine.single("alpha", contractTask("stream tokens"), {
        outputContract: "base.v1",
        runId: "delegate-live-1",
      });

      // Poll the monitor while the child sleeps between its two turns.
      const deadline = Date.now() + 5_000;
      let seenMidRun: { turns: number; model?: string } | undefined;
      while (Date.now() < deadline) {
        const run = engine.monitor.runs.find((candidate) => candidate.id === "delegate-live-1");
        if (run?.liveUsage) {
          seenMidRun = { turns: run.liveUsage.turns, model: run.liveUsage.model };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(seenMidRun, "liveUsage must be visible on the monitor DURING the run");
      assert.equal(seenMidRun.turns, 1, "first assistant turn streamed live");
      assert.equal(seenMidRun.model, "openai-codex/gpt-5.5");

      const result = await dispatched;
      engine.close();
      assert.equal(result.exitCode, 0);
      const run = engine.monitor.runs.find((candidate) => candidate.id === "delegate-live-1");
      assert.equal(run?.status, "complete");
      assert.equal(run?.liveUsage?.turns, 2, "last live snapshot carried the final turn");
      assert.equal(run?.usage?.contextTokens, 15, "settle stays authoritative");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/dispatch: output-contract marker prompt injection", () => {
  it("appends the FINAL OUTPUT CONTRACT line (card prompt first) to the agent system prompt", async () => {
    const dir = tempRepo("markers");
    const recorded = { args: [] as string[][] };
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(recorded),
        sessionDir: join(dir, "sessions"),
        source: "delegate_agent",
      });
      const result = await engine.single("alpha", contractTask("emit markers"), { outputContract: "base.v1" });
      engine.close();

      assert.equal(result.exitCode, 0);
      assert.equal(result.gatePassed, true);
      const prompt = systemPromptOf(recorded.args[0]);
      assert.ok(prompt, "expected --append-system-prompt in child args");
      assert.ok(prompt!.startsWith("You are alpha."), "card prompt stays first");
      assert.ok(prompt!.includes("FINAL OUTPUT CONTRACT:"), "marker instruction appended");
      assert.ok(prompt!.includes("output contract base.v1"), "contract id named");
      assert.ok(prompt!.includes("deliverable_delivered: yes"), "final marker spelled out");
      assert.ok(prompt!.includes("evidence, risks_blockers, compliance"), "required sections listed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
