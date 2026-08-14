// test/lanes/graceful.test.ts — B3 graceful turn limits (soft steer + hard abort).
//
// Headless: every test injects a SpawnFn that runs the fake-pi fixture in
// `--turns N` mode (N assistant message_end turns separated by a delay), so
// soft-steer / hard-abort land on deterministic turn boundaries. No real `pi`
// binary is ever launched.
//
// Reference (benchmark tintinweb agent-runner.ts:903-920): at maxTurns the
// parent sends a wrap-up STEER (no kill); the hard abort fires ONLY at
// maxTurns + graceTurns (grace default 5, min 1). A run that wraps up cleanly
// after the soft steer is distinguished as "steered"; one that hit the hard
// abort is "aborted".
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LanePool, resolveTurnLimits, WRAP_UP_STEER_MESSAGE } from "../../src/lanes/pool.js";
import { steerFilePath } from "../../src/lanes/steer.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import {
  DEFAULT_GRACE_TURNS,
  HARD_MAX_GRACE_TURNS,
  HARD_MAX_MAX_TURNS,
  loadConfig,
} from "../../src/shared/config.js";

const FAKE_PI = fileURLToPath(new URL("../../../test/fixtures/bin/fake-pi.mjs", import.meta.url));

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-b3-${label}-`));
}

/** Spawn fake-pi in `--turns N` mode with a fixed inter-turn delay (determinism). */
function spawnTurns(turns: number, extra: string[] = []): SpawnFn {
  return ({ args, cwd, env }) =>
    spawn(process.execPath, [FAKE_PI, "--turns", String(turns), ...extra, ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FAKE_PI_TURN_DELAY_MS: "100", ...env },
    });
}

// ---- resolveTurnLimits bounds ----

describe("lanes/graceful: resolveTurnLimits bounds", () => {
  it("graceTurns defaults to 5 and is clamped to [1, 20] (min 1 honored)", () => {
    assert.deepEqual(resolveTurnLimits({}), { maxTurns: undefined, graceTurns: DEFAULT_GRACE_TURNS });
    assert.deepEqual(resolveTurnLimits({ graceTurns: 0 }), { maxTurns: undefined, graceTurns: 1 });
    assert.deepEqual(resolveTurnLimits({ graceTurns: -7 }), { maxTurns: undefined, graceTurns: 1 });
    assert.deepEqual(resolveTurnLimits({ graceTurns: 99 }), { maxTurns: undefined, graceTurns: HARD_MAX_GRACE_TURNS });
    assert.deepEqual(resolveTurnLimits({ graceTurns: 3 }), { maxTurns: undefined, graceTurns: 3 });
  });

  it("maxTurns: undefined/non-positive/invalid = unlimited; else clamped to [1, 200]", () => {
    assert.equal(resolveTurnLimits({}).maxTurns, undefined);
    assert.equal(resolveTurnLimits({ maxTurns: 0 }).maxTurns, undefined);
    assert.equal(resolveTurnLimits({ maxTurns: -5 }).maxTurns, undefined);
    assert.equal(resolveTurnLimits({ maxTurns: Number.NaN }).maxTurns, undefined);
    assert.equal(resolveTurnLimits({ maxTurns: 2.9 }).maxTurns, 2);
    assert.equal(resolveTurnLimits({ maxTurns: 12 }).maxTurns, 12);
    assert.equal(resolveTurnLimits({ maxTurns: 5_000 }).maxTurns, HARD_MAX_MAX_TURNS);
  });
});

// ---- lanes: soft steer at maxTurns ----

describe("lanes/graceful: soft steer at maxTurns (once, not before)", () => {
  it("writes NO steer file and no 'steered' status while the run stays under maxTurns", async () => {
    const dir = tempDir("under");
    const steerDir = join(dir, "steer");
    try {
      const pool = new LanePool({ spawn: spawnTurns(3), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("under", {
        task: "quick",
        maxTurns: 10,
        graceTurns: 3,
        runId: "run-under",
        steerDir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.usage.turns, 3);
      assert.notEqual(result.stopReason, "steered");
      assert.equal(existsSync(steerFilePath("run-under", steerDir)), false, "no steer file under the limit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("steers exactly at maxTurns (wrap-up message payload, ONE file) and finishes 'steered' within grace", async () => {
    const dir = tempDir("steered");
    const steerDir = join(dir, "steer");
    try {
      const pool = new LanePool({ spawn: spawnTurns(4), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("wrap", {
        task: "long job",
        maxTurns: 2,
        graceTurns: 3,
        runId: "run-steer",
        steerDir,
      });

      // Finished on its own at turn 4 < maxTurns(2) + grace(3): clean wrap-up.
      assert.equal(result.exitCode, 0);
      assert.equal(result.usage.turns, 4);
      assert.equal(result.stopReason, "steered");
      assert.equal(result.errorMessage, undefined);

      // Steer file written at the soft limit (turn 2), still present (the fake
      // child has no steer-consuming adapter).
      const file = steerFilePath("run-steer", steerDir);
      assert.equal(existsSync(file), true, "steer file must be written at maxTurns");
      const payload = JSON.parse(readFileSync(file, "utf8")) as { runId: string; message: string; timestamp: number };
      assert.equal(payload.runId, "run-steer");
      assert.equal(payload.message, WRAP_UP_STEER_MESSAGE);
      assert.equal(typeof payload.timestamp, "number");

      // Written exactly ONCE: a single <runId>.steer file, no temp leftovers.
      assert.deepEqual(
        readdirSync(steerDir).filter((name) => name.endsWith(".steer")),
        ["run-steer.steer"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports a custom wrap-up message", async () => {
    const dir = tempDir("custom-msg");
    const steerDir = join(dir, "steer");
    try {
      const pool = new LanePool({ spawn: spawnTurns(2), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("custom", {
        task: "t",
        maxTurns: 1,
        graceTurns: 5,
        runId: "run-custom",
        steerDir,
        wrapUpMessage: "Finish now please.",
      });
      assert.equal(result.stopReason, "steered");
      const payload = JSON.parse(readFileSync(steerFilePath("run-custom", steerDir), "utf8")) as { message: string };
      assert.equal(payload.message, "Finish now please.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default graceTurns=5: a 6-turn run under maxTurns=2 wraps up cleanly (6 < 2+5)", async () => {
    const dir = tempDir("default-grace");
    const steerDir = join(dir, "steer");
    try {
      const pool = new LanePool({ spawn: spawnTurns(6), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("dg", {
        task: "t",
        maxTurns: 2,
        runId: "run-dg",
        steerDir,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stopReason, "steered");
      assert.equal(existsSync(steerFilePath("run-dg", steerDir)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- lanes: hard abort at maxTurns + graceTurns ----

describe("lanes/graceful: hard abort at maxTurns + graceTurns", () => {
  it("bounded-aborts (SIGTERM path) once turns reach maxTurns + graceTurns, after the soft steer", async () => {
    const dir = tempDir("aborted");
    const steerDir = join(dir, "steer");
    try {
      const pool = new LanePool({ spawn: spawnTurns(6), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("over", {
        task: "runaway",
        maxTurns: 1,
        graceTurns: 2,
        runId: "run-over",
        steerDir,
      });

      // Hard abort fired at turn 1+2=3 (bounded kill: exit 130, aborted).
      assert.equal(result.stopReason, "aborted");
      assert.equal(result.errorMessage, "Child agent aborted");
      assert.equal(result.exitCode, 130);
      assert.equal(result.usage.turns, 3, "abort lands exactly at maxTurns + graceTurns");
      // The soft steer was still delivered before the hard abort.
      assert.equal(existsSync(steerFilePath("run-over", steerDir)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("graceTurns is floored at 1: graceTurns=0 still grants exactly ONE grace turn", async () => {
    const dir = tempDir("grace-min");
    const steerDir = join(dir, "steer");
    try {
      const pool = new LanePool({ spawn: spawnTurns(2), sessionDir: join(dir, "sessions"), cwd: dir });
      const result = await pool.dispatch("g0", {
        task: "t",
        maxTurns: 1,
        graceTurns: 0, // -> clamped to 1: hard abort at turn 2, not at the steer turn
        runId: "run-g0",
        steerDir,
      });

      assert.equal(result.stopReason, "aborted");
      assert.equal(result.exitCode, 130);
      // If 0 were honored, the abort would land at turn 1 (usage.turns === 1);
      // with the floor the child gets its one grace turn (usage.turns === 2).
      assert.equal(result.usage.turns, 2);
      assert.equal(existsSync(steerFilePath("run-g0", steerDir)), true, "soft steer precedes the hard abort");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- engine plumbing: per-run options + run status steered/aborted ----

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-b3-eng-${label}-`));
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

