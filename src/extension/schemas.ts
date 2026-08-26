/**
 * src/extension/schemas.ts — plain JSON Schema parameter objects for the 5
 * Pi tools. Ported (adapted) from the ZOB harness `schemas.ts`; declared here
 * as zero-dependency JSON Schema (no typebox, no @earendil-works/pi-ai).
 * Shapes match the harness so the tools are Pi-compatible.
 */

import type { JsonSchema } from "./pi-types.js";

/** Shared leaf: agent catalog scope. */
const AGENT_SCOPE_SCHEMA: JsonSchema = {
  type: "string",
  enum: ["project", "user", "both"],
  description: "Which agent catalog to use. Default: project.",
  default: "project",
};

/** Shared leaf: child reasoning effort override. */
const THINKING_LEVEL_SCHEMA: JsonSchema = {
  type: "string",
  enum: ["low", "medium", "high", "xhigh"],
  description: "Optional explicit child reasoning effort override.",
};

/** Child goal guidance (parent-owned delegation context). */
const CHILD_GOAL_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", description: "Enable parent-owned child goal guidance. Default true when child_goal is provided." },
    objective: { type: "string", description: "Child goal objective to pursue inside the delegated task." },
    todo_id: { type: "string", description: "Exact canonical active-goal TODO node ID." },
    parent_todo_id: { type: "string", description: "Exact canonical parent TODO node ID." },
    todo_path: { type: "string", description: "Exact visible dotted TODO path, e.g. 1.2." },
    delegation_depth: { type: "integer", minimum: 0, description: "Parent-owned delegation depth for TODO-linked child work." },
    request_id: { type: "string", description: "Adaptive delegation request id." },
    oracle_required: { type: "boolean", description: "Whether parent/oracle review is required before accepting the child goal." },
    max_turns: { type: "integer", minimum: 1, description: "Advisory maximum child continuation turns." },
    max_tokens: { type: "integer", minimum: 1, description: "Advisory maximum child tokens." },
    completion_policy: { type: "string", enum: ["return_claim", "oracle_before_complete"], description: "How the child should exit." },
  },
  additionalProperties: false,
};

/** Per-item task input used by delegate_agent tasks[] / chain[]. */
export const TASK_ITEM: JsonSchema = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Specialist agent name" },
    task: { type: "string", description: "Required exact six-part contract with literal TASK, EXPECTED OUTCOME, REQUIRED TOOLS, MUST DO, MUST NOT DO, and CONTEXT sections." },
    cwd: { type: "string", description: "Override cwd for this child Pi process" },
    thinking: THINKING_LEVEL_SCHEMA,
    child_goal: CHILD_GOAL_PARAMS,
  },
  required: ["agent", "task"],
  additionalProperties: false,
};

const ALLOWED_PATHS_DESC =
  "Repo-relative-only paths delegated children may inspect/change. Absolute, home, traversal, broad-root, and NUL paths are rejected; use repo-local reports/... snapshot/context_ref artifacts for external context. Required when effective tools include edit/write.";
const FORBIDDEN_PATHS_DESC =
  "Deny-only path patterns delegated children must not touch. May be repo-local, absolute, or home-relative; broad roots are rejected.";

/** 1) delegate_agent. */
export const DELEGATE_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Agent name for single-agent mode" },
    task: { type: "string", description: "Task for single-agent mode" },
    cwd: { type: "string", description: "Default cwd for delegate_agent child Pi processes. Must stay inside repo; tasks[].cwd and chain[].cwd override this value." },
    tasks: { type: "array", items: TASK_ITEM, description: "Parallel tasks. Max 8, 4 concurrent." },
    chain: { type: "array", items: TASK_ITEM, description: "Sequential chain. {previous} is replaced by prior output." },
    scope: AGENT_SCOPE_SCHEMA,
    model: { type: "string", description: "Exceptional explicit model override for all delegated children. Normally omit to use the parent/session default." },
    thinking: THINKING_LEVEL_SCHEMA,
    tools: { type: "string", description: "Override comma-separated tool allowlist for all children. Must be a subset of the selected agent tools." },
    child_goal: CHILD_GOAL_PARAMS,
    allowed_paths: { type: "array", items: { type: "string" }, description: ALLOWED_PATHS_DESC },
    forbidden_paths: { type: "array", items: { type: "string" }, description: FORBIDDEN_PATHS_DESC },
    feed: {
      type: "boolean",
      description:
        "Stream compact live child action/turn lines into the parent conversation while the delegation runs (via the engine child-event feed). Default true; set false for silent dispatch.",
      default: true,
    },
  },
  additionalProperties: false,
};

