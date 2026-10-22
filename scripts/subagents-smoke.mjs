#!/usr/bin/env node
// scripts/subagents-smoke.mjs — headless E2E smoke for pi-subagents.
//
// Runs the ENTIRE delegation pipeline with NO real `pi` binary:
//   - catalog (registry) build over the package's default agents;
//   - six-part contract gate + preflight blocking BEFORE any spawn;
//   - a single run through the engine + LanePool with a fake-pi injected as
//     the spawner (test/fixtures/bin/fake-pi.mjs);
//   - a chain (2 steps) proving {previous} substitution + same sessionPath;
//   - a parallel run with a concurrency cap;
//   - hash-only / body-free ledger verification;
//   - a background delegation run inspected via get_delegation_run;
//   - v1.5 B1-B7: continueRun (session reuse + byte offset + continuedFromRunId),
//     mid-run steer (engine write + child consume-once), graceful turn limits
//     (soft wrap-up steer vs hard abort at maxTurns+graceTurns), multi-turn
//     cost deltas (anti-double-counting + formatRunUsage), ask_master
//     escalation (exit 42 -> escalated + hash-only + consumed file),
//     FleetView renderFleetLines, and the lifecycle event bus on a stub sink.
//
// '1 boot for N tasks' is demonstrated by the chain reusing the same
// sessionPath on a single lane.
//
// Requires a prior `npm run build` (imports compiled dist/src/*.js). Exits 0
// only when every check passes, otherwise prints the failure and exits 1.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// --- compiled core imports (dist mirrors src) ---
import { buildAgentCatalog } from "../dist/src/registry/catalog.js";
import { validateSixPartContract } from "../dist/src/gates/contract.js";
import { DispatchEngine, mapWithConcurrency } from "../dist/src/engine/dispatch.js";
import { formatRunUsage, summarizeDelegations } from "../dist/src/engine/monitor.js";
import {
  markRunRunning,
  startDelegationRun,
  updateDelegationRun,
} from "../dist/src/engine/runs.js";
import { sha256 } from "../dist/src/core/hashing.js";
import { WRAP_UP_STEER_MESSAGE } from "../dist/src/lanes/pool.js";
import { steerFilePath } from "../dist/src/lanes/steer.js";
import { escalationFilePath } from "../dist/src/lanes/escalation.js";
import { renderFleetLines, stopRun } from "../dist/src/extension/fleet.js";
import { SubagentsEventBus } from "../dist/src/extension/events.js";
import { consumeSteerFile } from "../dist/child/index.js";
import { BackgroundRunRegistry } from "../dist/src/engine/background.js";
import {
  appendLedgerFile,
  bodyFreeDelegationLedgerEntry,
  hasRawBodyKey,
} from "../dist/src/engine/ledger.js";
import { resolveChildModel } from "../dist/src/models/routing.js";
import { catalogFromParsed } from "../dist/src/models/catalog.js";

const FAKE_PI = fileURLToPath(new URL("../test/fixtures/bin/fake-pi.mjs", import.meta.url));
const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));

/** Headless spawner: runs the fake-pi fixture via node. No real `pi`. */
const spawnFakePi = ({ args, cwd, env }) =>
  spawn(process.execPath, [FAKE_PI, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });

