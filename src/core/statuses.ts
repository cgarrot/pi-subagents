/**
 * src/core/statuses.ts — chronicle lifecycle statuses and completion classifier.
 * Pure (no fs, no @earendil-works/*). Ported from the harness chronicle.ts.
 */
import type { ChildStopCondition, ChronicleClassifyInput } from "./types.js";

/** Ordered chronological lifecycle states for a child delegation run. */
export const CHRONICLE_STATES = [
  "created",
  "preflighted",
  "running",
  "assistant_turn_seen",
  "output_captured",
  "output_validated",
  "evidence_checked",
  "complete",
  "failed_preflight",
  "incomplete_no_assistant_turn",
  "incomplete_no_evidence",
  "failed_validation",
  "scope_violation",
  "timeout",
  "blocked",
  "planned",
  "agentic_failed",
] as const;

export type ChronicleState = (typeof CHRONICLE_STATES)[number];

/** States that represent a terminal (non-retryable) failure. */
export const TERMINAL_CHRONICLE_FAILURE_STATES = new Set<ChronicleState>([
  "failed_preflight",
  "incomplete_no_assistant_turn",
  "incomplete_no_evidence",
  "failed_validation",
  "scope_violation",
  "timeout",
  "blocked",
  "agentic_failed",
]);

/**
 * Classify a chronicle completion state from raw run signals. Uses the same
 * precedence order as the harness. Returns a body-free structured summary.
 */
export function classifyChronicleCompletion(input: ChronicleClassifyInput): Record<string, unknown> {
  const preflightPassed = input.preflightPassed ?? input.status !== "failed_preflight";
  const assistantTurnSeen = input.assistantTurnSeen === true;
  const outputCaptured = input.outputCaptured ?? Boolean(input.outputHash);
  const outputValidated = input.outputValidated === true;
  const evidenceChecked = input.evidenceChecked === true;
  let state: ChronicleState = "created";

  if (input.scopeViolation) state = "scope_violation";
  else if (input.timedOut) state = "timeout";
  else if (input.blocked) state = "blocked";
  else if (input.agenticFailed || input.status === "agentic_failed") state = "agentic_failed";
  else if (!preflightPassed || input.status === "failed_preflight") state = "failed_preflight";
  else if (input.planned || input.status === "planned") state = "planned";
  else if (!assistantTurnSeen) state = "incomplete_no_assistant_turn";
  else if (!outputCaptured || !input.outputHash || !evidenceChecked) state = "incomplete_no_evidence";
  else if (!outputValidated) state = "failed_validation";
  else state = "complete";

  const stopCondition = input.stopCondition ?? (state === "complete" || state === "planned" ? "none" : (state as ChildStopCondition));

  return {
    schema: "zob.chronicle-state.v1",
    kind: input.kind,
    runId: input.runId,
    state,
    complete: state === "complete",
    stopCondition,
    falseDoneGuard: {
      assistantTurnSeen,
      outputCaptured: Boolean(outputCaptured && input.outputHash),
      outputValidated,
      evidenceChecked,
      passed: state === "complete",
    },
    taskHash: input.taskHash,
    outputHash: input.outputHash,
    evidencePaths: input.evidencePaths ?? [],
    budget: {
      advisory: input.budget?.advisory ?? true,
      enforced: input.budget?.enforced === true,
    },
    terminalFailure: TERMINAL_CHRONICLE_FAILURE_STATES.has(state),
    errors: input.errors ?? [],
  };
}