describe("engine/dispatch: B3 turn-limit plumbing (per-run + defaults)", () => {
  it("per-run maxTurns/graceTurns: clean wrap-up -> ChildResult stopReason 'steered' and run status 'steered'", async () => {
    const dir = tempRepo("steered");
    const steerDir = join(dir, "steer");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: spawnTurns(4, ["--turns-deliverable"]),
        sessionDir: join(dir, "sessions"),
        steerDir,
        source: "delegate_task",
      });
      const result = await engine.single("alpha", contractTask("wrap up work"), {
        outputContract: "base.v1",
        maxTurns: 2,
        graceTurns: 3,
      });
      engine.close();

      assert.equal(result.exitCode, 0);
      assert.equal(result.stopReason, "steered");
      assert.equal(result.gatePassed, true);
      const run = engine.monitor.runs.find((candidate) => candidate.agent === "alpha")!;
      assert.equal(run.status, "steered");
      assert.equal(existsSync(steerFilePath(run.id, steerDir)), true, "engine writes the steer file under its steerDir");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("per-run maxTurns/graceTurns: overrun -> ChildResult stopReason 'aborted' and run status 'aborted'", async () => {
    const dir = tempRepo("aborted");
    const steerDir = join(dir, "steer");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: spawnTurns(6),
        sessionDir: join(dir, "sessions"),
        steerDir,
        source: "delegate_task",
      });
      const result = await engine.single("alpha", contractTask("runaway work"), {
        outputContract: "base.v1",
        maxTurns: 1,
        graceTurns: 2,
      });
      engine.close();

      assert.equal(result.stopReason, "aborted");
      assert.equal(result.exitCode, 130);
      assert.equal(result.usage.turns, 3);
      const run = engine.monitor.runs.find((candidate) => candidate.agent === "alpha")!;
      assert.equal(run.status, "aborted");
      assert.equal(existsSync(steerFilePath(run.id, steerDir)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("engine-level maxTurns/graceTurns defaults apply when per-run options are absent", async () => {
    const dir = tempRepo("engine-default");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: spawnTurns(5),
        sessionDir: join(dir, "sessions"),
        steerDir: join(dir, "steer"),
        maxTurns: 1,
        graceTurns: 1,
        source: "delegate_task",
      });
      const result = await engine.single("alpha", contractTask("default limits"), { outputContract: "base.v1" });
      engine.close();

      assert.equal(result.stopReason, "aborted");
      assert.equal(result.usage.turns, 2);
      assert.equal(engine.monitor.runs[0]!.status, "aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("per-run maxTurns overrides the engine default (looser per-run wins)", async () => {
    const dir = tempRepo("override");
    try {
      const engine = new DispatchEngine({
        repoRoot: dir,
        spawn: spawnTurns(3, ["--turns-deliverable"]),
        sessionDir: join(dir, "sessions"),
        steerDir: join(dir, "steer"),
        maxTurns: 1,
        source: "delegate_task",
      });
      const result = await engine.single("alpha", contractTask("loose per-run"), {
        outputContract: "base.v1",
        maxTurns: 50,
      });
      engine.close();

      assert.equal(result.exitCode, 0);
      assert.notEqual(result.stopReason, "steered");
      assert.notEqual(result.stopReason, "aborted");
      assert.equal(engine.monitor.runs[0]!.status, "complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- shared config: B3 defaults + bounds ----

describe("shared/config: B3 graceful turn-limit defaults", () => {
  it("defaults: defaultMaxTurns unlimited (undefined), defaultGraceTurns 5", () => {
    const dir = tempDir("cfg-default");
    try {
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.defaultMaxTurns, undefined);
      assert.equal(cfg.defaultGraceTurns, DEFAULT_GRACE_TURNS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clamps file values: maxTurns to [1,200] (0 = unlimited), graceTurns to [1,20]", () => {
    const dir = tempDir("cfg-file");
    try {
      const cfgDir = join(dir, ".subagents");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "config.json"),
        JSON.stringify({ defaultMaxTurns: 5_000, defaultGraceTurns: 0 }),
        "utf8",
      );
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.defaultMaxTurns, HARD_MAX_MAX_TURNS);
      assert.equal(cfg.defaultGraceTurns, 1);

      writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ defaultMaxTurns: 0 }), "utf8");
      assert.equal(loadConfig(dir, {}).defaultMaxTurns, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env overrides: SUBAGENTS_MAX_TURNS (0 = unlimited) and SUBAGENTS_GRACE_TURNS (clamped)", () => {
    const dir = tempDir("cfg-env");
    try {
      assert.equal(loadConfig(dir, { SUBAGENTS_MAX_TURNS: "8" }).defaultMaxTurns, 8);
      assert.equal(loadConfig(dir, { SUBAGENTS_MAX_TURNS: "0" }).defaultMaxTurns, undefined);
      assert.equal(loadConfig(dir, { SUBAGENTS_MAX_TURNS: "999" }).defaultMaxTurns, HARD_MAX_MAX_TURNS);
      assert.equal(loadConfig(dir, { SUBAGENTS_GRACE_TURNS: "2" }).defaultGraceTurns, 2);
      assert.equal(loadConfig(dir, { SUBAGENTS_GRACE_TURNS: "0" }).defaultGraceTurns, 1);
      assert.equal(loadConfig(dir, { SUBAGENTS_GRACE_TURNS: "99" }).defaultGraceTurns, HARD_MAX_GRACE_TURNS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
