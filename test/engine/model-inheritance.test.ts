// test/engine/model-inheritance.test.ts — F3 parent-model inheritance +
// F2 verified-catalog (.pi/model-catalog.json) wiring through the runtime.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { createSubagentsRuntime, normalizeParentModelInput, type SubagentsRuntime } from "../../src/extension/tools.js";
import { modelCatalogPath, readVerifiedModelCatalog } from "../../src/extension/model-catalog-reader.js";
import { readPiDefaultModel } from "../../src/extension/settings-reader.js";
import { parentInheritingClassModels } from "../../src/models/index.js";
import type { EnabledModelsReader } from "../../src/models/index.js";
import type { SpawnFn, SpawnInput } from "../../src/lanes/spawn.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-model-${label}-`));
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

/** Compliant echo child (mirrors dispatch.test.ts). */
function compliantSpawn(): SpawnFn {
  const script = [
    "const emit = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { data += c; });',
    'process.stdin.on("end", () => {',
    "  const task = data.trim();",
    `  const out = "answer:" + task + ${JSON.stringify(SUFFIX)};`,
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"m", provider:"p"}});',
    '  emit({type:"agent_settled"});',
    "  process.exit(0);",
    "});",
  ].join("\n");
  return ({ cwd, env }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
}

/** Compliant spawn that records the child argv of every launch. */
function recordingSpawn(seen: string[][]): SpawnFn {
  const inner = compliantSpawn();
  return (input: SpawnInput) => {
    seen.push([...input.args]);
    return inner(input);
  };
}

/** Hermetic runtime: scope check skipped, model plumbing fully injected. */
const SKIP_SCOPE: EnabledModelsReader = { readEnabledModels: () => undefined };

function runtime(dir: string, args: string[][]): SubagentsRuntime {
  return createSubagentsRuntime(dir, { spawn: recordingSpawn(args), enabledModelsReader: SKIP_SCOPE, parentModel: "p/m" });
}

function writeCatalog(dir: string, value: unknown): void {
  writeFileSync(join(dir, ".pi", "model-catalog.json"), JSON.stringify(value), "utf8");
}

