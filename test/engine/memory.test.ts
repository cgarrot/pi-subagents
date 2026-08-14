// test/engine/memory.test.ts — C5 persistent per-agent memory.
//
// Covers: resolveMemoryDir 3 scopes, isUnsafeName whitelist, symlink refusal
// (file + dir, read + ensure), 200-line truncation, read-only vs R/W blocks,
// AgentCard frontmatter parsing, and dispatch integration (memory block
// APPENDED to the system prompt, never the task; dispatch option > frontmatter;
// no memory -> prompt unchanged).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildMemoryBlock,
  ensureMemoryDir,
  isUnsafeName,
  MEMORY_BLOCK_HEADER,
  MEMORY_FILE_NAME,
  MEMORY_MAX_LINES,
  MEMORY_TRUNCATION_MARKER,
  parseMemoryScope,
  resolveMemoryDir,
  safeMemoryRead,
} from "../../src/engine/memory.js";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { loadAgentsFromDir } from "../../src/registry/agents.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-memory-${label}-`));
}

/** Agent markdown with optional tools / memory frontmatter. */
function agentMd(name: string, opts: { tools?: string; memory?: string } = {}): string {
  const lines = ["---", `name: ${name}`, "description: test agent"];
  if (opts.tools !== undefined) lines.push(`tools: ${opts.tools}`);
  if (opts.memory !== undefined) lines.push(`memory: ${opts.memory}`);
  lines.push("---", `You are ${name}. Produce evidence.`);
  return lines.join("\n");
}

function tempProject(label: string, agents: Record<string, string>): string {
  const dir = tempDir(label);
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [fileName, md] of Object.entries(agents)) writeFileSync(join(agentsDir, `${fileName}.md`), md, "utf8");
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
 * Spawner that records the child args (to inspect --append-system-prompt) and
 * echoes the received stdin task into a base.v1-compliant output (so the task
 * body is observable and must NOT contain the memory block).
 */
