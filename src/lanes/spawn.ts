/**
 * src/lanes/spawn.ts — injectable child spawner (I11).
 *
 * The LanePool never spawns a process directly; it calls an injected `SpawnFn`.
 * Tests inject a spawner that runs the headless fake-pi fixture instead of a
 * real `pi` binary. `defaultSpawn` is the node:child_process-backed fallback.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface SpawnInput {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Minimal child-process surface the lane pool depends on. */
export interface ChildLike {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  kill(signal?: NodeJS.Signals): boolean;
  readonly killed: boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

/** Injectable spawner (I11). */
export type SpawnFn = (input: SpawnInput) => ChildLike;

/**
 * Default spawner backed by node:child_process. Stdio is fully piped so the
 * pool can inject the task on stdin (one-shot) and stream stdout/stderr.
 */
export const defaultSpawn: SpawnFn = (input) =>
  spawn(input.command, input.args, {
    cwd: input.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: input.env,
  }) as unknown as ChildLike;
