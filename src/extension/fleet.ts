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
import { listDelegationRuns, statusIcon, summarizeDelegations } from "../engine/monitor.js";
import { abortDelegationRun, delegationDurationMs, type DelegationRunStatus, type DelegationRunView } from "../engine/runs.js";
import type { GetRuntime } from "./tools.js";
import type { SessionContext, WidgetContent, WidgetKey } from "./pi-types.js";

export const FLEET_WIDGET_ID: WidgetKey = "pi-subagents-fleet";
export const FLEET_STATUS_ID = "subagents-fleet";
export const FLEET_REFRESH_MS = 2_000;
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
}

/** Extract the token + cost summary from a run's usage (0 when absent). */
export function runUsageSummary(run: DelegationRunView): { tokens: number; cost: number } {
  const usage = run.usage;
  if (!usage) return { tokens: 0, cost: 0 };
  const tokens = (usage.input ?? 0) + (usage.output ?? 0);
  const cost = typeof usage.cost === "number" ? usage.cost : 0;
  return { tokens, cost };
}

/** Build the active-run rows for the fleet widget (bounded to FLEET_MAX_RUNS). */
export function fleetRunLines(getRuntime: GetRuntime, now: number = Date.now()): FleetRunLine[] {
  const rt = getRuntime();
  if (!rt) return [];
  return listDelegationRuns(rt.engine.monitor, "active")
    .filter((run) => run.status === "queued" || run.status === "running")
    .slice(0, FLEET_MAX_RUNS)
    .map((run) => {
      const { tokens, cost } = runUsageSummary(run);
      return {
        id: run.id,
        agent: run.agent,
        status: run.status,
        tokens,
        cost,
        durationMs: delegationDurationMs(run, now),
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
    lines.push(
      `${statusIcon(row.status)} ${row.agent} ${row.status} · ${row.tokens} tok · $${row.cost.toFixed(4)} · ${row.durationMs}ms`,
    );
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

/** Small FleetView owner: attaches a periodic widget refresh to a session ctx. */
export class FleetView {
  private timer?: NodeJS.Timeout;
  private readonly ctx: SessionContext;

  constructor(ctx: SessionContext, private readonly getRuntime: GetRuntime) {
    this.ctx = ctx;
  }

  attach(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), FLEET_REFRESH_MS);
    this.timer.unref();
  }

  detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ctx.ui.setWidget?.(FLEET_WIDGET_ID, undefined);
    this.ctx.ui.setStatus?.(FLEET_STATUS_ID, undefined);
  }

  /** Refresh immediately when a run completes/fails (event hook). */
  onLocalChange(): void {
    this.refresh();
  }

  private refresh(): void {
    const rt = this.getRuntime();
    if (!rt) return;
    this.ctx.ui.setWidget?.(FLEET_WIDGET_ID, renderFleetLines(this.getRuntime));
    const summary = summarizeDelegations(rt.engine.monitor);
    this.ctx.ui.setStatus?.(
      FLEET_STATUS_ID,
      summary.running > 0 ? `${summary.running} active run(s)` : "idle",
    );
  }
}