/** Counting spawner: never launches a child; used to prove gates block first. */
function countingSpawn(count) {
  return ({ args, cwd, env }) => {
    count.value += 1;
    return spawn(process.execPath, [FAKE_PI, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

/** Fake-pi `--turns N` spawner (B3): N assistant turns with a fixed inter-turn delay. */
function spawnTurns(turns, extra = []) {
  return ({ args, cwd, env }) =>
    spawn(process.execPath, [FAKE_PI, "--turns", String(turns), ...extra, ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FAKE_PI_TURN_DELAY_MS: "100", ...env },
    });
}

/** Fake-pi `--usage-turns N` spawner (B4): N turns with growing cumulative usage. */
const spawnUsageTurns = (turns) => ({ args, cwd, env }) =>
  spawn(process.execPath, [FAKE_PI, "--usage-turns", String(turns), ...args], {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

/** Fake-pi `--escalate <msg>` spawner (B5): writes the escalation file, exits 42. */
const spawnEscalate = (message) => ({ args, cwd, env }) =>
  spawn(process.execPath, [FAKE_PI, "--escalate", message, ...args], {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

/** Recording spawner wrapper: captures child args, delegates to fake-pi. */
function recordingFakePi(recorded) {
  return ({ args, cwd, env }) => {
    recorded.args.push(args);
    return spawn(process.execPath, [FAKE_PI, ...args], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };
}

/** Tiny poll-until helper (10ms steps, bounded timeout). */
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolve project agents to the package's default agents/ dir. */
const resolveAgents = (_cwd, source) => (source === "user" ? [] : [AGENTS_DIR]);

/** Six-part contract whose response payload satisfies base.v1 output gate. */
function contractTask(task) {
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
   - Downstream use:
Evidence: proof provided
Risks/blockers: none
Compliance: satisfied
deliverable_delivered: yes`;
}

/** Temporary repo root (agents resolved from the package dir instead). */
function tempRepo(label) {
  return mkdtempSync(join(tmpdir(), `pi-subagents-smoke-${label}-`));
}

// --- tiny check harness ---
const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || "ok" });
    console.log(`  PASS  ${name}${note ? `  (${note})` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, note: error instanceof Error ? error.message : String(error) });
    console.error(`  FAIL  ${name}  :: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  console.log("pi-subagents headless E2E smoke (no real pi — fake-pi injected)");

  // ---------------------------------------------------------------- (a) catalog
  console.log("\n[a] registry catalog build (body-free)");
  await check("a.catalog-build", () => {
    const repo = tempRepo("catalog");
    try {
      // Build over a clean project agent dir (copy the 5 default cards, no README).
      const agentsDir = join(repo, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      for (const file of readdirSync(AGENTS_DIR)) {
        if (!file.endsWith(".md") || file === "README.md") continue;
        writeFileSync(join(agentsDir, file), readFileSync(join(AGENTS_DIR, file), "utf8"), "utf8");
      }
      const catalog = buildAgentCatalog({ cwd: repo, scope: "project" });
      assert.equal(catalog.schema, "zob.agent-catalog.v1");
      assert.equal(catalog.noExecution, true);
      assert.equal(catalog.bodyStored, false);
      assert.equal(catalog.promptBodiesStored, false);
      const names = catalog.entries.map((e) => e.id).sort();
      for (const want of ["explore", "planner", "implementer", "oracle", "qa", "vision"]) {
        assert.ok(names.includes(want), `catalog missing default agent '${want}'`);
      }
      assert.equal(names.length, 6, `expected exactly 6 default agents, got ${names.length}`);
      for (const entry of catalog.entries) {
        assert.ok(entry.promptHash, `entry ${entry.id} must carry a promptHash (body-free)`);
        assert.equal(entry.id, entry.id.toLowerCase());
      }
      return `schema=${catalog.schema}, agents=${catalog.counts.total}, bodyStored=${catalog.bodyStored}`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------- (b) six-part gate
  console.log("\n[b] six-part contract gate + preflight blocking");
  await check("b.valid-contract", () => {
    assert.equal(validateSixPartContract(contractTask("build a widget")).length, 0, "valid six-part contract must have zero gate errors");
    assert.ok(validateSixPartContract("no contract here at all").length > 0, "malformed task must be rejected by the contract gate");
    return "valid=0 errors, malformed>0 errors";
  });
  await check("b.preflight-blocks-before-spawn", async () => {
    const repo = tempRepo("preflight");
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: countingSpawn(spawned),
        sessionDir: join(repo, "sessions"),
        resolveAgentDirs: resolveAgents,
        source: "delegate_task",
      });
      const result = await engine.single("explore", "no contract here at all");
      assert.equal(spawned.value, 0, "child must never spawn on preflight failure");
      assert.equal(result.gatePassed, false);
      assert.equal(result.failureKind, "preflight");
      assert.equal(engine.monitor.runs[0].status, "preflight_failed");
      const summary = summarizeDelegations(engine.monitor);
      assert.equal(summary.preflightFailed, 1);
      engine.close();
      return "no spawn, status=preflight_failed";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // -------------------------------------------- (c) single run via engine+lanes
  console.log("\n[c] single run via engine + LanePool + fake-pi");
  await check("c.single-run", async () => {
    const repo = tempRepo("single");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "sessions"),
        resolveAgentDirs: resolveAgents,
        maxParallel: 2,
        source: "delegate_task",
      });
      // F1: the write-scope gate sees the agent card's effective tools — the
      // default implementer card is write-capable (edit/write), so a legit
      // write dispatch must carry non-empty allowed_paths (mirror of
      // test/engine/write-scope-card.test.ts "WITH allowed_paths passes").
      const result = await engine.single("implementer", contractTask("build a widget"), { outputContract: "base.v1", allowedPaths: ["src/"] });
      assert.equal(result.exitCode, 0, `child exitCode was ${result.exitCode}`);
      assert.equal(result.gatePassed, true, `output gate failed: ${(result.gateErrors ?? []).join("; ")}`);
      assert.equal(result.agent, "implementer");
      assert.ok(result.output.includes("deliverable_delivered: yes"), "output must carry the final marker");
      assert.ok(result.sessionPath, "sessionPath must be recorded");
      const summary = summarizeDelegations(engine.monitor);
      assert.equal(summary.complete, 1);
      assert.equal(summary.total, 1);
      engine.close();
      return `exit=${result.exitCode}, gatePassed=${result.gatePassed}`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  await check("c.model-class-routing", () => {
    // Honest class-based routing with fallback (I10/I14): cheap -> mapped A -> parent.
    const route = resolveChildModel({
      modelClass: "cheap",
      classModels: { cheap: "openai/gpt-5-mini" },
      parentModel: "openai/gpt-5",
    });
    assert.equal(route.model, "openai/gpt-5-mini");
    assert.equal(route.status, "direct");
    const fallback = resolveChildModel({ modelClass: "cheap", parentModel: "openai/gpt-5" });
    assert.equal(fallback.model, "openai/gpt-5");
    assert.equal(fallback.status, "fallback");
    return `direct=${route.model}, fallback=${fallback.model}(${fallback.status})`;
  });
  await check("c.explicit-model-gate", async () => {
    const repo = tempRepo("modelgate");
    try {
      const spawned = { value: 0 };
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: countingSpawn(spawned),
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        verifiedCatalog: catalogFromParsed({ models: { "openai/gpt-5.5": { resolutionStatus: "verified" } } }),
      });
      // verified model passes
      const ok = await engine.single("explore", contractTask("x"), { model: "openai/gpt-5.5", outputContract: "base.v1" });
      assert.equal(ok.gatePassed, true);
      assert.equal(ok.model, "openai/gpt-5.5");
      // unverified model blocks with NO silent fallback and NO spawn
      const bad = await engine.single("explore", contractTask("y"), { model: "openai/gpt-4o", outputContract: "base.v1" });
      assert.equal(bad.gatePassed, false);
      assert.equal(bad.failureKind, "config");
      assert.match((bad.contractErrors ?? []).join(" "), /explicit model override/);
      engine.close();
      return "verified passes, unverified blocks before spawn";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ (d) chain
  console.log("\n[d] chain (2 steps): {previous} + same sessionPath");
  await check("d.chain-single-boot-reuse", async () => {
    const repo = tempRepo("chain");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "sessions"),
        resolveAgentDirs: resolveAgents,
        source: "delegate_agent",
      });
      const details = await engine.chain([
        { agent: "planner", task: contractTask("step one: plan"), outputContract: "base.v1" },
        // F1: implementer's card is write-capable (edit/write) — the step must
        // carry allowed_paths or preflight blocks it (union of card tools).
        { agent: "implementer", task: contractTask("step two uses: {previous}"), outputContract: "base.v1", allowedPaths: ["src/"] },
      ]);
      assert.equal(details.mode, "chain");
      assert.equal(details.results.length, 2);
      const [r1, r2] = details.results;
      assert.equal(r1.exitCode, 0);
      assert.equal(r2.exitCode, 0);
      assert.equal(r1.gatePassed, true);
      assert.equal(r2.gatePassed, true);
      // {previous} substituted: step 2 output embeds step 1 output.
      assert.ok(r2.output.includes(r1.output.trim()), "step 2 must embed the previous step output");
      // Same lane => same sessionPath (context continuity, one boot for N tasks).
      assert.ok(r1.sessionPath && r2.sessionPath, "session paths expected");
      assert.equal(r1.sessionPath, r2.sessionPath);
      const summary = summarizeDelegations(engine.monitor);
      assert.equal(summary.complete, 2);
      engine.close();
      return `session=${r1.sessionPath} reused across 2 steps`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------- (e) parallel
  console.log("\n[e] parallel dispatch with concurrency cap");
  await check("e.parallel-cap", async () => {
    const repo = tempRepo("parallel");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        maxParallel: 2,
        source: "delegate_agent",
      });
      const tasks = [
        { agent: "explore", task: contractTask("task a"), outputContract: "base.v1" },
        { agent: "qa", task: contractTask("task b"), outputContract: "base.v1" },
        { agent: "oracle", task: contractTask("task c"), outputContract: "base.v1" },
        { agent: "planner", task: contractTask("task d"), outputContract: "base.v1" },
      ];
      const details = await engine.parallel(tasks, { concurrency: 2 });
      assert.equal(details.mode, "parallel");
      assert.equal(details.results.length, 4);
      assert.equal(details.results.every((r) => r.exitCode === 0 && r.gatePassed === true), true);
      assert.deepEqual(details.agents, ["explore", "qa", "oracle", "planner"]);
      const summary = summarizeDelegations(engine.monitor);
      assert.equal(summary.complete, 4);
      engine.close();
      return "4 tasks, concurrency cap=2, all complete";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------- (f) ledger
  console.log("\n[f] hash-only / body-free ledger");
  await check("f.bodyFree-sanitizer", () => {
    const raw = { event: "start", runId: "r1", task: "secret body", output: "another body", stderr: "err body" };
    assert.equal(hasRawBodyKey(raw), true, "raw entry must be detected as body-bearing");
    const clean = bodyFreeDelegationLedgerEntry(raw);
    assert.equal(clean.bodyStored, false);
    assert.equal(clean.outputBodiesStored, false);
    assert.equal(clean.promptBodiesStored, false);
    assert.ok(!("task" in clean) && !("output" in clean), "raw body keys must be stripped");
    assert.ok(Array.isArray(clean.taskHashes) && clean.taskHashes.length === 1, "task must become a hash");
    assert.equal(hasRawBodyKey(clean), false);
    return "raw bodies stripped to sha-256 hashes";
  });
  await check("f.persisted-ledger-lines", async () => {
    const repo = tempRepo("ledger");
    try {
      const ledgerDir = join(repo, "ledger");
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "sessions"),
        resolveAgentDirs: resolveAgents,
        source: "delegate_task",
        persistLedger: true,
        ledgerDir,
      });
      await engine.single("explore", contractTask("ledger task"), { outputContract: "base.v1" });
      engine.close();

      const files = readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl"));
      assert.ok(files.length >= 1, "ledger file must be persisted");
      const lines = files
        .map((f) => readFileSync(join(ledgerDir, f), "utf8").split("\n").filter(Boolean))
        .flat();
      assert.ok(lines.length >= 2, `expected start+end entries, got ${lines.length}`);
      for (const line of lines) {
        const entry = JSON.parse(line);
        assert.equal(entry.bodyStored, false);
        assert.equal(entry.outputBodiesStored, false);
        assert.equal(entry.promptBodiesStored, false);
        assert.equal(hasRawBodyKey(entry), false, `ledger line leaked a raw body key: ${line}`);
        assert.ok(entry.timestamp, "entry must carry a timestamp");
      }
      return `${lines.length} hash-only JSONL lines`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ (g) background
  console.log("\n[g] background delegation run (get_delegation_run)");
  await check("g.background-registry", async () => {
    const repo = tempRepo("bg");
    try {
      const registry = new BackgroundRunRegistry();
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "sessions"),
        resolveAgentDirs: resolveAgents,
        backgroundRegistry: registry,
        source: "delegate_task",
      });
      const stub = await engine.single("oracle", contractTask("background oracle review"), {
        outputContract: "base.v1",
        background: true,
      });
      assert.ok(stub.ledgerRunId, "background stub must expose a run id");
      const runId = stub.ledgerRunId;
      const early = registry.getDelegationRun(runId);
      assert.ok(early, "getDelegationRun must find the run immediately");
      assert.ok(["queued", "running"].includes(early.status), `expected queued/running, got ${early.status}`);
      assert.ok(early.taskHash, "background state must be hash-only (taskHash)");
      assert.ok(!("task" in early), "background state must NOT store the raw task body");

      const settled = await registry.awaitDelegationRun(runId, 10_000);
      assert.equal(settled.status, "complete");
      assert.ok(settled.outputHash, "settled run must carry an output hash");
      assert.equal(settled.exitCode, 0);
      assert.equal(registry.size, 1);
      engine.close();
      return `run ${runId}: ${settled.status}`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ------------------------------------------ [h] B1: continue run
  console.log("\n[h] B1 continueRun: session reuse + offset + continuedFromRunId");
  await check("h.continue-run", async () => {
    const repo = tempRepo("continue");
    const recorded = { args: [] };
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: recordingFakePi(recorded),
        sessionDir: join(repo, "sessions"),
        resolveAgentDirs: resolveAgents,
        source: "delegate_task",
      });
      const first = await engine.single("explore", contractTask("first question"), { outputContract: "base.v1" });
      assert.equal(first.exitCode, 0, `first run failed: ${first.stderr}`);
      const firstRun = engine.monitor.runs[0];
      assert.equal(firstRun.status, "complete", `first run status was ${firstRun.status}`);
      assert.ok(firstRun.sessionPath, "first run must record a sessionPath");
      assert.equal(firstRun.turnCount, undefined, "a fresh run carries no turnCount");

      // Known session content so the continuation byte-offset is observable.
      const sessionPath = firstRun.sessionPath;
      const known = "known-session-content-for-continue-smoke";
      writeFileSync(sessionPath, known, "utf8");

      const continued = await engine.continueRun(firstRun.id, contractTask("continue the work"), { outputContract: "base.v1" });
      assert.equal(continued.exitCode, 0, `continued run failed: ${continued.stderr}`);
      const contRun = engine.monitor.runs.find((r) => r.id !== firstRun.id);
      assert.ok(contRun, "the continued run must be registered in the monitor");
      assert.equal(contRun.status, "complete");
      assert.equal(contRun.continuedFromRunId, firstRun.id, "continuedFromRunId must link the original run");
      assert.equal(contRun.turnCount, 2, "turnCount must increment from the original");
      assert.equal(contRun.sessionPath, sessionPath, "continue must reuse the SAME sessionPath");

      // The continuation spawn reuses --session <same path>; pi resumes the
      // session file AS-IS — no --session-offset (the option does not exist in
      // pi >= 0.84 and would exit 1).
      const contArgs = recorded.args[1];
      const sessionIdx = contArgs.indexOf("--session");
      assert.ok(sessionIdx >= 0, "continue args must include --session");
      assert.equal(contArgs[sessionIdx + 1], sessionPath);
      assert.ok(!contArgs.includes("--session-offset"), "continue args must NOT include --session-offset");
      engine.close();
      return `session reused as-is (no offset flag), turnCount=2`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  await check("h.continue-refuses-nonterminal", async () => {
    const repo = tempRepo("continueref");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        source: "delegate_task",
      });
      // A registered RUNNING run must be refused (only terminal runs continue).
      startDelegationRun(engine.monitor, {
        id: "smoke-running-1",
        parentToolCallId: "parent",
        source: "delegate_task",
        mode: "single",
        agent: "explore",
        task: contractTask("stuck"),
        startedAtMs: Date.now(),
      });
      markRunRunning(engine.monitor, "smoke-running-1");
      await assert.rejects(
        () => engine.continueRun("smoke-running-1", contractTask("continue")),
        /status is running, expected terminal/,
      );
      await assert.rejects(() => engine.continueRun("nope", contractTask("continue")), /Unknown run/);
      engine.close();
      return "running + unknown runs refused";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // --------------------------------------------- [i] B2: mid-run steer
  console.log("\n[i] B2 steer: engine write + child consume-once");
  await check("i.steer-write-and-consume", async () => {
    const repo = tempRepo("steer");
    const steerDir = join(repo, "steer");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnTurns(6, ["--turns-deliverable"]),
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        steerDir,
        source: "delegate_task",
      });
      // Foreground multi-turn run; steer it while the child is mid-run.
      const done = engine.single("oracle", contractTask("steerable work"), {
        outputContract: "base.v1",
        runId: "smoke-steer-run",
      });
      await waitFor(() => engine.monitor.runs.some((r) => r.id === "smoke-steer-run" && r.status === "running"));

      const outcome = engine.steer("smoke-steer-run", "focus on the ledger evidence");
      assert.equal(outcome.ok, true, `steer refused: ${JSON.stringify(outcome)}`);
      assert.ok(outcome.ok);
      assert.equal(outcome.steerFile, steerFilePath("smoke-steer-run", steerDir));
      assert.equal(existsSync(outcome.steerFile), true, "the steer file must be written on steer()");
      const payload = JSON.parse(readFileSync(outcome.steerFile, "utf8"));
      assert.equal(payload.runId, "smoke-steer-run");
      assert.equal(payload.message, "focus on the ledger evidence");
      assert.equal(engine.monitor.runs.find((r) => r.id === "smoke-steer-run").status, "steered");
      assert.equal(summarizeDelegations(engine.monitor).steered, 1);

      const result = await done;
      assert.equal(result.exitCode, 0, `steered run failed: ${result.stderr}`);
      assert.equal(engine.monitor.runs.find((r) => r.id === "smoke-steer-run").status, "complete");

      // Child-side consumption (child adapter consume-once): payload injected
      // once, file deleted, a second poll finds nothing.
      const consumed = consumeSteerFile(outcome.steerFile);
      assert.ok(consumed, "consumeSteerFile must return the payload");
      assert.equal(consumed.message, "focus on the ledger evidence");
      assert.equal(existsSync(outcome.steerFile), false, "consume-once must delete the steer file");
      assert.equal(consumeSteerFile(outcome.steerFile), null, "a second consume must find nothing");

      const refused = engine.steer("smoke-steer-run", "too late");
      assert.equal(refused.ok, false, "a terminal run must refuse steering");
      assert.match(refused.error, /not running/);
      engine.close();
      return "steered mid-run, file written+consumed once, terminal steer refused";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ---------------------------------- [j] B3: graceful turn limits
  console.log("\n[j] B3 graceful limits: soft wrap-up steer vs hard abort");
  await check("j.graceful-wrapup-steered", async () => {
    const repo = tempRepo("graceful");
    const steerDir = join(repo, "steer");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnTurns(4, ["--turns-deliverable"]),
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        steerDir,
        source: "delegate_task",
      });
      // 4-turn child under maxTurns=2 + graceTurns=3 (4 < 2+3): the soft
      // wrap-up steer fires at turn 2 and the run finishes cleanly -> 'steered',
      // never aborted. F1: implementer is write-capable, so allowed_paths is
      // required for the run to ever start (graceful B3 asserts only make
      // sense on a spawned run, not a preflight block).
      const result = await engine.single("implementer", contractTask("bounded work"), {
        outputContract: "base.v1",
        allowedPaths: ["src/"],
        maxTurns: 2,
        graceTurns: 3,
        runId: "smoke-grace-run",
      });
      assert.equal(result.exitCode, 0, `steered run exit was ${result.exitCode}`);
      assert.equal(result.stopReason, "steered", `stopReason was ${result.stopReason}`);
      assert.equal(result.errorMessage, undefined, "a graceful wrap-up is not an error");
      assert.equal(result.usage.turns, 4);
      assert.equal(engine.monitor.runs.find((r) => r.id === "smoke-grace-run").status, "steered");

      // Wrap-up steer file written exactly once, with the canonical message.
      assert.deepEqual(readdirSync(steerDir).filter((f) => f.endsWith(".steer")), ["smoke-grace-run.steer"]);
      const payload = JSON.parse(readFileSync(join(steerDir, "smoke-grace-run.steer"), "utf8"));
      assert.equal(payload.message, WRAP_UP_STEER_MESSAGE);
      engine.close();
      return "maxTurns=2 -> steered (no abort), wrap-up file written once";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  await check("j.graceful-hard-abort", async () => {
    const repo = tempRepo("overrun");
    const steerDir = join(repo, "steer");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnTurns(6),
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        steerDir,
        source: "delegate_task",
      });
      // 6-turn runaway under maxTurns=1 + graceTurns=2: bounded abort exactly at
      // turn 3 (1+2), after the soft steer was delivered at turn 1. F1: same
      // write-scope requirement as the steered check above (write-capable card).
      const result = await engine.single("implementer", contractTask("runaway work"), {
        outputContract: "base.v1",
        allowedPaths: ["src/"],
        maxTurns: 1,
        graceTurns: 2,
        runId: "smoke-over-run",
      });
      assert.equal(result.stopReason, "aborted", `stopReason was ${result.stopReason}`);
      assert.equal(result.exitCode, 130, `aborted exit code was ${result.exitCode}`);
      assert.equal(result.errorMessage, "Child agent aborted");
      assert.equal(result.usage.turns, 3, "the hard abort lands at maxTurns + graceTurns");
      assert.equal(engine.monitor.runs.find((r) => r.id === "smoke-over-run").status, "aborted");
      assert.equal(existsSync(steerFilePath("smoke-over-run", steerDir)), true, "the soft steer precedes the hard abort");
      engine.close();
      return "maxTurns=1+grace=2 -> aborted at turn 3, steer first";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // --------------------------------------- [k] B4: cost deltas (no double-count)
  console.log("\n[k] B4 cost deltas: multi-turn usage + formatRunUsage");
  await check("k.cost-deltas", async () => {
    const repo = tempRepo("cost");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnUsageTurns(3),
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        source: "delegate_task",
      });
      const result = await engine.single("qa", contractTask("cost accounting"), {
        outputContract: "base.v1",
        runId: "smoke-cost-run",
      });
      assert.equal(result.exitCode, 0);
      // 3 cumulative snapshots (input 1000/2000/3000): run usage must equal
      // the DELTAS (== last snapshot), never the naive 6000 sum.
      assert.equal(result.usage.turns, 3);
      assert.equal(result.usage.input, 3_000, `input was ${result.usage.input}, expected delta total 3000 not sum 6000`);
      assert.equal(result.usage.output, 300, `output was ${result.usage.output}, expected 300 not 600`);
      assert.equal(result.usage.cacheRead, 4_000, `cacheRead was ${result.usage.cacheRead}, expected 4000 not 6000`);
      assert.equal(result.usage.contextTokens, 3_300, "contextTokens keeps the LAST snapshot semantics");
      assert.ok(Math.abs(result.usage.cost - 0.003) < 1e-9, `cost was ${result.usage.cost}, expected 0.003 not 0.006`);

      const run = engine.monitor.runs.find((r) => r.id === "smoke-cost-run");
      assert.ok(run.usage, "the run view must record usage");
      assert.equal(run.usage.input, 3_000);
      const line = formatRunUsage(run.usage);
      assert.equal(line, "3t · 3.0k in · 300 out · ctx 3.3k · $0.0030", `formatRunUsage was '${line}'`);
      engine.close();
      return `usage=${line} (delta-based, no double-counting)`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // -------------------------------------- [l] B5: ask_master escalation
  console.log("\n[l] B5 escalation: exit 42 -> escalated + hash-only + consumed file");
  await check("l.escalation", async () => {
    const repo = tempRepo("escalated");
    const steerDir = join(repo, "steer");
    const ledger = [];
    try {
      const message = "master, should I edit src or only report?";
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnEscalate(message),
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        steerDir,
        source: "delegate_task",
        onLedger: (entry) => ledger.push(entry),
      });
      const result = await engine.single("oracle", contractTask("deep review"), {
        outputContract: "base.v1",
        runId: "smoke-esc-run",
      });
      assert.equal(result.exitCode, 42, `escalation exit code was ${result.exitCode}`);
      assert.equal(result.stopReason, "escalated", `stopReason was ${result.stopReason}`);
      assert.equal(result.escalationMessage, message, "the consumed ask_master message lives in-memory only");
      assert.equal(result.failureKind, undefined, "an escalation is not a failure");

      const run = engine.monitor.runs.find((r) => r.id === "smoke-esc-run");
      assert.equal(run.status, "escalated", `run status was ${run.status}`);
      assert.equal(run.escalationHash, sha256(message), "escalationHash must be the sha256 of the message");
      assert.equal(summarizeDelegations(engine.monitor).escalated, 1);

      // The escalation file was consumed (read + immediate delete).
      assert.equal(existsSync(escalationFilePath("smoke-esc-run", steerDir)), false, "the escalation file must be consumed on exit 42");

      // Ledger posture: hash-only — the raw body NEVER reaches the ledger.
      const end = ledger.find((entry) => entry.event === "end");
      assert.ok(end, "an end ledger entry must exist");
      assert.equal(end.status, "escalated");
      assert.equal(end.escalationHash, sha256(message));
      assert.equal(JSON.stringify(ledger).includes(message), false, "the raw escalation body leaked into the ledger");
      engine.close();
      return "exit 42 -> escalated + escalationHash, file consumed, ledger hash-only";
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ------------------------------------------ [m] B6: fleet widget render
  console.log("\n[m] B6 fleet: renderFleetLines over runs + stop action");
  await check("m.fleet-render", async () => {
    const repo = tempRepo("fleet");
    try {
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        source: "delegate_agent",
      });
      const rt = { engine, background: new BackgroundRunRegistry(), repoRoot: repo, startedAt: Date.now() };
      const getRuntime = () => rt;

      // Empty fleet.
      assert.deepEqual(renderFleetLines(getRuntime, 1_000), ["fleet: no active runs"]);

      const addRun = (id, agent, status, startedAtMs, usage) => {
        startDelegationRun(engine.monitor, {
          id,
          parentToolCallId: "parent",
          source: "delegate_agent",
          mode: "single",
          agent,
          task: `task for ${agent}`,
          startedAtMs,
        });
        updateDelegationRun(engine.monitor, id, { status, usage });
      };
      addRun("fleet-1", "explore", "running", 500, { turns: 2, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 150 });
      addRun("fleet-2", "qa", "queued", 700);
      addRun("fleet-done", "oracle", "complete", 100);

      const lines = renderFleetLines(getRuntime, 10_000);
      assert.equal(lines[0], "fleet: 2 active", `header was '${lines[0]}'`);
      assert.ok(lines.some((l) => l.includes("explore") && l.includes("150 tok") && l.includes("$0.0123")), `explore row missing/malformed in ${JSON.stringify(lines)}`);
      assert.ok(lines.some((l) => l.includes("qa") && l.includes("queued")), `qa row missing in ${JSON.stringify(lines)}`);
      assert.ok(!lines.some((l) => l.includes("fleet-done")), "terminal runs must not render in the fleet");

      // Stop action: abort a queued/running run through the monitor.
      assert.equal(stopRun(getRuntime, "fleet-1"), "stopped fleet-1");
      assert.equal(engine.monitor.runs.find((r) => r.id === "fleet-1").status, "aborted");
      assert.equal(stopRun(getRuntime, "nope"), "run not found: nope");
      engine.close();
      return `${lines.length} lines: 2 active rendered, terminal skipped, stop aborts`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // --------------------------------------- [n] B7: lifecycle event bus
  console.log("\n[n] B7 events: lifecycle emitted via the bus (stub sink)");
  await check("n.events-lifecycle", async () => {
    const repo = tempRepo("events");
    const steerDir = join(repo, "steer");
    const marker = "EVENTSBODY7f3a";
    try {
      const emitted = [];
      const bus = new SubagentsEventBus({ emit: (channel, payload) => emitted.push({ channel, payload }) });
      const engine = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnFakePi,
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        steerDir,
        source: "delegate_task",
        onLedger: (entry) => bus.handleLedgerEntry(entry),
      });
      const result = await engine.single("explore", contractTask(`events probe ${marker}`), { outputContract: "base.v1" });
      assert.equal(result.exitCode, 0);

      const channels = emitted.map((e) => e.channel);
      const createdIdx = channels.indexOf("subagents:created");
      const startedIdx = channels.indexOf("subagents:started");
      const completedIdx = channels.indexOf("subagents:completed");
      assert.ok(createdIdx >= 0, "subagents:created must be emitted");
      assert.ok(startedIdx >= 0, "subagents:started must be emitted");
      assert.ok(completedIdx >= 0, "subagents:completed must be emitted");
      assert.ok(createdIdx < startedIdx && startedIdx < completedIdx, `lifecycle order violated: ${channels.join(",")}`);

      const completed = emitted[completedIdx].payload;
      assert.equal(completed.schema, "zob.subagents-event.v1");
      assert.equal(completed.runId, result.ledgerRunId);
      assert.equal(completed.agent, "explore");
      assert.equal(completed.status, "complete");
      assert.equal(completed.bodyStored, false);
      assert.ok(completed.outputHash && completed.outputHash.length === 64, "a sha-256 outputHash must be carried");
      const started = emitted[startedIdx].payload;
      assert.equal(started.status, "running");

      // Hash-only posture on the wire: no raw task or output body anywhere.
      const serialized = JSON.stringify(emitted);
      assert.equal(serialized.includes(marker), false, "the raw task body leaked into an event payload");
      assert.equal(serialized.includes("answer:"), false, "the child output body leaked into an event payload");

      // The escalated end entry maps onto subagents:escalated (hash-only).
      const engine2 = new DispatchEngine({
        repoRoot: repo,
        spawn: spawnEscalate("need the owner decision on scope"),
        sessionDir: join(repo, "s"),
        resolveAgentDirs: resolveAgents,
        steerDir,
        source: "delegate_task",
        onLedger: (entry) => bus.handleLedgerEntry(entry),
      });
      await engine2.single("oracle", contractTask("blocked work"), { outputContract: "base.v1", runId: "smoke-ev-esc" });
      const escalated = emitted.filter((e) => e.channel === "subagents:escalated");
      assert.equal(escalated.length, 1, `expected exactly one subagents:escalated event, got ${escalated.length}`);
      assert.equal(escalated[0].payload.runId, "smoke-ev-esc");
      assert.equal(escalated[0].payload.status, "escalated");
      assert.ok(escalated[0].payload.escalationHash && escalated[0].payload.escalationHash.length === 64, "escalationHash must be carried (hash-only)");
      assert.equal(JSON.stringify(emitted).includes("owner decision"), false, "the raw escalation body leaked into an event payload");
      engine.close();
      engine2.close();
      return `${emitted.length} events: created->started->completed + escalated, all body-free`;
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);
  console.log("\n==============================================================");
  console.log(`pi-subagents E2E smoke: ${passed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error("Failing checks:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.note}`);
    console.error("SMOKE FAILED");
    process.exit(1);
  }
  console.log("SMOKE PASSED (headless, no real pi)");
  console.log("==============================================================");
  process.exit(0);
}

main().catch((error) => {
  console.error("SMOKE FAILED (unexpected error):", error);
  process.exit(1);
});
