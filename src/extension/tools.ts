/**
 * src/extension/tools.ts — the 5 delegation tools wired onto the pi-subagents
 * engine (mirror of the pi-mesh adapter pattern). This is the only adapter
 * layer that touches the local pi-types.ts; the engine/core stay Pi-free.
 *
 * The 6 tools:
 *   1. zob_delegation_catalog  — read-only body-free agent + contract catalog.
 *   2. delegate_agent          — single / parallel / chain dispatch.
 *   3. delegate_task           — structured single task (canonical + safe aliases).
 *   4. get_delegation_run      — inspect a background run (body-free).
 *   5. await_delegation_run    — bounded passive wait on a background run.
 *   6. continue_run            — resume a terminal run with its original session.
 *
 * Zero @earendil-works/* imports (I9).
 */

import { join } from "node:path";
import type {
  AgentScope,
  ChildResult,
  ChildThinkingLevel,
  DelegationDetails,
} from "../core/types.js";
import { DispatchEngine } from "../engine/dispatch.js";
import { verifyAttestationSidecar } from "../engine/attestation.js";
import { BackgroundRunRegistry, type BackgroundRunState } from "../engine/background.js";
import { listDelegationRuns } from "../engine/monitor.js";
import { listOutputContracts, parseToolList } from "../gates/index.js";
import { buildAgentCatalog, discoverAgents, formatAgentList, type AgentCatalog } from "../registry/index.js";
import type { EnabledModelsReader } from "../models/index.js";
import type { SpawnFn } from "../lanes/index.js";
import type { ExtensionAPI, SessionContext, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";
import { createPiSettingsEnabledModelsReader } from "./settings-reader.js";
import {
  AWAIT_DELEGATION_RUN_PARAMS,
  CONTINUE_RUN_PARAMS,
  DELEGATE_PARAMS,
  DELEGATE_TASK_PARAMS,
  DELEGATION_CATALOG_PARAMS,
  DELEGATION_RUN_PARAMS,
} from "./schemas.js";

/** Shared per-session runtime: the engine plus its background run registry. */
export interface SubagentsRuntime {
  engine: DispatchEngine;
  background: BackgroundRunRegistry;
  repoRoot: string;
  startedAt: number;
}

export type EnsureRuntime = (ctx: SessionContext) => SubagentsRuntime;
export type GetRuntime = () => SubagentsRuntime | null;

/** Build a runtime bound to a repo root. `spawn` injectable for tests. */
export function createSubagentsRuntime(
  repoRoot: string,
  opts: { spawn?: SpawnFn; onLedger?: (entry: Record<string, unknown>) => void; enabledModelsReader?: EnabledModelsReader } = {},
): SubagentsRuntime {
  const background = new BackgroundRunRegistry();
  const engine = new DispatchEngine({
    repoRoot,
    backgroundRegistry: background,
    source: "delegate_agent",
    sessionDir: join(repoRoot, ".pi", "sessions"),
    spawn: opts.spawn,
    onLedger: opts.onLedger,
    // C3 model scope: pi settings reader (project .pi/settings.json over the
    // global ~/.pi/agent/settings.json); undefined allowlist skips the check.
    enabledModelsReader: opts.enabledModelsReader ?? createPiSettingsEnabledModelsReader(repoRoot),
  });
  return { engine, background, repoRoot, startedAt: Date.now() };
}

// --- small local helpers (no harness import) ---

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function asStrArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

function asThinking(v: unknown): ChildThinkingLevel | undefined {
  return v === "low" || v === "medium" || v === "high" || v === "xhigh" ? v : undefined;
}

/** True when a child result is failed/incomplete. */
export function isFailed(result: ChildResult): boolean {
  return result.exitCode !== 0 || result.gatePassed === false || result.failureKind !== undefined;
}

/** Compact text rendering of a child result (no raw bodies persisted). */
export function formatChildResultText(result: ChildResult): string {
  const lines: string[] = [`Agent: ${result.agent}`, `Exit code: ${result.exitCode}`];
  if (result.output) lines.push(`Output:\n${result.output}`);
  if (result.stderr) lines.push(`Stderr:\n${result.stderr}`);
  if (result.gatePassed === false) {
    lines.push(`Gate: FAILED${result.gateErrors?.length ? `\n- ${result.gateErrors.join("\n- ")}` : ""}`);
  }
  if (result.failureKind) lines.push(`Failure kind: ${result.failureKind}`);
  if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);
  return lines.join("\n");
}

