/**
 * src/rpc/registry.ts — the session's controller-owned workers.
 *
 * Why a registry instead of a single worker (the #12 shape): one worker per
 * session cannot run two independent long tasks, and a crashed worker would
 * block the next start forever. Every worker is keyed by a runId, bounded in
 * number, and kept as a bounded tombstone after exit so `rpc_state` can
 * report the honest terminal status.
 */
import { randomBytes } from "node:crypto";
import { RPC_MAX_WORKERS, RPC_RUN_ID_RAND_CHARS, RPC_START_TIMEOUT_MS, RPC_TOMBSTONE_LIMIT } from "./limits.js";
import { RpcWorker, buildRpcEnv } from "./worker.js";

export type RpcRunStatus = "starting" | "running" | "exited" | "stopped" | "failed";

export interface RpcRunInfo {
  runId: string;
  pid: number | undefined;
  cwd: string;
  model?: string;
  name?: string;
  guard: boolean;
  status: RpcRunStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  stderrTail: string;
}

interface RpcRun extends RpcRunInfo {
  worker: RpcWorker;
}

export interface StartRpcOptions {
  cwd: string;
  model?: string;
  name?: string;
  /** Specialist agent card prompt + tool allowlist. */
  agentPrompt?: string;
  tools?: string;
  guard?: boolean;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  timeoutMs?: number;
  /** Extra env (tests); merged under the run id / guard paths. */
  env?: NodeJS.ProcessEnv;
}

export type RpcWorkerFactory = (opts: ConstructorParameters<typeof RpcWorker>[0]) => RpcWorker;

function makeRunId(): string {
  return `rpc_${Date.now().toString(36)}_${randomBytes(Math.ceil(RPC_RUN_ID_RAND_CHARS / 2)).toString("hex").slice(0, RPC_RUN_ID_RAND_CHARS)}`;
}

export class RpcWorkerRegistry {
  private readonly runs = new Map<string, RpcRun>();
  private readonly factory: RpcWorkerFactory;
  private readonly maxWorkers: number;
  private readonly now: () => number;

  constructor(
    factory: RpcWorkerFactory = (opts) => new RpcWorker(opts),
    maxWorkers: number = RPC_MAX_WORKERS,
    now: () => number = Date.now,
  ) {
    this.factory = factory;
    this.maxWorkers = maxWorkers;
    this.now = now;
  }

  private activeCount(): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.status === "starting" || run.status === "running") n += 1;
    }
    return n;
  }

  /** Drop the oldest terminal tombstones beyond the bound. */
  private pruneTombstones(): void {
    const terminal = [...this.runs.values()]
      .filter((run) => run.status !== "starting" && run.status !== "running")
      .sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt));
    for (const run of terminal.slice(0, Math.max(0, terminal.length - RPC_TOMBSTONE_LIMIT))) {
      this.runs.delete(run.runId);
    }
  }

  info(run: RpcRun): RpcRunInfo {
    return {
      runId: run.runId,
      pid: run.pid,
      cwd: run.cwd,
      model: run.model,
      name: run.name,
      guard: run.guard,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      error: run.error,
      stderrTail: run.worker.stderrTail,
    };
  }

  get(runId: string): RpcRunInfo | undefined {
    const run = this.runs.get(runId);
    return run === undefined ? undefined : this.info(run);
  }

  worker(runId: string): RpcWorker | undefined {
    return this.runs.get(runId)?.worker;
  }

  list(): RpcRunInfo[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => this.info(run));
  }

  /**
   * Spawn + readiness probe. A worker that cannot answer `get_state` is
   * stopped and never registered: "started" must mean "usable".
   */
  async start(opts: StartRpcOptions): Promise<RpcRunInfo> {
    if (this.activeCount() >= this.maxWorkers) {
      throw new Error(`rpc_max_workers (${this.maxWorkers} active)`);
    }
    const runId = makeRunId();
    const guard = opts.guard === true;
    const worker = this.factory({
      cwd: opts.cwd,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.agentPrompt !== undefined ? { agentPrompt: opts.agentPrompt } : {}),
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      guard,
      ...(opts.allowedPaths !== undefined ? { allowedPaths: opts.allowedPaths } : {}),
      ...(opts.forbiddenPaths !== undefined ? { forbiddenPaths: opts.forbiddenPaths } : {}),
      env: buildRpcEnv(
        {
          cwd: opts.cwd,
          guard,
          ...(opts.allowedPaths !== undefined ? { allowedPaths: opts.allowedPaths } : {}),
          ...(opts.forbiddenPaths !== undefined ? { forbiddenPaths: opts.forbiddenPaths } : {}),
        },
        runId,
      ),
      ...(opts.timeoutMs !== undefined ? { defaultTimeoutMs: opts.timeoutMs } : {}),
    });
    const run: RpcRun = {
      runId,
      pid: worker.pid,
      cwd: opts.cwd,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      guard,
      status: "starting",
      startedAt: new Date(this.now()).toISOString(),
      stderrTail: "",
      worker,
    };
    this.runs.set(runId, run);

    worker.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      run.status = run.status === "stopped" ? "stopped" : code === 0 ? "exited" : "failed";
      run.exitCode = code;
      run.signal = signal;
      run.endedAt = new Date(this.now()).toISOString();
      this.pruneTombstones();
    });

    try {
      await worker.getState(Math.min(opts.timeoutMs ?? RPC_START_TIMEOUT_MS, RPC_START_TIMEOUT_MS));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      run.status = "failed";
      run.error = reason;
      run.endedAt = new Date(this.now()).toISOString();
      await worker.stop().catch(() => {});
      throw new Error(`rpc_start_failed: ${reason} (stderr=${JSON.stringify(worker.stderrTail.slice(-500))})`);
    }
    run.status = "running";
    return this.info(run);
  }

  /** Stop a worker (idempotent). Returns undefined when the id is unknown. */
  async stop(runId: string): Promise<RpcRunInfo | undefined> {
    const run = this.runs.get(runId);
    if (run === undefined) return undefined;
    run.status = "stopped";
    run.endedAt = new Date(this.now()).toISOString();
    await run.worker.stop().catch(() => {});
    return this.info(run);
  }

  /** Stop every worker (session shutdown, test cleanup). Never throws. */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.worker.stop().catch(() => {})));
    for (const run of this.runs.values()) {
      if (run.status === "starting" || run.status === "running") {
        run.status = "stopped";
        run.endedAt = new Date(this.now()).toISOString();
      }
    }
  }
}
