/**
 * src/extension/commands.ts — /agents, /runs, /subagents doctor.
 * All output via ctx.ui.notify. Reads only the engine monitor + registry.
 */

import { summarizeDelegations, listDelegationRuns, statusIcon } from "../engine/monitor.js";
import { buildAgentCatalog, discoverAgents, formatAgentList } from "../registry/index.js";
import { formatDelegationCatalogSummary } from "./tools.js";
import type { EnsureRuntime } from "./tools.js";
import type { ExtensionAPI, SessionContext } from "./pi-types.js";

function notify(ctx: SessionContext, message: string): void {
  ctx.ui.notify(message, { level: "info" });
}

/** `/agents [list|catalog]` — project agent listing or body-free catalog. */
function registerAgentsCommand(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerCommand("agents", {
    description: "list available delegation agents or the body-free agent catalog",
    handler: (args, ctx) => {
      ensureRuntime(ctx);
      const [sub] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "catalog") {
        const catalog = buildAgentCatalog({ cwd: ctx.cwd, scope: "both" });
        notify(ctx, formatDelegationCatalogSummary(catalog));
        return;
      }
      notify(ctx, formatAgentList(discoverAgents(ctx.cwd, "both")));
    },
  });
}

/** `/runs [active|latest]` — delegation monitor snapshot. */
function registerRunsCommand(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerCommand("runs", {
    description: "show delegation runs (active by default, latest with `latest`)",
    handler: (args, ctx) => {
      const rt = ensureRuntime(ctx);
      const [sub] = args.trim().split(/\s+/).filter(Boolean);
      const sort = sub === "latest" ? "latest" : "active";
      const summary = summarizeDelegations(rt.engine.monitor);
      const runs = listDelegationRuns(rt.engine.monitor, sort).slice(0, 20);
      const lines = [
        `Delegations: ${summary.total} (running=${summary.running} complete=${summary.complete} failed=${summary.failed} preflight=${summary.preflightFailed} aborted=${summary.aborted})`,
        ...runs.map(
          (run) =>
            `${statusIcon(run.status)} ${run.id} ${run.agent} ${run.status}${run.durationMs !== undefined ? ` ${run.durationMs}ms` : ""}`,
        ),
      ];
      notify(ctx, lines.join("\n"));
    },
  });
}

/** `/subagents doctor` — engine/registry/background health summary. */
function registerSubagentsCommand(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerCommand("subagents", {
    description: "pi-subagents doctor: engine + registry + background health summary",
    handler: (args, ctx) => {
      const rt = ensureRuntime(ctx);
      const [sub] = args.trim().split(/\s+/).filter(Boolean);
      if (sub !== "doctor") {
        notify(ctx, "/subagents doctor — pi-subagents engine health summary");
        return;
      }
      const summary = summarizeDelegations(rt.engine.monitor);
      const bgStates = rt.background.list();
      const bgRunning = bgStates.filter((state) => state.status === "running" || state.status === "queued").length;
      const agents = discoverAgents(ctx.cwd, "both");
      const projectCount = agents.filter((agent) => agent.source === "project").length;
      notify(
        ctx,
        [
          `pi-subagents doctor`,
          `  repoRoot: ${rt.repoRoot}`,
          `  engine: ready (runs=${summary.total}, active=${summary.running}, complete=${summary.complete}, failed=${summary.failed}, preflight=${summary.preflightFailed})`,
          `  background: ${bgStates.length} total (${bgRunning} active)`,
          `  agents: ${agents.length} available (${projectCount} project, ${agents.length - projectCount} user)`,
          `  uptime: ${Math.floor((Date.now() - rt.startedAt) / 1000)}s`,
        ].join("\n"),
      );
    },
  });
}

/** Register all subagents commands on the Pi API. */
export function registerCommands(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  registerAgentsCommand(pi, ensureRuntime);
  registerRunsCommand(pi, ensureRuntime);
  registerSubagentsCommand(pi, ensureRuntime);
}
