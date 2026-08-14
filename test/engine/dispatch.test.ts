// test/engine/dispatch.test.ts — preflight-gated single/parallel/chain dispatch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DispatchEngine, mapWithConcurrency } from "../../src/engine/dispatch.js";
import { summarizeDelegations } from "../../src/engine/monitor.js";
import { catalogFromParsed } from "../../src/models/catalog.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";
import type { ChildResult } from "../../src/core/types.js";

const FAKE_PI = fileURLToPath(new URL("../../../test/fixtures/bin/fake-pi.mjs", import.meta.url));

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha", "beta"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-dispatch-${label}-`));
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

/**
 * Spawn a child that echoes the received stdin task wrapped in a base.v1
 * compliant suffix, then exits 0. The task is reflected in the output so tests
 * can observe `{previous}` substitution in chain dispatch while the final line
 * satisfies the output contract's deliverable marker.
 */
function compliantSpawn(): SpawnFn {
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

/** Spawner that just counts how many children would be launched. */
function countingSpawn(count: { value: number }): SpawnFn {
  return ({ args, cwd, env }) => {
    count.value += 1;
    return spawn(process.execPath, [FAKE_PI, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

describe("engine/dispatch: mapWithConcurrency cap", () => {
  it("never exceeds the configured concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return n * 2;
    });
    assert.ok(maxActive <= 2, `maxActive was ${maxActive}`);
    assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16]);
  });
});

