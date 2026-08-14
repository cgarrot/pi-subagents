/**
 * src/extension/fleet.ts — FleetView widget (B6): persistent visibility of
 * active delegation runs.
 *
 * Renders a live footer widget listing active runs (agent / status / tokens /
 * cost / duration), refreshes on a bounded timer (which catches completion and
 * failure transitions) plus an explicit `onLocalChange()` hook, supports a
 * BOUNDED transcript peek (reads the run's session jsonl, capped by lines and
 * bytes), and a `stop` action that aborts a run via the engine monitor.
 *
 * Safe string[] widget form only (Pi wraps each line in a Text component and
 * truncates itself). Transient — nothing is persisted.
 *
 * Zero @earendil-works/* imports.
 */

import { readFileSync } from "node:fs";
import { compactTokens, formatDurationMs, listDelegationRuns, statusIcon, summarizeDelegations } from "../engine/monitor.js";
import { abortDelegationRun, delegationDurationMs, isTerminalStatus, type DelegationRunStatus, type DelegationRunView } from "../engine/runs.js";
import type { GetRuntime } from "./tools.js";
import { WidgetPainter, widgetTicker, type WidgetTicker } from "./widget-refresh.js";
import type { SessionContext, WidgetContent, WidgetKey } from "./pi-types.js";

export const FLEET_WIDGET_ID: WidgetKey = "pi-subagents-fleet";
export const FLEET_STATUS_ID = "subagents-fleet";
export const FLEET_MAX_RUNS = 8;
export const PEEK_MAX_LINES = 20;
export const PEEK_MAX_BYTES = 4_000;

/** One rendered fleet row (pure data, injectable for tests). */
export interface FleetRunLine {
  id: string;
  agent: string;
  status: DelegationRunStatus;
  tokens: number;
  cost: number;
  durationMs: number;
  /** True while `tokens` is the LIVE context snapshot (mid-run estimate ≈). */
  live: boolean;
  /** Live model when the turn feed carried one (settled runs read run.model). */
  model?: string;
}

/**
 * Extract the token + cost summary from a run's usage. Settled usage
 * (input+output > 0) wins; an ACTIVE run with a live turn snapshot falls
 * back to `liveUsage.contextTokens` (marked live — cost unknown mid-run);
 * a settled usage with zero in/out but a context snapshot shows the snapshot.
 */
export function runUsageSummary(run: DelegationRunView): { tokens: number; cost: number; live: boolean } {
  const usage = run.usage;
  if (usage && (usage.input > 0 || usage.output > 0)) {
    const tokens = usage.input + usage.output;
    const cost = typeof usage.cost === "number" ? usage.cost : 0;
    return { tokens, cost, live: false };
  }
  const live = run.liveUsage;
  if (!isTerminalStatus(run.status) && live && (live.turns > 0 || (live.contextTokens ?? 0) > 0)) {
    return { tokens: live.contextTokens ?? 0, cost: 0, live: true };
  }
  if (usage && (usage.turns > 0 || usage.contextTokens > 0)) {
    return { tokens: usage.contextTokens, cost: typeof usage.cost === "number" ? usage.cost : 0, live: false };
  }
  return { tokens: 0, cost: 0, live: false };
}

/** Build the active-run rows for the fleet widget (bounded to FLEET_MAX_RUNS). */
export function fleetRunLines(getRuntime: GetRuntime, now: number = Date.now()): FleetRunLine[] {
  const rt = getRuntime();
  if (!rt) return [];
  return listDelegationRuns(rt.engine.monitor, "active")
    .filter((run) => run.status === "queued" || run.status === "running")
    .slice(0, FLEET_MAX_RUNS)
    .map((run) => {
      const { tokens, cost, live } = runUsageSummary(run);
      return {
        id: run.id,
        agent: run.agent,
        status: run.status,
        tokens,
        cost,
        durationMs: delegationDurationMs(run, now),
        live,
        model: run.liveUsage?.model ?? run.model,
      };
    });
}

/** Pure renderer — returns the widget lines for a runtime (injectable now). */
export function renderFleetLines(getRuntime: GetRuntime, now: number = Date.now()): WidgetContent {
  const rt = getRuntime();
  if (!rt) return undefined;
  const rows = fleetRunLines(getRuntime, now);
  if (rows.length === 0) return ["fleet: no active runs"];
  const lines = [`fleet: ${rows.length} active`];
  for (const row of rows) {
    const parts = [`${statusIcon(row.status)} ${row.agent} ${row.status}`];
    // Live rows carry the ≈ estimate marker (settle replaces it with the
    // authoritative input+output totals); zero-token rows omit the segment.
    if (row.tokens > 0) parts.push(`${row.live ? "≈" : ""}${compactTokens(row.tokens)} tok`);
    if (row.cost > 0) parts.push(`$${row.cost.toFixed(4)}`);
    parts.push(formatDurationMs(row.durationMs));
    lines.push(parts.join(" · "));
  }
  return lines;
}

/**
 * Bounded transcript peek: read the run's session jsonl, capped by both a max
 * line count and a max byte count. Never throws — returns a short message on
 * any read failure or when no session path is recorded.
 */
export function peekTranscript(
  run: DelegationRunView | undefined,
  maxLines: number = PEEK_MAX_LINES,
  maxBytes: number = PEEK_MAX_BYTES,
): string {
  if (!run?.sessionPath) return "(no session transcript)";
  try {
    const raw = readFileSync(run.sessionPath, "utf8");
    const lines = raw.split("\n").slice(0, maxLines);
    let text = lines.join("\n");
    if (raw.length > maxBytes || text.length > maxBytes) {
      text = `${text.slice(0, maxBytes)}\n…[truncated]`;
    }
    return text;
  } catch {
    return "(transcript unavailable)";
  }
}

/**
 * Stop a run via the engine monitor abort. Marks a queued/running run as
 * aborted; returns a short status message. No-op for unknown or already
 * terminal runs.
 */
export function stopRun(getRuntime: GetRuntime, runId: string): string {
  const rt = getRuntime();
  if (!rt) return "no runtime";
  const run = rt.engine.monitor.runs.find((candidate) => candidate.id === runId);
  if (!run) return `run not found: ${runId}`;
  if (run.status === "queued" || run.status === "running") {
    abortDelegationRun(rt.engine.monitor, runId, "Stopped from FleetView");
    return `stopped ${runId}`;
  }
  return `run ${runId} already ${run.status}`;
}

/** Small FleetView owner: diffed refresh on the shared ticker (anti-flicker). */
export class FleetView {
  private unsubscribe?: () => void;
  private readonly ctx: SessionContext;
  private readonly painter: WidgetPainter;

  constructor(
    ctx: SessionContext,
    private readonly getRuntime: GetRuntime,
    private readonly ticker: WidgetTicker = widgetTicker,
  ) {
    this.ctx = ctx;
    this.painter = new WidgetPainter(ctx, FLEET_WIDGET_ID, FLEET_STATUS_ID);
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

  /** Refresh immediately when a run completes/fails (event hook). */
  onLocalChange(): void {
    this.refresh();
  }

  private refresh(): void {
    try {
      const rt = this.getRuntime();
      if (!rt) return;
      this.painter.paintWidget(renderFleetLines(this.getRuntime));
      const summary = summarizeDelegations(rt.engine.monitor);
      const active = summary.queued + summary.running + summary.steered;
      this.painter.paintStatus(active > 0 ? `${active} active run(s)` : "idle");
    } catch {
      // best effort (I10): FleetView failure must not affect tools/commands
    }
  }
}
