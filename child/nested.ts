/**
 * child/nested.ts — C1 nested subagents: the `subagent` tool registered
 * INSIDE the child adapter, so a child can spawn its own grandchild agents
 * (self-hosted delegation).
 *
 * Three locks (benchmark tintinweb nested-tools.ts §4c; nicopreme env-based
 * recursion guard):
 *   1. Depth cap — the tool is registered ONLY when PI_SUBAGENTS_NESTED=1 AND
 *      PI_SUBAGENTS_DEPTH < PI_SUBAGENTS_MAX_DEPTH (the engine sets DEPTH=1
 *      and MAX_DEPTH from the config maxSubagentDepth, clamped 0..4 — 0/1 =
 *      off). Every grandchild spawn propagates PI_SUBAGENTS_DEPTH+1, so the
 *      recursion is bounded by construction.
 *   2. Strict allowlist — PI_SUBAGENTS_ALLOWED_SUBAGENTS (CSV agent names, or
 *      `all`). An agent NOT on the list is REFUSED with a message; there is
 *      NEVER a fallback to another agent. An empty allowlist refuses
 *      everything.
 *   3. Inherited security — the grandchild env inherits the child's ZOB_*
 *      path-policy vars (allowed/forbidden/sandbox) untouched, and the
 *      grandchild loads the SAME child adapter via `-e`, so the write-safety
 *      guard applies recursively. The child's OWN escalation/steer channel
 *      envs (PI_SUBAGENTS_RUN_ID / PI_SUBAGENTS_ESCALATION_DIR /
 *      PI_SUBAGENTS_STEER_FILE) are NOT inherited: a grandchild reports
 *      through this tool result and its child owns the ask_master channel
 *      (no escalation-file collisions on the shared <runId> name).
 *
 * The grandchild spawn REUSES the compiled lanes code (buildIsolatedChildArgs
 * + buildChildFlags + NdjsonStreamParser + attachBoundedAbort + injectable
 * SpawnFn): child/nested.ts compiles to dist/child/nested.js, so
 * `../src/lanes/*.js` resolves inside dist. Zero @earendil-works/* imports
 * (invariant I9); never spawns a REAL pi in tests (SpawnFn is injectable).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, PiExtensionContext, PiToolResult } from "./pi-types.js";
import { ESCALATION_DIR_ENV, RUN_ID_ENV } from "./escalation.js";
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  HARD_MAX_MAX_SUBAGENT_DEPTH,
} from "../src/shared/config.js";
import type { ChildResult } from "../src/core/types.js";
import { capOutput } from "../src/core/formatting.js";
import { sha256 } from "../src/core/hashing.js";
import { safeFileStem } from "../src/core/paths.js";
import { loadAgentsFromDir, type AgentCard } from "../src/registry/agents.js";
import { buildChildFlags, buildIsolatedChildArgs } from "../src/lanes/args.js";
import { NdjsonStreamParser } from "../src/lanes/ndjson.js";
import { attachBoundedAbort } from "../src/lanes/abort.js";
import { defaultSpawn, type ChildLike, type SpawnFn } from "../src/lanes/spawn.js";

// ---- env contract (MUST stay in sync with src/engine/dispatch.ts) ----

/** Master switch set by the engine when the dispatch enables nesting (C1). */
export const NESTED_ENV = "PI_SUBAGENTS_NESTED";
/** Current nesting depth (engine-spawned children start at 1). */
export const DEPTH_ENV = "PI_SUBAGENTS_DEPTH";
/** Maximum nesting depth (from config maxSubagentDepth, clamp 0..4; 0/1 = off). */
export const MAX_DEPTH_ENV = "PI_SUBAGENTS_MAX_DEPTH";
/** Strict CSV allowlist of grandchild agent names (`all` = any). */
export const ALLOWED_SUBAGENTS_ENV = "PI_SUBAGENTS_ALLOWED_SUBAGENTS";
/** Absolute agents dir used to resolve grandchild agent cards. */
export const AGENTS_DIR_ENV = "PI_SUBAGENTS_AGENTS_DIR";
/** pi binary override for the grandchild spawn (default `pi`). */
export const PI_COMMAND_ENV = "PI_SUBAGENTS_PI";
/** Child adapter path override passed to the grandchild via `-e`. */
export const CHILD_EXTENSION_ENV = "PI_SUBAGENTS_CHILD_EXTENSION";
/** Grandchild hard timeout in ms (default 10 min, floored at 1 s). */
export const NESTED_TIMEOUT_ENV = "PI_SUBAGENTS_NESTED_TIMEOUT_MS";