function capOutput(text: string, limit = 4000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

/** Body-free catalog summary text (mirrors harness formatDelegationCatalogSummary). */
export function formatDelegationCatalogSummary(catalog: AgentCatalog): string {
  const lines: string[] = [`Delegation agents (${catalog.counts.total}, scope=${catalog.scope}):`];
  for (const entry of catalog.entries) {
    lines.push(
      `- ${entry.id} [${entry.source}] tools=${entry.tools?.join(",") ?? "default"}${entry.model ? ` model=${entry.model}` : ""}: ${entry.description}`,
    );
  }
  lines.push("");
  lines.push(`Valid output contracts: ${listOutputContracts().join(", ")}`);
  return lines.join("\n");
}

// --------------------------------------------------------------- tools

/** 1) zob_delegation_catalog — read-only, no dispatch. */
export function registerDelegationCatalog(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerTool({
    name: "zob_delegation_catalog",
    label: "ZOB Delegation Catalog",
    description:
      "Read-only live catalog of available delegation agents, their tools/descriptions, and valid output contract ids. No child dispatch, no execution, no network.",
    promptSnippet: "Inspect available delegation agents and output contracts before choosing delegate_agent/delegate_task",
    promptGuidelines: [
      "Use this before the first delegation when agent or output_contract routing is uncertain.",
      "Choose the agent by desired deliverable; normally omit delegate_task.output_contract so the engine infers it from the agent.",
      "Do not invent output contract ids; use only validOutputContracts returned by this catalog.",
    ],
    parameters: DELEGATION_CATALOG_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope: AgentScope = params.scope === "user" || params.scope === "both" ? params.scope : "project";
      const catalog = buildAgentCatalog({ cwd: ctx.cwd, scope });
      return textResult(formatDelegationCatalogSummary(catalog), catalog as unknown as Record<string, unknown>);
    },
  });
  void ensureRuntime;
}

/** 2) delegate_agent — single / parallel / chain. */
export function registerDelegateAgent(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerTool({
    name: "delegate_agent",
    label: "Delegate Agent",
    description: [
      "Delegate a focused task to specialist Pi child agents.",
      "Modes: single (agent+task), parallel (tasks[]), chain (chain[] with {previous}).",
      "Every delegated task must use the exact six-part TASK/EXPECTED OUTCOME/REQUIRED TOOLS/MUST DO/MUST NOT DO/CONTEXT contract.",
    ].join(" "),
    promptSnippet: "Delegate focused work to project specialist agents with isolated child Pi contexts",
    promptGuidelines: [
      "If agent routing is uncertain, call zob_delegation_catalog before the first delegation.",
      "Use delegate_agent for broad discovery, external research, skeptical review, or independent QA before making risky edits.",
      "Give each child a bounded six-part contract and a concrete final output shape.",
      "Optional cwd selects the child working directory; it does not replace allowed_paths or write-scope grants.",
      "If effective tools include edit/write, provide non-empty repo-relative-only allowed_paths.",
    ],
    parameters: DELEGATE_PARAMS,
    async execute(toolCallId, params, _signal, onUpdate, ctx) {
      const rt = ensureRuntime(ctx);
      const scope: AgentScope = params.scope === "user" || params.scope === "both" ? params.scope : "project";
      const agents = discoverAgents(ctx.cwd, scope);
      const makeDetails = (mode: DelegationDetails["mode"], results: ChildResult[]): Record<string, unknown> => ({
        mode,
        results,
        agents: agents.map((agent) => agent.name),
      });

      const tasksArr = Array.isArray(params.tasks) ? (params.tasks as Array<Record<string, unknown>>) : [];
      const chainArr = Array.isArray(params.chain) ? (params.chain as Array<Record<string, unknown>>) : [];
      const modes =
        Number(Boolean(params.agent && params.task)) + Number(tasksArr.length > 0) + Number(chainArr.length > 0);
      if (modes !== 1) {
        return textResult(`Provide exactly one mode. Available agents:\n${formatAgentList(agents)}`, makeDetails("single", []));
      }

      const commonPaths = {
        allowedPaths: asStrArr(params.allowed_paths),
        forbiddenPaths: asStrArr(params.forbidden_paths),
      };

      if (params.agent && params.task) {
        const result = await rt.engine.single(params.agent as string, params.task as string, {
          cwd: str(params.cwd),
          model: str(params.model),
          thinking: asThinking(params.thinking),
          tools: parseToolList(str(params.tools)),
          ...commonPaths,
          parentToolCallId: toolCallId,
          source: "delegate_agent",
        });
        return isFailed(result)
          ? textResult(`Agent failed or incomplete:\n\n${formatChildResultText(result)}`, makeDetails("single", [result]))
          : textResult(result.output || "(no output)", makeDetails("single", [result]));
      }

      if (tasksArr.length > 0) {
        if (tasksArr.length > 8) {
          return textResult("Too many parallel tasks. Max is 8.", makeDetails("parallel", []));
        }
        const inputs = tasksArr.map((task) => ({
          agent: String(task.agent),
          task: String(task.task),
          cwd: str(task.cwd),
          model: str(params.model),
          tools: parseToolList(str(params.tools)),
          ...commonPaths,
        }));
        const details = await rt.engine.parallel(inputs, { concurrency: 4, parentToolCallId: toolCallId, source: "delegate_agent" });
        const successCount = details.results.filter((result) => !isFailed(result)).length;
        const summaries = details.results.map((result) => `### ${result.agent} — ${isFailed(result) ? "FAILED/INCOMPLETE" : "OK"}\n\n${capOutput(formatChildResultText(result))}`);
        onUpdate?.({ content: [{ type: "text", text: `Parallel delegation running…` }], details: details as unknown as Record<string, unknown> });
        return textResult(`Parallel delegation: ${successCount}/${details.results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`, details as unknown as Record<string, unknown>);
      }

      if (chainArr.length > 0) {
        const steps = chainArr.map((step) => ({
          agent: String(step.agent),
          task: String(step.task),
          cwd: str(step.cwd),
          model: str(params.model),
          tools: parseToolList(str(params.tools)),
          ...commonPaths,
        }));
        const details = await rt.engine.chain(steps, { parentToolCallId: toolCallId, source: "delegate_agent" });
        const results = details.results;
        for (const [index, result] of results.entries()) {
          if (isFailed(result)) {
            return textResult(`Chain stopped at step ${index + 1} (${result.agent}):\n\n${formatChildResultText(result)}`, details as unknown as Record<string, unknown>);
          }
        }
        return textResult(results.at(-1)?.output || "(no output)", details as unknown as Record<string, unknown>);
      }

      return textResult("Invalid delegation parameters.", makeDetails("single", []));
    },
  });
}

