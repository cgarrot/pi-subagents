// test/extension/widget-events.test.ts — event-driven widget refresh (cycle 4):
// the extension subscribes the HUD + FleetView to the pi.events lifecycle
// channels at session_start, so a settle repaints immediately (the previously
// dead onLocalChange hook is finally fed); polling stays the safety net.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import subagentsExtension from "../../src/extension/index.js";
import type { SessionContext } from "../../src/extension/pi-types.js";
import { emitTo, stubApi, type CapturedApi } from "./stub-api.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-wev-${label}-`));
}

function uiCtx(dir: string): { ctx: SessionContext; setWidgetCalls: () => number; paintedBy: (id: string) => string } {
  let calls = 0;
  const painted = new Map<string, string>();
  const ctx: SessionContext = {
    cwd: dir,
    hasUI: true,
    ui: {
      notify: () => {},
      setWidget: (id, content) => {
        calls += 1;
        painted.set(id, content ? content.join("\n") : "");
      },
      setStatus: () => {},
    },
  };
  return { ctx, setWidgetCalls: () => calls, paintedBy: (id) => painted.get(id) ?? "" };
}

async function startSession(captured: CapturedApi, ctx: SessionContext): Promise<void> {
  const start = captured.events.find((entry) => entry.name === "session_start");
  assert.ok(start, "session_start handler registered");
  await (start.handler as (event: unknown, ctx: SessionContext) => void | Promise<void>)({}, ctx);
}

describe("extension/widgets: event-driven refresh on pi.events", () => {
  it("subscribes the widgets to the lifecycle channels at session_start", async () => {
    const dir = tempDir("channels");
    try {
      const captured = stubApi();
      subagentsExtension(captured.api);
      const { ctx } = uiCtx(dir);
      await startSession(captured, ctx);
      for (const channel of ["subagents:started", "subagents:completed", "subagents:failed", "subagents:aborted", "subagents:escalated"]) {
        assert.ok((captured.eventHandlers.get(channel) ?? []).length > 0, `handler subscribed on ${channel}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a lifecycle event repaints the widgets immediately once a runtime exists", async () => {
    const dir = tempDir("refresh");
    try {
      const captured = stubApi();
      subagentsExtension(captured.api);
      const { ctx, setWidgetCalls, paintedBy } = uiCtx(dir);
      await startSession(captured, ctx);

      // No runtime yet -> no paint at all.
      assert.equal(setWidgetCalls(), 0);

      // Build the runtime the way a real session does: the first tool/command
      // call hits ensureRuntime (here: /runs).
      const runs = captured.commands.get("runs");
      assert.ok(runs);
      runs.handler("", ctx);

      // Emitting a lifecycle event on the bus must refresh the widgets NOW
      // (no 2s polling wait) — the summary line renders from the live monitor.
      emitTo(captured, "subagents:started", { runId: "r1", agent: "alpha", status: "running" });
      assert.ok(setWidgetCalls() >= 2, `both widgets repainted on the event (calls=${setWidgetCalls()})`);
      assert.match(paintedBy("pi-subagents-hud"), /0 runs · 0 active/, "hud summary line painted from the live monitor");
      assert.match(paintedBy("pi-subagents-fleet"), /fleet: no active runs/, "fleet painted from the live monitor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to polling-only when the host has no event bus", async () => {
    const dir = tempDir("nobus");
    try {
      const captured = stubApi();
      const { api } = captured;
      const bare = { ...api, events: undefined };
      subagentsExtension(bare);
      const { ctx, setWidgetCalls } = uiCtx(dir);
      const start = captured.events.find((entry) => entry.name === "session_start");
      assert.ok(start);
      await (start.handler as (event: unknown, ctx: SessionContext) => void | Promise<void>)({}, ctx);
      captured.commands.get("runs")!.handler("", ctx);
      assert.equal(setWidgetCalls(), 0, "no bus -> no event refresh (widgets idle until the ticker)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