/** Local mirror of child/index.ts STEER_FILE_ENV (no index->nested cycle). */
const STEER_FILE_ENV_LOCAL = "PI_SUBAGENTS_STEER_FILE";

export const SUBAGENT_TOOL_NAME = "subagent";
/** Byte cap on the grandchild result returned to the child's context. */
export const NESTED_OUTPUT_LIMIT_BYTES = 4_000;
/** Default grandchild hard timeout (10 minutes). */
export const DEFAULT_NESTED_TIMEOUT_MS = 10 * 60_000;

// ---- pure helpers (exported for tests) ----

function envInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** Current nesting depth (>= 0; absent/invalid = 0). */
export function readDepthEnv(env: NodeJS.ProcessEnv): number {
  return Math.max(0, envInt(env, DEPTH_ENV) ?? 0);
}

/** Maximum nesting depth, clamped to [0, 4] (absent/invalid = default 2). */
export function readMaxDepthEnv(env: NodeJS.ProcessEnv): number {
  return Math.min(HARD_MAX_MAX_SUBAGENT_DEPTH, Math.max(0, envInt(env, MAX_DEPTH_ENV) ?? DEFAULT_MAX_SUBAGENT_DEPTH));
}

/** Grandchild hard timeout in ms (invalid/absent = 10 min, floored at 1 s). */
export function readTimeoutEnv(env: NodeJS.ProcessEnv, override?: number): number {
  const raw = override ?? envInt(env, NESTED_TIMEOUT_ENV) ?? DEFAULT_NESTED_TIMEOUT_MS;
  return Math.max(1_000, raw);
}

/**
 * Parse the strict allowlist CSV. `all` (any position, case-insensitive)
 * means any agent is allowed; an EMPTY/absent value yields `[]`, which
 * refuses everything (strict: no implicit wildcard).
 */
export function parseAllowlist(raw: string | undefined): string[] | "all" {
  if (!raw || !raw.trim()) return [];
  const entries = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return entries.some((name) => name.toLowerCase() === "all") ? "all" : entries;
}

/** Strict membership check (case-insensitive name match; `all` = any). */
export function agentAllowed(name: string, allowlist: string[] | "all"): boolean {
  if (allowlist === "all") return true;
  return allowlist.some((entry) => entry.toLowerCase() === name.toLowerCase());
}

/**
 * Lock 1: the nested tool may exist ONLY when the master switch is exactly
 * `1` AND the current depth is strictly below the cap. depth >= max => the
 * tool is NOT registered (clean refusal — the child cannot nest further).
 */
export function nestedToolEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[NESTED_ENV] === "1" && readDepthEnv(env) < readMaxDepthEnv(env);
}

