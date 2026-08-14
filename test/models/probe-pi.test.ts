// test/models/probe-pi.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHILD_MODEL_PROBE_KILL_GRACE_MS,
  CHILD_MODEL_PROBE_OUTPUT_LIMIT,
  CHILD_MODEL_PROBE_TIMEOUT_MS,
  createPiModelProbe,
  modelListHasExactModel,
  runPiModelListProbe,
  type PiProbeProcess,
  type PiProbeReadable,
  type PiProbeSpawnFn,
} from "../../src/models/index.js";

/** In-memory readable that lets a test emit data lines. */
function makeReadable(): PiProbeReadable & { emit: (chunk: string) => void } {
  const listeners: Array<(chunk: string) => void> = [];
  return {
    setEncoding: () => undefined,
    on: (_event: "data", listener: (chunk: string) => void) => {
      listeners.push(listener);
      return undefined;
    },
    emit: (chunk: string) => { for (const l of listeners) l(chunk); },
  };
}

interface FakeConfig {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Auto-emit stdout/stderr and close on the next tick (default true). */
  autoClose?: boolean;
}

/** Fake spawner that captures the spawn call and auto-resolves close. */
function fakeSpawner(config: FakeConfig = {}) {
  const stdout = makeReadable();
  const stderr = makeReadable();
  const capture: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } = { command: "", args: [], cwd: "", env: {} };
  let killCalls: string[] = [];
  let closeListener: ((code: number | null) => void) | undefined;

  const process: PiProbeProcess = {
    stdout,
    stderr,
    kill: (signal: NodeJS.Signals) => { killCalls.push(signal); return true; },
    on: (event: "error" | "close", ...args: unknown[]) => {
      if (event === "close") closeListener = args[0] as (code: number | null) => void;
      return undefined;
    },
  };

  const spawnFn: PiProbeSpawnFn = (input) => {
    capture.command = input.command;
    capture.args = input.args;
    capture.cwd = input.cwd;
    capture.env = input.env;
    if (config.autoClose !== false) {
      setImmediate(() => {
        if (config.stdout) stdout.emit(config.stdout);
        if (config.stderr) stderr.emit(config.stderr);
        closeListener?.(config.code ?? 0);
      });
    }
    return process;
  };

  return {
    spawnFn,
    capture,
    stdout,
    stderr,
    get killCalls() { return killCalls; },
    close: (code: number | null) => closeListener?.(code),
  };
}

const baseEnv = { PATH: "/usr/bin", HOME: "/home/user" };

describe("modelListHasExactModel", () => {
  it("matches provider+id for a slash-qualified model", () => {
    assert.equal(modelListHasExactModel("openai gpt-4o\n", "openai/gpt-4o"), true);
    assert.equal(modelListHasExactModel("openai gpt-3.5\n", "openai/gpt-4o"), false);
  });

  it("matches id alone for an unqualified model and ignores the header", () => {
    assert.equal(modelListHasExactModel("provider model\nopenai gpt-4o\n", "gpt-4o"), true);
  });

  it("returns false for empty lines and absent models", () => {
    assert.equal(modelListHasExactModel("", "gpt-4o"), false);
    assert.equal(modelListHasExactModel("openai gpt-3.5\n", "gpt-4o"), false);
  });
});

describe("runPiModelListProbe: arg construction", () => {
  it("builds --no-extensions --list-models <model> without an extension", async () => {
    const f = fakeSpawner({ stdout: "openai gpt-4o\n", code: 0 });
    const run = await runPiModelListProbe({ model: "openai/gpt-4o", cwd: "/repo", env: baseEnv }, { spawnFn: f.spawnFn, command: "pi" });
    assert.deepEqual(f.capture.args, ["--no-extensions", "--list-models", "openai/gpt-4o"]);
    assert.equal(f.capture.command, "pi");
    assert.equal(f.capture.cwd, "/repo");
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "openai gpt-4o\n");
  });

  it("injects -e <extension> before --list-models when a provider extension is present", async () => {
    const f = fakeSpawner({ code: 0 });
    await runPiModelListProbe(
      { model: "gpt-4o", providerExtension: "/ext/provider.ts", cwd: "/repo", env: baseEnv },
      { spawnFn: f.spawnFn },
    );
    assert.deepEqual(f.capture.args, ["--no-extensions", "-e", "/ext/provider.ts", "--list-models", "gpt-4o"]);
  });
});

describe("createPiModelProbe: fake spawner", () => {
  it("returns ok when exit 0 and the model is listed", async () => {
    const f = fakeSpawner({ stdout: "provider model\nopenai gpt-4o\n", code: 0 });
    const probe = createPiModelProbe({ cwd: "/repo", env: baseEnv, spawnFn: f.spawnFn });
    const result = await probe("openai/gpt-4o");
    assert.deepEqual(result, { ok: true });
  });

  it("returns a reason when exit is non-zero", async () => {
    const f = fakeSpawner({ stderr: "boom\n", code: 2 });
    const probe = createPiModelProbe({ spawnFn: f.spawnFn });
    const result = await probe("openai/gpt-4o");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /boom/);
  });

  it("returns a reason when the exact model is not present", async () => {
    const f = fakeSpawner({ stdout: "openai gpt-3.5\n", code: 0 });
    const probe = createPiModelProbe({ spawnFn: f.spawnFn });
    const result = await probe("openai/gpt-4o");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /was not present/);
  });

  it("returns a reason when the probe times out", async () => {
    const f = fakeSpawner({ autoClose: false });
    const probe = createPiModelProbe({ spawnFn: f.spawnFn, timeoutMs: 1, killGraceMs: 1 });
    const pending = probe("openai/gpt-4o");
    setTimeout(() => f.close(null), 5);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /timed out/);
    assert.ok(f.killCalls.includes("SIGTERM"));
  });

  it("shares the configured provider extension through the probe", async () => {
    const f = fakeSpawner({ stdout: "openai gpt-4o\n", code: 0 });
    const probe = createPiModelProbe({ providerExtension: "/ext/provider.ts", spawnFn: f.spawnFn });
    await probe("openai/gpt-4o");
    assert.deepEqual(f.capture.args, ["--no-extensions", "-e", "/ext/provider.ts", "--list-models", "openai/gpt-4o"]);
  });
});

describe("probe constants", () => {
  it("matches the harness signatures", () => {
    assert.equal(CHILD_MODEL_PROBE_TIMEOUT_MS, 30_000);
    assert.equal(CHILD_MODEL_PROBE_KILL_GRACE_MS, 5_000);
    assert.equal(CHILD_MODEL_PROBE_OUTPUT_LIMIT, 128 * 1024);
  });
});
