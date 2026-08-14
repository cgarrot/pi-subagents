/**
 * src/extension/hud.ts — minimal optional footer widget (stub fonctionnel):
 * a live summary of delegation runs. Safe string[] widget form only (Pi wraps
 * each line in a Text component and truncates itself). Transient — nothing is
 * persisted.
 *
 * Cycle-4 fixes: reconciled summary (every run lands in exactly one bucket —
 * active/complete/failed/preflight[/aborted/escalated] — so the counts add
 * up), the runtime `uptime` line replaced by ACTIVE-RUN durations (`N active
 * · longest 14s`, hidden when idle — no ever-growing idle counter), the
 * repaint diffed via WidgetPainter (idle = 0 repaints) and the periodic
 * refresh riding the SINGLE shared widget ticker instead of a private timer.
 */

import { formatDurationMs, summarizeDelegations, type DelegationSummary } from "../engine/monitor.js";
import { delegationDurationMs, type DelegationMonitorState } from "../engine/runs.js";
import type { GetRuntime } from "./tools.js";
import { WidgetPainter, widgetTicker, type WidgetTicker } from "./widget-refresh.js";
import type { SessionContext } from "./pi-types.js";

export const HUD_WIDGET_ID = "pi-subagents-hud";
export const HUD_STATUS_ID = "subagents";

/** Active run count (queued + running + steered). */
export function activeRunCount(summary: DelegationSummary): number {
  return summary.queued + summary.running + summary.steered;
}

/**
 * Reconciled one-line summary: every run is counted in EXACTLY one bucket so
 * the numbers add up to the total — `N runs · N active · N complete ·
 * N failed · N preflight` (+ `N aborted` / `N escalated` only when nonzero).
 */
export function reconcileSummaryLine(summary: DelegationSummary): string {
  const parts = [
    `${summary.total} runs`,
    `${activeRunCount(summary)} active`,
    `${summary.complete} complete`,
    `${summary.failed} failed`,
    `${summary.preflightFailed} preflight`,
  ];
  if (summary.aborted > 0) parts.push(`${summary.aborted} aborted`);
  if (summary.escalated > 0) parts.push(`${summary.escalated} escalated`);
  return `subagents: ${parts.join(" · ")}`;
}

/**
 * Active-run durations line (`N active · longest 14s`), replacing the old
 * runtime uptime. Undefined when no run is active (line hidden in idle).
 */
export function activeRunsDurationLine(state: DelegationMonitorState, now: number = Date.now()): string | undefined {
  const active = state.runs.filter(
    (run) => run.status === "queued" || run.status === "running" || run.status === "steered",
  );
  if (active.length === 0) return undefined;
  const longest = Math.max(...active.map((run) => delegationDurationMs(run, now)));
  return `${active.length} active · longest ${formatDurationMs(longest)}`;
}

/** Pure renderer — returns the widget lines for a runtime (injectable now). */
export function renderHudLines(
  getRuntime: GetRuntime,
  now: number = Date.now(),
): string[] | undefined {
  const rt = getRuntime();
  if (!rt) return undefined;
  const summary = summarizeDelegations(rt.engine.monitor);
  const lines = [reconcileSummaryLine(summary)];
  const durations = activeRunsDurationLine(rt.engine.monitor, now);
  if (durations) lines.push(durations);
  return lines;
}

/** Small HUD owner: diffed widget refresh on the shared ticker (anti-flicker). */
export class SubagentsHud {
  private unsubscribe?: () => void;
  private readonly ctx: SessionContext;
  private readonly painter: WidgetPainter;

  constructor(
    ctx: SessionContext,
    private readonly getRuntime: GetRuntime,
    private readonly ticker: WidgetTicker = widgetTicker,
  ) {
    this.ctx = ctx;
    this.painter = new WidgetPainter(ctx, HUD_WIDGET_ID, HUD_STATUS_ID);
  }

  attach(): void {
    this.refresh();
    this.unsubscribe = this.ticker.subscribe(() => this.refresh());
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.painter.clear();
  }

  /** Immediate refresh (event hook — called on pi.events lifecycle changes). */
  onLocalChange(): void {
    this.refresh();
  }

  private refresh(): void {
    try {
      const rt = this.getRuntime();
      if (!rt) return;
      this.painter.paintWidget(renderHudLines(this.getRuntime));
      const summary = summarizeDelegations(rt.engine.monitor);
      const active = activeRunCount(summary);
      this.painter.paintStatus(active > 0 ? `${active} active delegation(s)` : "idle");
    } catch {
      // best effort (I10): HUD failure must not affect tools/commands
    }
  }
}
