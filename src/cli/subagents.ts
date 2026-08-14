/**
 * src/cli/subagents.ts — pi-subagents debug/admin CLI.
 *
 * Mirror of the pi-mesh `src/cli/mesh.ts` debug/admin pattern: a small
 * command-line surface over the pure core with clean exit codes
 * (0 success, 1 error, 2 usage). Commands:
 *
 *   subagents agents   [--scope project|user|both]
 *   subagents catalog
 *   subagents contract "<six-part task>"
 *   subagents runs     [--sort active|latest|duration|agent]
 *   subagents doctor   [--timing]
 *   subagents --help
 *
 * The bottom auto-run is guarded so tests can import `main` and the command
 * handlers directly without launching real `pi`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildAgentCatalog, formatAgentList, discoverAgents, type AgentCard } from "../registry/index.js";
import { validateSixPartContract, formatContractTemplate } from "../gates/index.js";
import { LanePool } from "../lanes/index.js";
import { loadConfig, configFilePath, type SubagentsConfig } from "../shared/index.js";
import type { AgentScope } from "../core/types.js";
import type { DelegationSortMode } from "../engine/monitor.js";

const VERSION = "0.1.0";
const DOCTOR_TIMEOUT_MS = 10_000;
const BOOT_TIMEOUT_MS = 20_000;
const BOOT_KILL_GRACE_MS = 5_000;

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function piCommand(env: NodeJS.ProcessEnv): string {
  const override = env.SUBAGENTS_PI_COMMAND;
  return override && override.trim() !== "" ? override.trim() : "pi";
}

function resolveLedgerDir(cwd: string, cfg: SubagentsConfig): string {
  return join(cwd, cfg.ledgerDir);
}

function usage(stream: NodeJS.WriteStream): void {
  stream.write(
    `usage: subagents <command> [options]\n\n` +
      `commands:\n` +
      `  agents [--scope project|user|both]   list discovered delegation agents\n` +
      `  catalog                               build and print the body-free agent catalog\n` +
      `  contract "<task>"                     validate a six-part delegation contract\n` +
      `  runs [--sort active|latest|duration|agent]  list delegation runs from the ledger\n` +
      `  doctor [--timing]                     check runtime health (pi, dirs, lanes)\n` +
      `  --help                                show this help\n`,
  );
}

// ---- agents ----

function cmdAgents(args: string[], cfg: SubagentsConfig): number {
  const raw = argValue(args, "--scope") ?? cfg.defaultScope;
  const scope: AgentScope = raw === "project" || raw === "user" || raw === "both" ? raw : cfg.defaultScope;
  const cards: AgentCard[] = discoverAgents(process.cwd(), scope);
  process.stdout.write(`agents (scope=${scope}, ${cards.length})\n`);
  process.stdout.write(formatAgentList(cards) + "\n");
  return 0;
}

// ---- catalog ----

function cmdCatalog(cfg: SubagentsConfig): number {
  const catalog = buildAgentCatalog({ cwd: process.cwd(), scope: cfg.defaultScope });
  process.stdout.write(
    [
      `catalog schema=${catalog.schema} scope=${catalog.scope}`,
      `counts total=${catalog.counts.total} project=${catalog.counts.project} user=${catalog.counts.user}`,
      `noExecution=${catalog.noExecution} bodyStored=${catalog.bodyStored} promptBodiesStored=${catalog.promptBodiesStored}`,
      ...catalog.entries.map((entry) => `- ${entry.id} [${entry.source}] tools=${entry.tools?.join(",") ?? "default"}${entry.model ? ` model=${entry.model}` : ""}: ${entry.description}`),
    ].join("\n") + "\n",
  );
  return 0;
}

// ---- contract ----

function cmdContract(task: string | undefined): number {
  if (!task) {
    process.stderr.write("usage: subagents contract \"<six-part task>\"\n");
    process.stderr.write(formatContractTemplate() + "\n");
    return 2;
  }
  const errors = validateSixPartContract(task);
  if (errors.length === 0) {
    process.stdout.write("contract: valid (six parts present, in order)\n");
    return 0;
  }
  process.stdout.write("contract: INVALID\n");
  for (const error of errors) process.stdout.write(`  - ${error}\n`);
  return 1;
}

// ---- runs ----

const RUN_SORTS: readonly string[] = ["active", "latest", "duration", "agent"];

function terminalRankOf(status: string | undefined): number {
  switch (status) {
    case "running": return 0;
    case "queued": return 1;
    case "failed": return 2;
    case "preflight_failed": return 3;
    case "aborted": return 4;
    case "complete": return 5;
    default: return 6;
  }
}

interface LedgerRun {
  runId: string;
  status?: string;
  agent?: string;
  startedAt?: string;
  latencyMs?: number;
}

function readLedgerRuns(dir: string): LedgerRun[] {
  if (!existsSync(dir)) return [];
  const runs: LedgerRun[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof entry.runId !== "string") continue;
        runs.push({
          runId: entry.runId,
          status: typeof entry.status === "string" ? entry.status : undefined,
          agent: typeof entry.agent === "string" ? entry.agent : undefined,
          startedAt: typeof entry.startedAt === "string" ? entry.startedAt : typeof entry.timestamp === "string" ? entry.timestamp : undefined,
          latencyMs: typeof entry.latencyMs === "number" ? entry.latencyMs : undefined,
        });
      } catch {
        // skip unparseable line
      }
    }
  }
  return runs;
}

function sortRuns(runs: LedgerRun[], sort: DelegationSortMode): LedgerRun[] {
  const sorted = [...runs];
  const time = (run: LedgerRun): number => (run.startedAt ? Date.parse(run.startedAt) || 0 : 0);
  switch (sort) {
    case "agent":
      sorted.sort((a, b) => (a.agent ?? "").localeCompare(b.agent ?? "") || time(b) - time(a));
      break;
    case "duration":
      sorted.sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0) || time(b) - time(a));
      break;
    case "latest":
      sorted.sort((a, b) => time(b) - time(a));
      break;
    default: // active
      sorted.sort((a, b) => terminalRankOf(a.status) - terminalRankOf(b.status) || time(b) - time(a));
  }
  return sorted;
}

function cmdRuns(args: string[], cfg: SubagentsConfig): number {
  const raw = argValue(args, "--sort");
  const sort: DelegationSortMode = raw && (RUN_SORTS as readonly string[]).includes(raw) ? (raw as DelegationSortMode) : "active";
  const dir = resolveLedgerDir(process.cwd(), cfg);
  const runs = sortRuns(readLedgerRuns(dir), sort);
  if (runs.length === 0) {
    process.stdout.write(`(no runs in ${dir})\n`);
    return 0;
  }
  process.stdout.write(`runs (${runs.length}, sort=${sort}) in ${dir}\n`);
  for (const run of runs) {
    process.stdout.write(
      `${run.runId}\t${run.status ?? "?"}\tagent=${run.agent ?? "-"}\tstarted=${run.startedAt ?? "-"}\tduration=${run.latencyMs ?? "-"}ms\n`,
    );
  }
  return 0;
}

// ---- doctor ----

/** Spawn `<command> --version` with a bounded timeout; true when exit 0. */
function checkPiAvailable(command: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; code: number | null; error?: string }> {
  return new Promise((resolveCheck) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok: boolean; code: number | null; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveCheck(result);
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(command, ["--version"], { cwd: process.cwd(), shell: false, stdio: ["ignore", "ignore", "pipe"], env });
    } catch (error) {
      finish({ ok: false, code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stderrTail = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-512);
    });
    const timeout = setTimeout(() => {
      try { child?.kill("SIGTERM"); } catch { /* noop */ }
      killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* noop */ } }, DOCTOR_TIMEOUT_MS);
      killTimer.unref();
      finish({ ok: false, code: null, error: `timed out after ${DOCTOR_TIMEOUT_MS}ms` });
    }, DOCTOR_TIMEOUT_MS);
    timeout.unref();
    child.on("error", (error) => finish({ ok: false, code: null, error: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, code }));
  });
}

