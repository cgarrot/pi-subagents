/**
 * test/child/steer-inject.test.ts — B2 child-side steer channel.
 *
 * Verifies with a FAKE pi (no real pi process) that the child adapter:
 *  - polls the steer file pointed at by PI_SUBAGENTS_STEER_FILE at the
 *    tool_call hook (emitted between tool_execution_start/end),
 *  - injects the payload as a real user message with deliverAs "steer",
 *  - consumes the file exactly once (deleted after injection, no re-inject),
 *  - drops invalid payloads while still consuming the file,
 *  - stays silent without the env var,
 *  - does not interfere with the write-safety policy (block still returned).
 */
import { after, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childExtension, { STEER_FILE_ENV, consumeSteerFile } from "../../child/index.js";
import type { ExtensionAPI, PiExtensionContext } from "../../child/pi-types.js";

const ENV_KEYS = [STEER_FILE_ENV, "ZOB_ALLOWED_PATHS", "ZOB_FORBIDDEN_PATHS", "ZOB_SANDBOX_ROOT", "ZOB_HARNESS_ROOT"] as const;

interface RecordedUserMessage {
  content: string;
  options?: { deliverAs?: "steer" | "followUp" };
}

/** Minimal fake pi: records handlers, sendUserMessage and appendEntry calls. */
function makeFakePi() {
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const sentUserMessages: RecordedUserMessage[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: never, ctx: never) => unknown): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void {
      sentUserMessages.push({ content, options });
    },
    appendEntry(type: string, data: unknown): void {
      entries.push({ type, data });
    },
    /** Emit an event through all registered handlers; returns the last result. */
    async emit(event: string, eventPayload: unknown, ctx: unknown): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(eventPayload as never, ctx as never);
      }
      return result;
    },
    sentUserMessages,
    entries,
  };
  return pi;
}

function makeCtx(cwd: string): PiExtensionContext {
  return { cwd, ui: { setStatus: () => {}, theme: { fg: (_name: string, text: string) => text } } };
}

function writeSteerFile(dir: string, payload: unknown): string {
  const file = join(dir, "run_abc.steer");
  writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return file;
}

