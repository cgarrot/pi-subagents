// test/extension/rpc.test.ts — B7: cross-extension RPC over pi.events.
// ping/spawn/stop reply EXACTLY ONCE on `subagents:rpc:reply:<requestId>`
// with standardized {success:true,data} / {success:false,error} envelopes,
// hash-only spawn results (never the child output body), and lifecycle
// emission on RPC stop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256 } from "../../src/core/hashing.js";
import { SubagentsEventBus } from "../../src/extension/events.js";
import {
  RPC_CHANNEL,
  RPC_MALFORMED_REQUEST_ID,
  RPC_METHODS,
  RPC_PING_CHANNEL,
  RPC_PROTOCOL_VERSION,
  RPC_SPAWN_CHANNEL,
  RPC_STOP_CHANNEL,
  handleRpcPayload,
  registerSubagentsRpc,
  rpcReplyChannel,
  type RpcEnvelope,
  type SubagentsRpcDeps,
} from "../../src/extension/rpc.js";
import { createSubagentsRuntime, type SubagentsRuntime } from "../../src/extension/tools.js";
import type { SpawnFn } from "../../src/lanes/index.js";
import { emitTo, stubApi, type CapturedApi } from "./stub-api.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-rpc-${label}-`));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const agent of agents) writeFileSync(join(agentsDir, `${agent}.md`), AGENT_MD(agent), "utf8");
  return dir;
}

const SUFFIX = "\nEvidence: proof provided\nRisks/blockers: none\nCompliance: satisfied\ndeliverable_delivered: yes";
const BODY_MARKER = "SECRETTASKBODY";

