// test/extension/events.test.ts — B7: lifecycle event bus on pi.events.
// Foreground/background dispatch, preflight refusal, steer and out-of-band
// abort all emit the right `subagents:*` channel with hash-only payloads
// (runId/agent/status/durationMs/tokens/outputHash) — NEVER a raw body.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256 } from "../../src/core/hashing.js";
import {
  SubagentsEventBus,
  SUBAGENTS_EVENT_SCHEMA,
  lifecyclePayloadFromLedgerEntry,
  steerRunWithEvents,
  subagentsEventChannel,
  type SubagentsLifecyclePayload,
} from "../../src/extension/events.js";
import { createSubagentsRuntime, type SubagentsRuntime } from "../../src/extension/tools.js";
import type { SpawnFn } from "../../src/lanes/index.js";
import { stubApi, type CapturedApi } from "./stub-api.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-events-${label}-`));
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
  bus: SubagentsEventBus;
  runtime: SubagentsRuntime;
  payloads: () => Array<{ channel: string; payload: SubagentsLifecyclePayload }>;
  cleanup(): void;
}

function setup(label: string, spawnFn: SpawnFn = compliantSpawn()): Harness {
  const dir = tempRepo(label);
  const captured = stubApi();
  const bus = new SubagentsEventBus(captured.api.events);
  const runtime = createSubagentsRuntime(dir, {
    spawn: spawnFn,
    onLedger: (entry) => bus.handleLedgerEntry(entry),
  });
  return {
    dir,
    captured,
    bus,
    runtime,
    payloads: () =>
      captured.emitted
        .filter((e) => e.channel.startsWith("subagents:"))
        .map((e) => ({ channel: e.channel, payload: e.payload as SubagentsLifecyclePayload })),
    cleanup: () => {
      runtime.engine.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const FORBIDDEN_KEYS = ["output", "task", "stderr", "body", "prompt", "errorMessage", "gateErrors", "outputPreview", "taskPreview"];

function assertBodyFree(payloads: Array<{ channel: string; payload: unknown }>): void {
  for (const { payload } of payloads) {
    const record = payload as Record<string, unknown>;
    assert.equal(record.bodyStored, false, `bodyStored must be false on ${JSON.stringify(record)}`);
    for (const key of FORBIDDEN_KEYS) {
      assert.ok(!(key in record), `forbidden raw key "${key}" in ${JSON.stringify(record)}`);
    }
    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes(BODY_MARKER), `task body leaked in ${serialized}`);
    assert.ok(!serialized.includes("answer:"), `child output body leaked in ${serialized}`);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("extension/events: foreground dispatch lifecycle", () => {
  it("emits created -> started -> completed in order with hash-only payloads", async () => {
    const h = setup("fg");
    try {
      const result = await h.runtime.engine.single("alpha", contractTask("probe"), { source: "delegate_agent" });
      const runId = result.ledgerRunId;
      assert.ok(runId);
      await waitFor(() => h.payloads().some((e) => e.channel === "subagents:completed"));

      const events = h.payloads();
      assertBodyFree(events);
      const channels = events.map((e) => e.channel);
      assert.ok(channels.includes("subagents:created"), "created emitted");
      assert.ok(channels.includes("subagents:started"), "started emitted");
      const createdIdx = channels.indexOf("subagents:created");
      const startedIdx = channels.indexOf("subagents:started");
      const completedIdx = channels.indexOf("subagents:completed");
      assert.ok(createdIdx < startedIdx && startedIdx < completedIdx, "lifecycle order");

      const completed = events[completedIdx]!.payload;
      assert.equal(completed.schema, SUBAGENTS_EVENT_SCHEMA);
      assert.equal(completed.runId, runId);
      assert.equal(completed.agent, "alpha");
      assert.equal(completed.status, "complete");
      assert.equal(typeof completed.durationMs, "number");
      assert.ok(completed.outputHash && completed.outputHash.length === 64, "sha256 outputHash present");
      assert.ok(typeof completed.tokens === "undefined" || typeof completed.tokens === "number");

      const started = events[startedIdx]!.payload;
      assert.equal(started.runId, runId);
      assert.equal(started.status, "running");
    } finally {
      h.cleanup();
    }
  });

  it("emits failed (preflight_failed) for an unknown agent — no child spawned", async () => {
    const h = setup("preflight");
    try {
      const result = await h.runtime.engine.single("ghost", contractTask("nope"), { source: "delegate_agent" });
      assert.equal(result.gatePassed, false);
      const events = h.payloads();
      assertBodyFree(events);
      const failed = events.find((e) => e.channel === "subagents:failed");
      assert.ok(failed, "failed emitted");
      assert.equal(failed.payload.status, "preflight_failed");
      assert.equal(failed.payload.failureKind, "config");
      assert.ok(!events.some((e) => e.channel === "subagents:started"), "no started for refused spawn");
    } finally {
      h.cleanup();
    }
  });
});

describe("extension/events: background dispatch lifecycle", () => {
  it("emits created/started immediately and completed after settlement", async () => {
    const h = setup("bg");
    try {
      const stub = await h.runtime.engine.single("alpha", contractTask("bgprobe"), {
        source: "delegate_agent",
        background: true,
      });
      const runId = stub.ledgerRunId;
      assert.ok(runId);
      assert.ok(h.payloads().some((e) => e.channel === "subagents:started"), "started emitted eagerly");

      await h.runtime.background.awaitDelegationRun(runId, 5_000);
      await waitFor(() => h.payloads().some((e) => e.channel === "subagents:completed"));
      const events = h.payloads();
      assertBodyFree(events);
      const completed = events.find((e) => e.channel === "subagents:completed")!;
      assert.equal(completed.payload.runId, runId);
      assert.equal(completed.payload.status, "complete");
    } finally {
      h.cleanup();
    }
  });
});

describe("extension/events: steer + out-of-band abort", () => {
  it("steerRunWithEvents emits subagents:steered for a running run", async () => {
    const h = setup("steer", compliantSpawn(400));
    try {
      const pending = h.runtime.engine.single("alpha", contractTask("slow"), { source: "delegate_agent" });
      await waitFor(() => h.payloads().some((e) => e.channel === "subagents:started"));
      const runId = h.payloads()[0]!.payload.runId;

      const outcome = steerRunWithEvents(h.runtime.engine, h.runtime.engine.monitor, runId, "wrap up now", h.bus);
      assert.equal(outcome.ok, true);
      const steered = h.payloads().find((e) => e.channel === "subagents:steered");
      assert.ok(steered, "steered emitted");
      assert.equal(steered.payload.runId, runId);
      assert.equal(steered.payload.status, "steered");
      assertBodyFree(h.payloads());
      await pending;
    } finally {
      h.cleanup();
    }
  });

  it("emitAborted publishes an aborted payload from a run view", async () => {
    const h = setup("abort", compliantSpawn(400));
    try {
      const pending = h.runtime.engine.single("alpha", contractTask("slowabort"), {
        source: "delegate_agent",
        background: true,
      });
      const runId = (await pending).ledgerRunId!;
      await waitFor(() => h.payloads().some((e) => e.channel === "subagents:started"));
      const run = h.runtime.engine.monitor.runs.find((candidate) => candidate.id === runId);
      assert.ok(run);
      h.bus.emitAborted(run);
      const aborted = h.payloads().find((e) => e.channel === "subagents:aborted");
      assert.ok(aborted, "aborted emitted");
      assert.equal(aborted.payload.runId, runId);
      assert.equal(aborted.payload.status, "aborted");
      assertBodyFree(h.payloads());
      await h.runtime.background.awaitDelegationRun(runId, 5_000);
    } finally {
      h.cleanup();
    }
  });
});

describe("extension/events: payload builder + degraded mode", () => {
  it("lifecyclePayloadFromLedgerEntry maps usage/latency/taskHash and refuses empty runIds", () => {
    const payload = lifecyclePayloadFromLedgerEntry("completed", {
      event: "end",
      runId: "run-1",
      agent: "alpha",
      status: "complete",
      delegationMode: "single",
      source: "delegate_agent",
      taskHash: sha256("t"),
      outputHash: sha256("o"),
      latencyMs: 42,
      usage: { input: 10, output: 5, cost: 0.25, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 1 },
    });
    assert.ok(payload);
    assert.equal(payload.tokens, 15);
    assert.equal(payload.cost, 0.25);
    assert.equal(payload.durationMs, 42);
    assert.equal(payload.taskHash, sha256("t"));
    assert.equal(payload.bodyStored, false);
    assert.equal(lifecyclePayloadFromLedgerEntry("created", { runId: "" }), undefined);
  });

  it("bus without a sink and bus on throw never break the dispatch path", async () => {
    const dir = tempRepo("nosink");
    try {
      const throwingBus = new SubagentsEventBus({ emit: () => { throw new Error("sink down"); } });
      const runtime = createSubagentsRuntime(dir, {
        spawn: compliantSpawn(),
        onLedger: (entry) => throwingBus.handleLedgerEntry(entry),
      });
      const result = await runtime.engine.single("alpha", contractTask("resilient"), { source: "delegate_agent" });
      assert.equal(result.exitCode, 0);
      runtime.engine.close();
      const silent = new SubagentsEventBus(undefined);
      silent.handleLedgerEntry({ event: "start", runId: "x", agent: "a" }); // no throw
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subagentsEventChannel maps every lifecycle event to its channel", () => {
    assert.equal(subagentsEventChannel("created"), "subagents:created");
    assert.equal(subagentsEventChannel("started"), "subagents:started");
    assert.equal(subagentsEventChannel("completed"), "subagents:completed");
    assert.equal(subagentsEventChannel("failed"), "subagents:failed");
    assert.equal(subagentsEventChannel("aborted"), "subagents:aborted");
    assert.equal(subagentsEventChannel("steered"), "subagents:steered");
  });
});
