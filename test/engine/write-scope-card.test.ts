// test/engine/write-scope-card.test.ts — F1 regression: the write-scope gate
// must see the child's EFFECTIVE tools — the union of the dispatch override
// and the agent card's declared allowlist. A write-capable card (write/edit in
// its frontmatter) dispatched WITHOUT allowed_paths must be rejected in
// preflight, BEFORE any spawn; a read-only tool override can never downgrade a
// write-capable card; a read-only card still dispatches without allowed_paths.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

/** Write-capable card fixture (F1 reproducer): tools include edit + write. */
const WRITE_CAPABLE_MD = `---
name: implementer
description: write-capable test agent
tools: read, bash, edit, write
---
You are implementer. Produce evidence.`;

/** Read-only card fixture: no write/edit tools. */
const READ_ONLY_MD = `---
name: explorer
description: read-only test agent
tools: read, bash
---
You are explorer. Produce evidence.`;

function tempRepo(label: string, cards: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-write-scope-${label}-`));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [fileName, md] of Object.entries(cards)) writeFileSync(join(agentsDir, `${fileName}.md`), md, "utf8");
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

/**
 * Spawn a compliant child (echoes the stdin task with a base.v1 deliverable
 * suffix, exits 0) while COUNTING how many children would be launched — the
 * spy proving that a blocked preflight never spawns.
 */
function compliantCountingSpawn(count: { value: number }): SpawnFn {
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
  return ({ cwd, env }) => {
    count.value += 1;
    return spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

describe("engine/dispatch: F1 write-scope gate sees effective tools (card ∪ override)", () => {
  it("write-capable agent card without allowed_paths -> preflight_failed, NO child spawned", async () => {
    const dir = tempRepo("card-block", { implementer: WRITE_CAPABLE_MD });
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantCountingSpawn(spawned),
        sessionDir: join(dir, "sessions"),
        source: "delegate_task",
      });
      const result = await engine.single("implementer", contractTask("edit a file"), { outputContract: "base.v1" });
      assert.equal(spawned.value, 0, "child must never be spawned when the write-capable card lacks allowed_paths");
      assert.equal(result.gatePassed, false);
      assert.equal(result.failureKind, "preflight");
      assert.match((result.gateErrors ?? []).join("; "), /write\/edit tools requires non-empty allowed_paths/);
      assert.equal(engine.monitor.runs[0]!.status, "preflight_failed");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a read-only tool override NEVER downgrades a write-capable card (still blocked without allowed_paths)", async () => {
    const dir = tempRepo("card-override", { implementer: WRITE_CAPABLE_MD });
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantCountingSpawn(spawned),
        sessionDir: join(dir, "sessions"),
        source: "delegate_task",
      });
      const result = await engine.single("implementer", contractTask("read only view"), { outputContract: "base.v1", tools: ["read"] });
      assert.equal(spawned.value, 0, "the card's write/edit tools must count even under a read-only override");
      assert.equal(result.gatePassed, false);
      assert.match((result.gateErrors ?? []).join("; "), /write\/edit tools requires non-empty allowed_paths/);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write-capable agent card WITH allowed_paths passes preflight and spawns the child", async () => {
    const dir = tempRepo("card-pass", { implementer: WRITE_CAPABLE_MD });
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantCountingSpawn(spawned),
        sessionDir: join(dir, "sessions"),
        source: "delegate_task",
      });
      const result = await engine.single("implementer", contractTask("edit a file"), { outputContract: "base.v1", allowedPaths: ["packages/"] });
      assert.equal(spawned.value, 1, "the child must be spawned once preflight passes");
      assert.equal(result.gatePassed, true);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes("deliverable_delivered: yes"));
      assert.equal(engine.monitor.runs[0]!.status, "complete");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read-only agent card without allowed_paths still dispatches (no over-blocking)", async () => {
    const dir = tempRepo("card-readonly", { explorer: READ_ONLY_MD });
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantCountingSpawn(spawned),
        sessionDir: join(dir, "sessions"),
        source: "delegate_task",
      });
      const result = await engine.single("explorer", contractTask("inspect only"), { outputContract: "base.v1" });
      assert.equal(spawned.value, 1);
      assert.equal(result.gatePassed, true);
      assert.equal(engine.monitor.runs[0]!.status, "complete");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
