/**
 * src/lanes/pool.ts — LanePool v1: spawn-per-task with a stable session.
 *
 * Per the stdin-spike verdict, `pi` EXITS after a task (stdin is one-shot, no
 * multi-task loop). Therefore v1 (delivered) dispatches each task as a fresh
 * one-shot spawn, but reuses a STABLE `--session` path per lane so that a chain
 * of tasks on the same lane keeps context continuity (same session file).
 *
 * Explicitly OUT OF SCOPE: the v2 warm-loop (one long-lived `pi` serving N
 * tasks via a child extension) is a separate spike.
 *
 * Design guarantees:
 *   - spawner is 100% injectable (I11) — never launches a real pi here;
 *   - model probe is an OPTIONAL injected hook fired off the critical path
 *     (fire-and-forget, never awaited before spawn);
 *   - bounded abort (SIGTERM -> 5s -> SIGKILL) via attachBoundedAbort;
 *   - maxParallel backpressure, idle tracking, closeAll() (I15: no leaks).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildResult } from "../core/types.js";
import { safeFileStem } from "../core/paths.js";
import {
  DEFAULT_GRACE_TURNS,
  HARD_MAX_GRACE_TURNS,
  HARD_MAX_MAX_TURNS,
  HARD_MIN_GRACE_TURNS,
  HARD_MIN_MAX_TURNS,
} from "../shared/config.js";
import { buildChildFlags, buildIsolatedChildArgs, type IsolatedChildArgsInput } from "./args.js";
import { NdjsonStreamParser } from "./ndjson.js";
import { attachBoundedAbort } from "./abort.js";
import { steer as writeSteerFile } from "./steer.js";
import { ESCALATION_DIR_ENV, ESCALATION_EXIT_CODE, ESCALATION_RUN_ID_ENV, consumeEscalation } from "./escalation.js";
import { defaultSpawn, type SpawnFn, type SpawnInput } from "./spawn.js";

/**
 * B3 soft-limit wrap-up message, written to the steer file when the assistant
 * turn count reaches `maxTurns` (benchmark tintinweb agent-runner.ts:903-920:
 * "Wrap up immediately" — a steer, never a kill).
 */
export const WRAP_UP_STEER_MESSAGE =
  "You have reached your turn limit. Wrap up immediately — provide your final answer now.";

/** Input to `resolveTurnLimits` (raw per-dispatch options). */
export interface TurnLimitsInput {
  maxTurns?: number;
  graceTurns?: number;
}

/** Resolved B3 turn limits: `maxTurns` undefined = unlimited. */
export interface TurnLimits {
  maxTurns?: number;
  graceTurns: number;
}

/**
 * Resolve per-dispatch B3 turn limits against the shared bounds:
 *   - maxTurns: non-positive/invalid = UNLIMITED (undefined); else clamped to
 *     [HARD_MIN_MAX_TURNS, HARD_MAX_MAX_TURNS] (1..200);
 *   - graceTurns: default 5, floored at 1, capped at 20 (grace is never 0 —
 *     the child always gets at least one turn to wrap up after the steer).
 */
export function resolveTurnLimits(input: TurnLimitsInput): TurnLimits {
  const maxTurns =
    typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns) && Math.floor(input.maxTurns) >= HARD_MIN_MAX_TURNS
      ? Math.min(HARD_MAX_MAX_TURNS, Math.floor(input.maxTurns))
      : undefined;
  const rawGrace = typeof input.graceTurns === "number" && Number.isFinite(input.graceTurns) ? Math.floor(input.graceTurns) : DEFAULT_GRACE_TURNS;
  const graceTurns = Math.min(HARD_MAX_GRACE_TURNS, Math.max(HARD_MIN_GRACE_TURNS, rawGrace));
  return { maxTurns, graceTurns };
}