/** 3) delegate_task — structured single task (canonical + safe aliases). */
export function registerDelegateTask(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: [
      "Strict single-task delegation API for specialist agents.",
      "Requires the six-part contract fields as structured parameters, validates tools/cwd/paths, logs a ledger entry, and gates child output.",
      "run_in_background starts active-session background execution and returns a run id; get_delegation_run/await_delegation_run inspect it without starting an always-on daemon.",
    ].join(" "),
    promptSnippet: "Delegate one atomic task with a mandatory six-part ZOB contract",
    promptGuidelines: [
      "If agent/output_contract routing is uncertain, call zob_delegation_catalog before the first delegation.",
      "Use delegate_task when you need strict preflight rather than a freeform delegated prompt.",
      "Normally omit output_contract; the engine infers it from the selected agent. Do not invent output contract ids.",
      "Use canonical JSON keys expected_outcome, must_do, must_not_do, context, original_user_ask, allowed_paths, forbidden_paths; safe aliases are accepted only when non-conflicting.",
      "Accepted aliases: expectedOutcome, mustDo, mustNotDo/must_not/mustNot, originalUserAsk, allowedPaths, forbiddenPaths, requiredTools, outputContract, runInBackground, childGoal, loadSkills.",
      "Always set expected_outcome, must_do, must_not_do, context, repo-relative-only allowed_paths, and deny-only forbidden_paths when known.",
    ],
    parameters: DELEGATE_TASK_PARAMS,
    async execute(toolCallId, raw, signal, onUpdate, ctx) {
      const rt = ensureRuntime(ctx);
      const normalized = normalizeDelegateTaskParams(raw as Record<string, unknown>);
      const params = normalized.params;
      if (normalized.errors.length > 0) {
        const failed: ChildResult = {
          agent: params.agent,
          task: params.task,
          exitCode: 1,
          output: `delegate_task preflight failed:\n- ${normalized.errors.join("\n- ")}`,
          stderr: "",
          gatePassed: false,
          gateErrors: normalized.errors,
          failureKind: "preflight",
          usage: usageEmpty(),
        };
        return textResult(formatChildResultText(failed), { mode: "single", results: [failed], agents: agentsOf(ctx, params.scope) });
      }

      const scope: AgentScope = params.scope === "user" || params.scope === "both" ? params.scope : "project";
      const agents = discoverAgents(ctx.cwd, scope);
      const structuredTask = buildStructuredTask(params);
      const background = params.run_in_background === true;

      const result = await rt.engine.single(params.agent, structuredTask, {
        cwd: params.cwd,
        model: params.model,
        thinking: params.thinking,
        tools: params.required_tools,
        allowedPaths: params.allowed_paths,
        forbiddenPaths: params.forbidden_paths,
        outputContract: params.output_contract,
        background,
        parentToolCallId: toolCallId,
        source: "delegate_task",
      });

      if (background) {
        const runId = result.ledgerRunId ?? "";
        return textResult(`delegate_task background started: ${runId}`, {
          mode: "single",
          background: true,
          runId,
          status: "running",
          results: [],
          agents: agents.map((agent) => agent.name),
        });
      }

      return isFailed(result)
        ? textResult(`Task failed or incomplete:\n\n${formatChildResultText(result)}`, { mode: "single", results: [result], agents: agents.map((agent) => agent.name) })
        : textResult(result.output || "(no output)", { mode: "single", results: [result], agents: agents.map((agent) => agent.name) });
    },
  });
}

