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
import { PROVIDER_QUOTA_MESSAGE } from "../core/formatting.js";
import { DispatchEngine } from "../engine/dispatch.js";
import type { ChildProgressEvent } from "../engine/index.js";
import { verifyAttestationSidecar } from "../engine/attestation.js";
import { BackgroundRunRegistry, type BackgroundRunState } from "../engine/background.js";
import { listDelegationRuns } from "../engine/monitor.js";
import { listOutputContracts, parseToolList } from "../gates/index.js";
import { discoverAgents, formatAgentList, type AgentCatalog } from "../registry/index.js";
import type { EnabledModelsReader, ModelByClassMap, VerifiedModelCatalog } from "../models/index.js";
import { parentInheritingClassModels } from "../models/index.js";
import type { SpawnFn } from "../lanes/index.js";
import type { ExtensionAPI, SessionContext, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";
import { createPiSettingsEnabledModelsReader, readPiDefaultModel } from "./settings-reader.js";
import { createModelCatalogReader } from "./model-catalog-reader.js";
import {
  AWAIT_DELEGATION_RUN_PARAMS,
  CONTINUE_RUN_PARAMS,
  DELEGATE_PARAMS,
  DELEGATE_TASK_PARAMS,
  DELEGATION_RUN_PARAMS,
} from "./schemas.js";

/** Shared per-session runtime: the engine plus its background run registry. */
export interface SubagentsRuntime {
  engine: DispatchEngine;
  background: BackgroundRunRegistry;
  repoRoot: string;
  startedAt: number;
  /** F3: parent/session model the engine inherits from (undefined = none). */
  parentModel?: string;
}

export type EnsureRuntime = (ctx: SessionContext) => SubagentsRuntime;
export type GetRuntime = () => SubagentsRuntime | null;

/**
 * F3/P1 session-model reference: a `"provider/model"` (or bare id) STRING,
 * or — pi >= 0.84 — the live Model OBJECT `{ provider, id }` the host exposes
 * on `ctx.model`. Normalized to a plain `"provider/id"` string via
 * normalizeParentModelInput BEFORE any string use (an object reaching
 * `.trim()` was the P1 TypeError regression).
 */
export type SessionModelRef = string | { provider: string; id: string };

/** Options for {@link createSubagentsRuntime} (everything injectable for tests). */
export interface CreateSubagentsRuntimeOptions {
  spawn?: SpawnFn;
  onLedger?: (entry: Record<string, unknown>) => void;
  enabledModelsReader?: EnabledModelsReader;
  /**
   * F3 parent-model inheritance: explicit parent/session model (string or
   * `{provider,id}` object — pi >= 0.84 `ctx.model`), wins over
   * `parentModelReader`. Normalized before use; see SessionModelRef.
   */
  parentModel?: SessionModelRef;
  /**
   * F3 injectable parent-model source; wins over the pi settings
   * `defaultModel` fallback (project `.pi/settings.json` over the global
   * `~/.pi/agent/settings.json`). Should never throw; a throwing reader is
   * caught and degrades to the settings fallback.
   */
  parentModelReader?: () => string | undefined;
  /**
   * F3 default class models. Default: every class (cheap/balanced/capable)
   * maps to the resolved parent model — quota-safe, the parent model is the
   * one model guaranteed available for this session. An explicit map REPLACES
   * the default entirely (unmapped classes fall back to the parent model).
   */
  classModels?: ModelByClassMap;
  /**
   * F2 verified-catalog source evaluated at every preflight. Default: read
   * `<repoRoot>/.pi/model-catalog.json` (schema zob.model-catalog.v1).
   */
  verifiedCatalogReader?: () => VerifiedModelCatalog;
  /**
   * F6: persist the hash-only delegation ledger + attestation sidecars under
   * `<repoRoot>/.pi/logs/runs` (default TRUE — real sessions leave an
   * observable trail). Explicit `false` disables persistence.
   */
  persistLedger?: boolean;
}

/**
 * P1: normalize a parent/session model value BEFORE any string use.
 * `typeof m === 'string'` → trimmed passthrough; a `{ provider, id }` object
 * (pi >= 0.84 `ctx.model`, cf. pi types.d.ts Model<any>) → `provider/id`;
 * anything else (empty string, object without both fields, undefined) →
 * undefined (fallback to the settings defaultModel). NEVER throws — this is
 * the mirror of the zob-harness child-runner child-model normalization.
 */
export function normalizeParentModelInput(value: SessionModelRef | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (value && typeof value === "object" && typeof value.provider === "string" && typeof value.id === "string") {
    const provider = value.provider.trim();
    const id = value.id.trim();
    return provider && id ? `${provider}/${id}` : undefined;
  }
  return undefined;
}

/** Resolve the F3 parent model: explicit (string|object) > injectable reader > settings defaultModel. */
export function resolveParentModel(repoRoot: string, opts: CreateSubagentsRuntimeOptions): string | undefined {
  const explicit = normalizeParentModelInput(opts.parentModel);
  if (explicit) return explicit;
  let fromReader: string | undefined;
  try {
    fromReader = opts.parentModelReader?.();
  } catch {
    fromReader = undefined; // a broken reader degrades to the settings fallback
  }
  return fromReader ?? readPiDefaultModel(repoRoot);
}

/** Build a runtime bound to a repo root. `spawn` injectable for tests. */
export function createSubagentsRuntime(repoRoot: string, opts: CreateSubagentsRuntimeOptions = {}): SubagentsRuntime {
  const background = new BackgroundRunRegistry();
  // F3: parent-model inheritance + quota-safe default class models. Without a
  // parent model children keep the previous behavior (no --model flag, host
  // default) — inheritance is strictly additive.
  const parentModel = resolveParentModel(repoRoot, opts);
  const engine = new DispatchEngine({
    repoRoot,
    backgroundRegistry: background,
    source: "delegate_agent",
    // F8 convention: unified session dir `.pi/agent-sessions` — same as the
    // LanePool default, the CLI doctor, and the README.
    sessionDir: join(repoRoot, ".pi", "agent-sessions"),
    spawn: opts.spawn,
    onLedger: opts.onLedger,
    // C3 model scope: pi settings reader (project .pi/settings.json over the
    // global ~/.pi/agent/settings.json); undefined allowlist skips the check.
    enabledModelsReader: opts.enabledModelsReader ?? createPiSettingsEnabledModelsReader(repoRoot),
    // F3: children without an explicit/agent/class model inherit the parent.
    parentModel,
    classModels: opts.classModels ?? parentInheritingClassModels(parentModel),
    // F2: verified overrides gate reads <repoRoot>/.pi/model-catalog.json at
    // every preflight (mid-session catalog edits are honored).
    verifiedCatalogReader: opts.verifiedCatalogReader ?? createModelCatalogReader(repoRoot),
    // F6: ledger + attestation persistence ON by default so real sessions
    // write `.pi/logs/runs/<day>.jsonl` and attestations (overridable).
    persistLedger: opts.persistLedger ?? true,
  });
  return { engine, background, repoRoot, startedAt: Date.now(), parentModel };
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

// --- live child-actions feed (consumes the engine ChildProgressEvent contract) ---

export type { ChildProgressEvent };

/** Hard-bounded one-line truncation (never a multi-line leak). */
function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** Compact token count: 12340 -> "12.3k", 2100000 -> "2.1M". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * Display agent name: the engine fills `agent` with the LANE id, which for
 * fresh sessions is `<agent>-<runId>` — strip the runId suffix for a clean
 * feed line (stable lanes pass through unchanged).
 */
function displayAgent(event: ChildProgressEvent): string {
  const suffix = `-${event.runId}`;
  return event.agent.endsWith(suffix) && event.agent.length > suffix.length
    ? event.agent.slice(0, -suffix.length)
    : event.agent;
}

/** Sliding window: how many of the child's last actions a feed block shows. */
export const FEED_ACTION_WINDOW = 5;
/** Max rendered chars per action detail inside a feed block. */
const FEED_DETAIL_MAX = 60;

/**
 * Live feed header line for a completed turn (STRICTLY bounded):
 *   `▸ explore · turn 2 · zai/glm-5.3 · 12.4k tok`
 * Actions no longer render standalone — they live inside the feed block
 * below; `text` never streams (that is per-token spam).
 */
export function formatChildProgressLine(event: ChildProgressEvent): string | undefined {
  if (event.kind !== "turn") return undefined;
  const parts = [displayAgent(event), `turn ${event.turns}`];
  if (event.model) parts.push(event.model);
  if (typeof event.contextTokens === "number" && event.contextTokens > 0) {
    parts.push(`${formatTokenCount(event.contextTokens)} tok`);
  }
  return `▸ ${parts.join(" · ")}`;
}

/** Per-run feed state: latest header snapshot + sliding window of actions. */
export interface ChildFeedState {
  agent: string;
  turns: number;
  model?: string;
  contextTokens?: number;
  /** Last actions, oldest -> newest (capped at FEED_ACTION_WINDOW). */
  actions: string[];
}

/**
 * Render one SELF-CONTAINED multi-line feed block (pi `onUpdate` REPLACES
 * the previous display, it does not append — so every block must carry the
 * full context): header line, then the last actions as an aligned tree with
 * the most recent action last, closed by `└─`. Strictly bounded:
 * 1 header + at most FEED_ACTION_WINDOW action lines.
 */
export function formatChildFeedBlock(state: ChildFeedState): string {
  const parts = [state.agent, `turn ${state.turns}`];
  if (state.model) parts.push(state.model);
  if (typeof state.contextTokens === "number" && state.contextTokens > 0) {
    parts.push(`${formatTokenCount(state.contextTokens)} tok`);
  }
  const lines = [`▸ ${parts.join(" · ")}`];
  const shown = state.actions.slice(-FEED_ACTION_WINDOW);
  shown.forEach((action, index) => {
    lines.push(`  ${index === shown.length - 1 ? "└─" : "├─"} ${action}`);
  });
  return lines.join("\n");
}

/**
 * Fold one progress event into a run's feed state. Returns false when the
 * event must stay silent (kind=text — per-token spam is never streamed).
 */
function applyChildEvent(state: ChildFeedState, event: ChildProgressEvent): boolean {
  if (event.kind === "text") return false;
  state.turns = Math.max(state.turns, event.turns);
  if (event.model) state.model = event.model;
  if (typeof event.contextTokens === "number" && event.contextTokens > 0) {
    state.contextTokens = event.contextTokens;
  }
  if (event.kind === "action") {
    state.actions.push(truncateLine(event.detail, FEED_DETAIL_MAX));
    if (state.actions.length > FEED_ACTION_WINDOW) {
      state.actions.splice(0, state.actions.length - FEED_ACTION_WINDOW);
    }
  }
  return true;
}

/**
 * Build the live `onChildEvent` consumer that streams ONE self-contained
 * multi-line block per child event — header `▸ agent · turn N · model · tok`
 * plus the sliding window of the last FEED_ACTION_WINDOW actions — into the
 * parent conversation via pi `onUpdate`. One update per event, no text
 * deltas. Parallel children keep independent per-runId blocks. Returns
 * undefined when there is no onUpdate — nothing is wired, zero overhead
 * (the feed:false path stays completely silent).
 */
export function makeChildEventFeed(
  onUpdate: ((partial: ToolResult) => void) | undefined,
): ((event: ChildProgressEvent) => void) | undefined {
  if (!onUpdate) return undefined;
  const states = new Map<string, ChildFeedState>();
  return (event) => {
    let state = states.get(event.runId);
    if (!state) {
      state = { agent: displayAgent(event), turns: 0, actions: [] };
      states.set(event.runId, state);
    }
    if (!applyChildEvent(state, event)) return;
    onUpdate({ content: [{ type: "text", text: formatChildFeedBlock(state) }] });
  };
}

/** Compact text rendering of a child result (no raw bodies persisted). */
export function formatChildResultText(result: ChildResult): string {
  const lines: string[] = [`Agent: ${result.agent}`];
  // F4: surface the child's effective model when known.
  if (result.model) lines.push(`Model: ${result.model}`);
  // F5: honest exit code — "n/a" when NO child ever ran (preflight/config
  // blocks carry a synthetic exit 0) or when a gate failed on empty output
  // (exit 0 there means "nothing was produced", not success); the real exit
  // code is shown only when a child actually ran.
  if (result.failureKind === "preflight" || result.failureKind === "config") {
    lines.push("Exit code: n/a (preflight)");
  } else if (result.gatePassed === false && result.exitCode === 0 && !result.output.trim()) {
    lines.push("Exit code: n/a (gate failure)");
  } else {
    lines.push(`Exit code: ${result.exitCode}`);
  }
  // P5: compact usage totals so a SUCCESSFUL delegate_task reports cost like
  // the failure paths do (bounded one line; an all-zero usage stays silent).
  const usage = result.usage;
  if (usage && (usage.turns > 0 || usage.input > 0 || usage.output > 0)) {
    const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`, `in ${formatTokenCount(usage.input)}`, `out ${formatTokenCount(usage.output)}`];
    if (usage.cost > 0) parts.push(`cost $${usage.cost.toFixed(4)}`);
    lines.push(`Usage: ${parts.join(" · ")}`);
  }
  if (result.output) lines.push(`Output:\n${result.output}`);
  if (result.stderr) lines.push(`Stderr:\n${result.stderr}`);
  if (result.gatePassed === false) {
    lines.push(`Gate: FAILED${result.gateErrors?.length ? `\n- ${result.gateErrors.join("\n- ")}` : ""}`);
  }
  // Live-actions summary: the LAST few child actions when the engine recorded
  // them on the result (`result.actions`) — bounded to 5 items, one line,
  // 80 chars each (defensive: strings or {detail|action|name} objects).
  const recordedActions = result.actions;
  if (Array.isArray(recordedActions) && recordedActions.length > 0) {
    const shown = recordedActions.slice(-5).map((action) => {
      if (typeof action === "string") return truncateLine(action, 80);
      if (action && typeof action === "object") {
        const record = action as Record<string, unknown>;
        const value = record.detail ?? record.action ?? record.name ?? record.tool;
        if (typeof value === "string") return truncateLine(value, 80);
      }
      return truncateLine(JSON.stringify(action), 80);
    });
    lines.push(`Actions (${recordedActions.length}): ${shown.join(" · ")}`);
  }
  if (result.failureKind) lines.push(`Failure kind: ${result.failureKind}`);
  // F4: pair the quota kind with its actionable remediation message.
  if (result.failureKind === "provider_quota") lines.push(PROVIDER_QUOTA_MESSAGE);
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
      `- ${entry.id} [${entry.source}] tools=${entry.tools?.join(",") ?? "default"}${entry.model ? ` model=${entry.model}` : ""}${entry.modelClass ? ` model_class=${entry.modelClass}` : ""}: ${entry.description}`,
    );
  }
  lines.push("");
  lines.push(`Valid output contracts: ${listOutputContracts().join(", ")}`);
  return lines.join("\n");
}

// --------------------------------------------------------------- tools

/** 1) delegate_agent — single / parallel / chain. */
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
      "Choose the agent by desired deliverable: standard agents are explore (read-only facts), planner (plans), implementer (bounded edits), oracle (skeptical review), qa (verification), vision (image analysis). More cards live in <cwd>/.pi/agents and ~/.pi/agents — read those folders to discover them; a project card overrides a user card with the same name.",
      "Use delegate_agent for broad discovery, external research, skeptical review, or independent QA before making risky edits.",
      "Give each child a bounded six-part contract and a concrete final output shape.",
      "Optional cwd selects the child working directory; it does not replace allowed_paths or write-scope grants.",
      "If effective tools include edit/write, provide non-empty repo-relative-only allowed_paths.",
    ],
    parameters: DELEGATE_PARAMS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rt = ensureRuntime(ctx);
      const scope: AgentScope = params.scope === "project" || params.scope === "user" ? params.scope : "both";
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
        // Live child-actions feed: one bounded line per engine child event
        // streamed into the parent conversation (disable with feed: false).
        const result = await rt.engine.single(params.agent as string, params.task as string, {
          cwd: str(params.cwd),
          model: str(params.model),
          thinking: asThinking(params.thinking),
          tools: parseToolList(str(params.tools)),
          ...commonPaths,
          parentToolCallId: toolCallId,
          source: "delegate_agent",
          // ESC escape hatch: aborting the parent tool call kills the child
          // (SIGTERM → killGrace → SIGKILL) instead of leaving it running.
          signal,
          onChildEvent: makeChildEventFeed(params.feed === false ? undefined : onUpdate),
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
        // Live feed: the "running" line goes to the parent BEFORE the await
        // (the old call sat after the await — dead, the tool had already
        // resolved); child events stream through the same onUpdate.
        if (params.feed !== false) {
          onUpdate?.({ content: [{ type: "text", text: `Parallel delegation running…` }] });
        }
        const details = await rt.engine.parallel(inputs, {
          concurrency: 4,
          parentToolCallId: toolCallId,
          source: "delegate_agent",
          signal,
          onChildEvent: makeChildEventFeed(params.feed === false ? undefined : onUpdate),
        });
        const successCount = details.results.filter((result) => !isFailed(result)).length;
        const summaries = details.results.map((result) => `### ${result.agent} — ${isFailed(result) ? "FAILED/INCOMPLETE" : "OK"}\n\n${capOutput(formatChildResultText(result))}`);
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
        const details = await rt.engine.chain(steps, {
          parentToolCallId: toolCallId,
          source: "delegate_agent",
          signal,
          onChildEvent: makeChildEventFeed(params.feed === false ? undefined : onUpdate),
        });
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

      const scope: AgentScope = params.scope === "project" || params.scope === "user" ? params.scope : "both";
      const agents = discoverAgents(ctx.cwd, scope);
      const structuredTask = buildStructuredTask(params);
      const background = params.run_in_background === true;

      // Live feed only for foreground runs — a background task resolves the
      // tool immediately, so there is no live onUpdate to stream into.
      const result = await rt.engine.single(params.agent, structuredTask, {
        cwd: params.cwd,
        model: params.model,
        thinking: params.thinking,
        tools: params.required_tools,
        allowedPaths: params.allowed_paths,
        forbiddenPaths: params.forbidden_paths,
        outputContract: params.output_contract,
        fresh: params.fresh,
        // C6 exposure: worktree isolation (engine-side; "none" = default).
        isolation: params.isolation === "worktree" ? "worktree" : undefined,
        background,
        parentToolCallId: toolCallId,
        source: "delegate_task",
        // ESC escape hatch: aborting the parent tool call kills the child.
        signal: background ? undefined : signal,
        onChildEvent: background || params.feed === false ? undefined : makeChildEventFeed(onUpdate),
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
        : textResult(formatChildResultText(result), { mode: "single", results: [result], agents: agents.map((agent) => agent.name) });
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
      // One terse reason line for non-clean terminal states: first gate error
      // (truncated), else the error message, else a ledger pointer.
      const reasonSource = run?.gateErrors?.[0] ?? run?.errorMessage ?? background?.errorMessage;
      const failedStatus = status !== "not_found" && status !== "complete" && status !== "running" && status !== "queued";
      const reason = failedStatus ? (reasonSource ? truncateLine(reasonSource, 140) : "see ledger") : undefined;
      const text = `get_delegation_run ${runId}: ${status}${reason ? `\nReason: ${reason}` : ""}`;
      return textResult(text, {
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
      "The task parameter MUST be a COMPLETE six-part delegation contract — the same preflight contract gate as delegate_agent/delegate_task applies, with the numbered parts in order: 1. TASK: 2. EXPECTED OUTCOME: 3. REQUIRED TOOLS: 4. MUST DO: 5. MUST NOT DO: 6. CONTEXT:. A plain 'continue with ...' sentence is REJECTED by preflight.",
    ].join(" "),
    promptSnippet: "Resume a completed/failed/aborted delegation run with its original session context",
    promptGuidelines: [
      "Use continue_run to pick up a terminal run where it left off, reusing its original session file so already-known context is not re-fed.",
      "The run_id must reference a terminal run (complete/failed/aborted); non-terminal runs are refused.",
      "The task must be the FULL six-part contract that references the original run's context — for example: '1. TASK: finish the fix started in run <run_id>\n2. EXPECTED OUTCOME: tests green with evidence\n3. REQUIRED TOOLS: read, bash\n4. MUST DO:\n   - restate the goal.\n   - verify before done.\n5. MUST NOT DO:\n   - no commits.\n6. CONTEXT: run <run_id> left the fix half-done; see its ledger entry.' A short prose continuation is rejected by the contract gate.",
    ],
    parameters: CONTINUE_RUN_PARAMS,
    async execute(toolCallId, params, _signal, onUpdate, ctx) {
      const rt = ensureRuntime(ctx);
      const runId = String(params.run_id);
      const task = String(params.task);
      const continueOpts: Parameters<DispatchEngine["continueRun"]>[2] = {
        parentToolCallId: toolCallId,
        source: "delegate_agent",
        cwd: str(params.cwd),
        model: str(params.model),
        thinking: asThinking(params.thinking),
        tools: parseToolList(str(params.tools)),
        allowedPaths: asStrArr(params.allowed_paths),
        forbiddenPaths: asStrArr(params.forbidden_paths),
        onChildEvent: makeChildEventFeed(onUpdate),
      };
      return rt.engine
        .continueRun(runId, task, continueOpts)
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
  return discoverAgents(ctx.cwd, scope === "project" || scope === "user" ? scope : "both").map((agent) => agent.name);
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
  /** F8: fresh per-run session (default true); false = legacy stable lane. */
  fresh?: boolean;
  child_goal?: unknown;
  cwd?: string;
  scope?: AgentScope;
  model?: string;
  thinking?: ChildThinkingLevel;
  load_skills?: string[];
  /** Live child-actions feed switch (default true). */
  feed?: boolean;
  /** C6 child filesystem isolation ("worktree"; default none). */
  isolation?: "none" | "worktree";
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
    fresh: typeof raw.fresh === "boolean" ? raw.fresh : undefined,
    child_goal: childGoal,
    cwd: str(raw.cwd),
    scope: raw.scope === "project" || raw.scope === "user" ? raw.scope : "both",
    model: str(raw.model),
    thinking: asThinking(raw.thinking),
    load_skills: asStrArr(loadSkills),
    feed: typeof raw.feed === "boolean" ? raw.feed : undefined,
    isolation: raw.isolation === "worktree" || raw.isolation === "none" ? raw.isolation : undefined,
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