describe("F3: parent-model inheritance (engine wiring)", () => {
  it("a child without model/agent/class model inherits parentModel (spawned with --model parent)", async () => {
    const dir = tempRepo("inherit");
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        parentModel: "ollama-cloud/qwen3",
        spawn: recordingSpawn(args),
        sessionDir: join(dir, "s"),
      });
      const result = await engine.single("alpha", contractTask("build a widget"), { outputContract: "base.v1" });
      assert.equal(result.exitCode, 0);
      assert.equal(result.gatePassed, true);
      assert.equal(result.model, "ollama-cloud/qwen3", "child must run on the parent model");
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(run.model, "ollama-cloud/qwen3");
      assert.ok(args[0]!.includes("--model"), `spawn args must carry --model: ${JSON.stringify(args[0])}`);
      assert.equal(args[0]![args[0]!.indexOf("--model") + 1], "ollama-cloud/qwen3");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without parentModel the child spawns with NO --model flag (previous behavior preserved)", async () => {
    const dir = tempRepo("legacy");
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn(args), sessionDir: join(dir, "s") });
      const result = await engine.single("alpha", contractTask("x"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(args[0]!.includes("--model"), false, "no parent model -> no --model flag");
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F3: runtime defaults (createSubagentsRuntime)", () => {
  it("exposes the resolved parentModel and defaults every class to it (quota-safe)", async () => {
    const dir = tempRepo("class-default");
    const args: string[][] = [];
    try {
      const rt = runtime(dir, args);
      assert.equal(rt.parentModel, "p/m");
      for (const modelClass of ["cheap", "balanced", "capable"]) {
        const result = await rt.engine.single("alpha", contractTask(`class ${modelClass}`), {
          modelClass,
          outputContract: "base.v1",
        });
        assert.equal(result.model, "p/m", `class ${modelClass} must default to the parent model`);
      }
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an explicit classModels map REPLACES the parent-inheriting default", async () => {
    const dir = tempRepo("class-explicit");
    const args: string[][] = [];
    try {
      const rt = createSubagentsRuntime(dir, {
        spawn: recordingSpawn(args),
        enabledModelsReader: SKIP_SCOPE,
        parentModel: "p/m",
        classModels: { cheap: "cheap/m0" },
      });
      const cheap = await rt.engine.single("alpha", contractTask("cheap"), { modelClass: "cheap", outputContract: "base.v1" });
      assert.equal(cheap.model, "cheap/m0");
      // capable is unmapped in the explicit map -> falls back to parentModel.
      const capable = await rt.engine.single("alpha", contractTask("capable"), { modelClass: "capable", outputContract: "base.v1" });
      assert.equal(capable.model, "p/m");
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parentModelReader wins over the settings defaultModel; a broken reader degrades to it", async () => {
    const dir = tempRepo("reader-priority");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ defaultModel: "settings/m2" }), "utf8");
    try {
      const withReader = createSubagentsRuntime(dir, {
        parentModelReader: () => "reader/m1",
        enabledModelsReader: SKIP_SCOPE,
      });
      assert.equal(withReader.parentModel, "reader/m1");
      withReader.engine.close();
      const broken = createSubagentsRuntime(dir, {
        parentModelReader: () => {
          throw new Error("boom");
        },
        enabledModelsReader: SKIP_SCOPE,
      });
      assert.equal(broken.parentModel, "settings/m2", "broken reader must fall back to the settings defaultModel");
      broken.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPiDefaultModel: project tier wins over global; undefined when neither defines it", () => {
    const dir = tempRepo("settings-tiers");
    const projectPath = join(dir, "project-settings.json");
    const userPath = join(dir, "user-settings.json");
    try {
      writeFileSync(projectPath, JSON.stringify({ defaultModel: "project/m1" }), "utf8");
      writeFileSync(userPath, JSON.stringify({ defaultModel: "user/m0" }), "utf8");
      assert.equal(readPiDefaultModel(dir, { projectSettingsPath: projectPath, userSettingsPath: userPath }), "project/m1");
      rmSync(projectPath);
      assert.equal(readPiDefaultModel(dir, { projectSettingsPath: projectPath, userSettingsPath: userPath }), "user/m0");
      writeFileSync(userPath, JSON.stringify({ other: true }), "utf8");
      assert.equal(readPiDefaultModel(dir, { projectSettingsPath: projectPath, userSettingsPath: userPath }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parentInheritingClassModels maps all three classes, or nothing without a parent", () => {
    assert.deepEqual(parentInheritingClassModels("p/m"), { cheap: "p/m", balanced: "p/m", capable: "p/m" });
    assert.deepEqual(parentInheritingClassModels("   "), undefined);
    assert.deepEqual(parentInheritingClassModels(undefined), undefined);
  });
});

describe("F2: verified catalog (.pi/model-catalog.json) wiring", () => {
  it("an override listed in the catalog PASSES the gate and spawns with --model", async () => {
    const dir = tempRepo("catalog-pass");
    const args: string[][] = [];
    writeCatalog(dir, {
      schema: "zob.model-catalog.v1",
      models: { "ollama-cloud/deepseek-v4-flash:preview": { resolutionStatus: "verified" } },
    });
    try {
      const rt = runtime(dir, args);
      const result = await rt.engine.single("alpha", contractTask("flash task"), {
        model: "ollama-cloud/deepseek-v4-flash:preview",
        outputContract: "base.v1",
      });
      assert.equal(result.gatePassed, true);
      assert.equal(result.model, "ollama-cloud/deepseek-v4-flash:preview");
      const run = rt.engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(args[0]![args[0]!.indexOf("--model") + 1], "ollama-cloud/deepseek-v4-flash:preview");
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catalog absent -> override BLOCKED with remediation naming .pi/model-catalog.json, no spawn", async () => {
    const dir = tempRepo("catalog-missing");
    const args: string[][] = [];
    try {
      const rt = runtime(dir, args);
      const result = await rt.engine.single("alpha", contractTask("x"), {
        model: "ollama-cloud/deepseek-v4-flash:preview",
        outputContract: "base.v1",
      });
      assert.equal(result.gatePassed, false);
      assert.equal(result.failureKind, "config");
      assert.equal(args.length, 0, "no child may be spawned when the catalog is missing");
      const errors = (result.gateErrors ?? []).join(" ");
      assert.match(errors, /explicit model override/);
      assert.match(errors, /catalog is missing/);
      assert.match(errors, /\.pi\/model-catalog\.json/, "remediation must name the expected catalog path");
      assert.equal(rt.engine.monitor.runs[0]!.status, "preflight_failed");
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a catalog created mid-session is honored on the next dispatch (per-preflight read)", async () => {
    const dir = tempRepo("catalog-mid-session");
    const args: string[][] = [];
    try {
      const rt = runtime(dir, args);
      const blocked = await rt.engine.single("alpha", contractTask("x"), {
        model: "ollama-cloud/deepseek-v4-flash:preview",
        outputContract: "base.v1",
      });
      assert.equal(blocked.gatePassed, false);
      writeCatalog(dir, {
        schema: "zob.model-catalog.v1",
        models: { "ollama-cloud/deepseek-v4-flash:preview": { resolutionStatus: "verified" } },
      });
      const passed = await rt.engine.single("alpha", contractTask("x"), {
        model: "ollama-cloud/deepseek-v4-flash:preview",
        outputContract: "base.v1",
      });
      assert.equal(passed.gatePassed, true, "catalog edits must be honored without rebuilding the runtime");
      assert.equal(passed.model, "ollama-cloud/deepseek-v4-flash:preview");
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt catalog JSON blocks with a readError (never a crash, never a pass)", async () => {
    const dir = tempRepo("catalog-corrupt");
    const args: string[][] = [];
    writeFileSync(join(dir, ".pi", "model-catalog.json"), "{ not json", "utf8");
    try {
      const rt = runtime(dir, args);
      const result = await rt.engine.single("alpha", contractTask("x"), {
        model: "openai/gpt-4o",
        outputContract: "base.v1",
      });
      assert.equal(result.gatePassed, false);
      assert.match((result.gateErrors ?? []).join(" "), /could not be read as JSON/);
      assert.equal(args.length, 0);
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a catalog entry without resolutionStatus=verified still blocks", async () => {
    const dir = tempRepo("catalog-unverified");
    const args: string[][] = [];
    writeCatalog(dir, { models: { "openai/gpt-4o": { resolutionStatus: "resolved" } } });
    try {
      const rt = runtime(dir, args);
      const result = await rt.engine.single("alpha", contractTask("x"), { model: "openai/gpt-4o", outputContract: "base.v1" });
      assert.equal(result.gatePassed, false);
      assert.match((result.gateErrors ?? []).join(" "), /not 'verified'/);
      assert.equal(args.length, 0);
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readVerifiedModelCatalog: missing file -> present=false; valid file -> parsed models", () => {
    const dir = tempRepo("reader-unit");
    try {
      assert.deepEqual(readVerifiedModelCatalog(dir), { present: false });
      assert.equal(modelCatalogPath(dir), join(dir, ".pi", "model-catalog.json"));
      writeCatalog(dir, { models: { "a/b": { resolutionStatus: "verified" } } });
      const catalog = readVerifiedModelCatalog(dir);
      assert.equal(catalog.present, true);
      assert.equal(catalog.models?.["a/b"]?.resolutionStatus, "verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P1: parentModel object normalization (pi >= 0.84 ctx.model is a Model object)", () => {
  it("normalizeParentModelInput: object -> 'provider/id', string passthrough (trimmed), junk -> undefined — never a TypeError", () => {
    assert.equal(normalizeParentModelInput({ provider: "ollama-cloud", id: "deepseek-v4-flash:0731" }), "ollama-cloud/deepseek-v4-flash:0731");
    assert.equal(normalizeParentModelInput("  ollama-cloud/qwen3 "), "ollama-cloud/qwen3");
    assert.equal(normalizeParentModelInput(""), undefined);
    assert.equal(normalizeParentModelInput("   "), undefined);
    assert.equal(normalizeParentModelInput({ provider: "ollama-cloud", id: " " }), undefined);
    assert.equal(normalizeParentModelInput({ provider: "", id: "m" } as unknown as { provider: string; id: string }), undefined);
    assert.equal(normalizeParentModelInput({ provider: "no-id" } as unknown as { provider: string; id: string }), undefined);
    assert.equal(normalizeParentModelInput(undefined), undefined);
  });

  it("createSubagentsRuntime with a ctx.model OBJECT: parentModel inherited 'provider/id', child spawned with --model, no TypeError", async () => {
    const dir = tempRepo("p1-object");
    const args: string[][] = [];
    try {
      const rt = createSubagentsRuntime(dir, {
        spawn: recordingSpawn(args),
        enabledModelsReader: SKIP_SCOPE,
        parentModel: { provider: "ollama-cloud", id: "deepseek-v4-flash:0731" },
      });
      assert.equal(rt.parentModel, "ollama-cloud/deepseek-v4-flash:0731");
      const result = await rt.engine.single("alpha", contractTask("object parent model"), { outputContract: "base.v1" });
      assert.equal(result.exitCode, 0);
      assert.equal(result.gatePassed, true);
      assert.equal(result.model, "ollama-cloud/deepseek-v4-flash:0731");
      const argv = args[0]!;
      assert.equal(argv[argv.indexOf("--model") + 1], "ollama-cloud/deepseek-v4-flash:0731", `spawn argv must carry the normalized --model: ${JSON.stringify(argv)}`);
      rt.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("string parentModel unchanged and undefined falls back to the reader (no regression, no crash)", async () => {
    const dir = tempRepo("p1-string-undefined");
    const args: string[][] = [];
    try {
      const rtString = createSubagentsRuntime(dir, {
        spawn: recordingSpawn(args),
        enabledModelsReader: SKIP_SCOPE,
        parentModel: "ollama-cloud/qwen3",
      });
      assert.equal(rtString.parentModel, "ollama-cloud/qwen3");
      const result = await rtString.engine.single("alpha", contractTask("string parent"), { outputContract: "base.v1" });
      assert.equal(result.model, "ollama-cloud/qwen3");
      assert.equal(args[0]![args[0]!.indexOf("--model") + 1], "ollama-cloud/qwen3");

      const rtFallback = createSubagentsRuntime(dir, {
        enabledModelsReader: SKIP_SCOPE,
        parentModel: undefined,
        parentModelReader: () => "reader/m",
      });
      assert.equal(rtFallback.parentModel, "reader/m");
      rtString.engine.close();
      rtFallback.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
