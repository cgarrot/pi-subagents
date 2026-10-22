// test/rpc/tools.test.ts — the six control tools against a fake worker.
// Drives the REAL tool definitions through the stub ExtensionAPI, so the
// assertions cover parameter validation, honest statuses, and the redirect
// ordering (abort → settle → prompt), not just the worker client.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { RpcWorker } from "../../src/rpc/worker.js";
import { RpcWorkerRegistry } from "../../src/rpc/registry.js";
import { registerRpcTools } from "../../src/extension/rpc-tools.js";
import { fakeCtx, stubApi } from "../extension/stub-api.js";
import type { ToolResult } from "../../src/extension/pi-types.js";

const FAKE = fileURLToPath(new URL("../../../test/fixtures/fake-rpc-worker.mjs", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn) await fn();
  }
});

function harness(busyMs = 30_000, maxWorkers = 4): {
  tools: ReturnType<typeof stubApi>["tools"];
  registry: RpcWorkerRegistry;
  cwd: string;
  call: (name: string, params: Record<string, unknown>) => Promise<ToolResult>;
} {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-rpc-tools-"));
  const registry = new RpcWorkerRegistry(
    (opts) =>
      new RpcWorker({
        ...opts,
        command: { bin: process.execPath, args: [FAKE] },
        env: { ...(opts.env ?? {}), FAKE_RPC_BUSY_MS: String(busyMs) },
      }),
    maxWorkers,
  );
  const captured = stubApi();
  registerRpcTools(captured.api, () => registry);
  cleanup.push(async () => {
    await registry.disposeAll();
    rmSync(cwd, { recursive: true, force: true });
  });
  const call = async (name: string, params: Record<string, unknown>): Promise<ToolResult> => {
    const tool = captured.tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    return tool.execute("call", params, undefined, undefined, fakeCtx(cwd));
  };
  return { tools: captured.tools, registry, cwd, call };
}

function details(result: ToolResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

async function startRun(call: (name: string, params: Record<string, unknown>) => Promise<ToolResult>): Promise<string> {
  const res = await call("rpc_start", {});
  assert.equal(details(res).status, "started", JSON.stringify(res));
  const runId = details(res).runId;
  assert.equal(typeof runId, "string");
  return runId as string;
}

describe("rpc tools: registration + start", () => {
  it("registers the six one-action tools with valid schemas", () => {
    const { tools } = harness();
    assert.deepEqual([...tools.keys()].sort(), [
      "rpc_abort",
      "rpc_prompt",
      "rpc_redirect",
      "rpc_start",
      "rpc_state",
      "rpc_stop",
    ]);
    for (const tool of tools.values()) {
      assert.ok(tool.description.length > 0);
      assert.ok(tool.promptSnippet !== undefined && tool.promptSnippet.length > 0);
      assert.equal(tool.parameters.type, "object");
      assert.equal(typeof tool.execute, "function");
    }
  });

  it("start probes readiness and reports the honest started status", async () => {
    const { call, registry, cwd } = harness();
    const runId = await startRun(call);
    const info = registry.get(runId);
    assert.equal(info?.status, "running");
    assert.equal(info?.cwd, cwd);
    assert.ok(info?.pid !== undefined);
  });

  it("start enforces the concurrency cap", async () => {
    const { call } = harness(30_000, 1);
    await startRun(call);
    const second = await call("rpc_start", {});
    assert.equal(details(second).status, "error");
    assert.match(String(details(second).reason), /rpc_max_workers/);
  });
});

describe("rpc tools: specialist agent cards", () => {
  it("start with an agent card passes the card prompt/tools and dispatches the first task", async () => {
    const { call, cwd } = harness();
    const agentsDir = join(cwd, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "implementer.md"),
      "---\nname: implementer\ndescription: test implementer\ntools: read, bash\n---\nYou are the implementer.\n",
      "utf8",
    );
    const res = await call("rpc_start", { agent: "implementer", task: "do the thing" });
    assert.equal(details(res).status, "started", JSON.stringify(res));
    assert.equal(details(res).agent, "implementer");
    assert.equal(details(res).taskDispatched, true);
    const runId = details(res).runId as string;
    const state = await call("rpc_state", { runId });
    const live = details(state).state as { promptCount?: number; lastMessage?: string };
    assert.equal(live.promptCount, 1);
    assert.equal(live.lastMessage, "do the thing");
  });

  it("an unknown agent is an honest error with the available names", async () => {
    const { call } = harness();
    const res = await call("rpc_start", { agent: "nope" });
    assert.equal(details(res).status, "error");
    assert.equal(details(res).reason, "unknown_agent");
    assert.match(res.content[0]!.text, /available:/);
  });
});