export interface LaneDispatchInput {
  task: string;
  model?: string;
  thinking?: string;
  tools?: string;
  agentPrompt?: string;
  extensions?: IsolatedChildArgsInput;
  /**
   * Explicit session path override. When set, dispatch uses this exact path
   * instead of the lane's stable session path (continue reuses the original
   * run's session file).
   */
  sessionPath?: string;
  /**
   * Byte offset into the session file to resume from (continue). Passed to the
   * child args so already-known content is not re-fed.
   */
  sessionOffset?: number;
  /**
   * B3 graceful turn limit: max assistant turns (ndjson message_end count)
   * before the soft wrap-up steer. Undefined/non-positive = unlimited.
   * Bounded to 1..200 by `resolveTurnLimits`.
   */
  maxTurns?: number;
  /**
   * B3 grace turns after `maxTurns` before the hard abort. Default 5, min 1,
   * max 20 (the child always gets at least one turn to wrap up).
   */
  graceTurns?: number;
  /** Run id naming the `<runId>.steer` file written at the soft limit. */
  runId?: string;
  /** Directory receiving the steer file (both runId + steerDir required). */
  steerDir?: string;
  /** Custom wrap-up message (default WRAP_UP_STEER_MESSAGE). */
  wrapUpMessage?: string;
  /**
   * C6 worktree isolation: cwd override for the child process (the disposable
   * git worktree). Defaults to the pool cwd. The session file stays in the
   * pool's sessionDir (parent side).
   */
  cwd?: string;
}

export interface LanePoolOptions {
  cwd?: string;
  /** Command resolved for the child (default "pi"). */
  piCommand?: string;
  /** Injectable spawner (I11). */
  spawn?: SpawnFn;
  /** Child env (e.g. buildChildEnv output). Optional. */
  env?: NodeJS.ProcessEnv;
  /** Max concurrent one-shot tasks (backpressure). Default 4. */
  maxParallel?: number;
  /** Session dir for stable per-lane session files. Default <cwd>/.pi/agent-sessions. */
  sessionDir?: string;
  /** Fallback file stem when a lane id sanitizes empty. Default "subagent". */
  agentName?: string;
  /** Abort grace between SIGTERM and SIGKILL in ms. Default 5000. */
  killGraceMs?: number;
  /**
   * Optional model probe hook. NEVER awaited on the critical path: it is fired
   * fire-and-forget per dispatch (off the critical path), as the spike requires.
   */
  probe?: (model: string, lane: string) => Promise<void> | void;
  /** Injectable clock for deterministic idle tracking. */
  now?: () => number;
}

export interface LaneInfo {
  id: string;
  sessionPath: string;
  createdAt: number;
  lastUsedAt: number;
  active: boolean;
}

export const DEFAULT_MAX_PARALLEL = 4;
export const DEFAULT_AGENT_NAME = "subagent";

interface LaneState {
  id: string;
  sessionPath: string;
  createdAt: number;
  lastUsedAt: number;
}

export class LanePool {
  private readonly cwd: string;
  private readonly piCommand: string;
  private readonly spawn: SpawnFn;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly maxParallel: number;
  private readonly sessionDir: string;
  private readonly agentName: string;
  private readonly killGraceMs?: number;
  private readonly probe?: LanePoolOptions["probe"];
  private readonly now: () => number;

  private readonly lanes = new Map<string, LaneState>();
  private readonly activeLanes = new Set<string>();
  private readonly inFlight = new Set<AbortController>();
  private readonly pendingResolvers: Array<() => void> = [];
  private activeCount = 0;
  private closed = false;

  constructor(options: LanePoolOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.piCommand = options.piCommand ?? "pi";
    this.spawn = options.spawn ?? defaultSpawn;
    this.env = options.env;
    this.maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL;
    this.sessionDir = options.sessionDir ?? join(this.cwd, ".pi", "agent-sessions");
    this.agentName = options.agentName ?? DEFAULT_AGENT_NAME;
    this.killGraceMs = options.killGraceMs;
    this.probe = options.probe;
    this.now = options.now ?? Date.now;
  }

