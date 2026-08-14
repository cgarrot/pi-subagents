/**
 * src/core/types.ts — pure core type definitions, ported from the ZOB harness
 * subagents system. Zero @earendil-works/* imports, zero fs side effects.
 */

export type ModeName = "explore" | "plan" | "implement" | "oracle" | "factory" | "orchestrator" | "vanilla";

export type AgentScope = "project" | "user" | "both";

export type ChildThinkingLevel = "low" | "medium" | "high" | "xhigh";

export interface ChildChangedPathRef {
  path: string;
  pathHash: string;
  status: string;
  contentHash?: string;
}

export type TextBlock = { type: "text"; text: string };

export type AssistantLikeMessage = {
  role?: string;
  content?: Array<TextBlock | { type: string; [key: string]: unknown }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
};

export type JsonEvent = {
  type?: string;
  message?: AssistantLikeMessage;
  messages?: AssistantLikeMessage[];
  assistantMessageEvent?: { type?: string; delta?: string };
  toolName?: string;
};

export type DelegationFailureKind = "preflight" | "config" | "output_gate" | "child_runtime" | "aborted";

export type OutputGateIssueCode =
  | "empty_output"
  | "unknown_contract"
  | "invalid_requirement_pattern"
  | "missing_final_marker"
  | "missing_requirement"
  | "deliverable_rejected"
  | "mismatched_todo_id"
  | "stale_child_goal_binding"
  | "mismatched_delegation_attempt";

export type OutputGateIssueClassification =
  | "output_missing"
  | "contract_configuration"
  | "contract_format"
  | "output_gate_semantic"
  | "deliverable_rejected";

export interface OutputGateIssue {
  code: OutputGateIssueCode;
  classification: OutputGateIssueClassification;
  failureKind: "output_gate";
  contractId: string;
  requirement?: string;
  message: string;
}

export interface DelegationPreflightDiagnostic {
  schema: string;
  code: string;
  field: string;
  retry_policy: string;
  safe_next_actions: readonly string[];
  errors: readonly { code: string; field: string; message: string; index?: number }[];
  candidates: readonly { canonicalId: string; goalId: string; path: string }[];
}

export interface ChildResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  cwd?: string;
  model?: string;
  sessionPath?: string;
  ledgerRunId?: string;
  outputContract?: string;
  contractErrors?: string[];
  gateErrors?: string[];
  gateIssues?: OutputGateIssue[];
  gatePassed?: boolean;
  preflightDiagnostics?: DelegationPreflightDiagnostic[];
  failureKind?: DelegationFailureKind;
  stopReason?: string;
  stopCondition?: ChildStopCondition;
  errorMessage?: string;
  /**
   * B5 escalation: the consumed ask_master message (exit code 42 + a
   * `<runId>.escalation.json` file read-and-deleted by the parent). In-memory
   * only — surfaced to the master caller, NEVER persisted to the ledger or
   * events (those carry `escalationHash` instead, sha-256 of this message).
   */
  escalationMessage?: string;
  childChangedPaths?: ChildChangedPathRef[];
  /**
   * Run-level usage accounting (B4, anti-double-counting).
   *
   * The child pi RE-ENCODES the whole conversation at every turn, so each
   * assistant `message_end` carries CUMULATIVE input/cache usage — summing
   * message_end events directly double-counts (benchmark pi-small-dense §1.4
   * and §3.2; archimedes execute.ts:45-57). Two distinct semantics:
   *   - CUMULATIVE run totals — `input`/`output`/`cacheRead`/`cacheWrite`/
   *     `cost` accumulate DELTAS between consecutive message_end usage
   *     snapshots (never the naive message_end sum); `turns` counts assistant
   *     message_end events;
   *   - CURRENT CONTEXT SNAPSHOT — `contextTokens` is the LAST message_end
   *     `totalTokens` (current context size, overwritten, never summed;
   *     pi9 activity.ts:111-119).
   */
  usage: {
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
  };
}

export interface DelegationDetails {
  mode: "single" | "parallel" | "chain";
  results: ChildResult[];
  agents: string[];
}

export type ChildStopCondition =
  | "none"
  | "failed_preflight"
  | "incomplete_no_assistant_turn"
  | "incomplete_no_evidence"
  | "failed_validation"
  | "timeout"
  | "blocked"
  | "scope_violation"
  | "agentic_failed"
  | "oracle_fail"
  | "no_ship"
  | "fail_loop";

export interface ChildStopConditionInput {
  status?: string;
  agent?: string;
  outputContract?: string;
  output?: string;
  assistantTurnSeen?: boolean;
  outputHash?: string;
  outputCaptured?: boolean;
  outputValidated?: boolean;
  evidenceChecked?: boolean;
  timedOut?: boolean;
  blocked?: boolean;
  scopeViolation?: boolean;
  preflightPassed?: boolean;
  agenticFailed?: boolean;
  failLoopExceeded?: boolean;
}

export type ChronicleRunKind = "delegation" | "factory" | "orchestration";

export interface ChronicleClassifyInput {
  kind: ChronicleRunKind;
  runId: string;
  status?: string;
  taskHash?: string;
  outputHash?: string;
  evidencePaths?: string[];
  assistantTurnSeen?: boolean;
  outputCaptured?: boolean;
  outputValidated?: boolean;
  evidenceChecked?: boolean;
  stopCondition?: ChildStopCondition;
  preflightPassed?: boolean;
  scopeViolation?: boolean;
  timedOut?: boolean;
  blocked?: boolean;
  agenticFailed?: boolean;
  planned?: boolean;
  budget?: { enforced?: boolean; advisory?: boolean };
  errors?: string[];
}

export interface RunawayGuardInput {
  recentStatuses?: string[];
  failures?: number;
  failLoopThreshold?: number;
  budgetWouldExceed?: boolean;
  budgetEnforced?: boolean;
}

export interface DelegationTelemetryInput {
  runId: string;
  source: "delegate_agent" | "delegate_task";
  mode: ModeName;
  agent: string;
  model?: string;
  cwd?: string;
  tools: string[];
  taskHash?: string;
  outputHash?: string;
  outputContract?: string;
  status: string;
  gatePassed?: boolean;
  gateErrors?: string[];
  failureKind?: DelegationFailureKind;
  assistantTurnSeen?: boolean;
  outputCaptured?: boolean;
  outputValidated?: boolean;
  evidenceChecked?: boolean;
  stopCondition?: ChildStopCondition;
  usage?: ChildResult["usage"];
  latencyMs: number;
  startedAt: string;
  endedAt: string;
  sessionPath?: string;
}
