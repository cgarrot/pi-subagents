// test/extension/fleet.test.ts — FleetView widget (B6): widget registered,
// content rendered with fake runs, bounded transcript peek, and stop action.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { BackgroundRunRegistry } from "../../src/engine/background.js";
import { createDelegationMonitorState } from "../../src/engine/monitor.js";
import { startDelegationRun, updateDelegationRun, type DelegationRunView } from "../../src/engine/runs.js";
import {
  FLEET_WIDGET_ID,
  FleetView,
  PEEK_MAX_BYTES,
  PEEK_MAX_LINES,
  fleetRunLines,
  peekTranscript,
  renderFleetLines,
  runUsageSummary,
  stopRun,
} from "../../src/extension/fleet.js";
import type { SubagentsRuntime } from "../../src/extension/tools.js";
import type { SessionContext } from "../../src/extension/pi-types.js";
import { SharedIntervalTicker } from "../../src/extension/widget-refresh.js";
import { fakeCtx } from "./stub-api.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-fleet-${label}-`));
}

/** Build a runtime whose monitor we can populate with fake runs. */
function makeRuntime(dir: string): SubagentsRuntime {
  const monitor = createDelegationMonitorState();
  const engine = new DispatchEngine({
    repoRoot: dir,
    monitor,
    backgroundRegistry: new BackgroundRunRegistry(),
    source: "delegate_agent",
    sessionDir: join(dir, ".pi", "sessions"),
  });
  return { engine, background: new BackgroundRunRegistry(), repoRoot: dir, startedAt: Date.now() };
}

function addRun(
  rt: SubagentsRuntime,
  input: { id: string; agent: string; status: "queued" | "running" | "complete" | "failed"; startedAtMs: number; sessionPath?: string; usage?: DelegationRunView["usage"]; liveUsage?: DelegationRunView["liveUsage"] },
): void {
  startDelegationRun(rt.engine.monitor, {
    id: input.id,
    parentToolCallId: "parent",
    source: "delegate_agent",
    mode: "single",
    agent: input.agent,
    task: `task for ${input.agent}`,
    startedAtMs: input.startedAtMs,
    sessionPath: input.sessionPath,
  });
  if (input.status === "running") {
    updateDelegationRun(rt.engine.monitor, input.id, { status: "running" });
  } else if (input.status === "complete" || input.status === "failed") {
    updateDelegationRun(rt.engine.monitor, input.id, {
      status: input.status,
      endedAtMs: input.startedAtMs + 5_000,
      durationMs: 5_000,
    });
  }
  if (input.usage) updateDelegationRun(rt.engine.monitor, input.id, { usage: input.usage });
  if (input.liveUsage) updateDelegationRun(rt.engine.monitor, input.id, { liveUsage: input.liveUsage });
}

