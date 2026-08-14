/**
 * test/child/nested.test.ts — C1 nested subagents (child-side `subagent`
 * tool + parent-side engine env positioning + config/registry units).
 *
 * Verifies with a FAKE pi (injected SpawnFn running the headless fake-pi
 * fixture — never a real pi binary) that:
 *   - the tool registers ONLY when PI_SUBAGENTS_NESTED=1 AND
 *     PI_SUBAGENTS_DEPTH < PI_SUBAGENTS_MAX_DEPTH (depth >= max => absent,
 *     the clean refusal at the depth cap);
 *   - an agent OUTSIDE the strict allowlist is REFUSED — never a fallback;
 *   - an unknown agent is refused (no fallback);
 *   - a grandchild spawn goes through the lanes code (-e child adapter,
 *     --session, stdin one-shot) and the capped result returns to the child;
 *   - the grandchild env carries DEPTH+1 / MAX_DEPTH / NESTED / allowlist /
 *     agents-dir plus the inherited ZOB_* security vars, while the child's
 *     own escalation/steer channel envs are stripped;
 *   - the engine positions the same envs on the child spawn for
 *     `nested: true` (+ card `allowed_subagents`) and stays OFF for
 *     maxSubagentDepth < 2 (0/1 = off) or without any allowlist.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import childExtension from "../../child/index.js";
import {
  AGENTS_DIR_ENV,
  ALLOWED_SUBAGENTS_ENV,
  DEPTH_ENV,
  MAX_DEPTH_ENV,
  NESTED_ENV,
  SUBAGENT_TOOL_NAME,
  agentAllowed,
  defaultChildAdapterPath,
  nestedToolEnabled,
  parseAllowlist,
  readDepthEnv,
  readMaxDepthEnv,
  registerNestedSubagentTool,
} from "../../child/nested.js";
import type { ExtensionAPI, PiExtensionContext, PiToolDefinition } from "../../child/pi-types.js";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { loadConfig } from "../../src/shared/config.js";
import { loadAgentsFromDir, parseFrontmatter } from "../../src/registry/agents.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

const FAKE_PI = fileURLToPath(new URL("../../../test/fixtures/bin/fake-pi.mjs", import.meta.url));

const RUN_ID_ENV = "PI_SUBAGENTS_RUN_ID";
const ESCALATION_DIR = "PI_SUBAGENTS_ESCALATION_DIR";
const STEER_FILE = "PI_SUBAGENTS_STEER_FILE";
const ENV_KEYS = [
  NESTED_ENV,
  DEPTH_ENV,
  MAX_DEPTH_ENV,
  ALLOWED_SUBAGENTS_ENV,
  AGENTS_DIR_ENV,
  "PI_SUBAGENTS_PI",
  "PI_SUBAGENTS_CHILD_EXTENSION",
  "PI_SUBAGENTS_NESTED_TIMEOUT_MS",
  RUN_ID_ENV,
  ESCALATION_DIR,
  STEER_FILE,
  "ZOB_ALLOWED_PATHS",
  "ZOB_FORBIDDEN_PATHS",
  "SUBAGENTS_MAX_DEPTH",
] as const;

/** Minimal fake pi: records handlers, registerTool calls, appendEntry calls. */
function makeFakePi() {
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const tools: PiToolDefinition[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: never, ctx: never) => unknown): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: PiToolDefinition): void {
      tools.push(tool);
    },
    sendUserMessage(): void {},
    appendEntry(type: string, data: unknown): void {
      entries.push({ type, data });
    },
    tools,
    entries,
  };
  return pi;
}

function makeCtx(cwd: string): PiExtensionContext {
  return { cwd, ui: { setStatus: () => {}, theme: { fg: (_name: string, text: string) => text } } };
}

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-nested-${label}-`));
}

/** Agents fixture dir with a `worker` card. */
function makeAgentsDir(parent: string, extra: string[] = []): string {
  const agentsDir = join(parent, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "worker.md"),
    "---\nname: worker\ndescription: nested worker\ntools: read\n---\nYou are worker. Do the sub-task.",
    "utf8",
  );
  for (const name of extra) {
    writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: helper\n---\nYou are ${name}.`, "utf8");
  }
  return agentsDir;
}

