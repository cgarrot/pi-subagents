/**
 * src/extension/widget-refresh.ts — anti-flicker widget plumbing (cycle 4).
 *
 * Two defects fixed here:
 *   1. TWO independent 2s timers (HUD + FleetView) each repainting
 *      unconditionally at every tick — replaced by ONE shared ticker all
 *      widgets subscribe to (created lazily on the first subscriber, stopped
 *      when the last one detaches).
 *   2. Unconditional setWidget/setStatus calls (flicker): WidgetPainter
 *      diffs the rendered content and SKIPS the host call when nothing
 *      changed — an idle session performs ZERO repaints.
 *
 * Zero @earendil-works/* imports.
 */

import type { SessionContext, WidgetContent } from "./pi-types.js";

/** Shared refresh period (safety-net polling; event bus drives immediate refreshes). */
export const WIDGET_REFRESH_MS = 2_000;

/** Minimal subscription surface (injectable for tests). */
export interface WidgetTicker {
  subscribe(refresh: () => void): () => void;
}

/**
 * One shared interval for every widget owner. The timer starts when the first
 * listener subscribes and stops when the last one leaves — a single 2s tick
 * for HUD + FleetView instead of two independent timers.
 */
export class SharedIntervalTicker implements WidgetTicker {
  private timer?: NodeJS.Timeout;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly intervalMs: number = WIDGET_REFRESH_MS) {}

  subscribe(refresh: () => void): () => void {
    this.listeners.add(refresh);
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.fire(), this.intervalMs);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(refresh);
      if (this.listeners.size === 0 && this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  private fire(): void {
    for (const refresh of [...this.listeners]) {
      try {
        refresh();
      } catch {
        // I10: one failing widget must never break the shared tick
      }
    }
  }
}

/** Process-wide shared widget ticker (HUD + FleetView ride the same timer). */
export const widgetTicker: WidgetTicker = new SharedIntervalTicker();

/** True when two widget contents render identically (deep string-array equal). */
export function sameWidgetContent(a: WidgetContent, b: WidgetContent): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((line, index) => line === b[index]);
}

/**
 * Diffing painter for one footer widget + its status line: setWidget /
 * setStatus are called ONLY when the rendered content actually changed, so an
 * unchanged render is a zero-op (no flicker). `clear()` always forces the
 * host calls (detach path).
 */
export class WidgetPainter {
  private lastWidget: WidgetContent = undefined;
  private widgetPainted = false;
  private lastStatus: string | undefined;
  private statusPainted = false;

  constructor(
    private readonly ctx: SessionContext,
    private readonly widgetId: string,
    private readonly statusId: string,
  ) {}

  /** Paint the widget content unless it renders identically to the last paint. */
  paintWidget(content: WidgetContent): void {
    if (this.widgetPainted && sameWidgetContent(this.lastWidget, content)) return;
    this.ctx.ui.setWidget?.(this.widgetId, content);
    this.lastWidget = content;
    this.widgetPainted = true;
  }

  /** Paint the status text unless it is identical to the last paint. */
  paintStatus(text: string | undefined): void {
    if (this.statusPainted && this.lastStatus === text) return;
    this.ctx.ui.setStatus?.(this.statusId, text);
    this.lastStatus = text;
    this.statusPainted = true;
  }

  /** Force-clear the widget + status and reset the diff state (detach). */
  clear(): void {
    this.ctx.ui.setWidget?.(this.widgetId, undefined);
    this.ctx.ui.setStatus?.(this.statusId, undefined);
    this.lastWidget = undefined;
    this.widgetPainted = false;
    this.lastStatus = undefined;
    this.statusPainted = false;
  }
}
