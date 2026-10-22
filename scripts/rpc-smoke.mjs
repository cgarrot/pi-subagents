#!/usr/bin/env node
// scripts/rpc-smoke.mjs — headless E2E for the controller-owned RPC worker.
//
// Default: a deterministic fake worker (no model, no network). It exercises
// the real registry + worker client: start → prompt → redirect (abort →
// settle → new prompt) → abort → stop.
//
// RPC_SMOKE_REAL=1: additionally starts a REAL `pi --mode rpc` worker, probes
// get_state, prompts a one-word answer, waits for agent_settled, and stops it.
// That path calls a model; run it explicitly.
//
// Requires `npm run build` first (imports dist/).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcWorker, buildRpcArgs } from "../dist/src/rpc/worker.js";
import { RpcWorkerRegistry } from "../dist/src/rpc/registry.js";

const FAKE = fileURLToPath(new URL("../test/fixtures/fake-rpc-worker.mjs", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-smoke-"));
const cleanup = [];
let passed = 0;
let failed = 0;

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

async function fakeFlow() {
  const registry = new RpcWorkerRegistry(
    (opts) =>
      new RpcWorker({
        ...opts,
        command: { bin: process.execPath, args: [FAKE] },
        env: { ...(opts.env ?? {}), FAKE_RPC_BUSY_MS: "30000" },
      }),
    2,
  );
  cleanup.push(() => registry.disposeAll());

  console.log("[1] start + readiness probe");
  const run = await registry.start({ cwd });
  await check("started with a pid", () => assert.ok(run.pid !== undefined));
  await check("status is running", () => assert.equal(run.status, "running"));

  const worker = registry.worker(run.runId);
  assert.ok(worker, "worker must exist");

  console.log("[2] prompt starts a turn (streaming)");
  const started = worker.waitForEvent("turn_start", () => true, 2_000);
  await worker.prompt("old plan");
  await started;
  await check("streaming after prompt", async () => {
    assert.equal((await worker.getState()).isStreaming, true);
  });

  console.log("[3] redirect = abort -> settle -> new prompt");
  const settled = worker.waitForSettled(5_000);
  await worker.abort();
  const event = await settled;
  await worker.prompt("new plan");
  const state = await worker.getState();
  await check("aborted the old turn", () => assert.equal(event.aborted, true));
  await check("worker stayed alive", () => assert.equal(worker.alive, true));
  await check("new prompt received (promptCount=2)", () => assert.equal(state.promptCount, 2));
  await check("last message is the new plan", () => assert.equal(state.lastMessage, "new plan"));

  console.log("[4] abort again, then stop the process tree");
  const settled2 = worker.waitForSettled(5_000);
  await worker.abort();
  const event2 = await settled2;
  await check("second abort settled", () => assert.equal(event2.aborted, true));
  const pid = run.pid;
  await registry.stop(run.runId);
  await check("stopped", () => assert.equal(registry.get(run.runId)?.status, "stopped"));
  if (pid !== undefined) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    await check("worker process is gone", () => assert.equal(alive, false));
  }
}

async function realFlow() {
  console.log("[5] REAL pi worker (get_state + prompt + settle + stop)");
  // Outside a pi session argv[1] is THIS script: spawn the real `pi` bin
  // explicitly instead of reusing the pi entry heuristic.
  const registry = new RpcWorkerRegistry(
    (opts) => new RpcWorker({ ...opts, command: { bin: "pi", args: buildRpcArgs(opts) } }),
  );
  cleanup.push(() => registry.disposeAll());
  const run = await registry.start({ cwd });
  await check("real worker started", () => assert.equal(run.status, "running"));
  const worker = registry.worker(run.runId);
  assert.ok(worker);
  const p = worker.prompt("Reply with exactly the word OK and nothing else.", { timeoutMs: 60_000 });
  await p;
  const settled = await worker.waitForSettled(120_000);
  await check("real turn settled", () => assert.equal(typeof settled.aborted, "boolean"));
  const state = await worker.getState();
  await check("real state readable", () => assert.equal(state.isStreaming, false));
  await registry.stop(run.runId);
}

async function main() {
  console.log("pi-subagents RPC worker smoke");
  await fakeFlow();
  if (process.env.RPC_SMOKE_REAL === "1") {
    await realFlow();
  } else {
    console.log("[5] real pi worker skipped (RPC_SMOKE_REAL=1 to include it)");
  }
  for (const fn of cleanup.reverse()) await fn();
  rmSync(cwd, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("SMOKE CRASHED:", err);
  for (const fn of cleanup.reverse()) await fn();
  rmSync(cwd, { recursive: true, force: true });
  process.exit(1);
});
