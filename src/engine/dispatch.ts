/**
 * src/engine/dispatch.ts — engine assembly: gates -> registry -> models ->
 * lanes -> result, with run lifecycle + hash-only ledger.
 *
 * This is the final assembly layer. Every dispatch runs the full preflight
 * BEFORE any spawn; a child is NEVER launched if any gate fails (I2/I10). The
 * six-part contract, path policy, write-scope, tool allowlist, output contract
 * and explicit-model gate are all enforced up front; failures yield a
 * `preflight_failed` run (failureKind `preflight` or `config`) and no child.
 *
 * runSingle / runParallel / runChain dispatch one or many runs through a
 * shared LanePool (hot sessions). runChain substitutes `{previous}` with the
 * prior step's output and reuses the SAME lane/sessionPath for continuity.
 *
 * Zero @earendil-works/* imports; the only child-process touch is the
 * injectable spawner supplied by src/lanes (never a hard-coded pi spawn here).
 */

import { statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentScope,
  ChildResult,
  DelegationDetails,
  DelegationFailureKind,
} from "../core/types.js";
import { join, relative, resolve } from "node:path";
import { sha256 } from "../core/hashing.js";
import { clampMaxSubagentDepth, loadConfig } from "../shared/config.js";
import {
  inferOutputContract,
  resolveChildCwd,
  validateAllowedPathPolicy,
  validateDelegationWriteScope,
  validateForbiddenPathPolicy,
  validateOutputContractId,
  validateSixPartContract,
  validateToolList,
  applyChildGates,
} from "../gates/index.js";
import { discoverAgents, type AgentCard, type ResolveAgentDirs } from "../registry/index.js";
import {
  resolveChildModel,
  validateExplicitModelOverride,
  checkModelScope,
  type EnabledModelsReader,
  type ModelByClassMap,
  type VerifiedModelCatalog,
} from "../models/index.js";
import {
  cleanupWorktree,
  createWorktree,
  validateWorktreeIsolation,
  type WorktreeChildResult,
  type WorktreeRunOutcome,
} from "../lanes/worktree.js";
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_STEER_DIR,
  LanePool,
  defaultSpawn,
  type LaneDispatchInput,
  type SpawnFn,
} from "../lanes/index.js";
import {
  classifyChildFailure,
  finishDelegationRun,
  isTerminalStatus,
  makeRunId,
  markRunRunning,
  outputHashOf,
  startDelegationRun,
  updateDelegationRun,
  type DelegationMonitorState,
  type DelegationRunMode,
  type DelegationRunSource,
  type DelegationRunStatus,
} from "./runs.js";
import { createDelegationMonitorState } from "./monitor.js";
import { appendLedgerFile, delegationLedgerMeta } from "./ledger.js";
import { buildAttestation, writeAttestationSidecar } from "./attestation.js";
import { steerRun, type SteerOutcome } from "./steer.js";
import { projectMainContext, wrapTaskWithContext, type ContextMode, type ContextProvider } from "./context.js";
import { buildMemoryBlock, ensureMemoryDir, resolveMemoryDir, type MemoryScope } from "./memory.js";
import type { BackgroundRunRegistry } from "./background.js";