describe("extension/fleet: renderFleetLines", () => {
  it("renders active runs with agent/status/tokens/cost/duration and skips terminal runs", () => {
    const dir = tempDir("render");
    try {
      const rt = makeRuntime(dir);
      const getRuntime = () => rt;
      addRun(rt, {
        id: "r1",
        agent: "alpha",
        status: "running",
        startedAtMs: 1_000,
        usage: { turns: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 150 },
      });
      addRun(rt, { id: "r2", agent: "beta", status: "queued", startedAtMs: 2_000 });
      addRun(rt, { id: "r3", agent: "gamma", status: "complete", startedAtMs: 3_000 });

      const lines = renderFleetLines(getRuntime, 6_000);
      assert.ok(lines, "widget content should be present");
      const text = lines.join("\n");
      assert.match(text, /fleet: 2 active/);
      assert.match(text, /alpha running/);
      assert.match(text, /150 tok/);
      assert.match(text, /\$0\.0123/);
      assert.match(text, /5s/);
      assert.match(text, /beta queued/);
      assert.ok(!text.includes("gamma"), "terminal runs must not appear in the fleet");
      // no flicker-formatted raw ms and no $0.0000 noise on the queued row
      assert.ok(!text.includes("5000ms"), "durations render human (5s), not raw ms");
      assert.ok(!text.includes("$0.0000"), "unknown cost must not render as $0.0000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a no-active placeholder when no runs are active", () => {
    const dir = tempDir("idle");
    try {
      const rt = makeRuntime(dir);
      const lines = renderFleetLines(() => rt);
      assert.deepEqual(lines, ["fleet: no active runs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/fleet: peekTranscript", () => {
  it("reads the session jsonl bounded by lines and bytes", () => {
    const dir = tempDir("peek");
    try {
      const sessionPath = join(dir, "run.jsonl");
      const longLine = "x".repeat(200);
      const body = Array.from({ length: 50 }, (_, i) => `${i}:${longLine}`).join("\n");
      writeFileSync(sessionPath, body, "utf8");

      const run: DelegationRunView = {
        id: "r1",
        parentToolCallId: "parent",
        source: "delegate_agent",
        mode: "single",
        agent: "alpha",
        taskPreview: "t",
        status: "running",
        startedAtMs: 1_000,
        outputPreview: "",
        stderrPreview: "",
        sessionPath,
      };

      const peeked = peekTranscript(run, PEEK_MAX_LINES, PEEK_MAX_BYTES);
      assert.ok(peeked.length <= PEEK_MAX_BYTES + 32, "peek must stay within the byte cap");
      assert.ok(peeked.split("\n").length <= PEEK_MAX_LINES + 1, "peek must stay within the line cap (plus marker)");
      assert.match(peeked, /…\[truncated\]/, "oversized transcript should be marked truncated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a short message when there is no session path or the file is missing", () => {
    const dir = tempDir("peekmissing");
    try {
      const noPath: DelegationRunView = {
        id: "r1",
        parentToolCallId: "parent",
        source: "delegate_agent",
        mode: "single",
        agent: "alpha",
        taskPreview: "t",
        status: "running",
        startedAtMs: 1_000,
        outputPreview: "",
        stderrPreview: "",
      };
      assert.equal(peekTranscript(noPath), "(no session transcript)");
      assert.equal(peekTranscript(undefined), "(no session transcript)");

      const missing: DelegationRunView = { ...noPath, sessionPath: join(dir, "nope.jsonl") };
      assert.equal(peekTranscript(missing), "(transcript unavailable)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/fleet: stopRun", () => {
  it("aborts a running run via the engine monitor", () => {
    const dir = tempDir("stop");
    try {
      const rt = makeRuntime(dir);
      addRun(rt, { id: "r1", agent: "alpha", status: "running", startedAtMs: 1_000 });
      const message = stopRun(() => rt, "r1");
      assert.equal(message, "stopped r1");
      const run = rt.engine.monitor.runs.find((candidate) => candidate.id === "r1");
      assert.equal(run?.status, "aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for unknown or already-terminal runs", () => {
    const dir = tempDir("stopnoop");
    try {
      const rt = makeRuntime(dir);
      addRun(rt, { id: "r1", agent: "alpha", status: "complete", startedAtMs: 1_000 });
      assert.equal(stopRun(() => rt, "r1"), "run r1 already complete");
      assert.equal(stopRun(() => rt, "nope"), "run not found: nope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/fleet: live usage (turn feed)", () => {
  it("renders ≈ live context tokens for an active run with liveUsage and no settled usage", () => {
    const dir = tempDir("live");
    try {
      const rt = makeRuntime(dir);
      addRun(rt, {
        id: "r1",
        agent: "alpha",
        status: "running",
        startedAtMs: 1_000,
        liveUsage: { turns: 2, contextTokens: 12_400, model: "zai/glm-5.3", atMs: 2_000 },
      });
      const rows = fleetRunLines(() => rt, 5_000);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.tokens, 12_400);
      assert.equal(rows[0]!.live, true);
      assert.equal(rows[0]!.model, "zai/glm-5.3");
      const text = renderFleetLines(() => rt, 5_000)!.join("\n");
      assert.match(text, /≈12\.4k tok/, "live tokens carry the ≈ estimate marker");
      assert.ok(!text.includes("$"), "cost is unknown mid-run — never a fake $0.0000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settled usage stays authoritative over the live snapshot", () => {
    const dir = tempDir("settledwins");
    try {
      const rt = makeRuntime(dir);
      addRun(rt, {
        id: "r1",
        agent: "alpha",
        status: "running",
        startedAtMs: 1_000,
        usage: { turns: 3, input: 900, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 1_000 },
        liveUsage: { turns: 2, contextTokens: 50_000, atMs: 2_000 },
      });
      const summary = runUsageSummary(rt.engine.monitor.runs[0]!);
      assert.deepEqual(summary, { tokens: 1_000, cost: 0.02, live: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/fleet: FleetView widget registration", () => {
  it("registers the widget and status on attach, and clears them on detach", () => {
    const dir = tempDir("widget");
    try {
      const rt = makeRuntime(dir);
      addRun(rt, { id: "r1", agent: "alpha", status: "running", startedAtMs: 1_000 });

      const widgets = new Map<string, string[] | undefined>();
      const statuses = new Map<string, string | undefined>();
      const ctx: SessionContext = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          setWidget: (id, content) => widgets.set(id, content),
          setStatus: (id, text) => statuses.set(id, text),
        },
      };

      const fleet = new FleetView(ctx, () => rt, new SharedIntervalTicker(10_000));
      fleet.attach();
      assert.ok(widgets.has(FLEET_WIDGET_ID), "fleet widget should be registered");
      assert.match((widgets.get(FLEET_WIDGET_ID) ?? []).join("\n"), /alpha running/);
      assert.equal(statuses.get("subagents-fleet"), "1 active run(s)");

      fleet.onLocalChange();
      assert.ok(widgets.has(FLEET_WIDGET_ID), "refresh on local change keeps the widget");

      fleet.detach();
      assert.equal(widgets.get(FLEET_WIDGET_ID), undefined, "detach clears the widget");
      assert.equal(statuses.get("subagents-fleet"), undefined, "detach clears the status");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips repaints when the rendered content is unchanged (anti-flicker)", () => {
    const dir = tempDir("diff");
    try {
      const rt = makeRuntime(dir);
      // startedAtMs relative to now so the FORMATTED duration ("1s") stays
      // stable across consecutive renders within the test.
      addRun(rt, { id: "r1", agent: "alpha", status: "running", startedAtMs: Date.now() - 1_000, liveUsage: { turns: 1, contextTokens: 100, atMs: Date.now() - 500 } });
      let widgetCalls = 0;
      let statusCalls = 0;
      const ctx: SessionContext = {
        cwd: dir,
        hasUI: true,
        ui: {
          notify: () => {},
          setWidget: () => { widgetCalls += 1; },
          setStatus: () => { statusCalls += 1; },
        },
      };
      const ticker = new SharedIntervalTicker(10_000); // never fires during the test
      const fleet = new FleetView(ctx, () => rt, ticker);
      fleet.attach();
      const afterAttach = widgetCalls;
      assert.equal(statusCalls, 1, "status painted once on attach");

      // same render -> NO new setWidget/setStatus calls (idle = 0 repaint)
      fleet.onLocalChange();
      fleet.onLocalChange();
      assert.equal(widgetCalls, afterAttach, "unchanged content must not repaint");
      assert.equal(statusCalls, 1, "unchanged status must not repaint");

      // content CHANGES (live usage tick) -> exactly one repaint
      updateDelegationRun(rt.engine.monitor, "r1", { liveUsage: { turns: 2, contextTokens: 5_000, atMs: Date.now() } });
      fleet.onLocalChange();
      assert.equal(widgetCalls, afterAttach + 1, "changed content repaints once");

      fleet.detach();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
