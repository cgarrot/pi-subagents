/**
 * test/child/ask-master.test.ts — B5 child-side ask_master escalation tool.
 *
 * Verifies with a FAKE pi (no real pi process) that the child adapter:
 *  - registers the `ask_master` tool ONLY when the subagent marker env
 *    `PI_SUBAGENTS_RUN_ID` is present (never in a main/master session),
 *  - on call: atomically writes `<escalationDir>/<runId>.escalation.json`
 *    ({runId, message, timestamp} — no temp leftovers),
 *  - appends a HASH-ONLY trace entry (sha-256, never the raw message),
 *  - records `process.exitCode = 42` and returns `terminate: true`,
 *  - throws (tool error) on an empty message or a missing escalation dir.
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childExtension, {
  ESCALATION_DIR_ENV,
  ESCALATION_EXIT_CODE,
  RUN_ID_ENV,
  escalationFilePath,
  escalationMessageHash,
  isSubagentSession,
  writeEscalationFile,
} from "../../child/index.js";
import type { ExtensionAPI, PiExtensionContext, PiToolDefinition } from "../../child/pi-types.js";

const STEER = "PI_SUBAGENTS_STEER_FILE";
const ENV_KEYS = [RUN_ID_ENV, ESCALATION_DIR_ENV, STEER] as const;

/** Minimal fake pi: records handlers, registerTool calls, appendEntry calls. */
function makeFakePi() {
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const tools: PiToolDefinition[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: never, ctx: never) => unknown): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: PiToolDefinition): void {
      tools.push(tool);
    },
    sendUserMessage(): void {},
    appendEntry(type: string, data: unknown): void {
      entries.push({ type, data });
    },
    async emit(event: string, eventPayload: unknown, ctx: unknown): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(eventPayload as never, ctx as never);
      }
      return result;
    },
    tools,
    entries,
  };
  return pi;
}

function makeCtx(cwd: string): PiExtensionContext {
  return { cwd, ui: { setStatus: () => {}, theme: { fg: (_name: string, text: string) => text } } };
}

describe("child/escalation units", () => {
  const dir = mkdtempSync(join(tmpdir(), "escalation-unit-"));

  it("isSubagentSession is true only for a non-empty PI_SUBAGENTS_RUN_ID", () => {
    assert.equal(isSubagentSession({}), false);
    assert.equal(isSubagentSession({ [RUN_ID_ENV]: "" }), false);
    assert.equal(isSubagentSession({ [RUN_ID_ENV]: "  " }), false);
    assert.equal(isSubagentSession({ [RUN_ID_ENV]: "delegate_abc" }), true);
  });

  it("writeEscalationFile writes the payload atomically (no tmp leftovers)", () => {
    const file = writeEscalationFile("run_w", "need master input", dir);
    assert.equal(file, escalationFilePath("run_w", dir));
    const payload = JSON.parse(readFileSync(file, "utf8")) as { runId: string; message: string; timestamp: number };
    assert.deepEqual(payload, { runId: "run_w", message: "need master input", timestamp: payload.timestamp });
    assert.equal(typeof payload.timestamp, "number");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp file leftovers");
  });

  it("escalationMessageHash is a stable sha-256 hex digest", () => {
    const hash = escalationMessageHash("need master input");
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, escalationMessageHash("need master input"));
    assert.notEqual(hash, escalationMessageHash("other"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("child adapter ask_master registration (fake pi)", () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let ctx: { cwd: string };
  let savedExitCode: string | number | undefined;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), "escalation-tool-"));
    ctx = makeCtx(dir);
    savedExitCode = process.exitCode ?? undefined;
    delete process.env[RUN_ID_ENV];
    delete process.env[ESCALATION_DIR_ENV];
    delete process.env[STEER];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    process.exitCode = savedExitCode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT register ask_master without PI_SUBAGENTS_RUN_ID (main session)", () => {
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    assert.deepEqual(pi.tools, [], "no tool registered in a main session");
  });

  it("does NOT register ask_master for a blank PI_SUBAGENTS_RUN_ID", () => {
    process.env[RUN_ID_ENV] = "   ";
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    assert.deepEqual(pi.tools, []);
  });

  it("registers ask_master when PI_SUBAGENTS_RUN_ID is present", () => {
    process.env[RUN_ID_ENV] = "delegate_esc1";
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    assert.equal(pi.tools.length, 1);
    assert.equal(pi.tools[0]!.name, "ask_master");
    assert.equal(typeof pi.tools[0]!.description, "string");
    assert.deepEqual(pi.tools[0]!.parameters, {
      type: "object",
      properties: { message: { type: "string", description: "The question or blocker to escalate to the master (self-contained)." } },
      required: ["message"],
      additionalProperties: false,
    });
  });

  it("execute: atomic escalation file + hash-only trace + exitCode 42 + terminate", async () => {
    process.env[RUN_ID_ENV] = "delegate_esc2";
    process.env[ESCALATION_DIR_ENV] = join(dir, "escalations");
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await pi.emit("session_start", {}, ctx);

    const result = await pi.tools[0]!.execute("call_1", { message: "which oracle gate should I run?" });

    // Tool result terminates the turn (the child then exits with code 42).
    assert.equal(result.terminate, true);
    assert.ok(result.content[0]!.text.includes("Escalation delivered to the master"));
    // Exit code recorded (not a hard process.exit — streams can flush).
    assert.equal(process.exitCode, ESCALATION_EXIT_CODE);

    // Atomic escalation file with the exact consume-once payload shape.
    const file = escalationFilePath("delegate_esc2", join(dir, "escalations"));
    assert.equal(existsSync(file), true, "escalation file written");
    const payload = JSON.parse(readFileSync(file, "utf8")) as { runId: string; message: string; timestamp: number };
    assert.equal(payload.runId, "delegate_esc2");
    assert.equal(payload.message, "which oracle gate should I run?");
    assert.equal(typeof payload.timestamp, "number");
    assert.deepEqual(
      readdirSync(join(dir, "escalations")).filter((name) => name.endsWith(".tmp")),
      [],
      "no temp leftovers",
    );

    // Session trace is HASH-ONLY: the raw message never appears in entries.
    const trace = pi.entries.find((e) => e.type === "pi-subagents-escalation");
    assert.ok(trace, "escalation trace appended");
    assert.deepEqual(trace?.data, {
      runId: "delegate_esc2",
      messageHash: escalationMessageHash("which oracle gate should I run?"),
      timestamp: (trace?.data as { timestamp: number }).timestamp,
    });
    assert.equal(JSON.stringify(pi.entries).includes("which oracle gate"), false, "no raw message in session entries");
  });

  it("execute throws (tool error) on an empty message", async () => {
    process.env[RUN_ID_ENV] = "delegate_esc3";
    process.env[ESCALATION_DIR_ENV] = join(dir, "escalations");
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await assert.rejects(pi.tools[0]!.execute("call_2", { message: "   " }), /non-empty 'message'/);
    assert.equal(existsSync(join(dir, "escalations")), false, "no file written for a rejected call");
  });

  it("execute throws (tool error) when the escalation dir env is missing", async () => {
    process.env[RUN_ID_ENV] = "delegate_esc4";
    const pi = makeFakePi();
    childExtension(pi as unknown as ExtensionAPI);
    await assert.rejects(pi.tools[0]!.execute("call_3", { message: "help" }), /PI_SUBAGENTS_ESCALATION_DIR/);
  });
});