/** Concurrency-limited async mapper (used by runParallel). */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(Math.max(1, concurrency), items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** Local `usageEmpty` mirror (telemetry.ts in the harness). */
export function usageEmpty(): ChildResult["usage"] {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

// ---- C1 nested subagents: per-dispatch child env positioning ----

/**
 * Env contract for nested subagents (MUST stay in sync with child/nested.ts —
 * the Pi-free core never imports the adapter module, so names are mirrored).
 */
const NESTED_ENV = "PI_SUBAGENTS_NESTED";
const NESTED_DEPTH_ENV = "PI_SUBAGENTS_DEPTH";
const NESTED_MAX_DEPTH_ENV = "PI_SUBAGENTS_MAX_DEPTH";
const NESTED_ALLOWED_ENV = "PI_SUBAGENTS_ALLOWED_SUBAGENTS";
const NESTED_AGENTS_DIR_ENV = "PI_SUBAGENTS_AGENTS_DIR";

interface NestedSpawnOverrides {
  env: NodeJS.ProcessEnv;
}

/** Per-dispatch nested env overrides, scoped around each pool.dispatch call. */
const nestedSpawnOverrides = new AsyncLocalStorage<NestedSpawnOverrides>();

/** Run `run()` with nested env overrides active for any spawn below it. */
function withNestedSpawnEnv<T>(env: NodeJS.ProcessEnv | undefined, run: () => T): T {
  return env ? nestedSpawnOverrides.run({ env }, run) : run();
}

/** Normalize a declarative allowlist (trim/drop empties; undefined = none). */
export function normalizeNestedAllowlist(values: readonly string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const trimmed = values.map((value) => value.trim()).filter(Boolean);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Byte size of a session file (0 when missing/unreadable). Used as the
 * continuation base offset so already-known session content is not re-fed.
 */
export function getSessionFileSize(sessionPath: string): number {
  try {
    return statSync(sessionPath).size;
  } catch {
    return 0;
  }
}

/** Classify preflight errors as `config` (unknown agent/contract) or `preflight`. */
function classifyConfigOrPreflight(errors: readonly string[]): DelegationFailureKind {
  return errors.some((error) => /unknown agent|unknown output contract|available:/i.test(error)) ? "config" : "preflight";
}

export interface DispatchEngineOptions {
  repoRoot: string;
  monitor?: DelegationMonitorState;
  spawn?: SpawnFn;
  piCommand?: string;
  sessionDir?: string;
  env?: NodeJS.ProcessEnv;
  maxParallel?: number;
  resolveAgentDirs?: ResolveAgentDirs;
  scope?: AgentScope;
  verifiedCatalog?: VerifiedModelCatalog;
  classModels?: ModelByClassMap;
  parentModel?: string;
  /**
   * C3 model scope: injectable source of the pi `enabledModels` allowlist.
   * Undefined (or an allowlist that reads back absent/empty) skips the scope
   * check entirely (no-op safety). The concrete reader (pi settings, project
   * over global) is supplied by src/extension; the engine stays fs-free.
   */
  enabledModelsReader?: EnabledModelsReader;
  ledgerDir?: string;
  /** When true, ledger entries are persisted to `<ledgerDir ?? .pi/logs/runs>`. */
  persistLedger?: boolean;
  /** Steer-file dir for mid-run steering (default `<repoRoot>/.pi/steer`). */
  steerDir?: string;
  /** Engine-level B3 default: max turns before the soft wrap-up steer (undefined = unlimited). */
  maxTurns?: number;
  /** Engine-level B3 default: grace turns before the hard abort (default 5, min 1). */
  graceTurns?: number;
  parentToolCallId?: string;
  source?: DelegationRunSource;
  onLedger?: (entry: Record<string, unknown>) => void;
  now?: () => number;
  backgroundRegistry?: BackgroundRunRegistry;
  /**
   * C2: injectable main-context source. Supplied by the extension (built from
   * the live pi session); the engine NEVER reads the session itself. Used only
   * when a dispatch sets `contextMode: "main"`.
   */
  contextProvider?: ContextProvider;
  /**
   * C5: root for `user`-scope agent memory (`<agentDir>/agent-memory/<name>/`).
   * Injectable so hosts and tests never touch the real home directory;
   * defaults to `<homedir>/.pi/agent` inside resolveMemoryDir.
   */
  memoryAgentDir?: string;
  /**
   * C1 nested subagents: explicit max-subagent-depth override (clamped 0..4).
   * Defaults to the shared config value (`maxSubagentDepth` from
   * `.subagents/config.json` or `SUBAGENTS_MAX_DEPTH`, default 2). 0/1 = off.
   */
  maxSubagentDepth?: number;
}

export interface SingleDispatchOptions {
  task?: string;
  cwd?: string;
  model?: string;
  modelClass?: string;
  thinking?: string;
  tools?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  outputContract?: string;
  index?: number;
  runId?: string;
  lane?: string;
  mode?: DelegationRunMode;
  parentToolCallId?: string;
  background?: boolean;
  source?: DelegationRunSource;
  scope?: AgentScope;
  /** Explicit session path override (continue reuses the original run's session file). */
  sessionPath?: string;
  /** Byte offset into the session file to resume from (continue). */
  sessionOffset?: number;
  /** B3 per-run override: max turns before the soft wrap-up steer (wins over engine default). */
  maxTurns?: number;
  /** B3 per-run override: grace turns before the hard abort (wins over engine default). */
  graceTurns?: number;
  /**
   * C2 context projection mode. `isolated` (default): the child gets the task
   * verbatim, no parent context. `main`: the task is wrapped with the condensed
   * main-context projection (compaction + last-20 + session-file pointer) in a
   * REQUEST/HISTORY authority hierarchy (anti-persona-bleed). Requires the
   * engine-level `contextProvider`; without one, `main` degrades gracefully to
   * an unwrapped (isolated-equivalent) dispatch.
   */
  contextMode?: ContextMode;
  /**
   * C6 worktree isolation: run the child inside a disposable DETACHED git
   * worktree of the repo (child cwd = worktree path, monorepo subfolders
   * mirrored). After the run the worktree is cleaned up: changes are
   * auto-committed onto a pi-agent-<runId> branch (timestamp suffix on
   * conflict); a clean run is just removed. The result carries the outcome on
   * `worktree` (see getWorktreeOutcome in lanes/worktree.ts). Requires a git
   * repository with at least one commit (enforced at preflight).
   */
  isolation?: "worktree";
  /**
   * C5 persistent memory scope override for this run. Wins over the agent
   * card frontmatter `memory` field; `false` explicitly disables memory even
   * when the card requests it. When memory is active, a memory block is
   * appended to the agent SYSTEM PROMPT (after the card prompt) — never into
   * the task. Read-only vs R/W is detected from the card tools (write/edit).
   */
  memory?: MemoryScope | false;
  /**
   * C1 nested subagents: enable the child's nested `subagent` tool by
   * positioning the nesting envs on the child spawn (PI_SUBAGENTS_NESTED=1,
   * PI_SUBAGENTS_ALLOWED_SUBAGENTS, PI_SUBAGENTS_DEPTH=1 and
   * PI_SUBAGENTS_MAX_DEPTH from the config maxSubagentDepth, clamped 0..4).
   * `true` uses the agent card's `allowed_subagents` frontmatter allowlist;
   * `{ allowedSubagents: [...] }` (names or `all`) overrides the card.
   * Nesting stays OFF without a non-empty allowlist or when maxSubagentDepth
   * < 2 (0/1 = off).
   */
  nested?: NestedDispatchOptions | true;
}

/** Options for `continueRun`: the run id to continue plus single-run options. */
export interface ContinueRunOptions extends SingleDispatchOptions {
  /** Optional id for the new (continued) run; defaults to makeRunId("delegate"). */
  runId?: string;
}

/** C1 nested-subagent dispatch option: the strict grandchild allowlist. */
export interface NestedDispatchOptions {
  /** Allowed grandchild agent names (or `all`); wins over the agent card. */
  allowedSubagents?: string[];
}

export interface ParallelTaskInput {
  agent: string;
  task: string;
  model?: string;
  modelClass?: string;
  cwd?: string;
  tools?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  outputContract?: string;
}

export interface ParallelDispatchOptions {
  concurrency?: number;
  parentToolCallId?: string;
  source?: DelegationRunSource;
}

export interface ChainStepInput {
  agent: string;
  task: string;
  model?: string;
  modelClass?: string;
  cwd?: string;
  tools?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  outputContract?: string;
}

export interface ChainDispatchOptions {
  parentToolCallId?: string;
  source?: DelegationRunSource;
  lane?: string;
}

/** Outcome of the preflight gate: either a launchable resolution or blocking errors. */
type PreflightOutcome =
  | {
      ok: true;
      agent: AgentCard;
      cwd: string;
      model?: string;
      modelFallback: boolean;
      outputContract: string;
      allowedPaths?: string[];
      forbiddenPaths?: string[];
      tools?: string[];
      /** C3 model-scope warnings (non-blocking; recorded on the run view). */
      warnings?: string[];
      /** C5 memory block appended to the agent system prompt (undefined = none). */
      memoryBlock?: string;
    }
  | { ok: false; failureKind: DelegationFailureKind; errors: readonly string[]; agentName: string; cwd: string };

/**
 * The final engine assembly. Owns a bounded monitor, a lazily-created LanePool
 * (hot sessions), model routing, preflight gates, and the hash-only ledger.
 */
export class DispatchEngine {
  readonly repoRoot: string;
  readonly monitor: DelegationMonitorState;
  private readonly options: DispatchEngineOptions;
  private pool?: LanePool;

  constructor(options: DispatchEngineOptions) {
    this.repoRoot = options.repoRoot;
    this.monitor = options.monitor ?? createDelegationMonitorState();
    this.options = options;
  }

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private get source(): DelegationRunSource {
    return this.options.source ?? "delegate_agent";
  }

  private get parentToolCallId(): string {
    return this.options.parentToolCallId ?? "parent";
  }

  /** Steer-file dir shared by manual steers and B3 wrap-up steers. */
  private get steerDir(): string {
    return this.options.steerDir ?? join(this.repoRoot, DEFAULT_STEER_DIR);
  }

  private getPool(): LanePool {
    if (!this.pool) {
      this.pool = new LanePool({
        cwd: this.repoRoot,
        piCommand: this.options.piCommand,
        spawn: this.wrappedSpawn(),
        env: this.options.env,
        sessionDir: this.options.sessionDir,
        maxParallel: this.options.maxParallel ?? DEFAULT_MAX_PARALLEL,
      });
    }
    return this.pool;
  }

  /**
   * C1: spawn wrapper merging per-dispatch nested env overrides. The pool's
   * env is shared across lanes, so the engine scopes the overrides with an
   * AsyncLocalStorage around each pool.dispatch call — concurrent dispatches
   * each get their own nested env (or none at all).
   */
  private wrappedSpawn(): SpawnFn {
    const base = this.options.spawn ?? defaultSpawn;
    return (input) => {
      const overrides = nestedSpawnOverrides.getStore();
      if (!overrides) return base(input);
      return base({ ...input, env: { ...(input.env ?? process.env), ...overrides.env } });
    };
  }

  private nestedConfig?: { maxDepth: number; agentsDir: string };

  /** C1 config: max depth (clamped 0..4) + absolute agents dir, memoized. */
  private loadNestedConfig(): { maxDepth: number; agentsDir: string } {
    if (!this.nestedConfig) {
      const cfg = loadConfig(this.repoRoot);
      this.nestedConfig = {
        maxDepth: clampMaxSubagentDepth(this.options.maxSubagentDepth ?? cfg.maxSubagentDepth),
        agentsDir: resolve(this.repoRoot, cfg.defaultAgentsDir),
      };
    }
    return this.nestedConfig;
  }

  /**
   * C1: resolve the nesting envs for a child spawn. Undefined = nesting OFF
   * (option absent, maxSubagentDepth < 2 (0/1 = off), or no allowlist — the
   * strict posture: no allowlist ever means no nested spawning).
   */
  private resolveNestedSpawnEnv(agent: AgentCard, opts: SingleDispatchOptions): NodeJS.ProcessEnv | undefined {
    if (!opts.nested) return undefined;
    const { maxDepth, agentsDir } = this.loadNestedConfig();
    if (maxDepth < 2) return undefined;
    const optionAllow = opts.nested !== true ? normalizeNestedAllowlist(opts.nested.allowedSubagents) : undefined;
    const allow = optionAllow ?? normalizeNestedAllowlist(agent.allowedSubagents);
    if (!allow) return undefined;
    const csv = allow.some((name) => name.toLowerCase() === "all") ? "all" : allow.join(",");
    return {
      [NESTED_ENV]: "1",
      [NESTED_ALLOWED_ENV]: csv,
      [NESTED_DEPTH_ENV]: "1",
      [NESTED_MAX_DEPTH_ENV]: String(maxDepth),
      [NESTED_AGENTS_DIR_ENV]: agentsDir,
    };
  }

  /** Close the owned lane pool (aborts in-flight tasks, no leaks). */
  close(): void {
    this.pool?.closeAll();
    this.pool = undefined;
  }

  /**
   * Steer a running run with a mid-run message (B2, parent side). Writes the
   * `<runId>.steer` file and marks the run view `steered`. Refuses unknown or
   * non-running runs. Returns a structured outcome (never throws).
   */
  steer(runId: string, message: string): SteerOutcome {
    return steerRun(this.monitor, runId, message, this.steerDir);
  }

  /**
   * Dispatch a single run. If `opts.background` is set and a background
   * registry is available, returns immediately with a running stub while the
   * child runs in the background; otherwise awaits the child result.
   */
  async single(agent: string, task: string, opts: SingleDispatchOptions = {}): Promise<ChildResult> {
    const mode = opts.mode ?? "single";
    if (opts.background && this.options.backgroundRegistry) {
      return this.singleBackground(agent, task, opts, mode);
    }
    return this.runOne(agent, task, { ...opts, mode });
  }

  private async singleBackground(agent: string, task: string, opts: SingleDispatchOptions, mode: DelegationRunMode): Promise<ChildResult> {
    const runId = opts.runId ?? makeRunId("delegate");
    const startedAtMs = this.now();
    const parentToolCallId = opts.parentToolCallId ?? this.parentToolCallId;
    const source = opts.source ?? this.source;
    startDelegationRun(this.monitor, {
      id: runId,
      parentToolCallId,
      source,
      mode,
      index: opts.index,
      agent,
      task,
      startedAtMs,
      cwd: opts.cwd,
      background: true,
    });

    const preflight = this.runPreflight(agent, task, opts);
    if (!preflight.ok) {
      this.failPreflight(runId, parentToolCallId, source, mode, agent, task, opts, preflight);
      const stub = this.preflightFailureResult(agent, task, preflight, runId);
      this.options.backgroundRegistry?.register({
        agent,
        mode,
        source,
        runId,
        taskHash: sha256(task),
        executor: Promise.resolve(stub),
      });
      return stub;
    }

    const executor = (async (): Promise<ChildResult> => {
      markRunRunning(this.monitor, runId);
      this.recordRunWarnings(runId, preflight.warnings);
      this.appendLedger({
        event: "start",
        ...delegationLedgerMeta(source, parentToolCallId, mode, opts.index),
        runId,
        agent,
        model: preflight.model,
        cwd: preflight.cwd,
        tools: preflight.tools ?? [],
        taskHash: sha256(task),
        outputContract: preflight.outputContract,
      });
      const result = await this.dispatchOnLane(agent, task, preflight, opts, runId);
      this.settleRun(runId, result);
      return result;
    })();
    this.options.backgroundRegistry?.register({
      agent,
      mode,
      source,
      runId,
      taskHash: sha256(task),
      executor,
    });
    return {
      agent,
      task,
      exitCode: 0,
      output: "",
      stderr: "",
      sessionPath: undefined,
      ledgerRunId: runId,
      model: preflight.model,
      gatePassed: true,
      usage: usageEmpty(),
    };
  }

  /** Core single-run path (foreground). Runs preflight then dispatches on a lane. */
  async runOne(agent: string, task: string, opts: SingleDispatchOptions): Promise<ChildResult> {
    const mode = opts.mode ?? "single";
    const runId = opts.runId ?? makeRunId("delegate");
    const startedAtMs = this.now();
    const parentToolCallId = opts.parentToolCallId ?? this.parentToolCallId;
    const source = opts.source ?? this.source;

    startDelegationRun(this.monitor, {
      id: runId,
      parentToolCallId,
      source,
      mode,
      index: opts.index,
      agent,
      task,
      startedAtMs,
      cwd: opts.cwd,
    });

    const preflight = this.runPreflight(agent, task, opts);
    if (!preflight.ok) {
      this.failPreflight(runId, parentToolCallId, source, mode, agent, task, opts, preflight);
      return this.preflightFailureResult(agent, task, preflight, runId);
    }

    markRunRunning(this.monitor, runId);
    this.recordRunWarnings(runId, preflight.warnings);
    this.appendLedger({
      event: "start",
      ...delegationLedgerMeta(source, parentToolCallId, mode, opts.index),
      runId,
      agent,
      model: preflight.model,
      cwd: preflight.cwd,
      tools: preflight.tools ?? [],
      taskHash: sha256(task),
      outputContract: preflight.outputContract,
    });

    const result = await this.dispatchOnLane(agent, task, preflight, opts, runId);
    this.settleRun(runId, result);
    return result;
  }

  /**
   * Continue a TERMINAL run with its original session file and byte-offset.
   *
   * Finds the run (monitor or background registry), verifies it is terminal
   * (complete/failed/aborted), reuses the SAME sessionPath, and resumes from
   * `persistedSessionBaseOffset = getSessionFileSize(sessionPath)` so already-
   * known session content is not re-fed. The new run links `continuedFromRunId`
   * and increments `turnCount`. Non-terminal runs are refused with a clear error.
   */
  async continueRun(runId: string, task: string, opts: ContinueRunOptions = {}): Promise<ChildResult> {
    const original = this.monitor.runs.find((candidate) => candidate.id === runId);
    if (!original) {
      const background = this.options.backgroundRegistry?.getDelegationRun(runId);
      if (!background) throw new Error(`Unknown run: ${runId}`);
      throw new Error(`Cannot continue run ${runId}: no sessionPath recorded for background run`);
    }
    if (!isTerminalStatus(original.status)) {
      throw new Error(`Cannot continue run ${runId}: status is ${original.status}, expected terminal (complete/failed/aborted)`);
    }
    if (!original.sessionPath) {
      throw new Error(`Cannot continue run ${runId}: no sessionPath recorded`);
    }

    const sessionPath = original.sessionPath;
    const persistedSessionBaseOffset = getSessionFileSize(sessionPath);
    const turnCount = (original.turnCount ?? 1) + 1;
    const newRunId = opts.runId ?? makeRunId("delegate");
    const startedAtMs = this.now();
    const parentToolCallId = opts.parentToolCallId ?? this.parentToolCallId;
    const source = opts.source ?? this.source;
    const mode = opts.mode ?? "single";

    startDelegationRun(this.monitor, {
      id: newRunId,
      parentToolCallId,
      source,
      mode,
      index: opts.index,
      agent: original.agent,
      task,
      startedAtMs,
      cwd: opts.cwd ?? original.cwd,
      sessionPath,
      continuedFromRunId: runId,
      turnCount,
    });

    const preflight = this.runPreflight(original.agent, task, opts);
    if (!preflight.ok) {
      this.failPreflight(newRunId, parentToolCallId, source, mode, original.agent, task, opts, preflight);
      return this.preflightFailureResult(original.agent, task, preflight, newRunId);
    }

    markRunRunning(this.monitor, newRunId);
    this.recordRunWarnings(newRunId, preflight.warnings);
    this.appendLedger({
      event: "continue_start",
      ...delegationLedgerMeta(source, parentToolCallId, mode, opts.index),
      runId: newRunId,
      continuedFromRunId: runId,
      agent: original.agent,
      model: preflight.model,
      cwd: preflight.cwd,
      tools: preflight.tools ?? [],
      taskHash: sha256(task),
      outputContract: preflight.outputContract,
      sessionPath,
      sessionOffset: persistedSessionBaseOffset,
    });

    const result = await this.dispatchOnLane(original.agent, task, preflight, { ...opts, sessionPath, sessionOffset: persistedSessionBaseOffset }, newRunId);
    this.settleRun(newRunId, result);
    return result;
  }

  /** Dispatch a batch of tasks concurrently with a configurable cap. */
  async parallel(tasks: readonly ParallelTaskInput[], opts: ParallelDispatchOptions = {}): Promise<DelegationDetails> {
    const concurrency = opts.concurrency ?? this.options.maxParallel ?? DEFAULT_MAX_PARALLEL;
    const agents = tasks.map((task) => task.agent);
    const results = await mapWithConcurrency(tasks, concurrency, (task, index) =>
      this.runOne(task.agent, task.task, {
        ...task,
        mode: "parallel",
        index,
        parentToolCallId: opts.parentToolCallId,
        source: opts.source,
      }),
    );
    return { mode: "parallel", results, agents };
  }

  /**
   * Dispatch a chain of steps. Each step's task may contain the `{previous}`
   * placeholder, which is substituted with the previous step's output. All
   * steps share the SAME lane (hence sessionPath) for context continuity.
   */
  async chain(steps: readonly ChainStepInput[], opts: ChainDispatchOptions = {}): Promise<DelegationDetails> {
    const lane = opts.lane ?? `chain_${opts.parentToolCallId ?? "run"}`;
    const results: ChildResult[] = [];
    const agents: string[] = [];
    let previousOutput: string | undefined;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const task = previousOutput !== undefined ? step.task.replace(/\{previous\}/g, previousOutput) : step.task;
      const result = await this.runOne(step.agent, task, {
        ...step,
        mode: "chain",
        index: i,
        lane,
        parentToolCallId: opts.parentToolCallId,
        source: opts.source,
      });
      results.push(result);
      agents.push(step.agent);
      previousOutput = result.output;
    }
    return { mode: "chain", results, agents };
  }

  // --- preflight ---

  private runPreflight(agentName: string, task: string, opts: SingleDispatchOptions): PreflightOutcome {
    const repoRoot = this.repoRoot;
    const errors: string[] = [];
    errors.push(...validateSixPartContract(task));
    const cwdRes = resolveChildCwd(repoRoot, opts.cwd);
    errors.push(...cwdRes.errors);
    errors.push(...validateAllowedPathPolicy(opts.allowedPaths, "allowed_paths", repoRoot));
    errors.push(...validateForbiddenPathPolicy(opts.forbiddenPaths, "forbidden_paths", repoRoot));
    // C6: worktree isolation needs a resolvable HEAD BEFORE any spawn.
    errors.push(...validateWorktreeIsolation(opts.isolation, repoRoot));
    const requiredTools = opts.tools ?? [];
    errors.push(...validateDelegationWriteScope("delegate_task", requiredTools, opts.allowedPaths));

    const scope = opts.scope ?? this.options.scope ?? "project";
    const agents = discoverAgents(repoRoot, scope, this.options.resolveAgentDirs);
    const agent = agents.find((candidate) => candidate.name.toLowerCase() === agentName.toLowerCase());
    if (!agent) {
      errors.push(`Unknown agent '${agentName}'. Available: ${agents.map((a) => a.name).join(", ") || "none"}`);
    } else {
      errors.push(...validateToolList(agent, opts.tools));
    }

    const outputContract = opts.outputContract ?? (agent ? inferOutputContract(agent.name) : undefined);
    if (outputContract) errors.push(...validateOutputContractId(outputContract));

    if (errors.length > 0) {
      return { ok: false, failureKind: classifyConfigOrPreflight(errors), errors, agentName, cwd: cwdRes.cwd };
    }

    // Explicit-model gate: never silently falls back. Blocks when not verified.
    const modelGate = validateExplicitModelOverride(opts.model, this.options.verifiedCatalog);
    if (!modelGate.ok) {
      return { ok: false, failureKind: "config", errors: modelGate.errors, agentName, cwd: cwdRes.cwd };
    }

    const modelRoute = resolveChildModel({
      explicitModel: opts.model,
      agentModel: agent!.model,
      modelClass: opts.modelClass,
      classModels: this.options.classModels,
      parentModel: this.options.parentModel,
    });

    // C3 model scope (after model resolution): an EXPLICIT out-of-scope model
    // blocks (preflight_failed); agent/class/inherited out-of-scope models only
    // warn (recorded on the run view, never blocking). A missing/empty
    // enabledModels allowlist skips the check entirely. A throwing reader is
    // treated as "not configured" (skip), never as a dispatch crash.
    let allowedModels: readonly string[] | undefined;
    try {
      allowedModels = this.options.enabledModelsReader?.readEnabledModels();
    } catch {
      allowedModels = undefined;
    }
    const scopeCheck = checkModelScope(modelRoute.model, allowedModels, modelRoute.source ?? "inherited");
    if (!scopeCheck.allowed) {
      return { ok: false, failureKind: "config", errors: [scopeCheck.reason], agentName, cwd: cwdRes.cwd };
    }
    const warnings: string[] = [];
    if (scopeCheck.severity === "warn") warnings.push(scopeCheck.reason);

    // C5 persistent memory: scope precedence = dispatch option > frontmatter.
    // The block is APPENDED to the agent system prompt (never the task); an
    // agent without write/edit tools gets the explicit READ-ONLY block. Any
    // resolution/safety failure (unsafe name, symlink) degrades to a warning
    // + memory disabled — never a crash, never a traversal.
    const memoryScope = opts.memory === false ? undefined : opts.memory ?? agent!.memory;
    let memoryBlock: string | undefined;
    if (memoryScope) {
      try {
        const memoryDir = resolveMemoryDir(memoryScope, agent!.name, cwdRes.cwd, this.options.memoryAgentDir);
        const hasWriteTool = (agent!.tools ?? []).some((tool) => tool === "write" || tool === "edit");
        if (hasWriteTool) ensureMemoryDir(memoryDir);
        memoryBlock = buildMemoryBlock(memoryDir, { readOnly: !hasWriteTool });
      } catch (error) {
        warnings.push(`memory disabled: ${(error as Error).message}`);
        memoryBlock = undefined;
      }
    }

    return {
      ok: true,
      agent: agent!,
      cwd: cwdRes.cwd,
      model: modelRoute.model,
      modelFallback: modelRoute.status === "fallback",
      outputContract: outputContract ?? "base.v1",
      allowedPaths: opts.allowedPaths,
      forbiddenPaths: opts.forbiddenPaths,
      tools: opts.tools,
      memoryBlock,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /** Record non-blocking preflight warnings (C3 model scope) on the run view. */
  private recordRunWarnings(runId: string, warnings: readonly string[] | undefined): void {
    if (warnings && warnings.length > 0) {
      updateDelegationRun(this.monitor, runId, { warnings: [...warnings] });
    }
  }

  private failPreflight(
    runId: string,
    parentToolCallId: string,
    source: DelegationRunSource,
    mode: DelegationRunMode,
    agent: string,
    task: string,
    opts: SingleDispatchOptions,
    preflight: Extract<PreflightOutcome, { ok: false }>,
  ): void {
    finishDelegationRun(this.monitor, runId, {
      status: "preflight_failed",
      endedAtMs: this.now(),
      gatePassed: false,
      gateErrors: [...preflight.errors],
      failureKind: preflight.failureKind,
      errorMessage: preflight.errors.join("; "),
      durationMs: Math.max(0, this.now() - this.monitor.runs.find((r) => r.id === runId)!.startedAtMs),
    });
    this.appendLedger({
      event: "preflight_failed",
      ...delegationLedgerMeta(source, parentToolCallId, mode, opts.index),
      runId,
      agent,
      failureKind: preflight.failureKind,
      gatePassed: false,
      gateErrors: [...preflight.errors],
    });
  }

  private preflightFailureResult(agent: string, task: string, preflight: Extract<PreflightOutcome, { ok: false }>, runId?: string): ChildResult {
    return {
      agent,
      task,
      exitCode: 0,
      output: "",
      stderr: "",
      ledgerRunId: runId,
      contractErrors: [...preflight.errors],
      gateErrors: [...preflight.errors],
      gatePassed: false,
      failureKind: preflight.failureKind,
      usage: usageEmpty(),
    };
  }

  // --- dispatch + settle ---

  private async dispatchOnLane(agent: string, task: string, preflight: Extract<PreflightOutcome, { ok: true }>, opts: SingleDispatchOptions, runId: string): Promise<ChildResult> {
    const lane = opts.lane ?? preflight.agent.name;
    // C2: wrap ONLY at the child boundary. Monitor views, ledger task hashes
    // and preflight validation all keep the ORIGINAL task; the projection is
    // injected into the child's stdin task and stripped back off the result.
    let effectiveTask = task;
    if ((opts.contextMode ?? "isolated") === "main" && this.options.contextProvider) {
      const data = this.options.contextProvider.getMainContext();
      effectiveTask = wrapTaskWithContext(task, projectMainContext(data, task), data.sessionFilePath);
    }
    const input: LaneDispatchInput = {
      task: effectiveTask,
      model: preflight.model,
      thinking: opts.thinking,
      tools: preflight.tools?.join(","),
      agentPrompt: preflight.memoryBlock
        // C5: memory block APPENDED to the agent system prompt (after the card
        // prompt). The task (stdin) is never touched by memory.
        ? `${preflight.agent.prompt}\n\n${preflight.memoryBlock}`
        : preflight.agent.prompt,
      sessionPath: opts.sessionPath,
      sessionOffset: opts.sessionOffset,
      // B3 graceful turn limits: per-run override wins over engine default.
      maxTurns: opts.maxTurns ?? this.options.maxTurns,
      graceTurns: opts.graceTurns ?? this.options.graceTurns,
      runId,
      steerDir: this.steerDir,
    };
    let result: ChildResult;
    let childCwd = preflight.cwd;
    // C1: position the nested-subagent envs on THIS child's spawn (scoped per
    // dispatch via AsyncLocalStorage so concurrent lanes stay independent).
    const nestedEnv = this.resolveNestedSpawnEnv(preflight.agent, opts);
    const pool = this.getPool();
    const dispatchOnPool = (): Promise<ChildResult> => pool.dispatch(lane, input);
    if (opts.isolation === "worktree") {
      // C6: run the child inside a disposable DETACHED git worktree at HEAD.
      // Monorepo subfolders are mirrored (child cwd = worktree + repo-relative
      // subpath); post-run cleanup ALWAYS runs (finally), even on crash/abort.
      const creation = createWorktree(this.repoRoot, runId, { description: task });
      const subPath = relative(this.repoRoot, preflight.cwd);
      childCwd = subPath ? join(creation.worktreePath, subPath) : creation.worktreePath;
      input.cwd = childCwd;
      let outcome: WorktreeRunOutcome | undefined;
      try {
        result = await withNestedSpawnEnv(nestedEnv, dispatchOnPool);
      } finally {
        try {
          outcome = cleanupWorktree(creation);
        } catch (error) {
          // Cleanup must never mask the run result: best-effort, error recorded.
          outcome = {
            worktreePath: creation.worktreePath,
            baseSha: creation.baseSha,
            hasChanges: false,
            committed: false,
            removed: false,
            cleanupError: (error as Error).message,
          };
        }
      }
      (result as WorktreeChildResult).worktree = outcome;
    } else {
      result = await withNestedSpawnEnv(nestedEnv, dispatchOnPool);
    }
    result.task = task; // result view keeps the original task, not the wrap
    result.agent = preflight.agent.name;
    result.model = preflight.model ?? result.model;
    result.cwd = childCwd;
    result.ledgerRunId = runId;
    result.outputContract = preflight.outputContract;
    applyChildGates(result);
    return result;
  }

  private settleRun(runId: string, result: ChildResult): void {
    const failureKind = classifyChildFailure(result);
    const escalationHash = result.stopReason === "escalated" && result.escalationMessage
      ? sha256(result.escalationMessage)
      : undefined;
    const status: DelegationRunStatus = result.stopReason === "escalated"
      ? "escalated"
      : result.stopReason === "aborted"
        ? "aborted"
        : result.stopReason === "steered" && result.exitCode === 0 && result.gatePassed !== false && failureKind === undefined
          ? "steered"
          : result.exitCode !== 0 || result.gatePassed === false || failureKind !== undefined
            ? "failed"
            : "complete";
    const outputHash = outputHashOf(result.output);
    finishDelegationRun(this.monitor, runId, {
      status,
      endedAtMs: this.now(),
      outputPreview: result.output,
      stderrPreview: result.stderr,
      exitCode: result.exitCode,
      model: result.model,
      outputHash,
      // B5: hash-only — the escalation body NEVER reaches the run view.
      escalationHash,
      gatePassed: result.gatePassed,
      gateErrors: result.gateErrors,
      failureKind,
      stopReason: result.stopReason,
      stopCondition: result.stopCondition,
      errorMessage: result.errorMessage,
      sessionPath: result.sessionPath,
      childChangedPaths: result.childChangedPaths,
      usage: result.usage,
    });
    // C4: hash-only attestation sidecar on EVERY terminal settle
    // (complete/failed/aborted/steered/escalated), best-effort — a failure
    // NEVER blocks or fails the settle.
    const attestationRef = this.writeAttestationForRun(runId, result);
    if (attestationRef) updateDelegationRun(this.monitor, runId, { attestationRef });
    const run = this.monitor.runs.find((candidate) => candidate.id === runId);
    this.appendLedger({
      event: "end",
      runId,
      agent: result.agent,
      mode: run?.mode,
      status,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      stopCondition: result.stopCondition,
      gatePassed: result.gatePassed,
      gateErrors: result.gateErrors,
      failureKind,
      outputHash,
      // B5: hash-only — the escalation body NEVER reaches the ledger.
      escalationHash,
      sessionPath: result.sessionPath,
      usage: result.usage,
      latencyMs: run ? Math.max(0, this.now() - run.startedAtMs) : undefined,
    });
  }

  /**
   * C4: write the hash-only attestation sidecar for a settled run to
   * `<ledgerDir ?? .pi/logs/runs>/attestations/<runId>.json`. Only when
   * ledger persistence is enabled (same posture as the ledger itself);
   * best-effort — returns undefined on ANY error, never throws, never
   * blocks settlement.
   */
  private writeAttestationForRun(runId: string, result: ChildResult): string | undefined {
    if (!this.options.persistLedger) return undefined;
    try {
      const run = this.monitor.runs.find((candidate) => candidate.id === runId);
      if (!run) return undefined;
      const dir = join(this.options.ledgerDir ?? join(this.repoRoot, ".pi", "logs", "runs"), "attestations");
      return writeAttestationSidecar(dir, buildAttestation(run, result));
    } catch {
      return undefined; // best-effort: attestation must never break settlement
    }
  }

  private appendLedger(entry: Record<string, unknown>): void {
    this.options.onLedger?.(entry);
    if (this.options.persistLedger) {
      appendLedgerFile(this.repoRoot, entry, { dir: this.options.ledgerDir });
    }
  }
}

/**
 * Standalone single-run dispatch. Builds a throwaway engine over `ctx`,
 * dispatches one run, and closes the pool.
 */
export async function runSingle(
  ctx: Omit<DispatchEngineOptions, "repoRoot"> & { repoRoot: string },
  agent: string,
  task: string,
  opts: SingleDispatchOptions = {},
): Promise<ChildResult> {
  const engine = new DispatchEngine(ctx);
  try {
    return await engine.single(agent, task, opts);
  } finally {
    engine.close();
  }
}

/** Standalone parallel dispatch (shared pool, configurable cap). */
export async function runParallel(
  ctx: Omit<DispatchEngineOptions, "repoRoot"> & { repoRoot: string },
  tasks: readonly ParallelTaskInput[],
  opts: ParallelDispatchOptions = {},
): Promise<DelegationDetails> {
  const engine = new DispatchEngine(ctx);
  try {
    return await engine.parallel(tasks, opts);
  } finally {
    engine.close();
  }
}

/** Standalone chain dispatch (same lane/sessionPath for continuity). */
export async function runChain(
  ctx: Omit<DispatchEngineOptions, "repoRoot"> & { repoRoot: string },
  steps: readonly ChainStepInput[],
  opts: ChainDispatchOptions = {},
): Promise<DelegationDetails> {
  const engine = new DispatchEngine(ctx);
  try {
    return await engine.chain(steps, opts);
  } finally {
    engine.close();
  }
}