/** Injected SpawnFn running the fake-pi fixture; records every spawn input. */
function makeRecordingSpawn(calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>): SpawnFn {
  return ({ args, cwd, env }) => {
    calls.push({ args, env });
    return spawn(process.execPath, [FAKE_PI, ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
  };
}

// ---------------------------------------------------------------- units

describe("child/nested pure units", () => {
  it("parseAllowlist: CSV entries, `all` wildcard, empty refuses everything", () => {
    assert.deepEqual(parseAllowlist(undefined), []);
    assert.deepEqual(parseAllowlist("  "), []);
    assert.deepEqual(parseAllowlist(" alpha , beta "), ["alpha", "beta"]);
    assert.equal(parseAllowlist("alpha, ALL"), "all");
    assert.equal(parseAllowlist("all"), "all");
  });

  it("agentAllowed: strict case-insensitive membership (never a fallback)", () => {
    assert.equal(agentAllowed("Worker", ["alpha", "worker"]), true);
    assert.equal(agentAllowed("gamma", ["alpha", "beta"]), false);
    assert.equal(agentAllowed("anything", "all"), true);
    assert.equal(agentAllowed("anything", []), false);
  });

  it("readDepthEnv / readMaxDepthEnv: defaults, clamping, invalid input", () => {
    assert.equal(readDepthEnv({}), 0);
    assert.equal(readDepthEnv({ [DEPTH_ENV]: "3" }), 3);
    assert.equal(readDepthEnv({ [DEPTH_ENV]: "-2" }), 0);
    assert.equal(readDepthEnv({ [DEPTH_ENV]: "nope" }), 0);
    assert.equal(readMaxDepthEnv({}), 2);
    assert.equal(readMaxDepthEnv({ [MAX_DEPTH_ENV]: "9" }), 4);
    assert.equal(readMaxDepthEnv({ [MAX_DEPTH_ENV]: "-1" }), 0);
    assert.equal(readMaxDepthEnv({ [MAX_DEPTH_ENV]: "x" }), 2);
  });

  it("nestedToolEnabled: ONLY NESTED=1 AND depth < max", () => {
    assert.equal(nestedToolEnabled({}), false);
    assert.equal(nestedToolEnabled({ [NESTED_ENV]: "0", [DEPTH_ENV]: "1", [MAX_DEPTH_ENV]: "3" }), false);
    assert.equal(nestedToolEnabled({ [NESTED_ENV]: "1", [DEPTH_ENV]: "1", [MAX_DEPTH_ENV]: "2" }), true);
    assert.equal(nestedToolEnabled({ [NESTED_ENV]: "1", [DEPTH_ENV]: "2", [MAX_DEPTH_ENV]: "2" }), false);
    assert.equal(nestedToolEnabled({ [NESTED_ENV]: "1", [DEPTH_ENV]: "0", [MAX_DEPTH_ENV]: "0" }), false);
  });

  it("defaultChildAdapterPath points at the sibling compiled index.js", () => {
    assert.ok(defaultChildAdapterPath().endsWith(join("child", "index.js")), defaultChildAdapterPath());
  });
});

// ------------------------------------------------- conditional registration

describe("child adapter nested registration (fake pi)", () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    dir = tempDir("reg");
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT register the subagent tool without PI_SUBAGENTS_NESTED", () => {
    process.env[DEPTH_ENV] = "1";
    process.env[MAX_DEPTH_ENV] = "3";
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    assert.deepEqual(pi.tools, [], "no nested tool without the master switch");
  });

  it("registers the subagent tool when NESTED=1 and depth < max", () => {
    process.env[NESTED_ENV] = "1";
    process.env[DEPTH_ENV] = "1";
    process.env[MAX_DEPTH_ENV] = "2";
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    const names = pi.tools.map((tool) => tool.name);
    assert.deepEqual(names, [SUBAGENT_TOOL_NAME]);
    assert.equal(typeof pi.tools[0]!.description, "string");
    assert.deepEqual(pi.tools[0]!.parameters, {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name — MUST be on the nested allowlist (PI_SUBAGENTS_ALLOWED_SUBAGENTS)." },
        task: { type: "string", description: "Self-contained sub-task for the grandchild (bounded six-part style contract when possible)." },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    });
  });

  it("depth >= max => tool ABSENT (clean refusal at the depth cap)", () => {
    process.env[NESTED_ENV] = "1";
    process.env[DEPTH_ENV] = "2";
    process.env[MAX_DEPTH_ENV] = "2";
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    assert.deepEqual(pi.tools, [], "depth cap reached: no nested tool registered");
  });

  it("NESTED=1 with MAX_DEPTH=1 (off) => tool ABSENT", () => {
    process.env[NESTED_ENV] = "1";
    process.env[DEPTH_ENV] = "1";
    process.env[MAX_DEPTH_ENV] = "1";
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    assert.deepEqual(pi.tools, []);
  });
});