/** 4) get_delegation_run — inspect a background / monitor run (body-free). */
export function registerGetDelegationRun(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerTool({
    name: "get_delegation_run",
    label: "Get Delegation Run",
    description: "Inspect an active-session delegation run, including background delegate_task runs. Metadata only; no daemon polling.",
    promptSnippet: "Inspect a background delegation run before deciding next TODO action.",
    parameters: DELEGATION_RUN_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = ensureRuntime(ctx);
      const runId = String(params.run_id);
      const run = rt.engine.monitor.runs.find((candidate) => candidate.id === runId);
      const background = rt.background.getDelegationRun(runId);
      const status = run?.status ?? background?.status ?? "not_found";
      // C4: verify the hash-only attestation sidecar when one exists
      // (non-blocking; an absent/unreadable sidecar adds NO attestation field
      // at all — clean fallback). Mismatches are reported, never fatal.
      const attestation = run?.attestationRef
        ? verifyAttestationSidecar(run.attestationRef, { outputHash: run.outputHash, sessionFile: run.sessionPath })
        : undefined;
      return textResult(`get_delegation_run ${runId}: ${status}`, {
        schema: "zob.delegation-run-status.v1",
        runId,
        status,
        run,
        background,
        ...(attestation ? { attestation } : {}),
        result: background && status !== "not_found" ? background : undefined,
      });
    },
  });
}

/** 5) await_delegation_run — bounded passive wait on a background run. */
export function registerAwaitDelegationRun(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerTool({
    name: "await_delegation_run",
    label: "Await Delegation Run",
    description:
      "Bounded passive wait for an active-session background delegate_task run. brief keeps the short cap; long_idle allows a longer bounded idle. Does not start a daemon, continuous loop, or wakeup.",
    promptSnippet: "Idle briefly or with long_idle while waiting for a background child when no other TODO is actionable.",
    parameters: AWAIT_DELEGATION_RUN_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = ensureRuntime(ctx);
      const runId = String(params.run_id);
      const waitMode = params.wait_mode === "long_idle" ? "long_idle" : "brief";
      const maxTimeoutMs = waitMode === "long_idle" ? 300_000 : 30_000;
      const requested = Math.floor(Number(params.timeout_ms) || 5_000);
      const timeoutMs = Math.max(25, Math.min(maxTimeoutMs, Number.isFinite(requested) ? requested : 5_000));
      const includeResult = params.include_result !== false;
      const existingRun = rt.engine.monitor.runs.find((candidate) => candidate.id === runId);
      const awaitMeta = { waitMode, timeoutMs, maxTimeoutMs };

      if (!rt.background.getDelegationRun(runId)) {
        const status = existingRun?.status ?? "not_found";
        return textResult(`await_delegation_run ${runId}: ${status}`, {
          schema: "zob.delegation-await.v1",
          runId,
          status,
          timedOut: false,
          ...awaitMeta,
          run: existingRun,
        });
      }

      const state = await rt.background.awaitDelegationRun(runId, timeoutMs);
      const timedOut = state.status === "failed" && /timed out/i.test(state.errorMessage ?? "");
      const status = timedOut ? "running" : state.status;
      const resultPayload = includeResult
        ? { result: state }
        : { resultSummary: compactBackgroundState(state), resultIncluded: false };
      return textResult(`await_delegation_run ${timedOut ? "timeout" : status}: ${runId}`, {
        schema: "zob.delegation-await.v1",
        runId,
        status,
        timedOut,
        ...awaitMeta,
        ...resultPayload,
        run: existingRun,
      });
    },
  });
}

