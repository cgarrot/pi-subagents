/**
 * src/gates/write-scope.ts — runtime/delegation write-scope gates plus sandbox,
 * diff-gate, rollback metadata builders and child env construction.
 *
 * Pure gates (validateRuntimeWritePolicy, validateDelegationWriteScope,
 * validateDelegateTaskWriteScope) have no side effects. The metadata builders
 * and buildChildEnv are STATEFUL (timestamps / base env) and therefore accept
 * injectable inputs (`now`, `baseEnv`) so they stay testable. Zero
 * @earendil-works/* imports.
 */

import { resolve } from "node:path";
import { expandHome, pathMatches } from "../core/paths.js";
import type { BudgetSidecar } from "./types.js";

/**
 * Runtime write-policy gate: checks a target path against zero-access,
 * forbidden, read-only, allowed-path, and sandbox-root policies. Returns a
 * boolean allow decision plus the list of violations.
 */
export function validateRuntimeWritePolicy(input: {
  targetPath: string;
  cwd: string;
  policyRoot?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  zeroAccessPaths?: string[];
  readOnlyPaths?: string[];
  sandboxRoot?: string;
}): { allowed: boolean; violations: string[] } {
  const policyRoot = input.policyRoot ?? input.cwd;
  const violations: string[] = [];
  for (const protectedPattern of input.zeroAccessPaths ?? []) {
    if (pathMatches(input.targetPath, protectedPattern, input.cwd, policyRoot)) violations.push(`zero-access path: ${protectedPattern}`);
  }
  for (const forbiddenPattern of input.forbiddenPaths ?? []) {
    if (pathMatches(input.targetPath, forbiddenPattern, input.cwd, policyRoot)) violations.push(`forbidden path: ${forbiddenPattern}`);
  }
  for (const readOnlyPattern of input.readOnlyPaths ?? []) {
    if (pathMatches(input.targetPath, readOnlyPattern, input.cwd, policyRoot)) violations.push(`read-only path: ${readOnlyPattern}`);
  }
  const allowedPaths = input.allowedPaths ?? [];
  if (allowedPaths.length > 0 && !allowedPaths.some((allowedPath) => pathMatches(input.targetPath, allowedPath, input.cwd, policyRoot))) {
    violations.push(`outside allowed_paths: ${allowedPaths.join(", ")}`);
  }
  if (input.sandboxRoot) {
    const sandboxRoot = resolve(policyRoot, expandHome(input.sandboxRoot));
    const target = resolve(input.cwd, expandHome(input.targetPath));
    if (target !== sandboxRoot && !target.startsWith(`${sandboxRoot}/`)) violations.push(`outside sandbox root: ${input.sandboxRoot}`);
  }
  return { allowed: violations.length === 0, violations };
}

/**
 * Delegation write-scope gate: write/edit tools require non-empty allowed_paths.
 */
export function validateDelegationWriteScope(source: string, requiredTools: string[], allowedPaths: string[] | undefined): string[] {
  const wantsWrite = requiredTools.some((tool) => tool === "write" || tool === "edit");
  if (wantsWrite && (allowedPaths?.length ?? 0) === 0) return [`${source} with write/edit tools requires non-empty allowed_paths`];
  return [];
}

/** `delegate_task`-flavoured write-scope gate (aliases the generic validator). */
export function validateDelegateTaskWriteScope(requiredTools: string[], allowedPaths: string[] | undefined): string[] {
  return validateDelegationWriteScope("delegate_task", requiredTools, allowedPaths);
}

/**
 * Build sandbox metadata envelope. STATEFUL (`createdAt`); the timestamp is
 * injectable via `now` for deterministic tests.
 */
export function createSandboxMetadata(
  input: { runId: string; repoRoot: string; sandboxRoot: string; allowedPaths?: string[]; forbiddenPaths?: string[]; budget?: BudgetSidecar },
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    schema: "zob.sandbox-metadata.v1",
    runId: input.runId,
    repoRoot: resolve(input.repoRoot),
    sandboxRoot: resolve(input.repoRoot, input.sandboxRoot),
    allowedPaths: input.allowedPaths ?? [],
    forbiddenPaths: input.forbiddenPaths ?? [],
    tempCopy: true,
    autoApply: false,
    budgetEnforced: false,
    budget: input.budget ?? { mode: "advisory", advisory: true, budgetEnforced: false, strictRequested: false, strictEnabled: false },
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: now,
  };
}

/**
 * Build diff-gate result envelope. STATEFUL (`evaluatedAt`); injectable `now`.
 */
export function createDiffGateResult(
  input: { runId: string; diffHash?: string; changedPaths?: string[]; allowed: boolean; violations?: string[] },
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    schema: "zob.diff-gate-result.v1",
    runId: input.runId,
    diffHash: input.diffHash,
    changedPaths: input.changedPaths ?? [],
    allowed: input.allowed,
    violations: input.violations ?? [],
    applyRequired: true,
    autoApply: false,
    budgetEnforced: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    evaluatedAt: now,
  };
}

/**
 * Build rollback metadata envelope. STATEFUL (`createdAt`); injectable `now`.
 */
export function createRollbackMetadata(
  input: { runId: string; baseRef?: string; snapshotPath?: string; changedPaths?: string[] },
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    schema: "zob.rollback-metadata.v1",
    runId: input.runId,
    baseRef: input.baseRef,
    snapshotPath: input.snapshotPath,
    changedPaths: input.changedPaths ?? [],
    rollbackPrepared: true,
    rollbackApplied: false,
    autoApply: false,
    budgetEnforced: false,
    bodyStored: false,
    promptBodiesStored: false,
    outputBodiesStored: false,
    createdAt: now,
  };
}

const KEEP_EXACT = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_PATH",
  "NVM_DIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "LOGNAME",
  "PI_OFFLINE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
]);

/**
 * Build the child process env. STATEFUL: reads a base env (default
 * `process.env`) and injects ZOB path-policy vars. The base env is injectable
 * via `baseEnv` for deterministic tests. Zero direct non-injectable env reads
 * once a caller passes `baseEnv`.
 */
export function buildChildEnv(
  repoRoot: string,
  pathPolicy?: { allowedPaths?: string[]; forbiddenPaths?: string[]; sandboxRoot?: string },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (KEEP_EXACT.has(key)) env[key] = value;
  }
  env.ZOB_HARNESS_ROOT = repoRoot;
  if (pathPolicy?.allowedPaths && pathPolicy.allowedPaths.length > 0) env.ZOB_ALLOWED_PATHS = pathPolicy.allowedPaths.join(",");
  if (pathPolicy?.forbiddenPaths && pathPolicy.forbiddenPaths.length > 0) env.ZOB_FORBIDDEN_PATHS = pathPolicy.forbiddenPaths.join(",");
  if (pathPolicy?.sandboxRoot) env.ZOB_SANDBOX_ROOT = pathPolicy.sandboxRoot;
  return env;
}
