/**
 * src/extension/index.ts — pi-subagents Pi extension entrypoint (thin adapter).
 *
 * This is the ONLY layer that knows the local pi-types.ts (invariant I9). It
 * registers the 5 delegation tools + the /agents, /runs, /subagents commands
 * immediately, and attaches the minimal HUD widget on session_start (TUI only).
 * All business logic lives in the Pi-free core/engine.
 *
 * Zero @earendil-works/* imports.
 */

import { registerCommands } from "./commands.js";
import { SubagentsEventBus } from "./events.js";
import { FleetView } from "./fleet.js";
import { SubagentsHud } from "./hud.js";
import type { ExtensionAPI, SessionContext } from "./pi-types.js";
import { registerSubagentsRpc } from "./rpc.js";
import { createSubagentsRuntime, registerTools, type SubagentsRuntime } from "./tools.js";

export default function subagentsExtension(pi: ExtensionAPI): void {
  let runtime: SubagentsRuntime | null = null;
  let hud: SubagentsHud | null = null;
  let fleet: FleetView | null = null;

  // B7: lifecycle event bus (no-op without pi.events) fed by the engine's
  // hash-only ledger stream; RPC lets other extensions ping/spawn/stop us.
  const eventBus = new SubagentsEventBus(pi.events);

  const getRuntime = (): SubagentsRuntime | null => runtime;

  /** Build the engine runtime bound to the session cwd (lazy, cached per root). */
  const ensureRuntime = (ctx: SessionContext): SubagentsRuntime => {
    if (runtime && runtime.repoRoot === ctx.cwd) return runtime;
    if (runtime) {
      try {
        runtime.engine.close();
      } catch {
        // best effort (I10): a close failure must not crash registration
      }
      runtime = null;
    }
    runtime = createSubagentsRuntime(ctx.cwd, {
      onLedger: (entry) => eventBus.handleLedgerEntry(entry),
    });
    return runtime;
  };

  // Tools + commands are registered IMMEDIATELY (they build the engine lazily).
  registerTools(pi, ensureRuntime);
  registerCommands(pi, ensureRuntime);
  // Cross-extension RPC (ping/spawn/stop) — no-op when the host has no bus.
  registerSubagentsRpc(pi, { getRuntime, eventBus });

  // Minimal HUD + FleetView on TUI sessions; harmless no-op when setWidget/setStatus absent.
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI && !ctx.ui.setWidget && !ctx.ui.setStatus) return;
    try {
      hud = new SubagentsHud(ctx, getRuntime);
      hud.attach();
    } catch {
      // best effort (I10): HUD failure must not affect tools/commands
    }
    try {
      fleet = new FleetView(ctx, getRuntime);
      fleet.attach();
    } catch {
      // best effort (I10): FleetView failure must not affect tools/commands
    }
  });

  // Close the engine pool (aborts in-flight children) and detach the HUD.
  pi.on("session_shutdown", () => {
    if (runtime) {
      try {
        runtime.engine.close();
      } catch {
        // best effort
      }
      runtime = null;
    }
    if (hud) {
      try {
        hud.detach();
      } catch {
        // best effort
      }
      hud = null;
    }
    if (fleet) {
      try {
        fleet.detach();
      } catch {
        // best effort
      }
      fleet = null;
    }
  });
}