  /**
   * Get-or-create the STABLE session path for a lane. Reused across a chain of
   * tasks on the same lane => context continuity via the same session file.
   */
  sessionPathFor(lane: string): string {
    const existing = this.lanes.get(lane);
    if (existing) return existing.sessionPath;
    mkdirSync(this.sessionDir, { recursive: true });
    const stem = safeFileStem(lane) || this.agentName;
    const sessionPath = join(this.sessionDir, `${stem}.jsonl`);
    this.lanes.set(lane, {
      id: lane,
      sessionPath,
      createdAt: this.now(),
      lastUsedAt: this.now(),
    });
    return sessionPath;
  }

  /** True if a lane currently has an in-flight task. */
  isLaneActive(lane: string): boolean {
    return this.activeLanes.has(lane);
  }

  /** Snapshot of registered lanes and their idle/active state. */
  laneInfo(): LaneInfo[] {
    return [...this.lanes.entries()].map(([id, state]) => ({
      id,
      sessionPath: state.sessionPath,
      createdAt: state.createdAt,
      lastUsedAt: state.lastUsedAt,
      active: this.activeLanes.has(id),
    }));
  }

  get laneCount(): number {
    return this.lanes.size;
  }

  get activeCountValue(): number {
    return this.activeCount;
  }

  /**
   * Dispatch a single task as a one-shot spawn on the given lane, reusing the
   * lane's stable session path. Returns the parsed ChildResult. The model probe
   * (if configured) is fired off the critical path and never blocks spawn.
   */
  async dispatch(lane: string, input: LaneDispatchInput): Promise<ChildResult> {
    const sessionPath = input.sessionPath ?? this.sessionPathFor(lane);
    // Optional probe hook: fire-and-forget, NEVER awaited (off the critical path).
    if (this.probe && input.model) {
      try {
        void Promise.resolve(this.probe(input.model, lane));
      } catch {
        // A failing probe must never block or break dispatch.
      }
    }
    return this.runOneShot(lane, sessionPath, input);
  }

  private async acquireSlot(): Promise<void> {
    if (this.closed) throw new Error("LanePool is closed");
    if (this.activeCount < this.maxParallel) {
      this.activeCount++;
      return;
    }
    await new Promise<void>((resolve) => this.pendingResolvers.push(resolve));
    this.activeCount++;
  }

  private releaseSlot(): void {
    this.activeCount--;
    const next = this.pendingResolvers.shift();
    next?.();
  }