/** 6) continue_run — resume a terminal run with its original session + byte-offset. */
export function registerContinueRun(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  pi.registerTool({
    name: "continue_run",
    label: "Continue Run",
    description: [
      "Resume a TERMINAL delegation run (complete/failed/aborted) with its original session file and byte-offset.",
      "Reuses the same sessionPath, links continuedFromRunId, and increments turnCount. Refuses non-terminal runs.",
    ].join(" "),
    promptSnippet: "Resume a completed/failed/aborted delegation run with its original session context",
    promptGuidelines: [
      "Use continue_run to pick up a terminal run where it left off, reusing its original session file so already-known context is not re-fed.",
      "The run_id must reference a terminal run (complete/failed/aborted); non-terminal runs are refused.",
      "Provide a focused continuation task that references the original run's context.",
    ],
    parameters: CONTINUE_RUN_PARAMS,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = ensureRuntime(ctx);
      const runId = String(params.run_id);
      const task = String(params.task);
      return rt.engine
        .continueRun(runId, task, {
          parentToolCallId: toolCallId,
          source: "delegate_agent",
          cwd: str(params.cwd),
          model: str(params.model),
          thinking: asThinking(params.thinking),
          tools: parseToolList(str(params.tools)),
          allowedPaths: asStrArr(params.allowed_paths),
          forbiddenPaths: asStrArr(params.forbidden_paths),
        })
        .then((result) =>
          isFailed(result)
            ? textResult(`Continue failed or incomplete:\n\n${formatChildResultText(result)}`, { mode: "single", results: [result], agents: [result.agent] })
            : textResult(result.output || "(no output)", { mode: "single", results: [result], agents: [result.agent] }),
        )
        .catch((error: unknown) =>
          textResult(`continue_run error: ${error instanceof Error ? error.message : String(error)}`, { mode: "single", results: [], agents: [] }),
        );
    },
  });
}

/** Register all 6 delegation tools on the Pi API. */
export function registerTools(pi: ExtensionAPI, ensureRuntime: EnsureRuntime): void {
  registerDelegationCatalog(pi, ensureRuntime);
  registerDelegateAgent(pi, ensureRuntime);
  registerDelegateTask(pi, ensureRuntime);
  registerGetDelegationRun(pi, ensureRuntime);
  registerAwaitDelegationRun(pi, ensureRuntime);
  registerContinueRun(pi, ensureRuntime);
}

// ---------------------------------------------------------- helpers

