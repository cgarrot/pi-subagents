/**
 * src/models/probe-pi.ts — injectable `pi` model-list probe adapter (NODE layer).
 *
 * This is the ONLY module in src/models that touches `node:child_process`. It
 * mirrors the harness `runChildModelListProbe` + constants + `modelListHasExactModel`
 * from child-runner.ts (cr:85–151), with the spawner fully injectable so tests
 * use a fake process and never boot `pi`.
 *
 * Used as the availability probe backing `AvailabilityCache`. It is NEVER
 * imported by the pure core (src/models/classes, routing, availability-cache,
 * src/core/*) — the pure core only consumes an injected `AvailabilityProbe`.
 *
 * NODE-only layer: imports node:child_process for the default spawner.
 */
import { spawn } from "node:child_process";

/** Timeout for the probe process (ms). */
export const CHILD_MODEL_PROBE_TIMEOUT_MS = 30_000;
/** SIGTERM -> SIGKILL grace window for a timed-out probe (ms). */
export const CHILD_MODEL_PROBE_KILL_GRACE_MS = 5_000;
/** Truncation bound for probe stdout/stderr (keeps the tail). */
export const CHILD_MODEL_PROBE_OUTPUT_LIMIT = 128 * 1024;

/** Minimal readable stream surface expected on the spawned process. */
export interface PiProbeReadable {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
}

/** Minimal child process surface consumed by the probe runner. */
export interface PiProbeProcess {
  stdout: PiProbeReadable;
  stderr: PiProbeReadable;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

export type PiProbeSpawnFn = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => PiProbeProcess;

export interface PiModelListRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface PiModelListProbeInput {
  /** The exact model to look up, e.g. "openai/gpt-4o" or "gpt-4o". */
  model: string;
  /** Provider extension passed as `-e <ext>` when present. */
  providerExtension?: string;
  /** Working directory for the probe process (defaults to process.cwd()). */
  cwd?: string;
  /** Environment for the probe process (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface PiModelListProbeOptions {
  /** Injectable spawner; defaults to `node:child_process` spawn. */
  spawnFn?: PiProbeSpawnFn;
  /** Command to spawn (default "pi"). */
  command?: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

const DEFAULT_PI_COMMAND = "pi";

function defaultSpawner(input: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): PiProbeProcess {
  return spawn(input.command, input.args, {
    cwd: input.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: input.env,
  });
}

/**
 * Whether a `pi --list-models <model>` output contains the exact model. A
 * slash in the expected model requires provider+id equality; otherwise the id
 * alone suffices. Skips empty lines and the literal `provider` header.
 */
export function modelListHasExactModel(output: string, expectedModel: string): boolean {
  const separator = expectedModel.indexOf("/");
  const expectedProvider = separator === -1 ? undefined : expectedModel.slice(0, separator);
  const expectedId = separator === -1 ? expectedModel : expectedModel.slice(separator + 1);
  return output.split(/\r?\n/).some((line) => {
    const [provider, model] = line.trim().split(/\s+/);
    if (!provider || !model || provider === "provider") return false;
    return expectedProvider ? provider === expectedProvider && model === expectedId : model === expectedId;
  });
}

/**
 * Run a single `pi --list-models <model>` probe process.
 *
 * Args (harness order): `--no-extensions` (+ `-e <providerExtension>` when
 * present) then `--list-models <model>`. Bounded output (tail 128 KB), timeout
 * with SIGTERM -> SIGKILL grace, `unref()` timers. Returns code/stdout/stderr
 * and whether the probe timed out.
 */
export function runPiModelListProbe(
  input: PiModelListProbeInput,
  options: PiModelListProbeOptions = {},
): Promise<PiModelListRun> {
  const args = ["--no-extensions"];
  if (input.providerExtension) args.push("-e", input.providerExtension);
  args.push("--list-models", input.model);

  const command = options.command ?? DEFAULT_PI_COMMAND;
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const spawnFn = options.spawnFn ?? defaultSpawner;
  const timeoutMs = options.timeoutMs ?? CHILD_MODEL_PROBE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? CHILD_MODEL_PROBE_KILL_GRACE_MS;

  return new Promise<PiModelListRun>((resolveProbe) => {
    const child = spawnFn({ command, args, cwd, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const appendBounded = (current: string, chunk: string): string =>
      `${current}${chunk}`.slice(-CHILD_MODEL_PROBE_OUTPUT_LIMIT);

    const finish = (result: PiModelListRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveProbe(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => finish({ code: 1, stdout, stderr: appendBounded(stderr, error.message), timedOut }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr, timedOut }));
  });
}

export interface PiProbeAvailabilityInput {
  providerExtension?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  spawnFn?: PiProbeSpawnFn;
  timeoutMs?: number;
  killGraceMs?: number;
}

/**
 * Build an `AvailabilityProbe`-compatible probe (model: string) => result,
 * evaluating code 0 AND exact-model presence as success. Returns an honest
 * `{ok:false, reason}` for timeout, non-zero exit, or missing model. Designed
 * to back `AvailabilityCache` (never imported by the pure core).
 */
export function createPiModelProbe(input: PiProbeAvailabilityInput = {}): (model: string) => Promise<{ ok: boolean; reason?: string }> {
  return async (model) => {
    const run = await runPiModelListProbe(
      { model, providerExtension: input.providerExtension, cwd: input.cwd, env: input.env },
      { spawnFn: input.spawnFn, command: input.command, timeoutMs: input.timeoutMs, killGraceMs: input.killGraceMs },
    );
    if (run.timedOut) return { ok: false, reason: "pi model probe timed out" };
    if (run.code !== 0) {
      const diagnostic = `${run.stdout}\n${run.stderr}`.trim();
      return { ok: false, reason: diagnostic || `pi model probe exited ${run.code}` };
    }
    if (!modelListHasExactModel(run.stdout, model)) {
      return { ok: false, reason: `exact model '${model}' was not present in pi model listing` };
    }
    return { ok: true };
  };
}