function contractTask(task: string): string {
  return `1. TASK: ${task} ${BODY_MARKER}
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

/** Fake child emitting a compliant output after an optional delay. */
function compliantSpawn(delayMs = 0): SpawnFn {
  const script = [
    'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { data += c; });',
    'process.stdin.on("end", () => {',
    `  const finish = () => {`,
    '    const task = data.trim();',
    `    const out = "answer:" + task + ${JSON.stringify(SUFFIX)};`,
    '    emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5", provider:"openai-codex"}});',
    '    emit({type:"agent_settled"});',
    '    process.exit(0);',
    '  };',
    `  ${delayMs > 0 ? `setTimeout(finish, ${delayMs});` : "finish();"}`,
    "});",
  ].join("\n");
  return ({ cwd, env }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
}

interface Harness {
  dir: string;
  captured: CapturedApi;
  runtime: SubagentsRuntime;
  deps: SubagentsRpcDeps;
  replies: (requestId: string) => Array<{ channel: string; payload: RpcEnvelope }>;
  cleanup(): void;
}

function setup(label: string, spawnFn: SpawnFn = compliantSpawn()): Harness {
  const dir = tempRepo(label);
  const captured = stubApi();
  const runtime = createSubagentsRuntime(dir, { spawn: spawnFn });
  const deps: SubagentsRpcDeps = {
    sink: captured.api.events!,
    getRuntime: () => runtime,
    eventBus: new SubagentsEventBus(captured.api.events),
  };
  registerSubagentsRpc(captured.api, deps);
  return {
    dir,
    captured,
    runtime,
    deps,
    replies: (requestId) =>
      captured.emitted
        .filter((e) => e.channel === rpcReplyChannel(requestId))
        .map((e) => ({ channel: e.channel, payload: e.payload as RpcEnvelope })),
    cleanup: () => {
      runtime.engine.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Assert the envelope is body-free (no task/output/answer leakage). */
function assertEnvelopeBodyFree(envelope: RpcEnvelope): void {
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes(BODY_MARKER), `task body leaked: ${serialized}`);
  assert.ok(!serialized.includes("answer:"), `child output leaked: ${serialized}`);
}

describe("extension/rpc: registration + ping", () => {
  it("subscribes to the shared channel and the three direct method channels", () => {
    const captured = stubApi();
    registerSubagentsRpc(captured.api, { getRuntime: () => null });
    for (const channel of [RPC_CHANNEL, RPC_PING_CHANNEL, RPC_SPAWN_CHANNEL, RPC_STOP_CHANNEL]) {
      assert.ok(captured.eventHandlers.has(channel), `handler for ${channel}`);
    }
  });

  it("is a harmless no-op when the host exposes no event bus", () => {
    const captured = stubApi();
    const api = { ...captured.api, events: undefined };
    registerSubagentsRpc(api, { getRuntime: () => null });
    assert.equal(captured.emitted.length, 0);
  });

  it("ping via the shared channel replies once with the protocol envelope", () => {
    const h = setup("ping");
    try {
      emitTo(h.captured, RPC_CHANNEL, { requestId: "r1", method: "ping" });
      const replies = h.replies("r1");
      assert.equal(replies.length, 1, "exactly one scoped reply");
      const { payload } = replies[0]!;
      assert.equal(payload.success, true);
      assert.equal(payload.requestId, "r1");
      const data = (payload as { data: Record<string, unknown> }).data;
      assert.equal(data.protocol, RPC_PROTOCOL_VERSION);
      assert.equal(data.extension, "pi-subagents");
      assert.deepEqual(data.methods, [...RPC_METHODS]);
    } finally {
      h.cleanup();
    }
  });

  it("ping via the direct channel replies on the scoped reply channel", () => {
    const h = setup("pingdirect");
    try {
      emitTo(h.captured, RPC_PING_CHANNEL, { requestId: "r2" });
      const replies = h.replies("r2");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.payload.success, true);
      assert.equal(replies[0]!.payload.requestId, "r2");
    } finally {
      h.cleanup();
    }
  });

  it("unknown method and malformed requestId produce scoped error envelopes", () => {
    const h = setup("errors");
    try {
      emitTo(h.captured, RPC_CHANNEL, { requestId: "r3", method: "bogus" });
      const unknown = h.replies("r3")[0]!.payload;
      assert.equal(unknown.success, false);
      assert.ok((unknown as { error: string }).error.includes("unknown method"));

      emitTo(h.captured, RPC_CHANNEL, { method: "ping" }); // no requestId
      const malformed = h.replies(RPC_MALFORMED_REQUEST_ID)[0]!.payload;
      assert.equal(malformed.success, false);
      assert.ok((malformed as { error: string }).error.includes("malformed"));
    } finally {
      h.cleanup();
    }
  });
});

describe("extension/rpc: spawn", () => {
  it("foreground spawn replies success with hash-only run metadata", async () => {
    const h = setup("spawnfg");
    try {
      emitTo(h.captured, RPC_SPAWN_CHANNEL, { requestId: "s1", agent: "alpha", task: contractTask("rpcprobe") });
      await waitFor(() => h.replies("s1").length > 0);
      const { payload } = h.replies("s1")[0]!;
      assert.equal(payload.success, true);
      assert.equal(payload.requestId, "s1");
      const data = (payload as { data: Record<string, unknown> }).data;
      assert.ok(typeof data.runId === "string" && data.runId.length > 0);
      assert.equal(data.status, "complete");
      assert.equal(data.exitCode, 0);
      assert.ok(typeof data.outputHash === "string" && data.outputHash.length === 64);
      assertEnvelopeBodyFree(payload);
    } finally {
      h.cleanup();
    }
  });

  it("background spawn replies immediately with the runId, then settles", async () => {
    const h = setup("spawnbg");
    try {
      emitTo(h.captured, RPC_SPAWN_CHANNEL, {
        requestId: "s2",
        agent: "alpha",
        task: contractTask("rpcbg"),
        run_in_background: true,
      });
      await waitFor(() => h.replies("s2").length > 0);
      const { payload } = h.replies("s2")[0]!;
      assert.equal(payload.success, true);
      const data = (payload as { data: Record<string, unknown> }).data;
      assert.equal(data.status, "running");
      assert.equal(data.background, true);
      const runId = data.runId as string;
      assert.ok(runId);
      await h.runtime.background.awaitDelegationRun(runId, 5_000);
      assert.equal(h.runtime.background.getDelegationRun(runId)!.status, "complete");
      assertEnvelopeBodyFree(payload);
    } finally {
      h.cleanup();
    }
  });

  it("refuses invalid params and preflight-refused agents with error envelopes", async () => {
    const h = setup("spawnbad");
    try {
      emitTo(h.captured, RPC_SPAWN_CHANNEL, { requestId: "s3", agent: "alpha" }); // no task
      await waitFor(() => h.replies("s3").length > 0);
      const missing = h.replies("s3")[0]!.payload;
      assert.equal(missing.success, false);
      assert.ok((missing as { error: string }).error.includes("agent, task"));

      emitTo(h.captured, RPC_SPAWN_CHANNEL, { requestId: "s4", agent: "ghost", task: contractTask("nope") });
      await waitFor(() => h.replies("s4").length > 0);
      const refused = h.replies("s4")[0]!.payload;
      assert.equal(refused.success, false);
      assert.ok((refused as { error: string }).error.includes("refused by preflight"));
    } finally {
      h.cleanup();
    }
  });

  it("replies with a clear error when no runtime is bound yet", async () => {
    const captured = stubApi();
    const deps: SubagentsRpcDeps = { sink: captured.api.events!, getRuntime: () => null };
    registerSubagentsRpc(captured.api, deps);
    emitTo(captured, RPC_SPAWN_CHANNEL, { requestId: "s5", agent: "alpha", task: contractTask("x") });
    await waitFor(() => captured.emitted.some((e) => e.channel === rpcReplyChannel("s5")));
    const payload = captured.emitted.find((e) => e.channel === rpcReplyChannel("s5"))!.payload as RpcEnvelope;
    assert.equal(payload.success, false);
    assert.ok((payload as { error: string }).error.includes("no subagents runtime"));
  });
});

describe("extension/rpc: stop", () => {
  it("aborts a running background run, replies success, and emits subagents:aborted", async () => {
    const h = setup("stop", compliantSpawn(600));
    try {
      emitTo(h.captured, RPC_SPAWN_CHANNEL, {
        requestId: "t1",
        agent: "alpha",
        task: contractTask("slowtarget"),
        run_in_background: true,
      });
      await waitFor(() => h.replies("t1").length > 0);
      const runId = ((h.replies("t1")[0]!.payload as { data?: { runId?: string } }).data ?? {}).runId as string;
      await waitFor(() => h.runtime.engine.monitor.runs.some((run) => run.id === runId && run.status === "running"));

      emitTo(h.captured, RPC_STOP_CHANNEL, { requestId: "t2", run_id: runId });
      await waitFor(() => h.replies("t2").length > 0);
      const { payload } = h.replies("t2")[0]!;
      assert.equal(payload.success, true);
      const data = (payload as { data: Record<string, unknown> }).data;
      assert.equal(data.stopped, true);
      assert.equal(data.status, "aborted");
      assert.equal(h.runtime.engine.monitor.runs.find((run) => run.id === runId)!.status, "aborted");
      await waitFor(() =>
        h.captured.emitted.some((e) => e.channel === "subagents:aborted" && (e.payload as { runId: string }).runId === runId),
      );
      await h.runtime.background.awaitDelegationRun(runId, 5_000);
    } finally {
      h.cleanup();
    }
  });

  it("replies stopped:false for an already-terminal run and an error for unknown runs", async () => {
    const h = setup("stopterminal");
    try {
      const done = await h.runtime.engine.single("alpha", contractTask("quick"), { source: "delegate_agent" });
      const runId = done.ledgerRunId!;
      emitTo(h.captured, RPC_STOP_CHANNEL, { requestId: "t3", run_id: runId });
      await waitFor(() => h.replies("t3").length > 0);
      const terminal = h.replies("t3")[0]!.payload;
      assert.equal(terminal.success, true);
      assert.equal((terminal as { data: Record<string, unknown> }).data.stopped, false);

      emitTo(h.captured, RPC_STOP_CHANNEL, { requestId: "t4", run_id: "does-not-exist" });
      await waitFor(() => h.replies("t4").length > 0);
      const unknown = h.replies("t4")[0]!.payload;
      assert.equal(unknown.success, false);
      assert.ok((unknown as { error: string }).error.includes("unknown run"));
    } finally {
      h.cleanup();
    }
  });

  it("validates the run_id param", async () => {
    const h = setup("stopparam");
    try {
      emitTo(h.captured, RPC_STOP_CHANNEL, { requestId: "t5" });
      await waitFor(() => h.replies("t5").length > 0);
      const payload = h.replies("t5")[0]!.payload;
      assert.equal(payload.success, false);
      assert.ok((payload as { error: string }).error.includes("run_id"));
    } finally {
      h.cleanup();
    }
  });
});

describe("extension/rpc: envelope helpers", () => {
  it("rpcReplyChannel scopes replies by requestId", () => {
    assert.equal(rpcReplyChannel("abc"), "subagents:rpc:reply:abc");
  });

  it("handleRpcPayload is drivable directly with explicit deps (method envelope)", () => {
    const emitted: Array<{ channel: string; payload?: unknown }> = [];
    handleRpcPayload(
      { sink: { emit: (channel, payload) => emitted.push({ channel, payload }) }, getRuntime: () => null },
      { requestId: "x1", method: "ping" },
    );
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.channel, "subagents:rpc:reply:x1");
    assert.equal((emitted[0]!.payload as RpcEnvelope).success, true);
  });
});
