/**
 * src/rpc/worker.ts — a controller-owned headless `pi --mode rpc` child.
 *
 * Why this exists (the problem it solves): a normal delegated child is a
 * one-shot process. To change its plan you must kill it (history lost) or
 * wait for its current turn. A worker keeps the SAME session alive and speaks
 * pi's RPC protocol, so the controller can abort the current TURN, wait for
 * `agent_settled`, and prompt the new instruction with history intact.
 *
 * Honest limits (verified against real pi):
 *   - `abort_bash` only aborts a DIRECT RPC bash command, NOT the agent's
 *     `bash` tool. It is therefore not exposed by the tools: `abort` (whole
 *     turn) is the honest lever.
 *   - On Windows there is no SIGSTOP/SIGTERM: stop() is `taskkill /T`, then
 *     `/F` after the grace. Never reported as a graceful signal.
 *
 * Zero @earendil-works/* imports (I9).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RPC_DEFAULT_TIMEOUT_MS,
  RPC_EVENT_RING,
  RPC_MAX_LINE_BYTES,
  RPC_STDERR_RING_BYTES,
  RPC_STOP_GRACE_MS,
} from "./limits.js";
import { isEvent, isResponse, type RpcEventRecord, type RpcResponse, type RpcState, type RpcWorkerOptions, type SteeringMode } from "./protocol.js";

interface Pending {
  resolve: (response: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcWorker extends EventEmitter {
  readonly cwd: string;
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly events: RpcEventRecord[] = [];
  private stdoutBuf = "";
  private stderrBuf = "";
  private seq = 0;
  private stopped = false;

  constructor(opts: RpcWorkerOptions) {
    super();
    this.cwd = opts.cwd;
    this.timeoutMs = opts.defaultTimeoutMs ?? RPC_DEFAULT_TIMEOUT_MS;
    const cmd = opts.command ?? defaultPiCommand(opts);
    this.child = spawn(cmd.bin, cmd.args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // The child is a controller-owned worker, not a one-shot delegation:
        // extensions are disabled, so this marker only helps diagnostics.
        PI_SUBAGENTS_RPC: "1",
        ...(opts.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: own process group so stop() can kill the whole tree (the
      // worker's bash children included), not just the pi process.
      // Windows: detached is harmless; taskkill /T walks the tree instead.
      detached: process.platform !== "win32",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.pid = this.child.pid;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    // A failed spawn can surface on any stdio stream; never let an
    // unhandled 'error' become an uncaughtException.
    this.child.stdout.on("error", () => {});
    this.child.stderr.on("error", () => {});
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-RPC_STDERR_RING_BYTES);
    });
    this.child.on("error", (err) => {
      this.stopped = true;
      this.failPending(err);
      // EventEmitter throws on an unhandled "error" event.
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
    this.child.on("exit", (code, signal) => {
      this.stopped = true;
      this.failPending(new Error(`rpc_worker_exited (code=${code ?? "null"} signal=${signal ?? "null"})`));
      this.emit("exit", { code, signal });
    });
  }

  get alive(): boolean {
    return !this.stopped && this.child.exitCode === null;
  }

  get stderrTail(): string {
    return this.stderrBuf;
  }

  /** Recent events (memory only, bounded) — diagnostics, never persisted. */
  get recentEvents(): readonly RpcEventRecord[] {
    return this.events;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    if (this.stdoutBuf.length > RPC_MAX_LINE_BYTES) {
      this.emit("protocol_error", { line: this.stdoutBuf.slice(0, 200), reason: "line_too_long" });
      this.stdoutBuf = "";
      return;
    }
    for (;;) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      let line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        this.emit("protocol_error", { line: line.slice(0, 200) });
        continue;
      }
      if (isResponse(record)) {
        const id = record.id;
        if (id !== undefined) {
          const waiter = this.pending.get(id);
          if (waiter !== undefined) {
            this.pending.delete(id);
            clearTimeout(waiter.timer);
            waiter.resolve(record);
            continue;
          }
        }
        // A response without a live waiter (late/duplicate) is still an
        // event for diagnostics.
        this.recordEvent(record as unknown as RpcEventRecord);
        continue;
      }
      if (isEvent(record)) {
        this.recordEvent(record as unknown as RpcEventRecord);
        this.emit("event", record);
        this.emit(record.type, record);
      }
    }
  }

  private recordEvent(record: RpcEventRecord): void {
    this.events.push(record);
    if (this.events.length > RPC_EVENT_RING) this.events.shift();
  }

  /** Send one command and resolve with its response (rejects on timeout/exit). */
  request(command: Record<string, unknown> & { type: string }, timeoutMs = this.timeoutMs): Promise<RpcResponse> {
    if (!this.alive) return Promise.reject(new Error("rpc_worker_not_running"));
    const id = `rpc_${++this.seq}`;
    const payload = { id, ...command };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc_timeout: ${command.type}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err === null || err === undefined) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async ok(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<unknown> {
    const res = await this.request(command, timeoutMs);
    if (!res.success) throw new Error(res.error ?? `${command.type} failed`);
    return res.data;
  }

  async prompt(
    message: string,
    opts: { streamingBehavior?: "steer" | "followUp"; timeoutMs?: number } = {},
  ): Promise<unknown> {
    return this.ok(
      {
        type: "prompt",
        message,
        ...(opts.streamingBehavior !== undefined ? { streamingBehavior: opts.streamingBehavior } : {}),
      },
      opts.timeoutMs,
    );
  }

  async steer(message: string, timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "steer", message }, timeoutMs);
  }

  async followUp(message: string, timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "follow_up", message }, timeoutMs);
  }

  /** Abort the whole current turn (the honest lever; not abort_bash). */
  async abort(timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "abort" }, timeoutMs);
  }

  /** Primitive kept for completeness; NOT exposed by the tools (no-op for
   *  the agent's own bash tool on real pi). */
  async abortBash(timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "abort_bash" }, timeoutMs);
  }

  async getState(timeoutMs?: number): Promise<RpcState> {
    return (await this.ok({ type: "get_state" }, timeoutMs)) as RpcState;
  }

  async setSteeringMode(mode: SteeringMode, timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "set_steering_mode", mode }, timeoutMs);
  }

  /** Wait for one event type (optionally filtered). The listener is always
   *  removed on timeout, so a settled worker never leaks callbacks. */
  waitForEvent(
    type: string,
    predicate: (event: RpcEventRecord) => boolean = () => true,
    timeoutMs = this.timeoutMs,
  ): Promise<RpcEventRecord> {
    return new Promise((resolvePromise, reject) => {
      const handler = (event: RpcEventRecord): void => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.removeListener(type, handler);
        resolvePromise(event);
      };
      const timer = setTimeout(() => {
        this.removeListener(type, handler);
        reject(new Error(`rpc_event_timeout: ${type}`));
      }, timeoutMs);
      timer.unref();
      this.on(type, handler);
    });
  }

  /** Convenience: `agent_settled` (the turn is over; `aborted` is honest). */
  waitForSettled(timeoutMs = this.timeoutMs): Promise<RpcEventRecord> {
    return this.waitForEvent("agent_settled", () => true, timeoutMs);
  }

  /**
   * Stop the worker and its process tree. POSIX: stdin close, SIGTERM to the
   * group, SIGKILL after the grace. Windows: taskkill /T, then /F.
   */
  async stop(graceMs = RPC_STOP_GRACE_MS): Promise<void> {
    if (this.stopped && this.child.exitCode !== null) return;
    this.stopped = true;
    this.failPending(new Error("rpc_worker_stopped"));
    // Orderly shutdown first: closing stdin lets pi flush its state.
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolvePromise) => {
      // Attach the exit listener BEFORE signalling: a fast SIGTERM exit can
      // otherwise land between killTree() and once("exit"), and an unref'd
      // grace timer would let the event loop drain with the wait pending.
      const onExit = (): void => {
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        this.child.removeListener("exit", onExit);
        this.killTree("SIGKILL");
        resolvePromise();
      }, Math.max(100, graceMs));
      this.child.once("exit", onExit);
      if (this.child.exitCode !== null) {
        onExit();
        return;
      }
      this.killTree("SIGTERM");
    });
  }

  private killTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T"];
      if (signal === "SIGKILL") args.push("/F");
      try {
        spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
      } catch {
        // taskkill unavailable: best effort
      }
      return;
    }
    try {
      // Negative pid = the worker's process group (detached: true).
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  private failPending(err: Error): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}