/**
 * Boot a real `pi` one-shot via stdin with a trivial task and measure elapsed
 * time. Bounded timeout (<= BOOT_TIMEOUT_MS) with SIGTERM -> SIGKILL cleanup.
 * A spawn error (ENOENT) means `pi` is not present.
 */
function bootPiOnce(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; code: number | null; elapsedMs: number; timedOut: boolean; error?: string }> {
  return new Promise((resolveBoot) => {
    const startedAt = Date.now();
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok: boolean; code: number | null; timedOut: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveBoot({ ...result, elapsedMs: Date.now() - startedAt });
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(command, ["--mode", "json", "-p", "--no-extensions"], {
        cwd: process.cwd(),
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        env,
      });
    } catch (error) {
      finish({ ok: false, code: null, timedOut: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stderrTail = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-512);
    });
    const timeout = setTimeout(() => {
      try { child?.kill("SIGTERM"); } catch { /* noop */ }
      killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* noop */ } }, BOOT_KILL_GRACE_MS);
      killTimer.unref();
      finish({ ok: false, code: null, timedOut: true });
    }, BOOT_TIMEOUT_MS);
    timeout.unref();
    child.on("error", (error) => finish({ ok: false, code: null, timedOut: false, error: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, code, timedOut: false }));
    // One-shot stdin injection, then close the pipe.
    try {
      child.stdin!.write("Reply with the single word: ok\n");
      child.stdin!.end();
    } catch {
      // stdin may already be closed (spawn error path)
    }
  });
}

