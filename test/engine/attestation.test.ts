// test/engine/attestation.test.ts — C4 hash-verified attestation sidecars:
// build/write/verify units, settle-time sidecar for EVERY terminal status,
// hash-only anti-body checks, and extension exposure (get_delegation_run +
// rpc spawn reply: non-blocking `verified` / `mismatches`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ATTESTATION_SCHEMA,
  buildAttestation,
  verifyAttestation,
  verifyAttestationSidecar,
  writeAttestationSidecar,
  type Attestation,
} from "../../src/engine/attestation.js";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { BackgroundRunRegistry } from "../../src/engine/background.js";
import type { DelegationRunView } from "../../src/engine/runs.js";
import type { ChildResult } from "../../src/core/types.js";
import { sha256 } from "../../src/core/hashing.js";
import { registerTools, type SubagentsRuntime } from "../../src/extension/tools.js";
import { registerSubagentsRpc, RPC_SPAWN_CHANNEL, rpcReplyChannel } from "../../src/extension/rpc.js";
import type { SpawnFn } from "../../src/lanes/index.js";
import type { ToolDefinition } from "../../src/extension/pi-types.js";
import { emitTo, fakeCtx, stubApi, type CapturedApi } from "../extension/stub-api.js";

// ------------------------------------------------------------- fixtures

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

function tempRepo(label: string, agents: string[] = ["alpha", "beta"]): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-attest-${label}-`));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const agent of agents) writeFileSync(join(agentsDir, `${agent}.md`), AGENT_MD(agent), "utf8");
  return dir;
}

function contractTask(task: string): string {
  return `1. TASK: ${task}
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

const SUFFIX = "\nEvidence: proof provided\nRisks/blockers: none\nCompliance: satisfied\ndeliverable_delivered: yes";

