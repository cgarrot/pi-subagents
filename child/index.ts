/**
 * child/index.ts — child extension adapter (standalone port of the harness
 * `.pi/extensions/zob-child-safety/index.ts`).
 *
 * Loaded inside child lanes via `-e`. Registers the write-safety guard over
 * the edit/write tools: blocks writes outside allowed/forbidden/zero-access/
 * read-only/sandbox rules via validateRuntimeWritePolicy + blockedFeedback.
 *
 * Uses the LOCAL child/pi-types.ts mirror (zero @earendil-works/* imports,
 * invariant I9); the real Pi API is wired at load time by the child runner.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "./pi-types.js";
import { isToolCallEventType } from "./pi-types.js";
import { registerNestedSubagentTool } from "./nested.js";
import { DEFAULT_RULES, blockedFeedback, parsePathListEnv, pathMatches, validateRuntimeWritePolicy } from "./policy.js";
import type { DamageRules } from "./policy.js";
import {
  ESCALATION_DIR_ENV,
  ESCALATION_EXIT_CODE,
  RUN_ID_ENV,
  escalationMessageHash,
  isSubagentSession,
  writeEscalationFile,
} from "./escalation.js";

export { pathMatches, parsePathListEnv, validateRuntimeWritePolicy } from "./policy.js";
export {
  ESCALATION_DIR_ENV,
  ESCALATION_EXIT_CODE,
  RUN_ID_ENV,
  escalationFilePath,
  escalationMessageHash,
  isSubagentSession,
  writeEscalationFile,
} from "./escalation.js";
export {
  AGENTS_DIR_ENV,
  ALLOWED_SUBAGENTS_ENV,
  DEPTH_ENV,
  MAX_DEPTH_ENV,
  NESTED_ENV,
  SUBAGENT_TOOL_NAME,
  agentAllowed,
  nestedToolEnabled,
  parseAllowlist,
  registerNestedSubagentTool,
} from "./nested.js";

/** Env var carrying the absolute path of this run's `<runId>.steer` file (B2). */
export const STEER_FILE_ENV = "PI_SUBAGENTS_STEER_FILE";

/** Steer payload consumed from the file written by the parent (src/lanes/steer.ts). */
export interface ConsumedSteerPayload {
  runId: string;
  message: string;
  timestamp: number;
}

/**
 * Consume-once read of the steer file (the parent writes it atomically via
 * rename, so a read never observes a partial payload). Deletes the file as
 * soon as it is read so the same steering message can never be injected
 * twice; an unreadable/invalid payload is still consumed (and dropped) so a
 * corrupt file cannot wedge the poll loop.
 *
 * Returns null when there is nothing to inject: no env var, no file, a
 * read race, or an invalid/empty payload.
 */
export function consumeSteerFile(steerFile: string | undefined): ConsumedSteerPayload | null {
  if (!steerFile) return null;
  let raw: string;
  try {
    raw = readFileSync(steerFile, "utf8");
  } catch {
    return null;
  }
  try {
    unlinkSync(steerFile);
  } catch {
    /* already consumed by a concurrent poll */
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConsumedSteerPayload>;
    if (typeof parsed?.message !== "string" || !parsed.message.trim()) return null;
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : "",
      message: parsed.message,
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
    };
  } catch {
    return null;
  }
}

function loadDamageRules(cwd: string): DamageRules {
  const root = process.env.ZOB_HARNESS_ROOT || cwd;
  const candidate = join(root, ".pi", "damage-control-rules.json");
  if (!existsSync(candidate)) return DEFAULT_RULES;
  try {
    const loaded = JSON.parse(readFileSync(candidate, "utf8")) as Partial<DamageRules>;
    return {
      bashToolPatterns: loaded.bashToolPatterns ?? DEFAULT_RULES.bashToolPatterns,
      zeroAccessPaths: loaded.zeroAccessPaths ?? DEFAULT_RULES.zeroAccessPaths,
      readOnlyPaths: loaded.readOnlyPaths ?? DEFAULT_RULES.readOnlyPaths,
      noDeletePaths: loaded.noDeletePaths ?? DEFAULT_RULES.noDeletePaths,
    };
  } catch {
    return DEFAULT_RULES;
  }
}

/**
 * B5: register the `ask_master` escalation tool — ONLY in subagent sessions
 * (benchmark ryan_nookpi escalation.ts §2.3: the tool must not exist in the
 * main/master session, so the master can never self-escalate). The subagent
 * marker is the `PI_SUBAGENTS_RUN_ID` env injected by the parent LanePool at
 * spawn time — more reliable than a session-file path check.
 *
 * On call: atomically write `<escalationDir>/<runId>.escalation.json`
 * ({runId, message, timestamp}), record `process.exitCode = 42`, and return
 * `terminate: true` so the child ends its turn and exits with the escalation
 * code. The parent consumes the file exactly once (src/lanes/escalation.ts).
 */
