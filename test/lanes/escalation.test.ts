/**
 * test/lanes/escalation.test.ts — B5 ask_master escalation (parent side).
 *
 * Headless: every test injects a SpawnFn that runs the fake-pi fixture in
 * `--escalate <msg>` mode (writes `<escalationDir>/<runId>.escalation.json`
 * then exits 42). No real `pi` binary is ever launched.
 *
 * Verifies:
 *  - lanes: exit 42 -> stopReason 'escalated' + escalationMessage + the file
 *    is CONSUMED (read + deleted exactly once);
 *  - lanes: exit 42 WITHOUT a file -> 'escalated' without a message (clean
 *    fallback — the exit code is the source of truth);
 *  - engine: run status 'escalated' + escalationHash (sha-256, hash-only) in
 *    the view AND the ledger, never the raw message body;
 *  - events: the ledger 'end' entry maps to subagents:escalated (hash-only);
 *  - recovery: an escalated run is terminal => continueRun answers it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LanePool } from "../../src/lanes/pool.js";
import { consumeEscalation, escalationFilePath } from "../../src/lanes/escalation.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { summarizeDelegations } from "../../src/engine/monitor.js";
import { SubagentsEventBus } from "../../src/extension/events.js";

const FAKE_PI = fileURLToPath(new URL("../../../test/fixtures/bin/fake-pi.mjs", import.meta.url));
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-b5-${label}-`));
}

/** Spawn fake-pi in `--escalate <msg>` mode (env passthrough like real lanes). */
function spawnEscalate(message: string, stripEscalationEnv = false): SpawnFn {
  return ({ args, cwd, env }) => {
    const merged = { ...process.env, ...env };
    if (stripEscalationEnv) {
      delete merged.PI_SUBAGENTS_RUN_ID;
      delete merged.PI_SUBAGENTS_ESCALATION_DIR;
    }
    return spawn(process.execPath, [FAKE_PI, "--escalate", message, ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: merged,
    });
  };
}

// ---- lanes: exit 42 detection + consume-once ----

