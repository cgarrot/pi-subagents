/**
 * src/extension/hud.ts — minimal optional footer widget (stub fonctionnel):
 * a live summary of active delegation runs. Safe string[] widget form only
 * (Pi wraps each line in a Text component and truncates itself). Transient —
 * nothing is persisted.
 */

import { hasActiveDelegations, summarizeDelegations } from "../engine/monitor.js";
import type { GetRuntime } from "./tools.js";
import type { SessionContext } from "./pi-types.js";

export const HUD_WIDGET_ID = "pi-subagents-hud";
export const HUD_STATUS_ID = "subagents";
export const HUD_REFRESH_MS = 2_000;

/** Pure renderer — returns the widget lines for a runtime (injectable now). */
export function renderHudLines(
  getRuntime: GetRuntime,
  now: number = Date.now(),
): string[] | undefined {
  const rt = getRuntime();
  if (!rt) return undefined;
  const summary = summarizeDelegations(rt.engine.monitor);
  return [
    `subagents: ${summary.total} runs · ${summary.running} active · ${summary.complete} complete · ${summary.failed} failed`,
    `uptime ${Math.max(0, Math.floor((now - rt.startedAt) / 1000))}s`,
  ];
}

/** Small HUD owner: attaches a periodic widget refresh to a session context. */
export class SubagentsHud {
  private timer?: NodeJS.Timeout;
  private readonly ctx: SessionContext;

  constructor(ctx: SessionContext, private readonly getRuntime: GetRuntime) {
    this.ctx = ctx;
  }

  attach(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), HUD_REFRESH_MS);
    this.timer.unref();
  }

  detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ctx.ui.setWidget?.(HUD_WIDGET_ID, undefined);
    this.ctx.ui.setStatus?.(HUD_STATUS_ID, undefined);
  }

  onLocalChange(): void {
    this.refresh();
  }

  private refresh(): void {
    const rt = this.getRuntime();
    const lines = renderHudLines(this.getRuntime);
    if (!rt) return;
    this.ctx.ui.setWidget?.(HUD_WIDGET_ID, lines);
    const summary = summarizeDelegations(rt.engine.monitor);
    this.ctx.ui.setStatus?.(
      HUD_STATUS_ID,
      hasActiveDelegations(rt.engine.monitor) ? `${summary.running} active delegation(s)` : "idle",
    );
  }
}