async function cmdDoctor(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const cwd = process.cwd();
  const command = piCommand(env);
  const sessionDir = join(cwd, ".pi", "agent-sessions");
  const ledgerDir = join(cwd, ".pi", "logs", "runs");

  // LanePool state (no dispatch; just report the hot-pool surface).
  const pool = new LanePool({ cwd, piCommand: command });
  const laneCount = pool.laneCount;
  const activeCount = pool.activeCountValue;
  pool.closeAll();

  const pi = await checkPiAvailable(command, env);
  const piLabel = pi.ok ? "available" : `missing (${pi.error ?? `exit ${pi.code ?? "?"}`})`;

  const lines: string[] = [
    `pi command: ${command} -> ${piLabel}`,
    `session dir: ${sessionDir} exists=${existsSync(sessionDir)}`,
    `ledger dir: ${ledgerDir} exists=${existsSync(ledgerDir)}`,
    `LanePool: lanes=${laneCount} active=${activeCount} closed=false`,
    `config: ${configFilePath(cwd)}${existsSync(configFilePath(cwd)) ? "" : " (absent, defaults)"}`,
  ];

  if (hasFlag(args, "--timing")) {
    const boot = await bootPiOnce(command, env);
    if (boot.error && boot.code === null && !boot.timedOut) {
      lines.push(`boot one-shot: FAILED (${boot.error})`);
    } else if (boot.timedOut) {
      lines.push(`boot one-shot: TIMED OUT after ${BOOT_TIMEOUT_MS}ms (killed)`);
    } else {
      lines.push(`boot one-shot: done in ${boot.elapsedMs}ms (exit ${boot.code ?? "?"})`);
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
  return pi.ok ? 0 : 1;
}

// ---- dispatch ----

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    usage(process.stdout);
    return cmd === undefined ? 2 : 0;
  }
  const cfg = loadConfig(process.cwd(), env);
  switch (cmd) {
    case "agents":
      return cmdAgents(args, cfg);
    case "catalog":
      return cmdCatalog(cfg);
    case "contract":
      return cmdContract(args[0]);
    case "runs":
      return cmdRuns(args, cfg);
    case "doctor":
      return cmdDoctor(args, env);
    case "--version":
      process.stdout.write(`subagents ${VERSION}\n`);
      return 0;
    default:
      usage(process.stderr);
      return 2;
  }
}

// Guarded auto-run: only when executed as the bin/entry (not on import by tests).
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`subagents cli fatal: ${String(err)}\n`);
      process.exit(1);
    });
}