describe("lanes/escalation: exit 42 -> escalated + consume-once", () => {
  it("surfaces the escalation message and consumes the file exactly once", async () => {
    const dir = tempDir("lane");
    const steerDir = join(dir, "steer");
    try {
      const pool = new LanePool({ spawn: spawnEscalate("which oracle gate for the ndjson parser?"), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("esc", {
        task: "review the parser",
        runId: "run-esc-1",
        steerDir,
      });

      assert.equal(result.exitCode, 42);
      assert.equal(result.stopReason, "escalated");
      assert.equal(result.escalationMessage, "which oracle gate for the ndjson parser?");
      // Consume-once: the file is gone, and a second consume finds nothing.
      assert.equal(existsSync(escalationFilePath("run-esc-1", steerDir)), false, "escalation file consumed (deleted)");
      assert.deepEqual(consumeEscalation("run-esc-1", steerDir), { consumed: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 42 WITHOUT a file -> escalated without a message (clean fallback)", async () => {
    const dir = tempDir("nofile");
    const steerDir = join(dir, "steer");
    try {
      // stripEscalationEnv: the child never learns where to write, so it exits
      // 42 without producing the file (crash-after-signal / lost-file shape).
      const pool = new LanePool({ spawn: spawnEscalate("lost message", true), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("lost", {
        task: "t",
        runId: "run-esc-2",
        steerDir,
      });

      assert.equal(result.exitCode, 42);
      assert.equal(result.stopReason, "escalated");
      assert.equal(result.escalationMessage, undefined);
      assert.equal(result.errorMessage, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a normal exit 0 run is never marked escalated", async () => {
    const dir = tempDir("normal");
    const steerDir = join(dir, "steer");
    try {
      const spawnNormal: SpawnFn = ({ args, cwd, env }) =>
        spawn(process.execPath, [FAKE_PI, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
      const pool = new LanePool({ spawn: spawnNormal, sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("ok", { task: "t", runId: "run-esc-3", steerDir });
      assert.equal(result.exitCode, 0);
      assert.notEqual(result.stopReason, "escalated");
      assert.equal(result.escalationMessage, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- engine: status 'escalated' + hash-only ledger/events ----

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-b5-eng-${label}-`));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "alpha.md"), AGENT_MD("alpha"), "utf8");
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

describe("engine/dispatch: B5 escalation plumbing (hash-only)", () => {
  it("escalated run: ChildResult message + run status 'escalated' + escalationHash in view and ledger (never the body)", async () => {
    const dir = tempRepo("escalated");
    const steerDir = join(dir, "steer");
    const ledger: Array<Record<string, unknown>> = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: spawnEscalate("master, should I edit src or only report?"),
        sessionDir: join(dir, "sessions"),
        steerDir,
        source: "delegate_task",
        onLedger: (entry) => ledger.push(entry),
      });
      const result = await engine.single("alpha", contractTask("deep review"), { outputContract: "base.v1" });
      engine.close();

      const message = "master, should I edit src or only report?";
      assert.equal(result.exitCode, 42);
      assert.equal(result.stopReason, "escalated");
      assert.equal(result.escalationMessage, message);
      assert.equal(result.failureKind, undefined, "an escalation is not a failure kind");

      const run = engine.monitor.runs.find((candidate) => candidate.agent === "alpha")!;
      assert.equal(run.status, "escalated");
      assert.equal(run.escalationHash, sha256(message));
      assert.equal(summarizeDelegations(engine.monitor).escalated, 1);

      // Ledger posture: the end entry carries the escalationHash and NEVER the
      // raw message (hash-only, invariant I1).
      const end = ledger.find((entry) => entry.event === "end")!;
      assert.equal(end.status, "escalated");
      assert.equal(end.escalationHash, sha256(message));
      assert.equal(JSON.stringify(ledger).includes("should I edit src"), false, "no raw escalation body in the ledger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("event bus: the escalated end entry maps to subagents:escalated with a hash-only payload", async () => {
    const dir = tempRepo("events");
    const steerDir = join(dir, "steer");
    const ledger: Array<Record<string, unknown>> = [];
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: spawnEscalate("need the owner decision on scope"),
        sessionDir: join(dir, "sessions"),
        steerDir,
        source: "delegate_task",
        onLedger: (entry) => ledger.push(entry),
      });
      await engine.single("alpha", contractTask("blocked work"), { outputContract: "base.v1" });
      engine.close();

      const emitted: Array<{ channel: string; payload: unknown }> = [];
      const bus = new SubagentsEventBus({ emit: (channel, payload) => emitted.push({ channel, payload }) });
      for (const entry of ledger) bus.handleLedgerEntry(entry);

      const escalated = emitted.filter((e) => e.channel === "subagents:escalated");
      assert.equal(escalated.length, 1, "exactly one subagents:escalated event");
      const payload = escalated[0]!.payload as Record<string, unknown>;
      assert.equal(payload.event, "escalated");
      assert.equal(payload.status, "escalated");
      assert.equal(payload.agent, "alpha");
      assert.equal(payload.escalationHash, sha256("need the owner decision on scope"));
      assert.equal(payload.bodyStored, false);
      assert.equal(JSON.stringify(emitted).includes("need the owner decision"), false, "no raw body on the event bus");
      // The other lifecycle events are untouched.
      assert.ok(emitted.some((e) => e.channel === "subagents:created"));
      assert.ok(emitted.some((e) => e.channel === "subagents:started"));
      assert.equal(emitted.some((e) => e.channel === "subagents:failed"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovery: an escalated run is terminal, so continueRun can answer it on the same session", async () => {
    const dir = tempRepo("continue");
    const steerDir = join(dir, "steer");
    try {
      // Stateful spawner: the FIRST dispatch escalates (ask_master), every
      // later dispatch (the master's continue) answers normally.
      let calls = 0;
      const spawnFirstEscalate: SpawnFn = ({ args, cwd, env }) => {
        calls += 1;
        const mode = calls === 1 ? ["--escalate", "stuck on the contract format"] : ["--turns", "2", "--turns-deliverable"];
        return spawn(process.execPath, [FAKE_PI, ...mode, ...args], {
          cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...env },
        });
      };
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: spawnFirstEscalate,
        sessionDir: join(dir, "sessions"),
        steerDir,
        source: "delegate_task",
      });
      const first = await engine.single("alpha", contractTask("initial work"), { outputContract: "base.v1" });
      assert.equal(first.stopReason, "escalated");

      // The master answers by continuing the escalated run (same session file).
      const second = await engine.continueRun(first.ledgerRunId!, contractTask("answer: proceed read-only"));
      engine.close();

      assert.notEqual(second.stopReason, "escalated");
      assert.notEqual(second.stopReason, "aborted");
      const continued = engine.monitor.runs.find((candidate) => candidate.continuedFromRunId === first.ledgerRunId)!;
      assert.equal(continued.continuedFromRunId, first.ledgerRunId);
      assert.notEqual(continued.status, "escalated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