/** 2) delegate_task — canonical + safe aliases. */
export const DELEGATE_TASK_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Specialist agent name" },
    task: { type: "string", description: "Atomic task statement" },
    expected_outcome: { type: "string", description: "Canonical observable artifact, verdict, or change. Required after safe alias normalization." },
    expectedOutcome: { type: "string", description: "Safe alias for expected_outcome. Conflicts with canonical values are blocked before child launch." },
    required_tools: { type: "array", items: { type: "string" }, description: "Optional tool subset for this task. Normally omit; the harness infers the selected agent's declared tools." },
    requiredTools: { type: "array", items: { type: "string" }, description: "Safe alias for required_tools. Conflicts with canonical values are blocked before child launch." },
    must_do: { type: "array", items: { type: "string" }, description: "Canonical positive constraints. Required after safe alias normalization." },
    mustDo: { type: "array", items: { type: "string" }, description: "Safe alias for must_do. Conflicts with canonical values are blocked before child launch." },
    must_not_do: { type: "array", items: { type: "string" }, description: "Canonical hard stops. Required after safe alias normalization." },
    mustNotDo: { type: "array", items: { type: "string" }, description: "Safe alias for must_not_do. Conflicts with canonical values are blocked before child launch." },
    must_not: { type: "array", items: { type: "string" }, description: "Safe alias for must_not_do. Conflicts with canonical values are blocked before child launch." },
    mustNot: { type: "array", items: { type: "string" }, description: "Safe alias for must_not_do. Conflicts with canonical values are blocked before child launch." },
    context: { type: "string", description: "Paths, prior evidence, downstream use" },
    original_user_ask: { type: "string", description: "Original human request for scope anchoring. Required for write-enabled delegate_task calls when effective tools include edit/write." },
    originalUserAsk: { type: "string", description: "Safe alias for original_user_ask. Conflicts with canonical values are blocked before child launch." },
    allowed_paths: { type: "array", items: { type: "string" }, description: ALLOWED_PATHS_DESC },
    allowedPaths: { type: "array", items: { type: "string" }, description: "Safe alias for allowed_paths. Conflicts with canonical values are blocked before child launch." },
    forbidden_paths: { type: "array", items: { type: "string" }, description: FORBIDDEN_PATHS_DESC },
    forbiddenPaths: { type: "array", items: { type: "string" }, description: "Safe alias for forbidden_paths. Conflicts with canonical values are blocked before child launch." },
    output_contract: { type: "string", description: "Optional exact output contract id. Normally omit; the harness infers it from agent. Do not invent ids." },
    outputContract: { type: "string", description: "Safe alias for output_contract. Conflicts with canonical values are blocked before child launch." },
    child_goal: CHILD_GOAL_PARAMS,
    childGoal: CHILD_GOAL_PARAMS,
    run_in_background: { type: "boolean", description: "Run this delegate_task in active-session background when enabled by parent. Returns runId immediately; no daemon/auto-start.", default: false },
    runInBackground: { type: "boolean", description: "Safe alias for run_in_background. Conflicts with canonical values are blocked before child launch." },
    fresh: {
      type: "boolean",
      description:
        "Fresh per-run session file (<agent>-<runId>.jsonl). Default true, so successive runs never share a session. Set false to reuse the agent's stable lane session (legacy behavior). Chain (shared lane) and continue_run (reuses the original session) are unaffected.",
      default: true,
    },
    load_skills: { type: "array", items: { type: "string" }, description: "Reserved skill list. Default empty." },
    loadSkills: { type: "array", items: { type: "string" }, description: "Safe alias for load_skills; still reserved by the P0 gate when non-empty." },
    cwd: { type: "string", description: "Override cwd for this child Pi process. Must stay inside repo." },
    scope: AGENT_SCOPE_SCHEMA,
    model: { type: "string", description: "Exceptional explicit model override for this child. Normally omit to use the parent/session default." },
    thinking: THINKING_LEVEL_SCHEMA,
    isolation: {
      type: "string",
      enum: ["none", "worktree"],
      description:
        "Child filesystem isolation. none (default): the child runs in the repo working tree. worktree: the child runs in a disposable detached git worktree that is auto-cleaned after the run (requires a git repo with a commit).",
      default: "none",
    },
    feed: {
      type: "boolean",
      description:
        "Stream compact live child action/turn lines into the parent conversation while the task runs. Default true; set false for silent dispatch.",
      default: true,
    },
  },
  required: ["agent", "task", "context"],
  additionalProperties: false,
};

/** 3) get_delegation_run. */
export const DELEGATION_RUN_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", description: "Delegation run id returned by delegate_task/delegate_agent." },
  },
  required: ["run_id"],
  additionalProperties: false,
};

/** 4) await_delegation_run. */
export const AWAIT_DELEGATION_RUN_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", description: "Delegation run id returned by a background delegate_task." },
    timeout_ms: { type: "number", description: "Bounded await timeout in milliseconds. Capped by runtime; brief caps at 30s, long_idle caps at 300s." },
    wait_mode: { type: "string", enum: ["brief", "long_idle"], description: "Wait behavior. brief preserves the short bounded wait for quick checks; long_idle is a passive bounded wait.", default: "brief" },
    include_result: { type: "boolean", description: "Include the full child result on completion. Set false for compact status/hash metadata only.", default: true },
  },
  required: ["run_id"],
  additionalProperties: false,
};

/** 5) continue_run. */
export const CONTINUE_RUN_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    run_id: { type: "string", description: "Terminal delegation run id to continue (complete/failed/aborted)." },
    task: { type: "string", description: "Continuation task for the resumed run. Should reference the original run's context." },
    cwd: { type: "string", description: "Override cwd for the continued child Pi process. Must stay inside repo." },
    model: { type: "string", description: "Exceptional explicit model override for the continued child. Normally omit." },
    thinking: THINKING_LEVEL_SCHEMA,
    tools: { type: "string", description: "Override comma-separated tool allowlist for the continued child. Must be a subset of the selected agent tools." },
    allowed_paths: { type: "array", items: { type: "string" }, description: ALLOWED_PATHS_DESC },
    forbidden_paths: { type: "array", items: { type: "string" }, description: FORBIDDEN_PATHS_DESC },
  },
  required: ["run_id", "task"],
  additionalProperties: false,
};
