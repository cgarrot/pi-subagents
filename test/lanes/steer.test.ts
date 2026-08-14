// test/lanes/steer.test.ts — parent-side steer-file channel (B2).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { steer, steerFilePath, type SteerFilePayload } from "../../src/lanes/steer.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-steer-${label}-`));
}

describe("lanes/steer: atomic steer-file write", () => {
  it("writes a <runId>.steer file with the structured payload and returns its path", () => {
    const dir = tempDir("write");
    try {
      const target = steer("run_abc", "please focus on the oracle gate", dir);
      assert.equal(target, steerFilePath("run_abc", dir));
      assert.equal(target, join(dir, "run_abc.steer"));
      assert.equal(existsSync(target), true);

      const payload = JSON.parse(readFileSync(target, "utf8")) as SteerFilePayload;
      assert.equal(payload.runId, "run_abc");
      assert.equal(payload.message, "please focus on the oracle gate");
      assert.equal(typeof payload.timestamp, "number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the steer dir if it does not exist", () => {
    const base = tempDir("mkdir");
    try {
      const nested = join(base, "deep", "steer");
      const target = steer("run_x", "msg", nested);
      assert.equal(existsSync(target), true);
      assert.equal(existsSync(nested), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("overwrites an existing steer file atomically (no leftover temp files)", () => {
    const dir = tempDir("overwrite");
    try {
      steer("run_y", "first", dir);
      steer("run_y", "second", dir);
      const payload = JSON.parse(readFileSync(join(dir, "run_y.steer"), "utf8")) as SteerFilePayload;
      assert.equal(payload.message, "second");
      // Atomic write leaves no temp artifacts behind.
      const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