// --------------------------------------------------- strict allowlist locks

describe("child nested tool: strict allowlist (refuse, never fallback)", () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let agentsDir: string;
  let spawnCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    dir = tempDir("allow");
    agentsDir = makeAgentsDir(dir, ["alpha"]);
    spawnCalls = [];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env[NESTED_ENV] = "1";
    process.env[DEPTH_ENV] = "1";
    process.env[MAX_DEPTH_ENV] = "3";
    process.env[AGENTS_DIR_ENV] = agentsDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("agent outside the allowlist is REFUSED and NOTHING is spawned (no fallback)", async () => {
    process.env[ALLOWED_SUBAGENTS_ENV] = "alpha,beta";
    const pi = makeFakePi();
    const boom: SpawnFn = () => {
      throw new Error("spawn must never be called for a refused agent");
    };
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: boom, cwd: dir });
    const tool = pi.tools.find((t) => t.name === SUBAGENT_TOOL_NAME)!;

    const result = await tool.execute("call_1", { agent: "gamma", task: "do work" });
    assert.match(result.content[0]!.text, /refused: agent 'gamma' is not in the nested allowlist \[alpha, beta\]/);
    assert.match(result.content[0]!.text, /No fallback agent is ever selected/);
    assert.equal((result.details as { allowed: boolean }).allowed, false);
    assert.equal((result.details as { reason: string }).reason, "allowlist");
  });

  it("an EMPTY allowlist refuses everything (strict, no implicit wildcard)", async () => {
    process.env[ALLOWED_SUBAGENTS_ENV] = "  ";
    const pi = makeFakePi();
    const boom: SpawnFn = () => {
      throw new Error("spawn must never be called");
    };
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: boom, cwd: dir });
    const tool = pi.tools[0]!;

    const result = await tool.execute("call_2", { agent: "worker", task: "x" });
    assert.match(result.content[0]!.text, /refused/);
    assert.equal((result.details as { reason: string }).reason, "allowlist");
  });

  it("an ALLOWED but UNKNOWN agent is refused (no fallback to a listed agent)", async () => {
    process.env[ALLOWED_SUBAGENTS_ENV] = "worker,ghost";
    const pi = makeFakePi();
    const boom: SpawnFn = () => {
      throw new Error("spawn must never be called for an unknown agent");
    };
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: boom, cwd: dir });
    const tool = pi.tools[0]!;

    const result = await tool.execute("call_3", { agent: "ghost", task: "x" });
    assert.match(result.content[0]!.text, /refused: unknown agent 'ghost'/);
    assert.match(result.content[0]!.text, /Available: alpha, worker/);
    assert.equal((result.details as { reason: string }).reason, "unknown_agent");
  });

  it("empty agent/task parameters throw a tool error", async () => {
    process.env[ALLOWED_SUBAGENTS_ENV] = "worker";
    const pi = makeFakePi();
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: makeRecordingSpawn(spawnCalls), cwd: dir });
    await assert.rejects(pi.tools[0]!.execute("call_4", { agent: "  ", task: "x" }), /non-empty/);
    await assert.rejects(pi.tools[0]!.execute("call_5", { agent: "worker", task: "" }), /non-empty/);
    assert.equal(spawnCalls.length, 0);
  });
});

// ------------------------------------------------- grandchild spawn (fake pi)

