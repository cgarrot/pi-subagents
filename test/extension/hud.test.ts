// test/extension/hud.test.ts — HUD widget (cycle-4 fixes): reconciled
// summary (counts add up, preflight included), runtime uptime replaced by
// active-run durations (hidden when idle), diffed repaints (idle = 0 calls),
// and the shared widget ticker.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DispatchEngine } from "../../src/engine/dispatch.js";
import { BackgroundRunRegistry } from "../../src/engine/background.js";
import { formatDurationMs } from "../../src/engine/monitor.js";
import { createDelegationMonitorState } from "../../src/engine/monitor.js";
import { startDelegationRun, updateDelegationRun, type DelegationRunStatus } from "../../src/engine/runs.js";
import {
  HUD_STATUS_ID,
  HUD_WIDGET_ID,
  SubagentsHud,
  activeRunsDurationLine,
  activeRunCount,
  reconcileSummaryLine,
  renderHudLines,
} from "../../src/extension/hud.js";
import { SharedIntervalTicker, sameWidgetContent } from "../../src/extension/widget-refresh.js";
import type { SubagentsRuntime } from "../../src/extension/tools.js";
import type { SessionContext } from "../../src/extension/pi-types.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-hud-${label}-`));
}

/** Runtime whose monitor we populate with fake runs (no real children). */
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

function addRun(rt: SubagentsRuntime, id: string, status: DelegationRunStatus, startedAtMs: number): void {
  startDelegationRun(rt.engine.monitor, {
    id,
    parentToolCallId: "parent",
    source: "delegate_agent",
    mode: "single",
    agent: `agent-${id}`,
    task: `task ${id}`,
    startedAtMs,
  });
  if (status !== "queued") updateDelegationRun(rt.engine.monitor, id, { status });
  if (status !== "running" && status !== "queued" && status !== "steered") {
    updateDelegationRun(rt.engine.monitor, id, { endedAtMs: startedAtMs + 3_000, durationMs: 3_000 });
  }
}

describe("extension/hud: formatDurationMs", () => {
  it("renders human wall-clock durations", () => {
    assert.equal(formatDurationMs(940), "940ms");
    assert.equal(formatDurationMs(5_000), "5s");
    assert.equal(formatDurationMs(14_000), "14s");
    assert.equal(formatDurationMs(74_000), "1m14s");
    assert.equal(formatDurationMs(3_700_000), "1h01m");
    assert.equal(formatDurationMs(-5), "0ms");
  });
});