function usageEmpty(): ChildResult["usage"] {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

function agentsOf(ctx: SessionContext, scope: AgentScope | undefined): string[] {
  return discoverAgents(ctx.cwd, scope === "user" || scope === "both" ? scope : "project").map((agent) => agent.name);
}

function compactBackgroundState(state: BackgroundRunState): Record<string, unknown> {
  return {
    runId: state.runId,
    agent: state.agent,
    mode: state.mode,
    status: state.status,
    taskHash: state.taskHash,
    outputHash: state.outputHash,
    exitCode: state.exitCode,
    errorMessage: state.errorMessage,
  };
}

// --- delegate_task normalization (canonical + safe aliases, conflict-aware) ---

export interface NormalizedDelegateTaskParams {
  agent: string;
  task: string;
  context: string;
  expected_outcome?: string;
  required_tools?: string[];
  must_do?: string[];
  must_not_do?: string[];
  original_user_ask?: string;
  allowed_paths?: string[];
  forbidden_paths?: string[];
  output_contract?: string;
  run_in_background?: boolean;
  child_goal?: unknown;
  cwd?: string;
  scope?: AgentScope;
  model?: string;
  thinking?: ChildThinkingLevel;
  load_skills?: string[];
}

export interface DelegateTaskNormalizedResult {
  params: NormalizedDelegateTaskParams;
  errors: string[];
}

/** Merge canonical + safe aliases; block non-equal conflicts before launch. */
export function normalizeDelegateTaskParams(raw: Record<string, unknown>): DelegateTaskNormalizedResult {
  const errors: string[] = [];
  const agent = str(raw.agent) ?? "";
  const task = str(raw.task) ?? "";
  const context = str(raw.context) ?? "";

  const pick = (canonical: string, aliases: string[]): { value?: unknown } => {
    const canon = raw[canonical];
    const aliasValues = aliases.map((key) => raw[key]).filter((v) => v !== undefined && v !== null);
    if (canon !== undefined && canon !== null) {
      if (aliasValues.length > 0 && aliasValues.some((v) => JSON.stringify(v) !== JSON.stringify(canon))) {
        errors.push(`Conflicting values for ${canonical} and safe alias(es): ${aliases.join(", ")}`);
      }
      return { value: canon };
    }
    return { value: aliasValues.length > 0 ? aliasValues[0] : undefined };
  };

  const expectedOutcome = pick("expected_outcome", ["expectedOutcome"]).value;
  const requiredTools = pick("required_tools", ["requiredTools"]).value;
  const mustDo = pick("must_do", ["mustDo"]).value;
  const mustNotDo = pick("must_not_do", ["mustNotDo", "must_not", "mustNot"]).value;
  const originalUserAsk = pick("original_user_ask", ["originalUserAsk"]).value;
  const allowedPaths = pick("allowed_paths", ["allowedPaths"]).value;
  const forbiddenPaths = pick("forbidden_paths", ["forbiddenPaths"]).value;
  const outputContract = pick("output_contract", ["outputContract"]).value;
  const runInBackground = pick("run_in_background", ["runInBackground"]).value;
  const childGoal = pick("child_goal", ["childGoal"]).value;
  const loadSkills = pick("load_skills", ["loadSkills"]).value;

  if (!agent) errors.push("agent is required");
  if (!task) errors.push("task is required");
  if (!context) errors.push("context is required");
  if (str(expectedOutcome as string) === undefined) errors.push("expected_outcome is required (or the safe alias expectedOutcome)");
  if (!Array.isArray(mustDo) || mustDo.length === 0) errors.push("must_do is required (or the safe alias mustDo)");
  if (!Array.isArray(mustNotDo) || mustNotDo.length === 0) errors.push("must_not_do is required (or the safe aliases mustNotDo/must_not/mustNot)");
  if (Array.isArray(loadSkills) && loadSkills.length > 0) errors.push("load_skills is reserved for a future explicit skill-loading gate; use [] for P0");

  const params: NormalizedDelegateTaskParams = {
    agent,
    task,
    context,
    expected_outcome: str(expectedOutcome as string),
    required_tools: asStrArr(requiredTools),
    must_do: asStrArr(mustDo),
    must_not_do: asStrArr(mustNotDo),
    original_user_ask: str(originalUserAsk as string),
    allowed_paths: asStrArr(allowedPaths),
    forbidden_paths: asStrArr(forbiddenPaths),
    output_contract: str(outputContract as string),
    run_in_background: runInBackground === true,
    child_goal: childGoal,
    cwd: str(raw.cwd),
    scope: raw.scope === "user" || raw.scope === "both" ? raw.scope : "project",
    model: str(raw.model),
    thinking: asThinking(raw.thinking),
    load_skills: asStrArr(loadSkills),
  };
  return { params, errors };
}

/** Build the six-part structured task text from normalized delegate_task params. */
export function buildStructuredTask(params: NormalizedDelegateTaskParams): string {
  const parts: string[] = [];
  parts.push(`ORIGINAL_USER_ASK: ${params.original_user_ask ?? "Not set"}`);
  if (params.output_contract) parts.push(`OUTPUT_CONTRACT: ${params.output_contract}`);
  if (params.allowed_paths?.length) parts.push(`ALLOWED_PATHS: ${params.allowed_paths.join(", ")}`);
  if (params.forbidden_paths?.length) parts.push(`FORBIDDEN_PATHS: ${params.forbidden_paths.join(", ")}`);
  parts.push("");
  parts.push(`1. TASK: ${params.task}`);
  parts.push(`2. EXPECTED OUTCOME: ${params.expected_outcome ?? ""}`);
  parts.push(`3. REQUIRED TOOLS: ${params.required_tools?.join(", ") || "agent default"}`);
  parts.push(`4. MUST DO:\n${(params.must_do ?? []).map((item) => `   - ${item}`).join("\n")}`);
  parts.push(`5. MUST NOT DO:\n${(params.must_not_do ?? []).map((item) => `   - ${item}`).join("\n")}`);
  parts.push(`6. CONTEXT: ${params.context}`);
  return parts.filter(Boolean).join("\n");
}