describe("engine/dispatch: runSingle full flow", () => {
  it("runs preflight -> lane -> complete with a recorded monitor run", async () => {
    const dir = tempRepo("single");
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: compliantSpawn(), sessionDir: join(dir, "sessions"), source: "delegate_task" });
      const result = await engine.single("alpha", contractTask("build a widget"), { outputContract: "base.v1" });
      assert.equal(result.exitCode, 0);
      assert.equal(result.gatePassed, true);
      assert.ok(result.output.includes("deliverable_delivered: yes"));
      assert.equal(result.agent, "alpha");
      assert.equal(summarizeDelegations(engine.monitor).complete, 1);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records agent/model/exitCode/outputHash/duration on the run view", async () => {
    const dir = tempRepo("view");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        verifiedCatalog: catalogFromParsed({ models: { "openai/gpt-5.5": { resolutionStatus: "verified" } } }),
      });
      await engine.single("alpha", contractTask("do work"), { model: "openai/gpt-5.5", outputContract: "base.v1" });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(run.agent, "alpha");
      assert.equal(run.model, "openai/gpt-5.5");
      assert.equal(run.exitCode, 0);
      assert.ok(run.outputHash, "outputHash must be set");
      assert.equal(typeof run.durationMs, "number");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/dispatch: preflight gates block BEFORE any spawn", () => {
  it("invalid six-part contract -> preflight_failed, NO child launched", async () => {
    const dir = tempRepo("preflight");
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({ repoRoot: dir, spawn: countingSpawn(spawned), sessionDir: join(dir, "s"), source: "delegate_task" });
      const result = await engine.single("alpha", "no contract here at all");
      assert.equal(spawned.value, 0, "child must never be spawned on preflight failure");
      assert.equal(result.failureKind, "preflight");
      assert.equal(result.gatePassed, false);
      assert.ok((result.contractErrors ?? []).length > 0);
      assert.equal(engine.monitor.runs[0]!.status, "preflight_failed");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown agent -> preflight_failed with failureKind config, NO child launched", async () => {
    const dir = tempRepo("unknown-agent");
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({ repoRoot: dir, spawn: countingSpawn(spawned), sessionDir: join(dir, "s"), source: "delegate_agent" });
      const result = await engine.single("ghost", contractTask("x"), { outputContract: "base.v1" });
      assert.equal(spawned.value, 0);
      assert.equal(result.failureKind, "config");
      assert.match((result.contractErrors ?? [])[0] ?? "", /Unknown agent/);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicit model NOT in the verified catalog -> preflight_failed config, NO child", async () => {
    const dir = tempRepo("model-gate");
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: countingSpawn(spawned),
        sessionDir: join(dir, "s"),
        verifiedCatalog: catalogFromParsed({ models: {} }), // empty catalog
      });
      const result = await engine.single("alpha", contractTask("x"), { model: "openai/gpt-4o", outputContract: "base.v1" });
      assert.equal(spawned.value, 0, "explicit model gate must block before spawn");
      assert.equal(result.failureKind, "config");
      assert.match((result.contractErrors ?? [])[0] ?? "", /explicit model override/);
      assert.equal(engine.monitor.runs[0]!.status, "preflight_failed");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write/edit tools without allowed_paths -> preflight_failed", async () => {
    const dir = tempRepo("write-scope");
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({ repoRoot: dir, spawn: countingSpawn(spawned), sessionDir: join(dir, "s"), source: "delegate_task" });
      const result = await engine.single("alpha", contractTask("x"), { tools: ["write", "edit"], outputContract: "base.v1" });
      assert.equal(spawned.value, 0);
      assert.match((result.contractErrors ?? []).join(" "), /allowed_paths/);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/dispatch: runParallel", () => {
  it("dispatches all tasks with a concurrency cap and records a run per task", async () => {
    const dir = tempRepo("parallel");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "s"),
        maxParallel: 2,
        source: "delegate_agent",
      });
      const details = await engine.parallel([
        { agent: "alpha", task: contractTask("a"), outputContract: "base.v1" },
        { agent: "beta", task: contractTask("b"), outputContract: "base.v1" },
        { agent: "alpha", task: contractTask("c"), outputContract: "base.v1" },
      ]);
      assert.equal(details.mode, "parallel");
      assert.equal(details.results.length, 3);
      assert.equal(details.results.every((r) => r.exitCode === 0 && r.gatePassed), true);
      assert.deepEqual(details.agents, ["alpha", "beta", "alpha"]);
      const summary = summarizeDelegations(engine.monitor);
      assert.equal(summary.complete, 3);
      assert.equal(summary.total, 3);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/dispatch: runChain with {previous} substitution", () => {
  it("replaces {previous} with the prior step output and reuses the same sessionPath", async () => {
    const dir = tempRepo("chain", ["alpha"]);
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        source: "delegate_agent",
      });
      const details = await engine.chain([
        { agent: "alpha", task: contractTask("step one: alpha"), outputContract: "base.v1" },
        { agent: "alpha", task: contractTask("step two uses: {previous}"), outputContract: "base.v1" },
      ]);
      assert.equal(details.results.length, 2);
      const [r1, r2] = details.results as [ChildResult, ChildResult];
      // {previous} substituted => step 2's dispatched output embeds step 1 output.
      assert.ok(r2.output.includes(r1.output.trim()), "step 2 must embed the previous step output");
      // Same lane => same sessionPath for context continuity.
      assert.ok(r1.sessionPath && r2.sessionPath, "session paths expected");
      assert.equal(r1.sessionPath, r2.sessionPath);
      assert.equal(summarizeDelegations(engine.monitor).complete, 2);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/dispatch: C3 model scope in preflight", () => {
  /** Repo whose alpha agent declares a frontmatter model. */
  function tempRepoWithAgentModel(label: string, agentModel: string): string {
    const dir = mkdtempSync(join(tmpdir(), `pi-subagents-scope-${label}-`));
    const agentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "alpha.md"),
      `---\nname: alpha\ndescription: test agent\ntools: read, bash\nmodel: ${agentModel}\n---\nYou are alpha. Produce evidence.`,
      "utf8",
    );
    return dir;
  }

  const ALLOW = ["openai/gpt-5.5"];
  const readerOf = (list?: string[]) => ({ readEnabledModels: () => list });

  it("explicit model out-of-scope -> preflight_failed config, NO child launched", async () => {
    const dir = tempRepo("scope-explicit");
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: countingSpawn(spawned),
        sessionDir: join(dir, "s"),
        // Catalog VERIFIES the model, so only the scope gate can reject it.
        verifiedCatalog: catalogFromParsed({ models: { "anthropic/claude": { resolutionStatus: "verified" } } }),
        enabledModelsReader: readerOf(ALLOW),
      });
      const result = await engine.single("alpha", contractTask("x"), { model: "anthropic/claude", outputContract: "base.v1" });
      assert.equal(spawned.value, 0, "explicit out-of-scope model must block before spawn");
      assert.equal(result.gatePassed, false);
      assert.equal(result.failureKind, "config");
      assert.match((result.gateErrors ?? []).join(" "), /enabledModels/);
      assert.equal(engine.monitor.runs[0]!.status, "preflight_failed");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent-declared model out-of-scope -> warn recorded on the run view, run completes", async () => {
    const dir = tempRepoWithAgentModel("scope-agent", "agent/m1");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        enabledModelsReader: readerOf(ALLOW),
      });
      const result = await engine.single("alpha", contractTask("x"), { outputContract: "base.v1" });
      assert.equal(result.exitCode, 0);
      assert.equal(result.gatePassed, true, "warn must never block");
      assert.equal(result.failureKind, undefined);
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(run.warnings?.length, 1);
      assert.match(run.warnings?.[0] ?? "", /agent\/m1/);
      assert.match(run.warnings?.[0] ?? "", /source agent/);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("class-resolved model out-of-scope -> warn (non-blocking)", async () => {
    const dir = tempRepo("scope-class");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        classModels: { capable: "class/m7" },
        enabledModelsReader: readerOf(ALLOW),
      });
      const result = await engine.single("alpha", contractTask("x"), { modelClass: "capable", outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.match(run.warnings?.[0] ?? "", /source class/);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inherited parent model out-of-scope -> warn (non-blocking)", async () => {
    const dir = tempRepo("scope-inherited");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        parentModel: "parent/m9",
        enabledModelsReader: readerOf(ALLOW),
      });
      const result = await engine.single("alpha", contractTask("x"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.match(run.warnings?.[0] ?? "", /source inherited/);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no reader configured -> scope check skipped, no warnings", async () => {
    const dir = tempRepo("scope-skip");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        parentModel: "parent/m9",
      });
      const result = await engine.single("alpha", contractTask("x"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(run.warnings, undefined);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty allowlist from the reader -> skip (no-op safety)", async () => {
    const dir = tempRepo("scope-empty");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        parentModel: "parent/m9",
        enabledModelsReader: readerOf([]),
      });
      const result = await engine.single("alpha", contractTask("x"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(engine.monitor.runs[0]!.warnings, undefined);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicit in-scope model -> completes with no warnings", async () => {
    const dir = tempRepo("scope-inscope");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        verifiedCatalog: catalogFromParsed({ models: { "openai/gpt-5.5": { resolutionStatus: "verified" } } }),
        enabledModelsReader: readerOf(ALLOW),
      });
      const result = await engine.single("alpha", contractTask("x"), { model: "openai/gpt-5.5", outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(run.model, "openai/gpt-5.5");
      assert.equal(run.warnings, undefined);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throwing reader degrades to skip (never a dispatch crash)", async () => {
    const dir = tempRepo("scope-throw");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: compliantSpawn(),
        sessionDir: join(dir, "sessions"),
        parentModel: "parent/m9",
        enabledModelsReader: { readEnabledModels: () => { throw new Error("boom"); } },
      });
      const result = await engine.single("alpha", contractTask("x"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(engine.monitor.runs[0]!.warnings, undefined);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
