#!/usr/bin/env node
// scripts/real-run-control-e2e.mjs — REAL pi session + mesh_run_control.
//
// bob2 is a real `pi --mode rpc` session (full tools) loading the LOCAL
// pi-subagents. The model is asked to call `rpc_start`; alice (this script's
// MeshClient) then stops that worker through the mesh (`run_stop`).
//
// Requires a model. Dev-only (imports the sibling pi-mesh build), not CI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshClient } from "../../pi-mesh/dist/src/client/client.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const meshRepo = resolve(repo, "../pi-mesh");
const jobdRepo = resolve(repo, "../pi-jobd");
const root = mkdtempSync(join(tmpdir(), "pi-subagents-run-e2e-"));
const rt = join(root, "rt");
const state = join(root, "state");
const bobCwd = join(root, "bob2");
mkdirSync(rt, { recursive: true });
mkdirSync(state, { recursive: true });
mkdirSync(bobCwd, { recursive: true });
const policy = join(state, "policy.json");
writeFileSync(
  policy,
  `${JSON.stringify({ allow: [{ from: "*", to: "*", room: "*" }], forceAllowedFrom: ["alice"] })}\n`,
);

// Hermetic: the surrounding pi session may export the real mesh endpoint.
delete process.env.MESH_BROKER_URL;
delete process.env.MESH_BROKER_TOKEN;
process.env.MESH_RUNTIME_DIR = rt;
process.env.MESH_STATE_DIR = state;
process.env.MESH_POLICY = policy;
process.env.MESH_ALIAS = "alice";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = setInterval(() => {}, 1_000); // MeshClient timers are unref'd

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

const alice = new MeshClient({ alias: "alice", rooms: ["default"], runtimeDir: rt, config: {}, noReconnect: true });
await alice.connect();

const env = {
  ...process.env,
  MESH_ALIAS: "bob2",
  MESH_ROOMS: "default",
  MESH_STATE_DIR: state,
  MESH_RUNTIME_DIR: rt,
  MESH_POLICY: policy,
  PI_JOBD_STATE_DIR: join(root, "jobd"),
};
const proc = spawn(
  "pi",
  [
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp",
    "-e", join(meshRepo, "index.ts"),
    "-e", join(jobdRepo, "index.ts"),
    "-e", join(repo, "index.ts"),
  ],
  { cwd: bobCwd, env, stdio: ["pipe", "pipe", "pipe"] },
);

let buf = "";
let seq = 0;
const history = [];
const pending = new Map();
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "response" && pending.has(rec.id)) {
      const p = pending.get(rec.id);
      pending.delete(rec.id);
      clearTimeout(p.timer);
      if (rec.success) p.resolve(rec);
      else p.reject(new Error(rec.error ?? `${rec.command} failed`));
      continue;
    }
    history.push(rec);
  }
});
proc.stderr.setEncoding("utf8");
let stderr = "";
proc.stderr.on("data", (c) => {
  stderr = (stderr + c).slice(-2_000);
});
proc.on("error", (err) => {
  stderr = `spawn error: ${err.message}`;
});
proc.on("exit", (code, signal) => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(`bob2 exited (${code}/${signal}) ${stderr.slice(-300)}`));
  }
  pending.clear();
});

function request(command, timeoutMs = 60_000) {
  const id = `r${++seq}`;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc timeout: ${command.type}`));
    }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
}

async function main() {
  console.log("real pi session + mesh_run_control");
  console.log(`root: ${root}`);
  await waitFor(async () => (await alice.status()).peers.some((p) => p.alias === "bob2"), 25_000, "bob2 online");
  console.log("  bob2 online");

  await request({ type: "prompt", message:
    `Call the rpc_start tool with exactly these parameters: { "cwd": "${bobCwd}", "task": "You MUST call the bash tool with exactly: sleep 60 . Do not answer with text." } . ` +
    "Do not answer with text; just call the tool." }, 30_000);

  const deadline = Date.now() + 90_000;
  let end;
  while (Date.now() < deadline && end === undefined) {
    end = history.find(
      (r) => r.type === "tool_execution_end" && /rpc_start/.test(String(r.toolName ?? r.name ?? "")),
    );
    if (end === undefined) await sleep(100);
  }
  assert.ok(end, "the model did not call rpc_start");
  const runId = end.result?.details?.runId;
  const pid = end.result?.details?.pid;
  console.log(`  rpc_start -> ${runId} pid=${pid}`);
  assert.match(String(runId), /^rpc_/);

  const ack = await alice.control({ to: "bob2", action: "run_stop", target: runId, timeoutMs: 20_000 });
  console.log("  run_stop ack:", JSON.stringify(ack));
  assert.equal(ack.status, "stopped");
  assert.equal(ack.target, runId);
  if (typeof pid === "number") {
    await sleep(500);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the worker process must be gone");
  }
  console.log("PASS: pi-mesh -> pi-subagents run_stop (live pi session)");
}

main()
  .catch((err) => {
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(keep);
    proc.kill("SIGKILL");
    await alice.close().catch(() => {});
    try {
      const lock = readFileSync(join(rt, "broker.lock"), "utf8").trim();
      const brokerPid = Number(lock);
      if (Number.isInteger(brokerPid) && brokerPid > 0) process.kill(brokerPid, "SIGTERM");
    } catch {
      // no broker
    }
    rmSync(root, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
