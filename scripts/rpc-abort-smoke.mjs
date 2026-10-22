#!/usr/bin/env node
// scripts/rpc-abort-smoke.mjs — REAL pi, mid-TOOL abort.
//
// Forces the worker to call the bash tool (tools=bash only, explicit prompt),
// waits for tool_execution_start, aborts, and measures the settle. This is the
// claim that matters: redirect can interrupt a running tool, not just a
// streaming reflection.
//
// Requires a model/credentials. Not part of CI (cost/no-key runners).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcWorker, buildRpcArgs } from "../dist/src/rpc/worker.js";

const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-abort-smoke-"));
const opts = { cwd, tools: "bash" };
const worker = new RpcWorker({
  ...opts,
  command: { bin: "pi", args: buildRpcArgs(opts) },
  defaultTimeoutMs: 60_000,
});

let toolAt = null;
worker.on("tool_execution_start", (event) => {
  if (toolAt === null) {
    toolAt = Date.now();
    console.log(`tool started: ${event.toolName ?? event.name}`);
  }
});

async function main() {
  const t0 = Date.now();
  await worker.prompt(
    "You are in a smoke test. Call the bash tool RIGHT NOW with the command: sleep 30 . " +
      "Do not reply with text, do not explain, just call the tool.",
  );
  const deadline = Date.now() + 25_000;
  while (toolAt === null && Date.now() < deadline) {
    const state = await worker.getState();
    if (state.isStreaming !== true) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(toolAt !== null, "the model did not call the bash tool (model-dependent smoke)");
  const state = await worker.getState();
  assert.equal(state.isStreaming, true, "the tool turn should be running");

  const abortAt = Date.now();
  const settled = worker.waitForSettled(20_000);
  await worker.abort();
  const event = await settled;
  const ms = Date.now() - abortAt;
  console.log(`abort settled in ${ms} ms (aborted=${event.aborted}), worker alive=${worker.alive}`);
  assert.equal(event.aborted, true, "abort must report aborted=true");
  assert.ok(ms < 5_000, `abort took ${ms}ms`);
  assert.equal(worker.alive, true, "abort must keep the worker (history preserved)");
  console.log("PASS: mid-tool abort (real pi)");
}

main()
  .catch((err) => {
    console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await worker.stop(500);
    rmSync(cwd, { recursive: true, force: true });
  });