describe("consumeSteerFile (unit)", () => {
  const dir = mkdtempSync(join(tmpdir(), "steer-unit-"));

  it("returns null without a path", () => {
    assert.equal(consumeSteerFile(undefined), null);
  });

  it("returns null when the file does not exist", () => {
    assert.equal(consumeSteerFile(join(dir, "missing.steer")), null);
  });

  it("returns the parsed payload and deletes the file (consume-once)", () => {
    const file = writeSteerFile(dir, { runId: "run_1", message: "focus on tests", timestamp: 123 });
    const payload = consumeSteerFile(file);
    assert.deepEqual(payload, { runId: "run_1", message: "focus on tests", timestamp: 123 });
    assert.equal(existsSync(file), false);
    assert.equal(consumeSteerFile(file), null);
  });

  it("consumes (deletes) an invalid-JSON file without returning a payload", () => {
    const file = writeSteerFile(dir, "{not json");
    assert.equal(consumeSteerFile(file), null);
    assert.equal(existsSync(file), false);
  });

  it("consumes a payload with an empty message and returns null", () => {
    const file = writeSteerFile(dir, { runId: "run_2", message: "   ", timestamp: 1 });
    assert.equal(consumeSteerFile(file), null);
    assert.equal(existsSync(file), false);
  });

  it("tolerates missing optional fields", () => {
    const file = writeSteerFile(dir, { message: "go" });
    const payload = consumeSteerFile(file);
    assert.equal(payload?.message, "go");
    assert.equal(payload?.runId, "");
    assert.equal(typeof payload?.timestamp, "number");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("child adapter steer injection (fake pi)", () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let ctx: { cwd: string };

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), "steer-e2e-"));
    ctx = makeCtx(dir);
    // Deterministic policy inputs: no harness root overrides, no inherited
    // lane restrictions leaking from the caller's environment.
    delete process.env.ZOB_HARNESS_ROOT;
    delete process.env.ZOB_ALLOWED_PATHS;
    delete process.env.ZOB_FORBIDDEN_PATHS;
    delete process.env.ZOB_SANDBOX_ROOT;
    delete process.env[STEER_FILE_ENV];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("injects a steer payload as a steer-delivered user message and consumes the file once", async () => {
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, ctx);

    const steerFile = writeSteerFile(dir, { runId: "run_abc", message: "pivot to the oracle gate", timestamp: 42 });
    process.env[STEER_FILE_ENV] = steerFile;

    // Full fake tool lifecycle: tool_execution_start -> tool_call -> tool_execution_end.
    await pi.emit("tool_execution_start", { toolName: "read", input: { path: join(dir, "notes.txt") } }, ctx);
    const verdict = await pi.emit("tool_call", { toolName: "read", input: { path: join(dir, "notes.txt") } }, ctx);
    await pi.emit("tool_execution_end", { toolName: "read" }, ctx);

    assert.equal(verdict, undefined, "benign read must not be blocked");
    assert.deepEqual(pi.sentUserMessages, [{ content: "pivot to the oracle gate", options: { deliverAs: "steer" } }]);
    assert.equal(existsSync(steerFile), false, "steer file must be consumed");
    const trace = pi.entries.find((e) => e.type === "pi-subagents-steer");
    assert.ok(trace, "steer trace entry appended");
    assert.deepEqual(trace?.data, { runId: "run_abc", timestamp: 42, consumedAt: (trace?.data as { consumedAt: number }).consumedAt });

    // Second tool call: consume-once means no second injection.
    await pi.emit("tool_execution_start", { toolName: "read", input: { path: join(dir, "notes.txt") } }, ctx);
    await pi.emit("tool_call", { toolName: "read", input: { path: join(dir, "notes.txt") } }, ctx);
    await pi.emit("tool_execution_end", { toolName: "read" }, ctx);
    assert.equal(pi.sentUserMessages.length, 1, "no re-injection after consumption");
  });

  it("stays silent when PI_SUBAGENTS_STEER_FILE is not set", async () => {
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, ctx);
    writeSteerFile(dir, { runId: "run_x", message: "unused", timestamp: 1 });

    await pi.emit("tool_call", { toolName: "read", input: { path: join(dir, "notes.txt") } }, ctx);
    assert.deepEqual(pi.sentUserMessages, []);
    assert.equal(pi.entries.filter((e) => e.type === "pi-subagents-steer").length, 0);
  });

  it("stays silent when the steer file has not been written yet", async () => {
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, ctx);
    process.env[STEER_FILE_ENV] = join(dir, "run_none.steer");

    await pi.emit("tool_call", { toolName: "read", input: { path: join(dir, "notes.txt") } }, ctx);
    assert.deepEqual(pi.sentUserMessages, []);
  });

  it("consumes and drops an invalid steer payload without injecting", async () => {
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, ctx);
    const steerFile = writeSteerFile(dir, "{corrupt");
    process.env[STEER_FILE_ENV] = steerFile;

    await pi.emit("tool_call", { toolName: "read", input: { path: join(dir, "notes.txt") } }, ctx);
    assert.deepEqual(pi.sentUserMessages, []);
    assert.equal(existsSync(steerFile), false, "corrupt steer file is still consumed");
  });

  it("does not interfere with the write-safety policy: blocked write still blocks while steering", async () => {
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, ctx);
    const steerFile = writeSteerFile(dir, { runId: "run_blk", message: "stop writing", timestamp: 7 });
    process.env[STEER_FILE_ENV] = steerFile;

    const verdict = (await pi.emit("tool_call", { toolName: "write", input: { path: join(dir, ".env") } }, ctx)) as
      | { block: boolean; reason: string }
      | undefined;
    assert.ok(verdict?.block === true, "write to .env must still be blocked");
    assert.ok(verdict?.reason.includes("zero-access path: .env"));
    assert.deepEqual(pi.sentUserMessages, [{ content: "stop writing", options: { deliverAs: "steer" } }]);
    assert.equal(existsSync(steerFile), false);
  });
});
