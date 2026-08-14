// test/lanes/pool.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LanePool } from "../../src/lanes/pool.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";

// Headless: every test injects a SpawnFn that runs the fake-pi fixture. No real
// `pi` binary is ever launched.
const FAKE_PI = fileURLToPath(new URL("../../../test/fixtures/bin/fake-pi.mjs", import.meta.url));

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-${label}-`));
}

const spawnFakePi: SpawnFn = ({ args, cwd, env }) =>
  spawn(process.execPath, [FAKE_PI, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });

const spawnFakePiFail: SpawnFn = ({ args, cwd, env }) =>
  spawn(process.execPath, [FAKE_PI, "--fail", ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });

const spawnHanging: SpawnFn = ({ args, cwd, env }) =>
  spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0), 60000)"], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });

describe("lanes/pool: single task full flow (spawn-per-task)", () => {
  it("boots, streams NDJSON to completion and records the stable session path", async () => {
    const dir = tempDir("one");
    try {
      const pool = new LanePool({ spawn: spawnFakePi, sessionDir: dir, cwd: dir, maxParallel: 2 });
      const result = await pool.dispatch("alpha", { task: "explain lanes" });

      assert.equal(result.exitCode, 0);
      assert.equal(result.output, "answer:explain lanes");
      assert.ok(result.sessionPath, "sessionPath should be set");
      assert.equal(result.sessionPath, join(dir, "alpha.jsonl"));
      assert.equal(pool.isLaneActive("alpha"), false);
      assert.equal(pool.laneCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lanes/pool: chain — stable session reused per lane", () => {
  it("two tasks on the same lane reuse the SAME sessionPath; a different lane gets a different one", async () => {
    const dir = tempDir("chain");
    try {
      const pool = new LanePool({ spawn: spawnFakePi, sessionDir: dir, cwd: dir });
      const r1 = await pool.dispatch("chain", { task: "task one" });
      const r2 = await pool.dispatch("chain", { task: "task two" });

      // Context continuity: same lane => same session file.
      assert.equal(r1.sessionPath, r2.sessionPath);
      assert.equal(r1.sessionPath, join(dir, "chain.jsonl"));
      assert.ok(r1.output.includes("task one"));
      assert.ok(r2.output.includes("task two"));

      // Different lane => distinct session path.
      const r3 = await pool.dispatch("other", { task: "task three" });
      assert.notEqual(r3.sessionPath, r1.sessionPath);
      assert.equal(r3.sessionPath, join(dir, "other.jsonl"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lanes/pool: bounded abort via closeAll (I15 no leak)", () => {
  it("aborts an in-flight task with a bounded kill and marks the pool closed", async () => {
    const dir = tempDir("abort");
    try {
      const pool = new LanePool({ spawn: spawnHanging, sessionDir: dir, cwd: dir });
      const inFlight = pool.dispatch("hang", { task: "long" });
      await new Promise((resolve) => setTimeout(resolve, 150)); // let it spawn

      assert.equal(pool.isLaneActive("hang"), true);

      pool.closeAll();
      const result = await inFlight;
      assert.equal(pool.isClosed, true);
      assert.equal(result.exitCode, 130);
      assert.equal(result.stopReason, "aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lanes/pool: idle close", () => {
  it("closeIdle removes idle (no in-flight) lanes; active lanes are preserved", async () => {
    const dir = tempDir("idle");
    try {
      let now = 1000;
      const pool = new LanePool({ spawn: spawnFakePi, sessionDir: dir, cwd: dir, now: () => now });

      await pool.dispatch("idle-lane", { task: "t" }); // completes, lastUsedAt = 1000
      now += 1000;

      const removed = pool.closeIdle(500); // idle 1000ms >= 500ms
      assert.deepEqual(removed, ["idle-lane"]);
      assert.equal(pool.laneCount, 0);

      // Re-dispatch on the same lane re-registers it.
      const again = await pool.dispatch("idle-lane", { task: "t2" });
      assert.ok(again.sessionPath);
      assert.equal(pool.laneCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closeIdle does NOT remove a lane with an in-flight task", async () => {
    const dir = tempDir("idle-active");
    try {
      const pool = new LanePool({ spawn: spawnHanging, sessionDir: dir, cwd: dir });
      const inFlight = pool.dispatch("busy", { task: "long" });
      await new Promise((resolve) => setTimeout(resolve, 150));

      const removed = pool.closeIdle(0);
      assert.deepEqual(removed, []); // busy lane is active, never idle-closed
      pool.closeAll();
      await inFlight;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lanes/pool: clean failure on non-zero exit", () => {
  it("exit != 0 yields a ChildResult with non-zero exitCode (no throw)", async () => {
    const dir = tempDir("fail");
    try {
      const pool = new LanePool({ spawn: spawnFakePiFail, sessionDir: dir, cwd: dir });
      const result = await pool.dispatch("fail-lane", { task: "boom" });

      assert.equal(result.exitCode, 3);
      assert.notEqual(result.output, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lanes/pool: probe is an injectable hook never awaited on the critical path", () => {
  it("fires the probe but dispatch completes regardless of probe timing", async () => {
    const dir = tempDir("probe");
    try {
      const probed: Array<{ model: string; lane: string }> = [];
      const pool = new LanePool({
        spawn: spawnFakePi,
        sessionDir: dir,
        cwd: dir,
        probe: (model, lane) => {
          probed.push({ model, lane });
          // Simulate a slow probe that must NOT block dispatch.
          return new Promise((resolve) => setTimeout(resolve, 50));
        },
      });

      const result = await pool.dispatch("probe-lane", { task: "t", model: "openai/gpt-5.5" });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(probed, [{ model: "openai/gpt-5.5", lane: "probe-lane" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// B4 cost tracking — fake pi emitting N assistant message_end events whose
// usage grows CUMULATIVELY each turn (pi re-encodes the conversation per
// turn). The accumulated run usage must equal the DELTAS (== last cumulative
// snapshot), NEVER the naive sum of message_end usage (double-counting).
describe("lanes/pool: usage accumulation via fake pi multi-turn (B4 anti-double-counting)", () => {
  const spawnFakePiUsageTurns = (turns: number): SpawnFn => ({ args, cwd, env }) =>
    spawn(process.execPath, [FAKE_PI, "--usage-turns", String(turns), ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

  it("3 growing message_end turns -> usage = deltas/last snapshot, not the sum", async () => {
    const dir = tempDir("usage");
    try {
      const pool = new LanePool({ spawn: spawnFakePiUsageTurns(3), sessionDir: dir, cwd: dir });
      const result = await pool.dispatch("cost-lane", { task: "expensive" });

      assert.equal(result.exitCode, 0);
      assert.equal(result.output, "answer:expensive");
      assert.equal(result.usage.turns, 3);
      // input snapshots 1000/2000/3000 -> deltas sum to 3000 (== last), NOT 6000.
      assert.equal(result.usage.input, 3_000);
      assert.notEqual(result.usage.input, 6_000);
      // output snapshots 100/200/300 -> 300 (== last), NOT 600.
      assert.equal(result.usage.output, 300);
      assert.notEqual(result.usage.output, 600);
      // cacheRead snapshots 0/2000/4000 -> 4000 (== last), NOT 6000.
      assert.equal(result.usage.cacheRead, 4_000);
      assert.notEqual(result.usage.cacheRead, 6_000);
      // current-context semantics: LAST totalTokens snapshot (3300), not a sum.
      assert.equal(result.usage.contextTokens, 3_300);
      // cost snapshots 0.001/0.002/0.003 -> 0.003 (== last), NOT 0.006.
      assert.ok(Math.abs(result.usage.cost - 0.003) < 1e-9, `cost ${result.usage.cost}`);
      assert.ok(Math.abs(result.usage.cost - 0.006) > 1e-9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("single-turn usage is carried through unchanged (no delta distortion)", async () => {
    const dir = tempDir("usage1");
    try {
      const pool = new LanePool({ spawn: spawnFakePiUsageTurns(1), sessionDir: dir, cwd: dir });
      const result = await pool.dispatch("one-cost", { task: "cheap" });

      assert.equal(result.usage.turns, 1);
      assert.equal(result.usage.input, 1_000);
      assert.equal(result.usage.output, 100);
      assert.equal(result.usage.contextTokens, 1_100);
      assert.ok(Math.abs(result.usage.cost - 0.001) < 1e-9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