/** Default child adapter path: this module's sibling index.js (dist/child). */
export function defaultChildAdapterPath(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/** Resolve a grandchild agent card from the agents dir (case-insensitive). */
export function findNestedAgentCard(name: string, agentsDir: string): AgentCard | undefined {
  return loadAgentsFromDir(agentsDir, "project").find(
    (card) => card.name.toLowerCase() === name.toLowerCase(),
  );
}

// ---- grandchild spawn (lanes code reuse) ----

export interface NestedGrandchildInput {
  card: AgentCard;
  task: string;
  cwd: string;
  /** Current depth; the grandchild runs at depth + 1. */
  depth: number;
  maxDepth: number;
  spawn?: SpawnFn;
  piCommand?: string;
  childExtension?: string;
  timeoutMs?: number;
  /** Cooperative abort propagated from the tool call. */
  signal?: AbortSignal;
  /** Base env (defaults to process.env — inherits the ZOB_* security vars). */
  env?: NodeJS.ProcessEnv;
}

function nestedUsageEmpty(): ChildResult["usage"] {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

/**
 * Spawn a one-shot grandchild pi via the lanes code (args + NDJSON parser +
 * bounded abort), with PI_SUBAGENTS_DEPTH+1 and the SAME security envs
 * (natural inheritance — ZOB_* vars are copied verbatim). The child's own
 * escalation/steer channel envs are stripped (see file header, lock 3).
 * Session files live in a throwaway temp dir removed after the run.
 */
export async function spawnNestedGrandchild(input: NestedGrandchildInput): Promise<ChildResult> {
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagents-nested-"));
  try {
    const sessionPath = join(sessionDir, `${safeFileStem(input.card.name) || "grandchild"}.jsonl`);
    const args = [
      ...buildIsolatedChildArgs({ childSafetyExtension: input.childExtension ?? defaultChildAdapterPath() }),
      ...buildChildFlags({
        sessionPath,
        model: input.card.model,
        thinking: input.card.thinking,
        tools: input.card.tools?.join(","),
        agentPrompt: input.card.prompt,
      }),
    ];

    // Lock 3: inherit everything (ZOB_* path policy included) EXCEPT the
    // child's own escalation/steer channel identity.
    const env: NodeJS.ProcessEnv = {
      ...(input.env ?? process.env),
      [NESTED_ENV]: "1",
      [DEPTH_ENV]: String(input.depth + 1),
      [MAX_DEPTH_ENV]: String(Math.min(HARD_MAX_MAX_SUBAGENT_DEPTH, Math.max(0, input.maxDepth))),
    };
    delete env[RUN_ID_ENV];
    delete env[ESCALATION_DIR_ENV];
    delete env[STEER_FILE_ENV_LOCAL];

    const result: ChildResult = {
      agent: input.card.name,
      task: input.task,
      exitCode: 0,
      output: "",
      stderr: "",
      sessionPath,
      model: input.card.model,
      usage: nestedUsageEmpty(),
    };

    const child: ChildLike = (input.spawn ?? defaultSpawn)({
      command: input.piCommand ?? "pi",
      args,
      cwd: input.cwd,
      env,
    });

    const parser = new NdjsonStreamParser(result);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => parser.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      result.stderr += chunk;
    });

    let aborted = false;
    let timedOut = false;
    const handle = attachBoundedAbort(child, input.signal, {
      onAbort: () => {
        aborted = true;
      },
    });
    // Bounded grandchild runtime: hard-abort (SIGTERM -> SIGKILL) past the
    // timeout so a hung grandchild can never wedge the child's tool call.
    const timer = setTimeout(() => {
      timedOut = true;
      handle.abort();
    }, readTimeoutEnv(input.env ?? process.env, input.timeoutMs));
    timer.unref();

    const exitPromise = new Promise<void>((resolveExit) => {
      child.on("error", (error) => {
        handle.dispose();
        clearTimeout(timer);
        result.exitCode = 1;
        result.errorMessage = error.message;
        resolveExit();
      });
      child.on("close", (code) => {
        handle.dispose();
        clearTimeout(timer);
        parser.flush();
        result.exitCode = code ?? 0;
        if (aborted) {
          result.stopReason = "aborted";
          result.errorMessage = timedOut
            ? "Grandchild agent aborted (nested timeout)"
            : "Grandchild agent aborted";
        }
        resolveExit();
      });
    });

    // One-shot stdin injection FIRST, then await the exit (pool.runOneShot
    // order — a child waiting on stdin can never close before the task lands).
    child.stdin.write(input.task);
    child.stdin.end();
    await exitPromise;
    return result;
  } finally {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // best effort (I10): a leftover temp dir must never fail the tool call
    }
  }
}

// ---- tool registration ----

/** Injection context for tests / hosts (fake pi SpawnFn, cwd, timeout). */
export interface NestedToolContext {
  cwd?: string;
  spawn?: SpawnFn;
  timeoutMs?: number;
}

function nestedRefusal(message: string, details: Record<string, unknown>): PiToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { schema: "pi-subagents.nested.v1", allowed: false, ...details },
  };
}

/**
 * Register the nested `subagent` tool on the child adapter.
 *
 * Registered ONLY when PI_SUBAGENTS_NESTED=1 AND PI_SUBAGENTS_DEPTH <
 * PI_SUBAGENTS_MAX_DEPTH (lock 1). On call the tool enforces the strict
 * allowlist (lock 2: refused agents are NEVER replaced by a fallback), then
 * spawns the grandchild through the lanes code with the inherited security
 * envs (lock 3) and returns the CAPPED result to the child.
 */