  private async runOneShot(lane: string, sessionPath: string, input: LaneDispatchInput): Promise<ChildResult> {
    await this.acquireSlot();
    const controller = new AbortController();
    this.inFlight.add(controller);
    this.activeLanes.add(lane);
    try {
      const result: ChildResult = {
        agent: lane,
        task: input.task,
        exitCode: 0,
        output: "",
        stderr: "",
        model: input.model,
        sessionPath,
        usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      };

      const args = [
        ...buildIsolatedChildArgs(input.extensions),
        ...buildChildFlags({
          sessionPath,
          model: input.model,
          thinking: input.thinking,
          tools: input.tools,
          agentPrompt: input.agentPrompt,
          sessionOffset: input.sessionOffset,
        }),
      ];
      const spawnInput: SpawnInput = {
        command: this.piCommand,
        args,
        cwd: input.cwd ?? this.cwd,
        env: input.runId && input.steerDir
          ? {
              // B5: wire the escalation channel into the child env — the
              // PI_SUBAGENTS_RUN_ID marker gates the child's ask_master tool
              // (subagent sessions only) and points at the escalation file
              // name; the dir matches the steer dir. Inherits the configured
              // child env (or the parent's when none was set) so nothing else
              // changes for the child.
              ...(this.env ?? process.env),
              [ESCALATION_RUN_ID_ENV]: input.runId,
              [ESCALATION_DIR_ENV]: input.steerDir,
            }
          : this.env,
      };
      const child = this.spawn(spawnInput);

      // B3 graceful turn limits (resolved against the shared bounds).
      const limits = resolveTurnLimits(input);
      let softLimitReached = false;
      let steerDelivered = false;
      let hardAborted = false;
      let abortNow: (() => void) | undefined;

      /**
       * Turn-limit enforcement, fired from the parser's onUpdate (after each
       * assistant message_end increments usage.turns):
       *   - soft: at maxTurns, write the wrap-up steer file ONCE (B2 channel);
       *   - hard: at maxTurns + graceTurns, bounded abort (SIGTERM -> killGrace
       *     -> SIGKILL) — only after the soft steer, exactly once.
       */
      const enforceTurnLimit = (): void => {
        if (limits.maxTurns === undefined || hardAborted) return;
        const turns = result.usage.turns;
        if (!softLimitReached) {
          if (turns >= limits.maxTurns) {
            softLimitReached = true;
            if (input.runId && input.steerDir) {
              try {
                writeSteerFile(input.runId, input.wrapUpMessage ?? WRAP_UP_STEER_MESSAGE, input.steerDir);
                steerDelivered = true;
              } catch {
                // A failed steer write must never take the run down; the hard
                // abort at maxTurns + graceTurns still bounds it.
              }
            }
          }
        } else if (turns >= limits.maxTurns + limits.graceTurns) {
          hardAborted = true;
          abortNow?.();
        }
      };

      const parser = new NdjsonStreamParser(result, { onUpdate: enforceTurnLimit });
      let wasAborted = false;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => parser.push(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        result.stderr += chunk;
      });

      const handle = attachBoundedAbort(child, controller.signal, {
        killGraceMs: this.killGraceMs,
        onAbort: () => {
          wasAborted = true;
        },
      });
      abortNow = () => handle.abort();

      const exitPromise = new Promise<void>((resolveExit) => {
        child.on("error", (error) => {
          handle.dispose();
          result.exitCode = 1;
          result.errorMessage = error.message;
          resolveExit();
        });
        child.on("close", (code) => {
          handle.dispose();
          parser.flush();
          result.exitCode = code ?? (wasAborted ? 130 : 0);
          if (wasAborted) {
            result.stopReason = "aborted";
            result.errorMessage = "Child agent aborted";
          } else if (code === ESCALATION_EXIT_CODE) {
            // B5 escalation: consume-once (read + immediate delete). The exit
            // code is the source of truth — a missing/invalid file still marks
            // the run escalated, just without a message (clean fallback).
            const escalation = consumeEscalation(input.runId, input.steerDir);
            result.stopReason = "escalated";
            if (escalation.message) result.escalationMessage = escalation.message;
          } else if (steerDelivered && result.exitCode === 0) {
            // B3: the child wrapped up cleanly after the soft steer (before the
            // hard abort) — a distinguishable, successful "steered" outcome.
            result.stopReason = "steered";
          }
          resolveExit();
        });
      });

      // One-shot stdin injection, then close the pipe.
      child.stdin.write(input.task);
      child.stdin.end();

      await exitPromise;
      return result;
    } finally {
      this.inFlight.delete(controller);
      this.activeLanes.delete(lane);
      this.releaseSlot();
      const state = this.lanes.get(lane);
      if (state) state.lastUsedAt = this.now();
    }
  }

  /**
   * Remove lanes that have been idle for at least `ttlMs` and have no in-flight
   * task. Their stable session paths are forgotten (next dispatch creates a
   * fresh one). Returns the removed lane ids.
   */
  closeIdle(ttlMs: number): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const [id, state] of this.lanes) {
      if (this.activeLanes.has(id)) continue;
      if (now - state.lastUsedAt >= ttlMs) expired.push(id);
    }
    for (const id of expired) this.lanes.delete(id);
    return expired;
  }

  /** Abort every in-flight task and mark the pool closed (bounded kill via signal). */
  closeAll(): void {
    this.closed = true;
    const controllers = [...this.inFlight];
    for (const controller of controllers) controller.abort();
    this.lanes.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