function maybeRegisterAskMaster(pi: ExtensionAPI): void {
  if (!isSubagentSession()) return;
  pi.registerTool?.({
    name: "ask_master",
    label: "Ask master",
    description:
      "Escalate a question or blocker to the master session when you cannot proceed safely. " +
      "Provide a single self-contained message with the exact question, what you already tried, and the decision you need. " +
      "Calling this tool terminates this subagent run; the master receives your message and may continue the run.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The question or blocker to escalate to the master (self-contained).",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message) throw new Error("ask_master requires a non-empty 'message' parameter");
      const runId = process.env[RUN_ID_ENV] ?? "";
      const dir = process.env[ESCALATION_DIR_ENV];
      if (!dir) {
        throw new Error(`ask_master: ${ESCALATION_DIR_ENV} is not set — escalation channel unavailable`);
      }
      writeEscalationFile(runId, message, dir);
      // Hash-only trace in the child session (the body lives only in the
      // escalation file, which the parent consumes and never persists).
      pi.appendEntry("pi-subagents-escalation", {
        runId,
        messageHash: escalationMessageHash(message),
        timestamp: Date.now(),
      });
      // Signal the runner: this process must exit with the escalation code.
      // `exitCode` (not process.exit) so stdout flushes before the exit.
      process.exitCode = ESCALATION_EXIT_CODE;
      return {
        content: [{ type: "text", text: `Escalation delivered to the master (run ${runId || "unknown"}). This subagent session now terminates; the master may continue the run.` }],
        terminate: true,
      };
    },
  });
}

export default function zobChildSafety(pi: ExtensionAPI): void {
  let rules: DamageRules = DEFAULT_RULES;

  // B5: ask_master exists ONLY in subagent sessions (PI_SUBAGENTS_RUN_ID).
  maybeRegisterAskMaster(pi);

  // C1: the nested `subagent` tool registers ONLY when the engine enabled
  // nesting for this child (PI_SUBAGENTS_NESTED=1) AND the depth cap allows
  // one more level. Self-gated inside registerNestedSubagentTool.
  registerNestedSubagentTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    rules = loadDamageRules(ctx.cwd);
    ctx.ui.setStatus("zob-child-safety", ctx.ui.theme.fg("accent", "child-safe"));
  });

  pi.on("tool_call", async (event, ctx) => {
    // B2 child-side steer poll (consume-once): check for a mid-run steering
    // message from the parent before every tool call. `deliverAs: "steer"`
    // queues the user message for delivery after the current turn's tool
    // calls, before the next LLM call (pi docs/extensions.md
    // "pi.sendUserMessage(content, options?)").
    const steered = consumeSteerFile(process.env[STEER_FILE_ENV]);
    if (steered) {
      pi.sendUserMessage(steered.message, { deliverAs: "steer" });
      pi.appendEntry("pi-subagents-steer", {
        runId: steered.runId,
        timestamp: steered.timestamp,
        consumedAt: Date.now(),
      });
    }

    let violation: string | undefined;
    let attempted = JSON.stringify(event.input);
    const pathInputs: string[] = [];
    const policyRoot = process.env.ZOB_HARNESS_ROOT || ctx.cwd;

    if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      pathInputs.push(event.input.path ?? "");
    }
    if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      pathInputs.push(event.input.path ?? ".");
    }

    const inheritedAllowedPaths = parsePathListEnv(process.env.ZOB_ALLOWED_PATHS);
    const inheritedForbiddenPaths = parsePathListEnv(process.env.ZOB_FORBIDDEN_PATHS);
    const sandboxRoot = process.env.ZOB_SANDBOX_ROOT;

    for (const inputPath of pathInputs) {
      for (const protectedPattern of rules.zeroAccessPaths) {
        if (pathMatches(inputPath, protectedPattern, ctx.cwd, policyRoot)) violation = `zero-access path: ${protectedPattern}`;
      }
      if (!violation) {
        for (const forbiddenPattern of inheritedForbiddenPaths) {
          if (pathMatches(inputPath, forbiddenPattern, ctx.cwd, policyRoot)) violation = `forbidden path: ${forbiddenPattern}`;
        }
      }
      if ((event.toolName === "write" || event.toolName === "edit") && !violation) {
        const writePolicy = validateRuntimeWritePolicy({
          targetPath: inputPath,
          cwd: ctx.cwd,
          policyRoot,
          allowedPaths: inheritedAllowedPaths,
          forbiddenPaths: inheritedForbiddenPaths,
          zeroAccessPaths: rules.zeroAccessPaths,
          readOnlyPaths: rules.readOnlyPaths,
          sandboxRoot,
        });
        if (!writePolicy.allowed) violation = writePolicy.violations[0];
      }
    }

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      attempted = command;
      for (const rule of rules.bashToolPatterns) {
        if (new RegExp(rule.pattern, "i").test(command)) {
          violation = rule.reason;
          break;
        }
      }
      if (!violation) {
        for (const protectedPattern of rules.zeroAccessPaths) {
          if (command.includes(protectedPattern)) violation = `bash references zero-access path: ${protectedPattern}`;
        }
      }
      if (!violation) {
        for (const forbiddenPattern of inheritedForbiddenPaths) {
          if (command.includes(forbiddenPattern)) violation = `bash references forbidden path: ${forbiddenPattern}`;
        }
      }
      if (!violation) {
        for (const noDelete of rules.noDeletePaths) {
          if (command.includes(noDelete) && /\b(rm|mv)\b/.test(command)) violation = `delete/move protected path: ${noDelete}`;
        }
      }
    }

    if (violation) {
      pi.appendEntry("zob-child-safety", { tool: event.toolName, input: event.input, violation, timestamp: Date.now() });
      return { block: true, reason: blockedFeedback(event.toolName, violation, attempted) };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("zob-child-safety", undefined);
  });
}
