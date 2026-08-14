/**
 * src/core/stop-conditions.ts — pure stop-condition classifiers and oracle/runaway
 * helpers. No fs, no @earendil-works/*. Ported from the harness chronicle.ts.
 */
import type {
  ChildStopCondition,
  ChildStopConditionInput,
  DelegationTelemetryInput,
  RunawayGuardInput,
} from "./types.js";
import { classifyChronicleCompletion } from "./statuses.js";

/** True when the output carries a recognised evidence marker. */
export function outputHasEvidenceMarker(output: string | undefined): boolean {
  if (!output) return false;
  return /(?:<evidence>[\s\S]*?<\/evidence>|<evidence>|\bevidence\b|proof)/i.test(output);
}

/** Detect oracle FAIL / no_ship markers in an output string. */
export function detectOracleFail(output: string | undefined): { oracleFailed: boolean; noShip: boolean; stopCondition: ChildStopCondition } {
  const text = output ?? "";
  const oracleFailed = /(?:<verdict>\s*FAIL\s*<\/verdict>|\bverdict\s*[:=-]\s*FAIL\b|^\s*FAIL\b)/im.test(text);
  const noShip = /(?:<no_ship>\s*(?:true|yes)\s*<\/no_ship>|\bno_ship\s*[:=-]\s*(?:true|yes)\b|\bno ship\s*[:=-]\s*(?:true|yes)\b)/i.test(text);
  return { oracleFailed, noShip, stopCondition: noShip ? "no_ship" : oracleFailed ? "oracle_fail" : "none" };
}

/** Summarize a runaway-guard evaluation into a body-free structured record. */
export function summarizeRunawayGuard(input: RunawayGuardInput = {}): Record<string, unknown> {
  const threshold = Math.max(1, Math.floor(input.failLoopThreshold ?? 3));
  const failureStatuses = new Set(["failed", "failed_preflight", "failed_validation", "incomplete_or_failed", "incomplete_no_assistant_turn", "incomplete_no_evidence", "timeout", "agentic_failed", "oracle_fail", "no_ship"]);
  const recentFailures = typeof input.failures === "number" ? input.failures : (input.recentStatuses ?? []).filter((status) => failureStatuses.has(status)).length;
  const failLoopExceeded = recentFailures >= threshold;
  return {
    schema: "zob.runaway-guard.v1",
    stopCondition: failLoopExceeded ? "fail_loop" : "none",
    shouldStop: failLoopExceeded,
    failLoopThreshold: threshold,
    recentFailures,
    budget: {
      wouldExceed: input.budgetWouldExceed === true,
      enforced: false,
      advisory: true,
      wouldBlockDispatch: false,
    },
    budgetEnforced: false,
  };
}

/**
 * Classify the child stop condition from raw run signals. Precedence order is
 * ported exactly from the harness. Returns a body-free structured summary.
 */
export function classifyChildStopCondition(input: ChildStopConditionInput): Record<string, unknown> {
  const oracle = detectOracleFail(input.output);
  const outputCaptured = input.outputCaptured ?? Boolean(input.outputHash);
  let stopCondition: ChildStopCondition = "none";

  if (input.failLoopExceeded) stopCondition = "fail_loop";
  else if (input.scopeViolation) stopCondition = "scope_violation";
  else if (input.timedOut || input.status === "timeout") stopCondition = "timeout";
  else if (input.blocked || input.status === "blocked") stopCondition = "blocked";
  else if (input.agenticFailed || input.status === "agentic_failed") stopCondition = "agentic_failed";
  else if (input.preflightPassed === false || input.status === "failed_preflight" || input.status === "unknown_agent") stopCondition = "failed_preflight";
  else if (oracle.noShip) stopCondition = "no_ship";
  else if (oracle.oracleFailed) stopCondition = "oracle_fail";
  else if (input.assistantTurnSeen === false) stopCondition = "incomplete_no_assistant_turn";
  else if (!outputCaptured || !input.outputHash || input.evidenceChecked === false) stopCondition = "incomplete_no_evidence";
  else if (input.outputValidated === false || input.status === "failed_validation" || input.status === "incomplete_or_failed") stopCondition = "failed_validation";

  return {
    schema: "zob.child-stop-condition.v1",
    stopCondition,
    shouldStop: stopCondition !== "none",
    oracleFailed: oracle.oracleFailed,
    noShip: oracle.noShip,
    budget: { advisory: true, enforced: false },
    budgetEnforced: false,
  };
}

/** Classify a delegation telemetry record into a chronicle completion summary. */
export function classifyDelegationChronicleCompletion(input: DelegationTelemetryInput): Record<string, unknown> {
  const stop = classifyChildStopCondition({
    status: input.status,
    agent: input.agent,
    outputContract: input.outputContract,
    assistantTurnSeen: input.assistantTurnSeen ?? ((input.usage?.turns ?? 0) > 0),
    outputHash: input.outputHash,
    outputCaptured: input.outputCaptured ?? Boolean(input.outputHash),
    outputValidated: input.outputValidated ?? input.gatePassed === true,
    evidenceChecked: input.evidenceChecked ?? input.gatePassed === true,
    preflightPassed: input.status !== "failed_preflight" && input.status !== "unknown_agent",
    timedOut: input.status === "timeout",
    blocked: input.status === "blocked",
  });
  return classifyChronicleCompletion({
    kind: "delegation",
    runId: input.runId,
    status: input.status,
    taskHash: input.taskHash,
    outputHash: input.outputHash,
    stopCondition: input.stopCondition ?? (stop.stopCondition as ChildStopCondition),
    assistantTurnSeen: input.assistantTurnSeen ?? ((input.usage?.turns ?? 0) > 0),
    outputCaptured: input.outputCaptured ?? Boolean(input.outputHash),
    outputValidated: input.outputValidated ?? input.gatePassed === true,
    evidenceChecked: input.evidenceChecked ?? input.gatePassed === true,
    preflightPassed: input.status !== "failed_preflight" && input.status !== "unknown_agent",
    timedOut: input.status === "timeout",
    blocked: input.status === "blocked",
    budget: { advisory: true, enforced: false },
    errors: input.gateErrors ?? [],
  });
}