describe("child nested tool: grandchild spawn via lanes code (fake pi)", () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let agentsDir: string;
  let spawnCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>;
  let sessionsDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    dir = tempDir("spawn");
    agentsDir = makeAgentsDir(dir);
    spawnCalls = [];
    sessionsDir = tempDir("sessions");
    for (const key of ENV_KEYS) delete process.env[key];
    process.env[NESTED_ENV] = "1";
    process.env[DEPTH_ENV] = "1";
    process.env[MAX_DEPTH_ENV] = "3";
    process.env[ALLOWED_SUBAGENTS_ENV] = "worker";
    process.env[AGENTS_DIR_ENV] = agentsDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("spawns the grandchild (-e adapter, --session, isolated args) and returns the CAPPED result", async () => {
    const pi = makeFakePi();
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: makeRecordingSpawn(spawnCalls), cwd: dir });
    const tool = pi.tools.find((t) => t.name === SUBAGENT_TOOL_NAME)!;

    // 6000-char task => fake-pi echoes "answer:<task>" (~6007 bytes) which
    // must be capped to the 4000-byte nested output limit.
    const longTask = "x".repeat(6000);
    const result = await tool.execute("call_10", { agent: "worker", task: longTask }, undefined, undefined, makeCtx(dir));

    // Exactly one grandchild spawn through the lanes code.
    assert.equal(spawnCalls.length, 1);
    const args = spawnCalls[0]!.args;
    assert.ok(args.includes("--mode") && args.includes("json"), "isolated json mode");
    assert.ok(args.includes("-p") && args.includes("--no-extensions"), "isolated headless flags");
    const extensionFlag = args.indexOf("-e");
    assert.ok(extensionFlag >= 0, "child adapter loaded via -e");
    assert.ok(args[extensionFlag + 1]!.endsWith("index.js"), `adapter path: ${args[extensionFlag + 1]}`);
    assert.ok(args.includes("--session"), "stable session flag present");
    assert.ok(args.includes("--append-system-prompt"), "agent card prompt appended");

    // Capped result returned to the child.
    const text = result.content[0]!.text;
    assert.ok(text.startsWith("subagent 'worker' (depth 2/3) — exit 0"), text.slice(0, 80));
    assert.ok(text.includes("answer:"), "grandchild output delivered");
    assert.ok(text.includes("[truncated"), "output capped");
    assert.ok(Buffer.byteLength(text, "utf8") <= 4_000 + 64, `capped text length: ${Buffer.byteLength(text, "utf8")}`);

    // Details: metadata only (no raw bodies beyond the capped content).
    const details = result.details as Record<string, unknown>;
    assert.equal(details.agent, "worker");
    assert.equal(details.depth, 2);
    assert.equal(details.maxDepth, 3);
    assert.equal(details.exitCode, 0);
    assert.equal(details.allowed, true);
    assert.match(String(details.taskHash), /^[0-9a-f]{64}$/);
    assert.match(String(details.outputHash), /^[0-9a-f]{64}$/);
  });

  it("propagates DEPTH+1 / MAX_DEPTH / NESTED / allowlist / agents-dir and the ZOB_* security envs; strips escalation channels", async () => {
    process.env.ZOB_ALLOWED_PATHS = "/safe/root";
    process.env.ZOB_FORBIDDEN_PATHS = "/secret";
    process.env[RUN_ID_ENV] = "delegate_parent";
    process.env[ESCALATION_DIR] = join(dir, "esc");
    process.env[STEER_FILE] = join(dir, "steer");

    const pi = makeFakePi();
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: makeRecordingSpawn(spawnCalls), cwd: dir });
    await pi.tools[0]!.execute("call_11", { agent: "worker", task: "small" }, undefined, undefined, makeCtx(dir));

    const env = spawnCalls[0]!.env!;
    // Depth accounting: child depth 1 -> grandchild depth 2 (cap kept).
    assert.equal(env[DEPTH_ENV], "2");
    assert.equal(env[MAX_DEPTH_ENV], "3");
    assert.equal(env[NESTED_ENV], "1");
    assert.equal(env[ALLOWED_SUBAGENTS_ENV], "worker");
    assert.equal(env[AGENTS_DIR_ENV], agentsDir);
    // Inherited security envs (lock 3): propagated verbatim.
    assert.equal(env.ZOB_ALLOWED_PATHS, "/safe/root");
    assert.equal(env.ZOB_FORBIDDEN_PATHS, "/secret");
    // The child's OWN escalation/steer channels are NOT inherited.
    assert.equal(env[RUN_ID_ENV], undefined);
    assert.equal(env[ESCALATION_DIR], undefined);
    assert.equal(env[STEER_FILE], undefined);
  });

  it("appends a HASH-ONLY nested trace entry (no raw task/output bodies)", async () => {
    const pi = makeFakePi();
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: makeRecordingSpawn(spawnCalls), cwd: dir });
    await pi.tools[0]!.execute("call_12", { agent: "worker", task: "secret-task-body" });

    const trace = pi.entries.find((e) => e.type === "pi-subagents-nested");
    assert.ok(trace, "nested trace appended");
    const data = trace!.data as Record<string, unknown>;
    assert.equal(data.agent, "worker");
    assert.equal(data.depth, 2);
    assert.equal(data.exitCode, 0);
    assert.match(String(data.taskHash), /^[0-9a-f]{64}$/);
    assert.match(String(data.outputHash), /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(pi.entries).includes("secret-task-body"), false, "no raw task body in entries");
  });

  it("grandchild non-zero exit is surfaced (not thrown) in the capped result", async () => {
    const spawnFail: SpawnFn = ({ args, cwd, env }) =>
      spawn(process.execPath, [FAKE_PI, "--fail", ...args], {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    const pi = makeFakePi();
    registerNestedSubagentTool(pi as unknown as ExtensionAPI, { spawn: spawnFail, cwd: dir });
    const result = await pi.tools[0]!.execute("call_13", { agent: "worker", task: "boom" });
    const details = result.details as Record<string, unknown>;
    assert.equal(details.exitCode, 3);
    assert.ok(result.content[0]!.text.includes("exit 3"), "exit code surfaced to the child");
  });
});