function recordingSpawn(capture: { args?: string[] }): SpawnFn {
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
  return ({ args, cwd, env }) => {
    capture.args = args;
    return spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

/** Extract the `--append-system-prompt` value from recorded child args. */
function systemPromptOf(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined;
  const index = args.indexOf("--append-system-prompt");
  return index === -1 ? undefined : args[index + 1];
}

describe("engine/memory: resolveMemoryDir scopes", () => {
  it("resolves the three exact scope locations", () => {
    const cwd = "/repo/x";
    assert.equal(resolveMemoryDir("project", "alpha", cwd), join(cwd, ".pi", "agent-memory", "alpha"));
    assert.equal(resolveMemoryDir("local", "alpha", cwd), join(cwd, ".pi", "agent-memory-local", "alpha"));
    const agentDir = "/agents-root";
    assert.equal(resolveMemoryDir("user", "alpha", cwd, agentDir), join(agentDir, "agent-memory", "alpha"));
    // user scope defaults to ~/.pi/agent (benchmark: ~/.pi/agent/agent-memory/).
    assert.equal(resolveMemoryDir("user", "alpha", cwd), join(homedir(), ".pi", "agent", "agent-memory", "alpha"));
  });

  it("refuses unsafe agent names (anti-traversal whitelist, max 128)", () => {
    for (const unsafe of ["", "../evil", "a/b", "a\\b", ".hidden", "a b", "a\tb", "a".repeat(129), "..", "/abs"]) {
      assert.ok(isUnsafeName(unsafe), `expected unsafe: ${JSON.stringify(unsafe)}`);
      assert.throws(() => resolveMemoryDir("project", unsafe, "/repo"));
    }
    for (const safe of ["alpha", "a", "A-b_2.3", "a".repeat(128), "9start"]) {
      assert.ok(!isUnsafeName(safe), `expected safe: ${JSON.stringify(safe)}`);
    }
  });

  it("refuses unknown scopes", () => {
    assert.throws(() => resolveMemoryDir("global" as never, "alpha", "/repo"));
  });
});

describe("engine/memory: safeMemoryRead symlink refusal", () => {
  it("reads normal files and returns undefined when absent", () => {
    const dir = tempDir("read");
    try {
      assert.equal(safeMemoryRead(join(dir, "missing")), undefined);
      const memoryDir = join(dir, "m");
      mkdirSync(memoryDir);
      assert.equal(safeMemoryRead(memoryDir), undefined); // dir without file
      writeFileSync(join(memoryDir, MEMORY_FILE_NAME), "fact one\n", "utf8");
      assert.equal(safeMemoryRead(memoryDir), "fact one\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked memory FILE", () => {
    const dir = tempDir("symfile");
    try {
      const outside = join(dir, "outside.md");
      writeFileSync(outside, "poisoned\n", "utf8");
      const memoryDir = join(dir, "m");
      mkdirSync(memoryDir);
      symlinkSync(outside, join(memoryDir, MEMORY_FILE_NAME));
      assert.throws(() => safeMemoryRead(memoryDir), /symlinked memory file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked memory DIR", () => {
    const dir = tempDir("symdir");
    try {
      const real = join(dir, "real");
      mkdirSync(real);
      writeFileSync(join(real, MEMORY_FILE_NAME), "poisoned\n", "utf8");
      const link = join(dir, "link");
      symlinkSync(real, link);
      assert.throws(() => safeMemoryRead(link), /symlinked memory dir/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/memory: ensureMemoryDir", () => {
  it("creates the dir recursively and returns it", () => {
    const dir = tempDir("ensure");
    try {
      const memoryDir = join(dir, ".pi", "agent-memory", "alpha");
      assert.equal(ensureMemoryDir(memoryDir), memoryDir);
      assert.ok(existsSync(memoryDir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked target dir", () => {
    const dir = tempDir("ensuresym");
    try {
      const real = join(dir, "real");
      mkdirSync(real);
      const link = join(dir, "link");
      symlinkSync(real, link);
      assert.throws(() => ensureMemoryDir(link), /symlinked memory dir/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/memory: buildMemoryBlock", () => {
  it("injects header, content, and R/W format instructions", () => {
    const dir = tempDir("rw");
    try {
      const memoryDir = join(dir, "m");
      mkdirSync(memoryDir);
      writeFileSync(join(memoryDir, MEMORY_FILE_NAME), "Known convention: use tabs.\n", "utf8");
      const block = buildMemoryBlock(memoryDir);
      assert.ok(block.includes(MEMORY_BLOCK_HEADER));
      assert.ok(block.includes("Known convention: use tabs."));
      assert.ok(block.includes("READ/WRITE"));
      assert.ok(block.includes(join(memoryDir, MEMORY_FILE_NAME)));
      assert.ok(!block.includes("READ-ONLY"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders an explicit read-only block when readOnly is set", () => {
    const dir = tempDir("ro");
    try {
      const memoryDir = join(dir, "m");
      mkdirSync(memoryDir);
      writeFileSync(join(memoryDir, MEMORY_FILE_NAME), "fact\n", "utf8");
      const block = buildMemoryBlock(memoryDir, { readOnly: true });
      assert.ok(block.includes("READ-ONLY"));
      assert.ok(block.includes("fact"));
      assert.ok(!block.includes("READ/WRITE"));
      const rw = buildMemoryBlock(memoryDir);
      assert.ok(rw.includes("READ/WRITE"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows a placeholder when there is no memory yet", () => {
    const dir = tempDir("empty");
    try {
      const block = buildMemoryBlock(join(dir, "missing"));
      assert.ok(block.includes(MEMORY_BLOCK_HEADER));
      assert.ok(block.includes("(no memories yet)"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`truncates memory content to ${MEMORY_MAX_LINES} lines with a marker`, () => {
    const dir = tempDir("trunc");
    try {
      const memoryDir = join(dir, "m");
      mkdirSync(memoryDir);
      const lines = Array.from({ length: 250 }, (_, i) => `L${i}`);
      writeFileSync(join(memoryDir, MEMORY_FILE_NAME), `${lines.join("\n")}\n`, "utf8");
      const block = buildMemoryBlock(memoryDir);
      assert.ok(block.includes("L0\n"));
      assert.ok(block.includes("L199")); // line 200 kept
      assert.ok(!block.includes("L200")); // line 201 dropped
      assert.ok(!block.includes("L249"));
      assert.ok(block.includes(MEMORY_TRUNCATION_MARKER));
      assert.ok(block.includes("50 more lines"));
      // exactly at the limit: no truncation marker
      writeFileSync(join(memoryDir, MEMORY_FILE_NAME), `${lines.slice(0, 200).join("\n")}\n`, "utf8");
      const exact = buildMemoryBlock(memoryDir);
      assert.ok(exact.includes("L199"));
      assert.ok(!exact.includes(MEMORY_TRUNCATION_MARKER));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/memory: frontmatter parsing", () => {
  it("parses memory scope in AgentCard and rejects garbage", () => {
    const dir = tempDir("fm");
    try {
      const agentsDir = join(dir, "agents");
      mkdirSync(agentsDir);
      writeFileSync(join(agentsDir, "alpha.md"), agentMd("alpha", { memory: "project" }), "utf8");
      writeFileSync(join(agentsDir, "beta.md"), agentMd("beta", { memory: "global" }), "utf8");
      writeFileSync(join(agentsDir, "gamma.md"), agentMd("gamma"), "utf8");
      const cards = new Map(loadAgentsFromDir(agentsDir, "project").map((card) => [card.name, card]));
      assert.equal(cards.get("alpha")!.memory, "project");
      assert.equal(cards.get("beta")!.memory, undefined); // invalid -> disabled
      assert.equal(cards.get("gamma")!.memory, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseMemoryScope accepts exactly the three scopes", () => {
    assert.equal(parseMemoryScope("user"), "user");
    assert.equal(parseMemoryScope("project"), "project");
    assert.equal(parseMemoryScope("local"), "local");
    assert.equal(parseMemoryScope("global"), undefined);
    assert.equal(parseMemoryScope(undefined), undefined);
  });
});

describe("engine/dispatch: memory integration", () => {
  it("appends the memory block to the system prompt, never to the task", async () => {
    const dir = tempProject("inject", {
      alpha: agentMd("alpha", { tools: "read, bash, write, edit", memory: "project" }),
    });
    try {
      const memoryDir = join(dir, ".pi", "agent-memory", "alpha");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, MEMORY_FILE_NAME), "Known convention: use tabs.\n", "utf8");
      const capture: { args?: string[] } = {};
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn(capture), sessionDir: join(dir, "sessions"), source: "delegate_task" });
      try {
        const result = await engine.single("alpha", contractTask("do work"), { outputContract: "base.v1" });
        assert.equal(result.exitCode, 0);
        assert.equal(result.gatePassed, true);
        const prompt = systemPromptOf(capture.args);
        assert.ok(prompt, "expected --append-system-prompt in child args");
        assert.ok(prompt!.startsWith("You are alpha.")); // card prompt first
        assert.ok(prompt!.includes(MEMORY_BLOCK_HEADER)); // memory appended after
        assert.ok(prompt!.includes("Known convention: use tabs."));
        // The task (echoed back through the child output) must NOT carry memory.
        assert.ok(!result.output.includes(MEMORY_BLOCK_HEADER));
        assert.ok(!result.output.includes("Known convention"));
      } finally {
        engine.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the prompt unchanged when the agent has no memory", async () => {
    const dir = tempProject("nomem", { beta: agentMd("beta", { tools: "read, bash" }) });
    try {
      const capture: { args?: string[] } = {};
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn(capture), sessionDir: join(dir, "sessions"), source: "delegate_task" });
      try {
        const result = await engine.single("beta", contractTask("plain run"), { outputContract: "base.v1" });
        assert.equal(result.gatePassed, true);
        assert.equal(systemPromptOf(capture.args), "You are beta. Produce evidence.");
        assert.ok(!existsSync(join(dir, ".pi", "agent-memory")));
      } finally {
        engine.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the dispatch option priority over the frontmatter scope", async () => {
    const dir = tempProject("override", {
      alpha: agentMd("alpha", { tools: "read, bash, write, edit", memory: "project" }),
    });
    try {
      const capture: { args?: string[] } = {};
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn(capture), sessionDir: join(dir, "sessions"), source: "delegate_task" });
      try {
        await engine.single("alpha", contractTask("scoped work"), { outputContract: "base.v1", memory: "local" });
        const prompt = systemPromptOf(capture.args)!;
        assert.ok(prompt.includes(join(".pi", "agent-memory-local", "alpha", MEMORY_FILE_NAME)));
        assert.ok(!prompt.includes(join(".pi", "agent-memory", "alpha")));
        // R/W agent -> memory dir ensured at preflight.
        assert.ok(existsSync(join(dir, ".pi", "agent-memory-local", "alpha")));
      } finally {
        engine.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables frontmatter memory when the dispatch option is false", async () => {
    const dir = tempProject("off", {
      alpha: agentMd("alpha", { tools: "read, bash, write, edit", memory: "project" }),
    });
    try {
      const capture: { args?: string[] } = {};
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn(capture), sessionDir: join(dir, "sessions"), source: "delegate_task" });
      try {
        await engine.single("alpha", contractTask("no memory"), { outputContract: "base.v1", memory: false });
        assert.equal(systemPromptOf(capture.args), "You are alpha. Produce evidence.");
        assert.ok(!existsSync(join(dir, ".pi", "agent-memory")));
      } finally {
        engine.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a read-only block (and no dir) when the card lacks write/edit tools", async () => {
    const dir = tempProject("readonly", {
      alpha: agentMd("alpha", { tools: "read, bash", memory: "project" }),
    });
    try {
      const memoryDir = join(dir, ".pi", "agent-memory", "alpha");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, MEMORY_FILE_NAME), "shared fact\n", "utf8");
      const capture: { args?: string[] } = {};
      const engine = new DispatchEngine({ repoRoot: dir, spawn: recordingSpawn(capture), sessionDir: join(dir, "sessions"), source: "delegate_task" });
      try {
        await engine.single("alpha", contractTask("consult only"), { outputContract: "base.v1" });
        const prompt = systemPromptOf(capture.args)!;
        assert.ok(prompt.includes("READ-ONLY"));
        assert.ok(prompt.includes("shared fact"));
        assert.ok(!prompt.includes("READ/WRITE"));
        // read-only agents never get their memory dir created by dispatch.
        rmSync(memoryDir, { recursive: true, force: true });
        await engine.single("alpha", contractTask("consult only again"), { outputContract: "base.v1" });
        assert.ok(systemPromptOf(capture.args)!.includes("READ-ONLY"));
        assert.ok(!existsSync(memoryDir));
      } finally {
        engine.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves user scope through the injectable memoryAgentDir", async () => {
    const dir = tempProject("user", {
      gamma: agentMd("gamma", { tools: "read, bash, write, edit", memory: "user" }),
    });
    try {
      const capture: { args?: string[] } = {};
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: recordingSpawn(capture),
        sessionDir: join(dir, "sessions"),
        source: "delegate_task",
        memoryAgentDir: join(dir, "user-agents"),
      });
      try {
        await engine.single("gamma", contractTask("user scope"), { outputContract: "base.v1" });
        const prompt = systemPromptOf(capture.args)!;
        assert.ok(prompt.includes(join(dir, "user-agents", "agent-memory", "gamma", MEMORY_FILE_NAME)));
        assert.ok(existsSync(join(dir, "user-agents", "agent-memory", "gamma")));
      } finally {
        engine.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
