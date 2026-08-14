// test/engine/provider-extensions.test.ts — P2 provider-extension (-e) wiring:
// children spawn `--no-extensions`; when the RESOLVED child model's provider
// has a known extension, the spawn argv gains `-e <path>` (custom providers
// like ollama-cloud otherwise crash in the child with 'Model not found').
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import {
  buildProviderExtensionResolver,
  defaultOllamaCloudExtensionPath,
  providerOfModel,
} from "../../src/models/provider-extensions.js";
import type { EnabledModelsReader } from "../../src/models/index.js";
import type { SpawnFn, SpawnInput } from "../../src/lanes/spawn.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-provext-${label}-`));
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

/** Compliant echo child (mirrors model-inheritance.test.ts). */
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

/** Hermetic runtime: scope check skipped. */
const SKIP_SCOPE: EnabledModelsReader = { readEnabledModels: () => undefined };

/** Value following `flag` in the first recorded argv (undefined = absent). */
function argvOf(args: string[][], flag: string): string | undefined {
  const argv = args[0]!;
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

describe("P2 unit: providerOfModel", () => {
  it("extracts the provider prefix of 'provider/model'", () => {
    assert.equal(providerOfModel("ollama-cloud/deepseek-v4-flash:0731"), "ollama-cloud");
    assert.equal(providerOfModel(" ollama-cloud/qwen3 "), "ollama-cloud");
  });

  it("builtin/bare ids (no slash, leading slash, empty) carry no provider", () => {
    assert.equal(providerOfModel("qwen3-builtin"), undefined);
    assert.equal(providerOfModel("/leading-slash"), undefined);
    assert.equal(providerOfModel(undefined), undefined);
    assert.equal(providerOfModel("   "), undefined);
  });
});

describe("P2 unit: buildProviderExtensionResolver", () => {
  it("default map: ollama-cloud -> ~/pi-provider-ollama-cloud/src/index.ts ONLY when it exists", () => {
    const present = buildProviderExtensionResolver(undefined, { home: "/home/u", exists: () => true });
    assert.equal(present("ollama-cloud"), defaultOllamaCloudExtensionPath("/home/u"));
    assert.equal(defaultOllamaCloudExtensionPath("/home/u"), join("/home/u", "pi-provider-ollama-cloud", "src", "index.ts"));
    const guarded = buildProviderExtensionResolver(undefined, { home: "/home/u", exists: () => false });
    assert.equal(guarded("ollama-cloud"), undefined, "existsSync guard must suppress the default (no dead hard-coded path)");
  });

  it("config map entries win over the default and are exists-guarded; unknown providers get nothing", () => {
    const resolver = buildProviderExtensionResolver({ "my-cloud": "/e/my.ts" }, { exists: (p) => p === "/e/my.ts" });
    assert.equal(resolver("my-cloud"), "/e/my.ts");
    assert.equal(resolver("ollama-cloud"), undefined);
    assert.equal(resolver("other-cloud"), undefined);
    const missing = buildProviderExtensionResolver({ "my-cloud": "/e/missing.ts" }, { exists: () => false });
    assert.equal(missing("my-cloud"), undefined, "a configured path that does not exist is never injected");
  });

  it("empty provider string resolves to nothing", () => {
    const resolver = buildProviderExtensionResolver({}, { exists: () => true });
    assert.equal(resolver("   "), undefined);
  });
});

describe("P2 engine: provider extension injected into the child spawn argv", () => {
  it("resolved model with a known provider -> spawn argv contains -e <extension>", async () => {
    const dir = tempRepo("ext-known");
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(args),
        sessionDir: join(dir, "s"),
        parentModel: "ollama-cloud/qwen3",
        providerExtensions: (provider) => (provider === "ollama-cloud" ? "/ext/pi-provider-ollama-cloud.ts" : undefined),
      });
      const result = await engine.single("alpha", contractTask("provider ext"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(result.model, "ollama-cloud/qwen3");
      assert.equal(argvOf(args, "-e"), "/ext/pi-provider-ollama-cloud.ts", `argv must carry -e <provider ext>: ${JSON.stringify(args[0])}`);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builtin model (no provider) -> NO -e flag in argv", async () => {
    const dir = tempRepo("ext-builtin");
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(args),
        sessionDir: join(dir, "s"),
        parentModel: "qwen3-builtin",
        providerExtensions: () => "/ext/should-not-appear.ts",
      });
      const result = await engine.single("alpha", contractTask("builtin model"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(argvOf(args, "-e"), undefined, `builtin model must spawn WITHOUT -e: ${JSON.stringify(args[0])}`);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("provider with no extension mapping -> NO -e flag in argv", async () => {
    const dir = tempRepo("ext-unmapped");
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(args),
        sessionDir: join(dir, "s"),
        parentModel: "openai/gpt-4o",
        providerExtensions: () => undefined,
      });
      const result = await engine.single("alpha", contractTask("unmapped provider"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(argvOf(args, "-e"), undefined, `unknown provider must spawn WITHOUT -e: ${JSON.stringify(args[0])}`);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default resolver reads .subagents/config.json providerExtensions (exists-guarded, no injection needed)", async () => {
    const dir = tempRepo("ext-config");
    const extPath = join(dir, "provider-ext.ts");
    mkdirSync(join(dir, ".subagents"), { recursive: true });
    writeFileSync(join(dir, ".subagents", "config.json"), JSON.stringify({ providerExtensions: { "my-cloud": extPath } }), "utf8");
    writeFileSync(extPath, "// fake provider extension entry\n", "utf8");
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(args),
        sessionDir: join(dir, "s"),
        parentModel: "my-cloud/m1",
      });
      const result = await engine.single("alpha", contractTask("config mapped provider"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(argvOf(args, "-e"), extPath, `config-mapped provider must spawn with -e <configured path>: ${JSON.stringify(args[0])}`);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config entry pointing at a MISSING file -> no -e (existsSync guard on config paths too)", async () => {
    const dir = tempRepo("ext-config-missing");
    mkdirSync(join(dir, ".subagents"), { recursive: true });
    writeFileSync(
      join(dir, ".subagents", "config.json"),
      JSON.stringify({ providerExtensions: { "ghost-cloud": join(dir, "does-not-exist.ts") } }),
      "utf8",
    );
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(args),
        sessionDir: join(dir, "s"),
        parentModel: "ghost-cloud/m1",
      });
      const result = await engine.single("alpha", contractTask("ghost provider"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(argvOf(args, "-e"), undefined, `a configured-but-missing path must NOT be injected: ${JSON.stringify(args[0])}`);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throwing resolver degrades to no extension (never a dispatch crash)", async () => {
    const dir = tempRepo("ext-throwing");
    const args: string[][] = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(args),
        sessionDir: join(dir, "s"),
        parentModel: "ollama-cloud/qwen3",
        providerExtensions: () => {
          throw new Error("resolver boom");
        },
      });
      const result = await engine.single("alpha", contractTask("throwing resolver"), { outputContract: "base.v1" });
      assert.equal(result.gatePassed, true);
      assert.equal(argvOf(args, "-e"), undefined);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
