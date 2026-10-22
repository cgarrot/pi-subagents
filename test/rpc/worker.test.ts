// test/rpc/worker.test.ts — the JSONL client against a deterministic fake
// worker. No real pi, no model, no network: framing, correlation, timeout,
// abort settlement and process-tree stop are all exercised here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RpcWorker, buildRpcArgs } from "../../src/rpc/worker.js";

const FAKE = fileURLToPath(new URL("../../../test/fixtures/fake-rpc-worker.mjs", import.meta.url));

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagents-rpc-"));
}

function fake(env: NodeJS.ProcessEnv = {}, timeoutMs = 5_000): { worker: RpcWorker; cwd: string; cleanup: () => Promise<void> } {
  const cwd = tempCwd();
  const worker = new RpcWorker({
    cwd,
    command: { bin: process.execPath, args: [FAKE] },
    env,
    defaultTimeoutMs: timeoutMs,
  });
  return {
    worker,
    cwd,
    cleanup: async () => {
      await worker.stop(200);
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("rpc/worker: spawn args are hermetic", () => {
  it("default args disable extensions and MCP; guard adds the child adapter", () => {
    const plain = buildRpcArgs({ cwd: "/tmp" });
    assert.deepEqual(plain.slice(0, 5), ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp"]);
    assert.equal(plain.includes("-e"), false, "no extension by default (no phantom mesh peer)");

    const guarded = buildRpcArgs({ cwd: "/tmp", guard: true, model: "m", name: "n" });
    assert.ok(guarded.includes("--no-extensions"));
    assert.ok(guarded.includes("-e"), "guard loads the explicit child adapter");
    assert.ok(guarded.includes("--model"));
    assert.ok(guarded.includes("--name"));
  });
});

describe("rpc/worker: protocol", () => {
  it("get_state responds and the stderr ring is captured", async () => {
    const { worker, cleanup } = fake();
    try {
      const state = await worker.getState();
      assert.equal(state.isStreaming, false);
      assert.equal(state.promptCount, 0);
      // stdout and stderr are independent streams: the response can land
      // before the child's startup stderr chunk. Poll briefly, don't flake.
      for (let i = 0; i < 40 && !worker.stderrTail.includes("fake-rpc-worker ready"); i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.match(worker.stderrTail, /fake-rpc-worker ready/);
    } finally {
      await cleanup();
    }
  });

  it("prompt starts a turn; agent_settled reports aborted=false", async () => {
    const { worker, cleanup } = fake({ FAKE_RPC_BUSY_MS: "50" });
    try {
      await worker.prompt("hello");
      const settled = await worker.waitForSettled(3_000);
      assert.equal(settled.aborted, false);
      const state = await worker.getState();
      assert.equal(state.isStreaming, false);
      assert.equal(state.promptCount, 1);
      assert.equal(state.lastMessage, "hello");
    } finally {
      await cleanup();
    }
  });

  it("a non-JSON line is a protocol_error, not a crash", async () => {
    const { worker, cleanup } = fake({ FAKE_RPC_BAD_LINE: "1" });
    try {
      const errors: unknown[] = [];
      worker.on("protocol_error", (e) => errors.push(e));
      await worker.getState();
      assert.equal(errors.length, 1);
    } finally {
      await cleanup();
    }
  });

  it("a missing response rejects with rpc_timeout", async () => {
    const { worker, cleanup } = fake({}, 5_000);
    try {
      await assert.rejects(worker.request({ type: "hang" }, 80), /rpc_timeout/);
    } finally {
      await cleanup();
    }
  });
});

describe("rpc/worker: abort + stop", () => {
  it("abort settles the running turn quickly (history kept, process alive)", async () => {
    const { worker, cleanup } = fake({ FAKE_RPC_BUSY_MS: "30000" });
    try {
      const started = worker.waitForEvent("turn_start", () => true, 2_000);
      await worker.prompt("run a long thing");
      await started;
      assert.equal((await worker.getState()).isStreaming, true);

      const t0 = Date.now();
      const settled = worker.waitForSettled(5_000);
      await worker.abort();
      const event = await settled;
      assert.equal(event.aborted, true);
      assert.ok(Date.now() - t0 < 2_000, "abort must not wait for the long turn");
      assert.equal((await worker.getState()).isStreaming, false);
      assert.equal(worker.alive, true, "abort keeps the worker (and its history) alive");
    } finally {
      await cleanup();
    }
  });

  it("stop kills the worker process tree and reports not-alive", async () => {
    const { worker, cleanup } = fake({ FAKE_RPC_BUSY_MS: "30000" });
    try {
      await worker.prompt("long");
      const pid = worker.pid;
      assert.ok(pid !== undefined);
      assert.equal(pidAlive(pid), true);
      await worker.stop(500);
      assert.equal(worker.alive, false);
      // The OS may need a tick to reap; a bounded poll keeps the test honest.
      for (let i = 0; i < 20 && pidAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 25));
      assert.equal(pidAlive(pid), false, "the worker process must be gone");
    } finally {
      await cleanup();
    }
  });

  it("a worker that exits makes pending requests reject (no hang)", async () => {
    const { worker, cleanup } = fake({ FAKE_RPC_EXIT_ON: "prompt" }, 10_000);
    try {
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      await worker.prompt("boom");
      await exited;
      await assert.rejects(worker.getState(), /rpc_worker_not_running|rpc_worker_exited/);
    } finally {
      await cleanup();
    }
  });
});