/** Resolve the compiled child adapter (`dist/child/index.js`), falling back
 *  to the TypeScript source for dev runs. */
function childAdapterEntry(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "../../child/index.js");
  if (existsSync(compiled)) return compiled;
  const source = resolve(here, "../../child/index.ts");
  return existsSync(source) ? source : undefined;
}

/** Build the child argv. `--no-extensions` is the critical one: without it
 *  the worker loads pi-mesh (and every other package) and becomes a phantom
 *  mesh peer. `-e` still loads the explicit child adapter when guard=true. */
export function buildRpcArgs(opts: RpcWorkerOptions): string[] {
  const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp"];
  if (opts.model !== undefined && opts.model !== "") args.push("--model", opts.model);
  if (opts.name !== undefined && opts.name !== "") args.push("--name", opts.name);
  if (opts.tools !== undefined && opts.tools !== "") args.push("--tools", opts.tools);
  if (opts.agentPrompt !== undefined && opts.agentPrompt !== "") {
    args.push("--append-system-prompt", opts.agentPrompt);
  }
  if (opts.guard === true) {
    const entry = childAdapterEntry();
    if (entry !== undefined) args.push("-e", entry);
  }
  return args;
}

function defaultPiCommand(opts: RpcWorkerOptions): { bin: string; args: string[] } {
  const args = buildRpcArgs(opts);
  const override = process.env.PI_RPC_BIN;
  if (override !== undefined && override !== "") return { bin: override, args };
  // Running inside pi: argv[1] is the pi CLI entry — reuse the SAME runtime.
  const entry = process.argv[1];
  if (entry !== undefined) return { bin: process.execPath, args: [entry, ...args] };
  return { bin: "pi", args };
}

/** Env additions for the child (guard paths + run id). Exported for tests. */
export function buildRpcEnv(opts: RpcWorkerOptions, runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? {}),
    PI_SUBAGENTS_RPC: "1",
    PI_SUBAGENTS_RUN_ID: runId,
  };
  if (opts.allowedPaths !== undefined && opts.allowedPaths.length > 0) {
    env.ZOB_ALLOWED_PATHS = opts.allowedPaths.join(",");
  }
  if (opts.forbiddenPaths !== undefined && opts.forbiddenPaths.length > 0) {
    env.ZOB_FORBIDDEN_PATHS = opts.forbiddenPaths.join(",");
  }
  return env;
}
