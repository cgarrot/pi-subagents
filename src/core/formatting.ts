/**
 * src/core/formatting.ts — pure output/feedback formatting. No fs, no @earendil-works/*.
 */
import type { ChildResult } from "./types.js";

export interface BlockedFeedbackDiagnostics {
  executionPerformed: false;
  currentMode: string;
  reasonCode: string;
  retryPolicy: string;
  safeNextAction: string;
}

export interface FileToolPreflightFeedbackDiagnostics {
  executionPerformed: false;
  toolName: string;
  reasonCode: string;
  field: string;
  pathHash: string;
  inputHash: string;
  snapshotHash: string;
  fingerprintHash: string;
  retryPolicy: string;
  safeNextActions: readonly string[];
  telemetryRecorded: boolean;
  deduplicated: boolean;
  attemptCount: number;
  unchangedRetryCount: number;
}

/** Build a "blocked" feedback message for a blocked tool call. */
export function blockedFeedback(toolName: string, reason: string, attempted: string, diagnostics?: BlockedFeedbackDiagnostics): string {
  return [
    `ZOB damage-control blocked ${toolName}: ${reason}`,
    "",
    `Attempted: ${attempted}`,
    "",
    "Continue safely:",
    "- If this was non-destructive reconnaissance, skip it or ask the user for the specific value.",
    "- If this was destructive, stop and ask for explicit approval with exact command, risk, and rollback plan.",
    "- Do not retry the same blocked call.",
    ...(diagnostics ? [
      "",
      "Structured diagnostics:",
      `execution_performed=${diagnostics.executionPerformed}`,
      `current_mode=${diagnostics.currentMode}`,
      `reason_code=${diagnostics.reasonCode}`,
      `retry_policy=${diagnostics.retryPolicy}`,
      `safe_next_action=${diagnostics.safeNextAction}`,
    ] : []),
  ].join("\n");
}

/** Build a body-free file-tool preflight blocked message. */
export function fileToolPreflightFeedback(diagnostics: FileToolPreflightFeedbackDiagnostics): string {
  return [
    `ZOB file-tool preflight blocked ${diagnostics.toolName}: ${diagnostics.reasonCode}`,
    "",
    "Structured diagnostics (body-free):",
    `execution_performed=${diagnostics.executionPerformed}`,
    `reason_code=${diagnostics.reasonCode}`,
    `field=${diagnostics.field}`,
    `path_hash=${diagnostics.pathHash}`,
    `input_hash=${diagnostics.inputHash}`,
    `snapshot_hash=${diagnostics.snapshotHash}`,
    `fingerprint_hash=${diagnostics.fingerprintHash}`,
    `retry_policy=${diagnostics.retryPolicy}`,
    `safe_next_actions=${diagnostics.safeNextActions.join(",")}`,
    `telemetry_recorded=${diagnostics.telemetryRecorded}`,
    `deduplicated=${diagnostics.deduplicated}`,
    `attempt_count=${diagnostics.attemptCount}`,
    `unchanged_retry_count=${diagnostics.unchangedRetryCount}`,
    "No native tool execution occurred. Correct the cited field or follow the safe action; no input was changed or retried automatically.",
  ].join("\n");
}

/** Cap output to a byte limit, truncating safely on UTF-8 boundaries. */
export function capOutput(output: string, limit = 50 * 1024): string {
  if (Buffer.byteLength(output, "utf8") <= limit) return output;
  let truncated = output.slice(0, limit);
  while (Buffer.byteLength(truncated, "utf8") > limit) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[truncated: full output stored in tool details]`;
}

/**
 * F4: actionable message surfaced wherever a `provider_quota` failure kind
 * appears (result text, run views). Provider-side usage/rate limits are
 * retryable by waiting or switching model — say so explicitly.
 */
export const PROVIDER_QUOTA_MESSAGE = "Provider quota/rate limit reached — retry later or switch model.";

/** Render a child result into a readable human/machine summary. */
export function formatChildResultText(result: ChildResult): string {
  const messages: string[] = [];
  if (result.failureKind) {
    messages.push(`Failure kind: ${result.failureKind}`);
    // F4: pair the quota kind with its actionable remediation message.
    if (result.failureKind === "provider_quota") messages.push(PROVIDER_QUOTA_MESSAGE);
  }
  if (result.contractErrors && result.contractErrors.length > 0) messages.push(`Blocked before child launch (preflight/config):\n- ${result.contractErrors.join("\n- ")}`);
  if (result.gateErrors && result.gateErrors.length > 0) messages.push(`Output-contract gate errors (format repair may be enough; inspect and rerun only if content is actually missing):\n- ${result.gateErrors.join("\n- ")}`);
  if (result.errorMessage) messages.push(`Error: ${result.errorMessage}`);
  if (result.stderr.trim()) messages.push(`stderr:\n${result.stderr.trim()}`);
  if (result.output.trim()) messages.push(result.output.trim());
  return messages.length > 0 ? messages.join("\n\n") : "(no output)";
}