export function registerNestedSubagentTool(pi: ExtensionAPI, ctx: NestedToolContext = {}): void {
  if (!pi.registerTool) return; // shim without tool registration: clean no-op
  if (!nestedToolEnabled(process.env)) return; // lock 1: depth cap / master switch

  pi.registerTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description:
      "Spawn a NESTED subagent (grandchild) to delegate one bounded, self-contained sub-task. " +
      "Only agents on your nested allowlist are permitted; any other agent is refused with no fallback. " +
      "Keep the sub-task small — nesting depth is capped.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Agent name — MUST be on the nested allowlist (PI_SUBAGENTS_ALLOWED_SUBAGENTS).",
        },
        task: {
          type: "string",
          description: "Self-contained sub-task for the grandchild (bounded six-part style contract when possible).",
        },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params, signal, _onUpdate, execCtx: PiExtensionContext | undefined) => {
      const agent = typeof params.agent === "string" ? params.agent.trim() : "";
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!agent || !task) {
        throw new Error("subagent requires non-empty 'agent' and 'task' parameters");
      }

      const env = process.env;
      const depth = readDepthEnv(env);
      const maxDepth = readMaxDepthEnv(env);

      // Lock 1 re-checked at execute time (defense in depth: a stale env or a
      // hand-tampered depth is refused cleanly, never a crash).
      if (depth >= maxDepth) {
        return nestedRefusal(
          `refused: nested depth cap reached (depth ${depth} >= max ${maxDepth}). No grandchild was spawned.`,
          { reason: "depth_cap", depth, maxDepth, agent },
        );
      }

      // Lock 2: strict allowlist — REFUSE, never fall back to another agent.
      const allowlist = parseAllowlist(env[ALLOWED_SUBAGENTS_ENV]);
      if (!agentAllowed(agent, allowlist)) {
        const list = allowlist === "all" ? "all" : allowlist.length > 0 ? allowlist.join(", ") : "(empty)";
        return nestedRefusal(
          `refused: agent '${agent}' is not in the nested allowlist [${list}]. ` +
            "No fallback agent is ever selected — ask the master to extend the allowlist if this agent is required.",
          { reason: "allowlist", agent, allowlist: list },
        );
      }

      // Resolve the agent card (unknown agent = refusal, never a fallback).
      const cwd = ctx.cwd ?? execCtx?.cwd ?? process.cwd();
      const agentsDir = env[AGENTS_DIR_ENV] || join(cwd, ".pi", "agents");
      const card = findNestedAgentCard(agent, agentsDir);
      if (!card) {
        const available = loadAgentsFromDir(agentsDir, "project").map((entry) => entry.name);
        return nestedRefusal(
          `refused: unknown agent '${agent}' under ${agentsDir}. Available: ${available.join(", ") || "none"}. ` +
            "No fallback agent is ever selected.",
          { reason: "unknown_agent", agent, agentsDir, available },
        );
      }

      // Lock 3: grandchild spawn with inherited security envs (lanes code).
      const result = await spawnNestedGrandchild({
        card,
        task,
        cwd,
        depth,
        maxDepth,
        spawn: ctx.spawn,
        piCommand: env[PI_COMMAND_ENV],
        childExtension: env[CHILD_EXTENSION_ENV],
        timeoutMs: ctx.timeoutMs,
        signal,
        env,
      });

      // Hash-only trace in the child session (bodies never reach the trace).
      pi.appendEntry?.("pi-subagents-nested", {
        agent: card.name,
        depth: depth + 1,
        maxDepth,
        exitCode: result.exitCode,
        taskHash: sha256(task),
        outputHash: sha256(result.output),
        timestamp: Date.now(),
      });

      const header = `subagent '${card.name}' (depth ${depth + 1}/${maxDepth}) — exit ${result.exitCode}`;
      const body = [
        result.errorMessage ? `Error: ${result.errorMessage}` : undefined,
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
        result.output.trim() ? `Output:\n${result.output.trim()}` : "(no output)",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        content: [{ type: "text", text: capOutput(`${header}\n\n${body}`, NESTED_OUTPUT_LIMIT_BYTES) }],
        details: {
          schema: "pi-subagents.nested.v1",
          allowed: true,
          agent: card.name,
          depth: depth + 1,
          maxDepth,
          exitCode: result.exitCode,
          stopReason: result.stopReason,
          taskHash: sha256(task),
          outputHash: sha256(result.output),
          usage: result.usage,
        },
      };
    },
  });
}
