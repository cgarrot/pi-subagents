// test/engine/continue.test.ts — continueRun: resume a terminal run with its
// original session file + byte-offset, link continuedFromRunId, increment
// turnCount, and refuse non-terminal runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { markRunRunning, startDelegationRun } from "../../src/engine/runs.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-continue-${label}-`));
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

const COMPLIANT_SCRIPT = [
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

/** Spawner that records every child's args and runs a compliant echo child. */
function recordingSpawn(recorded: { args: string[][] }): SpawnFn {
  return ({ args, cwd, env }) => {
    recorded.args.push(args);
    return spawn(process.execPath, ["-e", COMPLIANT_SCRIPT], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

/** Spawner that fails on the first call (exit 3) then succeeds on later calls. */
function failThenSucceed(recorded: { args: string[][] }): SpawnFn {
  let calls = 0;
  return ({ args, cwd, env }) => {
    recorded.args.push(args);
    calls++;
    if (calls === 1) {
      return spawn(process.execPath, ["-e", "process.exit(3);"], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
    }
    return spawn(process.execPath, ["-e", COMPLIANT_SCRIPT], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

describe("engine/dispatch: continueRun", () => {
  it("reuses the same sessionPath, links continuedFromRunId, and increments turnCount", async () => {
    const dir = tempRepo("reuse");
    const recorded = { args: [] as string[][] };
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn(recorded), sessionDir: join(dir, "sessions"), source: "delegate_agent" });
      const first = await engine.single("alpha", contractTask("first"), { outputContract: "base.v1" });
      assert.equal(first.exitCode, 0);
      const firstRun = engine.monitor.runs[0]!;
      assert.equal(firstRun.status, "complete");
      assert.ok(firstRun.sessionPath, "first run must record a sessionPath");
      assert.equal(firstRun.turnCount, undefined, "a fresh run has no turnCount");

      const sessionPath = firstRun.sessionPath!;

      const continued = await engine.continueRun(firstRun.id, contractTask("continue"), { outputContract: "base.v1" });
      assert.equal(continued.exitCode, 0);

      const contRun = engine.monitor.runs.find((r) => r.id !== firstRun.id)!;
      assert.equal(contRun.status, "complete");
      assert.equal(contRun.continuedFromRunId, firstRun.id, "continuedFromRunId must link the original run");
      assert.equal(contRun.turnCount, 2, "turnCount must increment from the original");
      assert.equal(contRun.sessionPath, sessionPath, "continue must reuse the SAME sessionPath");

      // The continue spawn must carry --session <same path>; pi resumes the
      // session file AS-IS — the --session-offset flag does NOT exist in
      // pi >= 0.84 (Unknown option, exit 1) and must never be passed.
      const contArgs = recorded.args[1]!;
      const sessionIdx = contArgs.indexOf("--session");
      assert.ok(sessionIdx >= 0, "continue args must include --session");
      assert.equal(contArgs[sessionIdx + 1], sessionPath);
      assert.ok(!contArgs.includes("--session-offset"), "continue args must NOT include --session-offset");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues a failed (terminal) run and links continuedFromRunId", async () => {
    const dir = tempRepo("failed");
    const recorded = { args: [] as string[][] };
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: failThenSucceed(recorded), sessionDir: join(dir, "sessions"), source: "delegate_agent" });
      const first = await engine.single("alpha", contractTask("first"), { outputContract: "base.v1" });
      assert.equal(first.exitCode, 3);
      const firstRun = engine.monitor.runs[0]!;
      assert.equal(firstRun.status, "failed");
      assert.ok(firstRun.sessionPath, "failed run must still record a sessionPath");

      const continued = await engine.continueRun(firstRun.id, contractTask("continue"), { outputContract: "base.v1" });
      assert.equal(continued.exitCode, 0);
      const contRun = engine.monitor.runs.find((r) => r.id !== firstRun.id)!;
      assert.equal(contRun.status, "complete");
      assert.equal(contRun.continuedFromRunId, firstRun.id);
      assert.equal(contRun.turnCount, 2);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to continue a non-terminal run with a clear error", async () => {
    const dir = tempRepo("nonterminal");
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn({ args: [] }), sessionDir: join(dir, "sessions"), source: "delegate_agent" });
      // Manually register a running run (no sessionPath yet).
      startDelegationRun(engine.monitor, {
        id: "running-1",
        parentToolCallId: "p",
        source: "delegate_agent",
        mode: "single",
        agent: "alpha",
        task: contractTask("x"),
        startedAtMs: Date.now(),
      });
      markRunRunning(engine.monitor, "running-1");
      await assert.rejects(
        () => engine.continueRun("running-1", contractTask("continue"), { outputContract: "base.v1" }),
        /status is running, expected terminal/,
      );
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to continue an unknown run", async () => {
    const dir = tempRepo("unknown");
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn({ args: [] }), sessionDir: join(dir, "sessions"), source: "delegate_agent" });
      await assert.rejects(
        () => engine.continueRun("nope", contractTask("continue"), { outputContract: "base.v1" }),
        /Unknown run/,
      );
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
