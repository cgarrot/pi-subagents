#!/usr/bin/env node
// scripts/real-redirect-cases.mjs — REAL pi worker, real bash tool.
// One fresh worker per case (no cross-case contamination); events are
// subscribed BEFORE the prompt (no timestamp guessing).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RpcWorker, buildRpcArgs } from "../dist/src/rpc/worker.js";

const root = mkdtempSync(join(tmpdir(), "pi-subagents-real-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

function makeWorker(cwd) {
  const opts = { cwd, tools: "bash" };
  return new RpcWorker({
    ...opts,
    command: { bin: "pi", args: buildRpcArgs(opts) },
    defaultTimeoutMs: 60_000,
  });
}

function onceToolStart(worker, ms = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("tool_execution_start", handler);
      reject(new Error(`no bash tool start within ${ms}ms (stderr=${JSON.stringify(worker.stderrTail.slice(-300))})`));
    }, ms);
    const handler = (event) => {
      clearTimeout(timer);
      worker.off("tool_execution_start", handler);
      resolve(event);
    };
    worker.on("tool_execution_start", handler);
  });
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log("real pi RPC cases");
  console.log(`root: ${root}`);

  await check("redirect mid-TOOL: sleep 30 -> abort -> new instruction executes", async () => {
    const cwd = mkdtempSync(join(root, "redirect-"));
    const worker = makeWorker(cwd);
    try {
      const tool = onceToolStart(worker, 90_000);
      await worker.prompt(
        "You are in an automated smoke test. You MUST call the bash tool NOW with exactly: sleep 30 . " +
          "Do not answer with text, do not explain. Call the tool.",
      );
      await tool;
      assert.equal((await worker.getState()).isStreaming, true);

      const settled = worker.waitForSettled(20_000);
      await worker.abort();
      const event = await settled;
      assert.equal(event.aborted, true, "the old turn must be aborted");

      const secondTool = onceToolStart(worker, 90_000);
      const secondSettled = worker.waitForSettled(90_000);
      await worker.prompt("Use the bash tool with exactly: echo REDIRECT_OK > redirect-ok.txt . Then reply DONE.");
      await secondTool;
      await secondSettled;
      assert.equal(readFileSync(join(cwd, "redirect-ok.txt"), "utf8").trim(), "REDIRECT_OK");
      assert.equal(worker.alive, true);
    } finally {
      await worker.stop(500).catch(() => {});
    }
  });

  await check("steer during a long stream: the queued instruction executes", async () => {
    const cwd = mkdtempSync(join(root, "steer-"));
    const worker = makeWorker(cwd);
    try {
      await worker.prompt(
        "Write a very long 800-word essay about the history of Unix. Do not use any tools at all; just write.",
      );
      // Wait until the model is actually streaming.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (await worker.getState()).isStreaming !== true) await sleep(100);
      assert.equal((await worker.getState()).isStreaming, true, "the essay turn should be streaming");

      const tool = onceToolStart(worker, 90_000);
      const settled = worker.waitForSettled(90_000);
      await worker.steer(
        "STOP the essay now. Use the bash tool with exactly: echo STEER_OK > steer-ok.txt . Then reply DONE.",
      );
      await tool;
      await settled;
      assert.equal(readFileSync(join(cwd, "steer-ok.txt"), "utf8").trim(), "STEER_OK");
    } finally {
      await worker.stop(500).catch(() => {});
    }
  });

  await check("stop mid-TOOL kills the worker and its bash child", async () => {
    const cwd = mkdtempSync(join(root, "stop-"));
    const worker = makeWorker(cwd);
    try {
      const tool = onceToolStart(worker, 90_000);
      await worker.prompt(
        "You are in an automated smoke test. You MUST call the bash tool NOW with exactly: sleep 61 . " +
          "Do not answer with text. Call the tool.",
      );
      await tool;
      const pid = worker.pid;
      assert.ok(pid !== undefined);
      await worker.stop(2_000);
      assert.equal(worker.alive, false);
      let stays = true;
      try {
        process.kill(pid, 0);
      } catch {
        stays = false;
      }
      assert.equal(stays, false, "worker process must be gone");
      await sleep(400);
      let orphan = "";
      try {
        orphan = execFileSync("pgrep", ["-f", "sleep 61"], { encoding: "utf8" }).trim();
      } catch {
        orphan = "";
      }
      assert.equal(orphan, "", `bash child survived: ${orphan}`);
    } finally {
      await worker.stop(500).catch(() => {});
    }
  });

  rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CRASHED:", err);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