// ------------------------------------------- engine env positioning (parent)

describe("engine/dispatch: nested envs positioned on the child spawn (C1)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.SUBAGENTS_MAX_DEPTH;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function nestedRepo(label: string, agentMd?: string): string {
    const dir = tempDir(label);
    const agentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "alpha.md"),
      agentMd ??
        "---\nname: alpha\ndescription: test agent\ntools: read, bash\nallowed_subagents: helper,reviewer\n---\nYou are alpha.",
      "utf8",
    );
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

  it("nested: true + card allowed_subagents -> NESTED/ALLOWED/DEPTH/MAX_DEPTH/AGENTS_DIR on the spawn", async () => {
    const dir = nestedRepo("on");
    try {
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: makeRecordingSpawn(calls),
        sessionDir: join(dir, "sessions"),
        maxSubagentDepth: 3,
      });
      await engine.single("alpha", contractTask("nested work"), { nested: true });
      engine.close();

      assert.equal(calls.length, 1);
      const env = calls[0]!.env!;
      assert.equal(env[NESTED_ENV], "1");
      assert.equal(env[DEPTH_ENV], "1");
      assert.equal(env[MAX_DEPTH_ENV], "3");
      assert.equal(env[ALLOWED_SUBAGENTS_ENV], "helper,reviewer");
      assert.equal(env[AGENTS_DIR_ENV], join(dir, ".pi", "agents"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicit nested.allowedSubagents overrides the card allowlist", async () => {
    const dir = nestedRepo("override");
    try {
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine = new DispatchEngine({ repoRoot: dir, spawn: makeRecordingSpawn(calls), sessionDir: join(dir, "sessions") });
      await engine.single("alpha", contractTask("override"), { nested: { allowedSubagents: ["beta", "gamma"] } });
      engine.close();
      assert.equal(calls[0]!.env![ALLOWED_SUBAGENTS_ENV], "beta,gamma");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`all` allowlist is passed through verbatim", async () => {
    const dir = nestedRepo("all");
    try {
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine = new DispatchEngine({ repoRoot: dir, spawn: makeRecordingSpawn(calls), sessionDir: join(dir, "sessions") });
      await engine.single("alpha", contractTask("all"), { nested: { allowedSubagents: ["all"] } });
      engine.close();
      assert.equal(calls[0]!.env![ALLOWED_SUBAGENTS_ENV], "all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maxSubagentDepth < 2 (0/1 = off) and missing allowlist keep nesting OFF", async () => {
    const dir = nestedRepo("off");
    try {
      // maxSubagentDepth 1 = off, even with an allowlist.
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: makeRecordingSpawn(calls),
        sessionDir: join(dir, "sessions"),
        maxSubagentDepth: 1,
      });
      await engine.single("alpha", contractTask("off by depth"));
      engine.close();
      assert.equal(calls[0]!.env![NESTED_ENV], undefined, "maxSubagentDepth 1 = off");

      // No allowlist anywhere (plain card, nested: true) = strict off.
      const plain = nestedRepo("off2", "---\nname: alpha\ndescription: test agent\n---\nYou are alpha.");
      const calls2: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine2 = new DispatchEngine({ repoRoot: plain, spawn: makeRecordingSpawn(calls2), sessionDir: join(plain, "sessions") });
      await engine2.single("alpha", contractTask("off by allowlist"), { nested: true });
      engine2.close();
      assert.equal(calls2[0]!.env![NESTED_ENV], undefined, "no allowlist = off");

      // No nested option = off even with a card allowlist.
      const calls3: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine3 = new DispatchEngine({ repoRoot: dir, spawn: makeRecordingSpawn(calls3), sessionDir: join(dir, "sessions") });
      await engine3.single("alpha", contractTask("no option"));
      engine3.close();
      assert.equal(calls3[0]!.env![NESTED_ENV], undefined, "no nested option = off");
      rmSync(plain, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default maxSubagentDepth is 2 (one nesting level) and is clamped to 0..4", async () => {
    const dir = nestedRepo("default");
    try {
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine = new DispatchEngine({ repoRoot: dir, spawn: makeRecordingSpawn(calls), sessionDir: join(dir, "sessions") });
      await engine.single("alpha", contractTask("default depth"), { nested: true });
      engine.close();
      assert.equal(calls[0]!.env![MAX_DEPTH_ENV], "2");

      const callsHi: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engineHi = new DispatchEngine({
        repoRoot: dir,
        spawn: makeRecordingSpawn(callsHi),
        sessionDir: join(dir, "sessions"),
        maxSubagentDepth: 99,
      });
      await engineHi.single("alpha", contractTask("clamped depth"), { nested: true });
      engineHi.close();
      assert.equal(callsHi[0]!.env![MAX_DEPTH_ENV], "4", "clamped to 4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SUBAGENTS_MAX_DEPTH env override reaches the child spawn", async () => {
    const dir = nestedRepo("envdepth");
    try {
      process.env.SUBAGENTS_MAX_DEPTH = "3";
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const engine = new DispatchEngine({ repoRoot: dir, spawn: makeRecordingSpawn(calls), sessionDir: join(dir, "sessions") });
      await engine.single("alpha", contractTask("env depth"), { nested: true });
      engine.close();
      assert.equal(calls[0]!.env![MAX_DEPTH_ENV], "3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------ config + registry

describe("shared/config: maxSubagentDepth (default 2, clamp 0..4, env override)", () => {
  const dir = tempDir("cfg");
  const configPath = join(dir, ".subagents", "config.json");

  function writeConfig(value: unknown): void {
    mkdirSync(join(dir, ".subagents"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ maxSubagentDepth: value }), "utf8");
  }

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to 2; file values clamp into [0, 4]", () => {
    assert.equal(loadConfig(dir).maxSubagentDepth, 2);
    writeConfig(9);
    assert.equal(loadConfig(dir).maxSubagentDepth, 4);
    writeConfig(-3);
    assert.equal(loadConfig(dir).maxSubagentDepth, 0);
    writeConfig("bogus");
    assert.equal(loadConfig(dir).maxSubagentDepth, 2);
  });

  it("SUBAGENTS_MAX_DEPTH env overrides the file value (clamped)", () => {
    writeConfig(4);
    assert.equal(loadConfig(dir, { SUBAGENTS_MAX_DEPTH: "3" }).maxSubagentDepth, 3);
    assert.equal(loadConfig(dir, { SUBAGENTS_MAX_DEPTH: "99" }).maxSubagentDepth, 4);
    assert.equal(loadConfig(dir, { SUBAGENTS_MAX_DEPTH: "0" }).maxSubagentDepth, 0);
  });
});

describe("registry/agents: allowed_subagents frontmatter (CSV | all)", () => {
  const dir = tempDir("agents");
  const agentsDir = join(dir, "agents");

  before(() => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "scout.md"),
      "---\nname: scout\ndescription: scout\nallowed_subagents: helper, reviewer\n---\nYou are scout.",
      "utf8",
    );
    writeFileSync(
      join(agentsDir, "open.md"),
      "---\nname: open\ndescription: open\nallowed_subagents: all\n---\nYou are open.",
      "utf8",
    );
    writeFileSync(join(agentsDir, "plain.md"), "---\nname: plain\ndescription: plain\n---\nYou are plain.", "utf8");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses CSV allowlists, `all`, and absent fields", () => {
    const agents = loadAgentsFromDir(agentsDir, "project");
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    assert.deepEqual(byName.get("scout")!.allowedSubagents, ["helper", "reviewer"]);
    assert.deepEqual(byName.get("open")!.allowedSubagents, ["all"]);
    assert.equal(byName.get("plain")!.allowedSubagents, undefined);
    assert.equal(parseFrontmatter("---\nallowed_subagents: a , b\n---\nbody").frontmatter.allowed_subagents, "a , b");
  });
});
