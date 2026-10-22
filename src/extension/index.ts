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
import { SubagentsEventBus, SUBAGENTS_EVENT_CHANNEL } from "./events.js";
import { FleetView } from "./fleet.js";
import { SubagentsHud } from "./hud.js";
import type { ExtensionAPI, SessionContext } from "./pi-types.js";
import { registerSubagentsRpc } from "./rpc.js";
import { registerRpcTools } from "./rpc-tools.js";
import { registerMeshCtl } from "./mesh-ctl.js";
import { RpcWorkerRegistry } from "../rpc/registry.js";
import { createSubagentsRuntime, registerTools, type SubagentsRuntime } from "./tools.js";

/**
 * Lifecycle channels that flip widget content (start/terminal transitions).
 * The widgets ALSO keep the shared 2s ticker as a safety net, but these
 * subscriptions make the refresh EVENT-driven: a settle repaints immediately
 * instead of waiting for the next polling tick (the previously dead
 * `onLocalChange` hook is finally fed). Absent `pi.events` degrades to
 * polling-only.
 */
const WIDGET_REFRESH_CHANNELS = [
  SUBAGENTS_EVENT_CHANNEL.started,
  SUBAGENTS_EVENT_CHANNEL.completed,
  SUBAGENTS_EVENT_CHANNEL.failed,
  SUBAGENTS_EVENT_CHANNEL.aborted,
  SUBAGENTS_EVENT_CHANNEL.escalated,
] as const;

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
      // F3: prefer the live session model when the host exposes it on the
      // context; otherwise the runtime falls back to the pi settings
      // defaultModel reader (project over global) inside createSubagentsRuntime.
      parentModel: ctx.model,
    });
    return runtime;
  };

  // Tools + commands are registered IMMEDIATELY (they build the engine lazily).
  registerTools(pi, ensureRuntime);
  registerCommands(pi, ensureRuntime);
  // Controller-owned headless workers (rpc_start/prompt/abort/redirect/state/stop).
  // One registry per session; the workers are stopped on session shutdown.
  const rpcRegistry = new RpcWorkerRegistry();
  registerRpcTools(pi, () => rpcRegistry);
  // Remote run control from pi-mesh (the mesh policy already authorized the
  // sender; this handler only acts on this session's own workers).
  registerMeshCtl(pi, () => rpcRegistry);
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
    // Event-driven refresh: repaint the widgets the moment a run lifecycle
    // event lands on the bus (no stale 'running' row until the next tick).
    if (pi.events) {
      const refreshWidgets = (): void => {
        try {
          hud?.onLocalChange();
        } catch {
          // best effort (I10)
        }
        try {
          fleet?.onLocalChange();
        } catch {
          // best effort (I10)
        }
      };
      for (const channel of WIDGET_REFRESH_CHANNELS) {
        try {
          pi.events.on(channel, refreshWidgets);
        } catch {
          // best effort (I10): a failing bus must not break session start
        }
      }
    }
  });

  // Close the engine pool (aborts in-flight children) and detach the HUD.
  pi.on("session_shutdown", async () => {
    // A controller-owned worker must not outlive the session that owns it.
    // Await the bounded stop so a fast host exit does not orphan the tree.
    await rpcRegistry.disposeAll();
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