describe("extension/hud: reconciled summary", () => {
  it("counts every run in exactly one bucket — preflight included (counts add up)", () => {
    const dir = tempDir("summary");
    try {
      const rt = makeRuntime(dir);
      addRun(rt, "a", "complete", 1_000);
      addRun(rt, "b", "failed", 2_000);
      addRun(rt, "c", "preflight_failed", 3_000);
      const summary = rt.engine.monitor.runs.length;
      const lines = renderHudLines(() => rt, 10_000)!;
      assert.equal(lines.length, 1, "no active runs -> single line (no durations line)");
      assert.match(lines[0]!, /^subagents: 3 runs · 0 active · 1 complete · 1 failed · 1 preflight$/);
      assert.ok(!lines[0]!.includes("uptime"), "runtime uptime must be gone");
      assert.equal(summary, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends aborted/escalated buckets only when nonzero and keeps the total reconciled", () => {
    const summary = {
      total: 6, queued: 1, running: 1, steered: 0, complete: 1, failed: 1, preflightFailed: 1, aborted: 1, escalated: 0,
    };
    const line = reconcileSummaryLine(summary);
    assert.equal(line, "subagents: 6 runs · 2 active · 1 complete · 1 failed · 1 preflight · 1 aborted");
    assert.ok(!line.includes("escalated"), "zero buckets stay hidden");
    assert.equal(activeRunCount(summary), 2);
  });

  it("renders active-run durations instead of runtime uptime, hidden when idle", () => {
    const dir = tempDir("durations");
    try {
      const rt = makeRuntime(dir);
      addRun(rt, "x", "running", 1_000);
      addRun(rt, "y", "running", 2_000);
      const lines = renderHudLines(() => rt, 15_000)!;
      assert.equal(lines.length, 2);
      assert.match(lines[1]!, /^2 active · longest 14s$/);
      assert.ok(!lines.join("\n").includes("uptime"), "no runtime uptime anywhere");

      // idle -> the durations line disappears
      updateDelegationRun(rt.engine.monitor, "x", { status: "complete", endedAtMs: 20_000, durationMs: 19_000 });
      updateDelegationRun(rt.engine.monitor, "y", { status: "complete", endedAtMs: 21_000, durationMs: 19_000 });
      const idle = renderHudLines(() => rt, 25_000)!;
      assert.equal(idle.length, 1, "idle hides the durations line");
      assert.equal(activeRunsDurationLine(rt.engine.monitor, 25_000), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/hud: SubagentsHud widget", () => {
  function makeCtx(dir: string): { ctx: SessionContext; widgetCalls: () => number; statusCalls: () => number; widgets: Map<string, string[] | undefined>; statuses: Map<string, string | undefined> } {
    let widgetCount = 0;
    let statusCount = 0;
    const widgets = new Map<string, string[] | undefined>();
    const statuses = new Map<string, string | undefined>();
    const ctx: SessionContext = {
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: (id, content) => { widgetCount += 1; widgets.set(id, content); },
        setStatus: (id, text) => { statusCount += 1; statuses.set(id, text); },
      },
    };
    return { ctx, widgetCalls: () => widgetCount, statusCalls: () => statusCount, widgets, statuses };
  }

  it("paints once and skips identical repaints (idle = 0 repaint)", () => {
    const dir = tempDir("diffskip");
    try {
      const rt = makeRuntime(dir);
      const { ctx, widgetCalls, statusCalls, widgets, statuses } = makeCtx(dir);
      const hud = new SubagentsHud(ctx, () => rt, new SharedIntervalTicker(10_000));
      hud.attach();
      const painted = widgetCalls();
      assert.equal(painted, 1, "attach paints the widget once");
      assert.match(widgets.get(HUD_WIDGET_ID)!.join("\n"), /0 runs · 0 active/);
      assert.equal(statuses.get(HUD_STATUS_ID), "idle");

      hud.onLocalChange();
      hud.onLocalChange();
      assert.equal(widgetCalls(), painted, "unchanged content -> setWidget NOT called again");
      assert.equal(statusCalls(), 1, "unchanged status -> setStatus NOT called again");

      addRun(rt, "r1", "running", Date.now() - 1_000);
      hud.onLocalChange();
      assert.equal(widgetCalls(), painted + 1, "changed content repaints exactly once");
      assert.match(widgets.get(HUD_WIDGET_ID)!.join("\n"), /1 active · longest 1s/);
      assert.equal(statuses.get(HUD_STATUS_ID), "1 active delegation(s)");

      hud.detach();
      assert.equal(widgets.get(HUD_WIDGET_ID), undefined, "detach clears the widget");
      assert.equal(statuses.get(HUD_STATUS_ID), undefined, "detach clears the status");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no runtime -> no paint at all (harmless before the first delegation)", () => {
    const dir = tempDir("nort");
    try {
      const { ctx, widgetCalls } = makeCtx(dir);
      const hud = new SubagentsHud(ctx, () => null, new SharedIntervalTicker(10_000));
      hud.attach();
      hud.onLocalChange();
      assert.equal(widgetCalls(), 0);
      hud.detach();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extension/widget-refresh: shared ticker + content diff", () => {
  it("sameWidgetContent deep-compares string arrays", () => {
    assert.equal(sameWidgetContent(undefined, undefined), true);
    assert.equal(sameWidgetContent(["a"], ["a"]), true);
    assert.equal(sameWidgetContent(["a"], ["a", "b"]), false);
    assert.equal(sameWidgetContent(["a"], ["b"]), false);
    assert.equal(sameWidgetContent(undefined, ["a"]), false);
  });

  it("SharedIntervalTicker fires ALL subscribers from ONE interval and stops when empty", async () => {
    const ticker = new SharedIntervalTicker(10);
    let a = 0;
    let b = 0;
    const offA = ticker.subscribe(() => { a += 1; });
    const offB = ticker.subscribe(() => { b += 1; });
    // Poll instead of a fixed sleep: a loaded CI runner can delay a 10 ms
    // interval (observed a=1,b=1 after 55 ms under a full-suite load).
    const deadline = Date.now() + 1_000;
    while ((a < 3 || b < 3) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(a >= 3 && b >= 3, `both subscribers ticked (a=${a}, b=${b})`);
    offA();
    offB();
    const frozenA = a;
    const frozenB = b;
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(a, frozenA, "no tick after the last unsubscribe (timer stopped)");
    assert.equal(b, frozenB);
  });
});