describe("rpc tools: prompt + state", () => {
  it("prompt is accepted, state shows streaming, then settled after the turn", async () => {
    const { call } = harness(80);
    const runId = await startRun(call);
    const prompt = await call("rpc_prompt", { runId, message: "hello" });
    assert.equal(details(prompt).status, "accepted");

    const streaming = await call("rpc_state", { runId });
    assert.equal((details(streaming).state as { isStreaming?: boolean }).isStreaming, true);

    await new Promise((r) => setTimeout(r, 200));
    const settled = await call("rpc_state", { runId });
    assert.equal((details(settled).state as { isStreaming?: boolean }).isStreaming, false);
  });

  it("a plain prompt while streaming is rejected by the worker (honest error)", async () => {
    const { call } = harness();
    const runId = await startRun(call);
    await call("rpc_prompt", { runId, message: "long" });
    const second = await call("rpc_prompt", { runId, message: "again" });
    assert.equal(details(second).status, "error");
    assert.match(String(details(second).reason), /streaming/);
  });

  it("rpc_state without runId lists the session workers", async () => {
    const { call } = harness();
    const runId = await startRun(call);
    const list = await call("rpc_state", {});
    assert.equal(details(list).count, 1);
    assert.deepEqual((details(list).runs as Array<{ runId: string }>).map((r) => r.runId), [runId]);
  });
});

describe("rpc tools: abort", () => {
  it("aborts a busy turn, keeps the worker alive, reports aborted=true", async () => {
    const { call, registry } = harness();
    const runId = await startRun(call);
    await call("rpc_prompt", { runId, message: "run a 30s thing" });

    const res = await call("rpc_abort", { runId });
    assert.equal(details(res).status, "aborted");
    assert.equal(details(res).aborted, true);
    assert.equal(registry.get(runId)?.status, "running", "abort must not stop the worker");

    const state = await call("rpc_state", { runId });
    assert.equal((details(state).state as { isStreaming?: boolean }).isStreaming, false);
  });

  it("an idle worker returns not_streaming (never a fake abort)", async () => {
    const { call } = harness();
    const runId = await startRun(call);
    const res = await call("rpc_abort", { runId });
    assert.equal(details(res).status, "not_streaming");
  });

  it("unknown run ids are honest not_found", async () => {
    const { call } = harness();
    for (const name of ["rpc_abort", "rpc_prompt", "rpc_redirect", "rpc_stop"]) {
      const res = await call(name, { runId: "rpc_nope", message: "x" });
      assert.equal(details(res).status, "not_found", name);
    }
  });
});

describe("rpc tools: redirect", () => {
  it("redirect aborts the running turn THEN prompts the new instruction", async () => {
    const { call } = harness();
    const runId = await startRun(call);
    await call("rpc_prompt", { runId, message: "old plan" });

    const res = await call("rpc_redirect", { runId, message: "new plan" });
    assert.equal(details(res).status, "redirected");
    assert.equal(details(res).aborted, true);

    const state = await call("rpc_state", { runId });
    const live = details(state).state as { promptCount?: number; lastMessage?: string; isStreaming?: boolean };
    assert.equal(live.promptCount, 2);
    assert.equal(live.lastMessage, "new plan");
    assert.equal(live.isStreaming, true, "the redirected instruction started a new turn");
  });

  it("redirect on an idle worker prompts without aborting", async () => {
    const { call } = harness(80);
    const runId = await startRun(call);
    const res = await call("rpc_redirect", { runId, message: "just do this" });
    assert.equal(details(res).status, "redirected");
    assert.equal(details(res).aborted, false);
    const state = await call("rpc_state", { runId });
    assert.equal((details(state).state as { promptCount?: number }).promptCount, 1);
  });
});

describe("rpc tools: stop", () => {
  it("stop terminates the worker; state reports the terminal status", async () => {
    const { call, registry } = harness();
    const runId = await startRun(call);
    const res = await call("rpc_stop", { runId });
    assert.equal(details(res).status, "stopped");
    assert.equal(registry.get(runId)?.status, "stopped");
    const state = await call("rpc_state", { runId });
    assert.equal(details(state).status, "stopped");
  });
});
