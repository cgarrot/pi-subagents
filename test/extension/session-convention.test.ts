// test/extension/session-convention.test.ts — F8 wiring through the REAL
// extension runtime: delegate_task sessions land under the UNIFIED
// `.pi/agent-sessions/` dir (same convention as the LanePool default, the CLI
// doctor, and the README) with a FRESH per-run file `<agent>-<runId>.jsonl`;
// `fresh: false` restores the stable agent-named lane session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { createSubagentsRuntime, registerTools } from "../../src/extension/tools.js";
import { stubApi, toolCtx } from "./stub-api.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

const AGENT_MD = `---\nname: alpha\ndescription: test agent\ntools: read, bash\n---\nYou are alpha. Produce evidence.`;

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

function tempRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-conv-${label}-`));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "alpha.md"), AGENT_MD, "utf8");
  return dir;
}

/** Spawner that records every child's args and runs a compliant echo child. */
function recordingSpawn(recorded: { args: string[][] }): SpawnFn {
  return ({ args, cwd, env }) => {
    recorded.args.push(args);
    return spawn(process.execPath, ["-e", COMPLIANT_SCRIPT], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

/** Extract the `--session <path>` value from recorded child args. */
function sessionOf(args: string[]): string {
  const idx = args.indexOf("--session");
  assert.ok(idx >= 0, `--session missing from child args: ${args.join(" ")}`);
  return args[idx + 1]!;
}

function taskParams(task: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "alpha",
    task: `Do: ${task}`,
    context: "reports/",
    expected_outcome: "an artifact",
    must_do: ["Restate the task."],
    must_not_do: ["No destructive commands."],
    ...extra,
  };
}

describe("extension/session convention (F8): .pi/agent-sessions everywhere", () => {
  it("delegate_task writes fresh per-run sessions under .pi/agent-sessions/<agent>-<runId>.jsonl", async () => {
    const dir = tempRepo("fresh");
    const recorded = { args: [] as string[][] };
    try {
      const { api, tools } = stubApi();
      const rt = createSubagentsRuntime(dir, { spawn: recordingSpawn(recorded) });
      registerTools(api, () => rt);
      const delegate = tools.get("delegate_task")!;
      await delegate.execute("call-1", taskParams("first"), undefined, undefined, toolCtx(dir));
      await delegate.execute("call-2", taskParams("second"), undefined, undefined, toolCtx(dir));
      assert.equal(recorded.args.length, 2, "two children must have been spawned");
      const expectedDir = join(dir, ".pi", "agent-sessions");
      const s1 = sessionOf(recorded.args[0]!);
      const s2 = sessionOf(recorded.args[1]!);
      assert.ok(s1.startsWith(`${expectedDir}/`), `session must live under the unified ${expectedDir}: ${s1}`);
      assert.ok(s2.startsWith(`${expectedDir}/`), `session must live under the unified ${expectedDir}: ${s2}`);
      assert.match(basename(s1), /^alpha-delegate_\d+_[a-z0-9]+\.jsonl$/);
      assert.match(basename(s2), /^alpha-delegate_\d+_[a-z0-9]+\.jsonl$/);
      assert.notEqual(s1, s2, "successive delegate_task runs must use distinct per-run sessions");
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delegate_task fresh:false reuses the stable agent-named session across runs", async () => {
    const dir = tempRepo("legacy");
    const recorded = { args: [] as string[][] };
    try {
      const { api, tools } = stubApi();
      const rt = createSubagentsRuntime(dir, { spawn: recordingSpawn(recorded) });
      registerTools(api, () => rt);
      const delegate = tools.get("delegate_task")!;
      await delegate.execute("call-1", taskParams("legacy a", { fresh: false }), undefined, undefined, toolCtx(dir));
      await delegate.execute("call-2", taskParams("legacy b", { fresh: false }), undefined, undefined, toolCtx(dir));
      assert.equal(recorded.args.length, 2, "two children must have been spawned");
      const s1 = sessionOf(recorded.args[0]!);
      const s2 = sessionOf(recorded.args[1]!);
      assert.equal(basename(s1), "alpha.jsonl", "fresh:false must restore the agent-named lane session");
      assert.equal(s1, s2, "fresh:false must reuse the same stable session across runs");
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