/** Run a node -e script as the child (stdin task in, ndjson out). */
function scriptSpawn(script: string): SpawnFn {
  return ({ cwd, env }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
}

const EMIT_JS = 'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");';
const READ_STDIN_JS = [
  'let data = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (c) => { data += c; });',
].join("\n");

/** One assistant message_end carrying usage (B4 deltas: first snapshot = value). */
const TURN_EVENT_JS = (outExpr: string): string =>
  [
    `  const out = ${outExpr};`,
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text", text: out}], model:"gpt-5.5", provider:"openai-codex", usage:{input:10, output:5, cacheRead:0, cacheWrite:0, totalTokens:15, cost:{total:0.012}}}});',
  ].join("\n");

/** Complete: one contract-compliant assistant turn, then exit 0. */
const completeSpawn = (): SpawnFn =>
  scriptSpawn(
    [
      EMIT_JS,
      READ_STDIN_JS,
      'process.stdin.on("end", () => {',
      TURN_EVENT_JS('"answer:" + data.trim() + ' + JSON.stringify(SUFFIX)),
      '  emit({type:"agent_settled"});',
      "  process.exit(0);",
      "});",
    ].join("\n"),
  );

/** Failed: exits non-zero with no assistant turn. */
const failedSpawn = (): SpawnFn => scriptSpawn('process.stdin.resume(); process.stdin.on("data", () => process.exit(1)); setTimeout(() => process.exit(1), 2000);');

/** Escalated: exits with the B5 escalation code 42. */
const escalatedSpawn = (): SpawnFn =>
  scriptSpawn('process.stdin.resume(); process.stdin.on("data", () => process.exit(42)); setTimeout(() => process.exit(42), 2000);');

/** Steered: one compliant turn, then a clean exit AFTER the soft steer lands. */
const steeredSpawn = (): SpawnFn =>
  scriptSpawn(
    [
      EMIT_JS,
      READ_STDIN_JS,
      'process.stdin.on("end", () => {',
      TURN_EVENT_JS('"steered-answer:" + data.trim() + ' + JSON.stringify(SUFFIX)),
      "  setTimeout(() => process.exit(0), 150);",
      "});",
    ].join("\n"),
  );

/**
 * Aborted: keeps emitting turns so the B3 hard abort (maxTurns+grace) fires.
 * Self-exits after 10s so a regression FAILS the test instead of hanging it.
 */
const abortedSpawn = (): SpawnFn =>
  scriptSpawn(
    [
      EMIT_JS,
      "let n = 0;",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', () => {});",
      'setInterval(() => { n++; emit({type:"message_end", message:{role:"assistant", content:[{type:"text", text: "turn-" + n}], model:"gpt-5.5", usage:{input:10, output:5, cacheRead:0, cacheWrite:0, totalTokens:15, cost:{total:0}}}}); }, 20);',
      "setTimeout(() => process.exit(0), 10000);",
    ].join("\n"),
  );

function engineFor(dir: string, spawnFn: SpawnFn, ledgerDir: string, opts: { maxTurns?: number; graceTurns?: number } = {}): DispatchEngine {
  return new DispatchEngine({
    repoRoot: dir,
    spawn: spawnFn,
    sessionDir: join(dir, "sessions"),
    source: "delegate_task",
    persistLedger: true,
    ledgerDir,
    maxTurns: opts.maxTurns,
    graceTurns: opts.graceTurns,
  });
}

function readSidecar(ref: string): Attestation {
  assert.ok(existsSync(ref), `sidecar missing: ${ref}`);
  return JSON.parse(readFileSync(ref, "utf8")) as Attestation;
}

// ------------------------------------------------- unit: build + verify

describe("engine/attestation: buildAttestation + verifyAttestation", () => {
  it("builds a hash-only attestation and verifies output + session hashes OK", () => {
    const dir = tempRepo("unit-ok");
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, '{"v":1}\n{"v":2}\n', "utf8");
      const run: DelegationRunView = {
        id: "delegate-unit1",
        parentToolCallId: "parent",
        source: "delegate_task",
        mode: "single",
        agent: "alpha",
        taskPreview: "preview",
        status: "complete",
        startedAtMs: 1_000,
        endedAtMs: 2_500,
        outputPreview: "",
        stderrPreview: "",
        sessionPath: sessionFile,
      };
      const result: ChildResult = {
        agent: "alpha",
        task: "SECRET-TASK-MARKER-C4",
        exitCode: 0,
        output: "SECRET-OUTPUT-MARKER-C4",
        stderr: "",
        model: "openai/gpt-5.5",
        sessionPath: sessionFile,
        stopReason: undefined,
        usage: { turns: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.012, contextTokens: 15 },
      };

      const attestation = buildAttestation(run, result);
      assert.equal(attestation.schema, ATTESTATION_SCHEMA);
      assert.equal(attestation.schema, "pi-subagents.attestation.v1");
      assert.equal(attestation.runId, "delegate-unit1");
      assert.equal(attestation.agent, "alpha");
      assert.equal(attestation.model, "openai/gpt-5.5");
      assert.equal(attestation.exitCode, 0);
      assert.equal(attestation.status, "complete");
      assert.equal(attestation.startedAt, new Date(1_000).toISOString());
      assert.equal(attestation.endedAt, new Date(2_500).toISOString());
      assert.equal(attestation.outputHash, sha256("SECRET-OUTPUT-MARKER-C4"));
      assert.equal(attestation.sessionHash, sha256('{"v":1}\n{"v":2}\n'));
      assert.deepEqual(attestation.usage, result.usage);

      const verification = verifyAttestation(attestation, { output: result.output, sessionFile });
      assert.equal(verification.valid, true);
      const byName = new Map(verification.checks.map((check) => [check.name, check]));
      assert.equal(byName.get("schema")!.ok, true);
      assert.equal(byName.get("outputHash")!.ok, true);
      assert.equal(byName.get("outputHash")!.actual, attestation.outputHash);
      assert.equal(byName.get("sessionHash")!.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a modified output (hash mismatch) while the session hash still passes", () => {
    const dir = tempRepo("unit-mismatch");
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, "session-bytes\n", "utf8");
      const run: DelegationRunView = {
        id: "delegate-unit2", parentToolCallId: "parent", source: "delegate_task", mode: "single",
        agent: "alpha", taskPreview: "p", status: "complete", startedAtMs: 0, endedAtMs: 10,
        outputPreview: "", stderrPreview: "", sessionPath: sessionFile,
      };
      const result: ChildResult = {
        agent: "alpha", task: "t", exitCode: 0, output: "original output", stderr: "",
        sessionPath: sessionFile, usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      };
      const attestation = buildAttestation(run, result);

      const tampered = verifyAttestation(attestation, { output: "TAMPERED output", sessionFile });
      assert.equal(tampered.valid, false);
      const outputCheck = tampered.checks.find((check) => check.name === "outputHash")!;
      assert.equal(outputCheck.ok, false);
      assert.equal(outputCheck.expected, attestation.outputHash);
      assert.equal(outputCheck.actual, sha256("TAMPERED output"));
      assert.equal(tampered.checks.find((check) => check.name === "sessionHash")!.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a modified session file and skips unverifiable checks (never invalid)", () => {
    const dir = tempRepo("unit-session");
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, "session-v1\n", "utf8");
      const run: DelegationRunView = {
        id: "delegate-unit3", parentToolCallId: "parent", source: "delegate_task", mode: "single",
        agent: "alpha", taskPreview: "p", status: "complete", startedAtMs: 0, endedAtMs: 10,
        outputPreview: "", stderrPreview: "", sessionPath: sessionFile,
      };
      const result: ChildResult = {
        agent: "alpha", task: "t", exitCode: 0, output: "out", stderr: "",
        sessionPath: sessionFile, usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      };
      const attestation = buildAttestation(run, result);
      assert.equal(attestation.sessionHash, sha256("session-v1\n"));

      // Modified session file -> sessionHash mismatch -> invalid.
      writeFileSync(sessionFile, "session-v2-TAMPERED\n", "utf8");
      const tamperedSession = verifyAttestation(attestation, { output: "out", sessionFile });
      assert.equal(tamperedSession.valid, false);
      const sessionCheck = tamperedSession.checks.find((check) => check.name === "sessionHash")!;
      assert.equal(sessionCheck.ok, false);
      assert.equal(sessionCheck.actual, sha256("session-v2-TAMPERED\n"));

      // Missing session file + no output -> checks skipped, still valid.
      rmSync(sessionFile);
      const skipped = verifyAttestation(attestation, {});
      assert.equal(skipped.valid, true);
      assert.equal(skipped.checks.find((check) => check.name === "outputHash")!.skipped, true);
      assert.equal(skipped.checks.find((check) => check.name === "sessionHash")!.skipped, true);

      // Unreadable session file -> skipped, not a mismatch.
      const missingFile = verifyAttestation(attestation, { sessionFile });
      assert.equal(missingFile.valid, true);
      assert.equal(missingFile.checks.find((check) => check.name === "sessionHash")!.skipped, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies against a known output digest (ledger/run-view style) and flags divergence", () => {
    const attestation: Attestation = {
      schema: ATTESTATION_SCHEMA, runId: "r", agent: "a", exitCode: 0,
      outputHash: sha256("the output"), startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
      status: "complete", usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
    };
    const ok = verifyAttestation(attestation, { outputHash: sha256("the output") });
    assert.equal(ok.valid, true);
    assert.equal(ok.checks.find((check) => check.name === "outputHash")!.ok, true);

    const bad = verifyAttestation(attestation, { outputHash: sha256("another output") });
    assert.equal(bad.valid, false);
    assert.equal(bad.checks.find((check) => check.name === "outputHash")!.ok, false);

    const wrongSchema = verifyAttestation({ ...attestation, schema: "other.v9" as Attestation["schema"] }, {});
    assert.equal(wrongSchema.valid, false);
    assert.equal(wrongSchema.checks.find((check) => check.name === "schema")!.ok, false);
  });
});

// ----------------------------------------------- unit: sidecar write I/O

describe("engine/attestation: writeAttestationSidecar", () => {
  it("writes atomically (no tmp leftovers), hash-only keys, no bodies", () => {
    const dir = tempRepo("sidecar-io");
    try {
      const sessionFile = join(dir, "s.jsonl");
      writeFileSync(sessionFile, "sess\n", "utf8");
      const run: DelegationRunView = {
        id: "delegate-io1", parentToolCallId: "parent", source: "delegate_task", mode: "single",
        agent: "alpha", taskPreview: "p", status: "failed", startedAtMs: 5_000, endedAtMs: 6_000,
        outputPreview: "", stderrPreview: "", sessionPath: sessionFile,
      };
      const result: ChildResult = {
        agent: "alpha", task: "SECRET-TASK-MARKER-C4", exitCode: 1, output: "SECRET-OUTPUT-MARKER-C4",
        stderr: "SECRET-STDERR", stopReason: "error", model: "openai/gpt-5.5", sessionPath: sessionFile,
        usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      };
      const attestation = buildAttestation(run, result);

      const sidecarDir = join(dir, "ledger", "attestations");
      const ref = writeAttestationSidecar(sidecarDir, attestation);
      assert.equal(ref, join(sidecarDir, "delegate-io1.json"));
      assert.ok(existsSync(ref));

      // Atomic: only the final file remains in the dir (tmp renamed away).
      assert.deepEqual(readdirSync(sidecarDir), ["delegate-io1.json"]);

      // Hash-only allowlist: exactly these keys, nothing else.
      const parsed = JSON.parse(readFileSync(ref, "utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), [
        "agent", "endedAt", "exitCode", "model", "outputHash", "runId",
        "schema", "sessionHash", "startedAt", "status", "stopReason", "usage",
      ]);

      // Anti-corps: no raw body ever reaches the sidecar.
      const raw = readFileSync(ref, "utf8");
      assert.equal(raw.includes("SECRET-TASK-MARKER-C4"), false, "task body leaked into sidecar");
      assert.equal(raw.includes("SECRET-OUTPUT-MARKER-C4"), false, "output body leaked into sidecar");
      assert.equal(raw.includes("SECRET-STDERR"), false, "stderr body leaked into sidecar");
      for (const forbidden of ["task", "output", "prompt", "stderr", "error", "escalationMessage", "body"]) {
        assert.equal(parsed[forbidden], undefined, `forbidden key present: ${forbidden}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifyAttestationSidecar returns undefined for an absent sidecar (clean fallback)", () => {
    const dir = tempRepo("sidecar-absent");
    try {
      assert.equal(verifyAttestationSidecar(join(dir, "ledger", "attestations", "nope.json")), undefined);
      writeFileSync(join(dir, "garbage.json"), "{not json", "utf8");
      assert.equal(verifyAttestationSidecar(join(dir, "garbage.json")), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------- engine: sidecar at settle

describe("engine/attestation: settle writes the sidecar for every terminal status", () => {
  it("complete: sidecar written, attestationRef on the run view, hashes verify", async () => {
    const dir = tempRepo("settle-complete");
    const ledgerDir = join(dir, "ledger");
    try {
      const engine = engineFor(dir, completeSpawn(), ledgerDir);
      const result = await engine.single("alpha", contractTask("SECRET-TASK-MARKER-C4 do work"), { outputContract: "base.v1" });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(result.gatePassed, true);

      const expectedRef = join(ledgerDir, "attestations", `${run.id}.json`);
      assert.equal(run.attestationRef, expectedRef);
      const attestation = readSidecar(expectedRef);
      assert.equal(attestation.status, "complete");
      assert.equal(attestation.runId, run.id);
      assert.equal(attestation.agent, "alpha");
      assert.equal(attestation.model, "openai-codex/gpt-5.5"); // ndjson normalizes provider/model
      assert.equal(attestation.exitCode, 0);
      assert.equal(attestation.outputHash, sha256(result.output));
      assert.equal(attestation.usage.turns, 1);
      assert.equal(attestation.usage.input, 10);
      assert.equal(attestation.usage.cost, 0.012);
      // Fake children never write the session file -> sessionHash omitted.
      assert.equal(attestation.sessionHash, undefined);

      const verification = verifyAttestationSidecar(run.attestationRef!, { output: result.output });
      assert.equal(verification!.verified, true);
      assert.deepEqual(verification!.mismatches, []);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("failed: sidecar written with status failed (empty output -> no outputHash)", async () => {
    const dir = tempRepo("settle-failed");
    const ledgerDir = join(dir, "ledger");
    try {
      const engine = engineFor(dir, failedSpawn(), ledgerDir);
      const result = await engine.single("alpha", contractTask("fail please"), { outputContract: "base.v1" });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "failed");
      assert.equal(result.exitCode, 1);

      const attestation = readSidecar(run.attestationRef!);
      assert.equal(attestation.status, "failed");
      assert.equal(attestation.exitCode, 1);
      assert.equal(attestation.outputHash, undefined); // empty output, hash-only
      // Schema-only verification still passes (no hashes attested).
      assert.equal(verifyAttestation(attestation, {}).valid, true);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalated: sidecar written with status escalated", async () => {
    const dir = tempRepo("settle-escalated");
    const ledgerDir = join(dir, "ledger");
    try {
      const engine = engineFor(dir, escalatedSpawn(), ledgerDir);
      await engine.single("alpha", contractTask("escalate please"), { outputContract: "base.v1" });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "escalated");

      const attestation = readSidecar(run.attestationRef!);
      assert.equal(attestation.status, "escalated");
      assert.equal(attestation.exitCode, 42);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("steered: sidecar written with status steered after the soft wrap-up steer", async () => {
    const dir = tempRepo("settle-steered");
    const ledgerDir = join(dir, "ledger");
    try {
      const engine = engineFor(dir, steeredSpawn(), ledgerDir, { maxTurns: 1, graceTurns: 5 });
      const result = await engine.single("alpha", contractTask("steer please"), { outputContract: "base.v1", maxTurns: 1, graceTurns: 5 });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "steered");
      assert.equal(result.stopReason, "steered");

      const attestation = readSidecar(run.attestationRef!);
      assert.equal(attestation.status, "steered");
      assert.equal(attestation.stopReason, "steered");
      assert.equal(attestation.outputHash, sha256(result.output));
      assert.equal(verifyAttestationSidecar(run.attestationRef!, { output: result.output })!.verified, true);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborted: sidecar written with status aborted after the hard turn abort", async () => {
    const dir = tempRepo("settle-aborted");
    const ledgerDir = join(dir, "ledger");
    try {
      const engine = engineFor(dir, abortedSpawn(), ledgerDir, { maxTurns: 1, graceTurns: 1 });
      await engine.single("alpha", contractTask("run forever"), { outputContract: "base.v1", maxTurns: 1, graceTurns: 1 });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "aborted");

      const attestation = readSidecar(run.attestationRef!);
      assert.equal(attestation.status, "aborted");
      assert.equal(attestation.stopReason, "aborted");
      assert.equal(attestation.exitCode, 130);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no ledger persistence -> no sidecar and no attestationRef (clean fallback)", async () => {
    const dir = tempRepo("settle-nopersist");
    try {
      const engine = new DispatchEngine({ repoRoot: dir, spawn: completeSpawn(), sessionDir: join(dir, "sessions"), source: "delegate_task" });
      await engine.single("alpha", contractTask("no persistence"), { outputContract: "base.v1" });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(run.attestationRef, undefined);
      assert.equal(existsSync(join(dir, ".pi", "logs", "runs", "attestations")), false);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an attestation write failure NEVER blocks the settle (best-effort)", async () => {
    const dir = tempRepo("settle-besteffort");
    const ledgerDir = join(dir, "ledger");
    try {
      // The LEDGER dir stays writable, but `attestations` exists as a regular
      // FILE -> the sidecar mkdir fails while the ledger keeps appending.
      mkdirSync(ledgerDir, { recursive: true });
      writeFileSync(join(ledgerDir, "attestations"), "not a dir", "utf8");
      const engine = engineFor(dir, completeSpawn(), ledgerDir);
      const result = await engine.single("alpha", contractTask("best effort"), { outputContract: "base.v1" });
      const run = engine.monitor.runs[0]!;
      assert.equal(run.status, "complete");
      assert.equal(result.gatePassed, true);
      assert.equal(run.attestationRef, undefined);
      engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------- extension exposure (non-blocking)

function extensionRuntime(dir: string, spawnFn: SpawnFn, opts: { persist?: boolean; ledgerDir?: string } = {}): SubagentsRuntime {
  const background = new BackgroundRunRegistry();
  const engine = new DispatchEngine({
    repoRoot: dir,
    backgroundRegistry: background,
    source: "delegate_task",
    sessionDir: join(dir, "sessions"),
    spawn: spawnFn,
    persistLedger: opts.persist ?? false,
    ledgerDir: opts.ledgerDir,
  });
  return { engine, background, repoRoot: dir, startedAt: Date.now() };
}

const runTool = (tool: ToolDefinition, params: Record<string, unknown>, ctx: ReturnType<typeof fakeCtx>) =>
  tool.execute("call", params, undefined, undefined, ctx);

async function waitForRpcReply(captured: CapturedApi, requestId: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const channel = rpcReplyChannel(requestId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = captured.emitted.find((emission) => emission.channel === channel);
    if (found) return found.payload as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`no rpc reply on ${channel}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("extension: attestation verification exposure (non-blocking)", () => {
  it("get_delegation_run exposes verified:true, then detects a tampered sidecar; absent sidecar -> no field", async () => {
    const dir = tempRepo("ext-verify");
    const ledgerDir = join(dir, "ledger");
    try {
      const runtime = extensionRuntime(dir, completeSpawn(), { persist: true, ledgerDir });
      const { api, tools } = stubApi();
      registerTools(api, () => runtime);
      const ctx = fakeCtx(dir);
      const getTool = (name: string): ToolDefinition => {
        const tool = tools.get(name);
        assert.ok(tool, `tool ${name} not registered`);
        return tool;
      };

      const started = await runTool(getTool("delegate_task"), {
        agent: "alpha", task: "t", expected_outcome: "artifact", must_do: ["m"], must_not_do: ["n"],
        context: "ctx", run_in_background: true,
      }, ctx);
      const runId = (started.details as { runId: string }).runId;
      await runTool(getTool("await_delegation_run"), { run_id: runId, timeout_ms: 5_000 }, ctx);

      // Sidecar exists -> verified:true against the run-view outputHash.
      const done = await runTool(getTool("get_delegation_run"), { run_id: runId }, ctx);
      const attestation = (done.details as { attestation?: { verified: boolean; mismatches: string[]; ref: string } }).attestation;
      assert.ok(attestation, "attestation field missing on get_delegation_run");
      assert.equal(attestation!.verified, true);
      assert.deepEqual(attestation!.mismatches, []);

      // Tamper the sidecar's outputHash -> verified:false + mismatch name.
      const run = runtime.engine.monitor.runs.find((candidate) => candidate.id === runId)!;
      const tampered = JSON.parse(readFileSync(run.attestationRef!, "utf8")) as Record<string, unknown>;
      tampered.outputHash = sha256("tampered-output");
      writeFileSync(run.attestationRef!, JSON.stringify(tampered), "utf8");
      const mismatch = await runTool(getTool("get_delegation_run"), { run_id: runId }, ctx);
      const bad = (mismatch.details as { attestation?: { verified: boolean; mismatches: string[] } }).attestation;
      assert.equal(bad!.verified, false);
      assert.deepEqual(bad!.mismatches, ["outputHash"]);

      // No persistence -> no sidecar -> NO attestation field at all (clean fallback).
      const runtime2 = extensionRuntime(dir, completeSpawn(), {});
      const { api: api2, tools: tools2 } = stubApi();
      registerTools(api2, () => runtime2);
      const ctx2 = fakeCtx(dir);
      const started2 = await runTool(tools2.get("delegate_task")!, {
        agent: "alpha", task: "t2", expected_outcome: "artifact", must_do: ["m"], must_not_do: ["n"],
        context: "ctx", run_in_background: true,
      }, ctx2);
      const runId2 = (started2.details as { runId: string }).runId;
      await runTool(tools2.get("await_delegation_run")!, { run_id: runId2, timeout_ms: 5_000 }, ctx2);
      const bare = await runTool(tools2.get("get_delegation_run")!, { run_id: runId2 }, ctx2);
      assert.equal((bare.details as { attestation?: unknown }).attestation, undefined);
      runtime.engine.close();
      runtime2.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rpc spawn reply carries verified:true when the sidecar verifies", async () => {
    const dir = tempRepo("rpc-verify");
    const ledgerDir = join(dir, "ledger");
    try {
      const runtime = extensionRuntime(dir, completeSpawn(), { persist: true, ledgerDir });
      const captured = stubApi();
      registerSubagentsRpc(captured.api, { getRuntime: () => runtime });

      emitTo(captured, RPC_SPAWN_CHANNEL, { requestId: "req-c4", agent: "alpha", task: contractTask("rpc verify") });
      const reply = await waitForRpcReply(captured, "req-c4");
      assert.equal(reply.success, true);
      const data = reply.data as { runId: string; verified?: boolean; attestationMismatches?: string[]; outputHash?: string };
      assert.ok(data.outputHash, "rpc reply missing outputHash");
      assert.equal(data.verified, true);
      assert.deepEqual(data.attestationMismatches, []);
      runtime.engine.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
