/**
 * src/gates/paths.ts — path-policy gates (pure). Ported verbatim from the ZOB
 * harness safety gates. Uses only node builtins and src/core/paths helpers.
 */

import { resolve } from "node:path";
import { expandHome } from "../core/paths.js";

function staysInsideRepo(path: string, repoRoot: string): boolean {
  const root = resolve(repoRoot);
  const resolved = resolve(root, expandHome(path));
  return resolved === root || resolved.startsWith(`${root}/`);
}

function normalizePolicyPattern(path: string): string {
  return path.trim().replace(/\\+/g, "/").replace(/\/+/g, "/");
}

function isBroadDenyPattern(path: string): boolean {
  const normalized = normalizePolicyPattern(path);
  return normalized === "" || normalized === "." || normalized === "./" || normalized === "/" || normalized === "/*" || normalized === "*" || normalized === "**" || normalized === "~" || normalized === "~/";
}

function isRepoRelativePattern(path: string): boolean {
  const normalized = normalizePolicyPattern(path);
  return !normalized.startsWith("/") && !normalized.startsWith("~/") && normalized !== "~";
}

function isWindowsAbsolutePattern(path: string): boolean {
  return /^[a-zA-Z]:\//.test(normalizePolicyPattern(path));
}

function hasTraversalSegment(path: string): boolean {
  return normalizePolicyPattern(path).split("/").some((segment) => segment === "..");
}

function allowedPathGuidance(label: string, path: string, reason: string): string {
  // F7: backtick-quote the offending path so a broad root like `.` can never
  // render as the ambiguous traversal-looking "root: ..".
  return `${label} path must be repo-relative only (${reason}) and stay inside repo root: \`${path}\`. If the child needs external context, write or cite a repo-local snapshot/context_ref under reports/... and pass that repo-relative ref instead.`;
}

/**
 * Resolve the child working directory, ensuring it stays inside the repo root.
 */
export function resolveChildCwd(repoRoot: string, requestedCwd: string | undefined): { cwd: string; errors: string[] } {
  const root = resolve(repoRoot);
  const cwd = requestedCwd ? resolve(root, expandHome(requestedCwd)) : root;
  if (cwd !== root && !cwd.startsWith(`${root}/`)) {
    return { cwd, errors: [`Child cwd must stay inside repo root. Requested: ${requestedCwd}`] };
  }
  return { cwd, errors: [] };
}

/**
 * Validate an allowed-path policy list: each entry must be repo-relative,
 * inside the repo, with no NUL bytes, broad roots, absolute/home paths, or
 * traversal segments. Returns an array of errors.
 */
export function validateAllowedPathPolicy(paths: string[] | undefined, label: string, repoRoot: string): string[] {
  const errors: string[] = [];
  for (const path of paths ?? []) {
    const normalized = normalizePolicyPattern(path);
    if (path.includes("\0")) {
      errors.push(allowedPathGuidance(label, path, "NUL bytes are not allowed"));
      continue;
    }
    if (normalized === "" || normalized === "." || normalized === "./") {
      errors.push(allowedPathGuidance(label, path, "broad repo roots are not allowed"));
      continue;
    }
    if (normalized.startsWith("/") || normalized === "~" || normalized.startsWith("~/") || isWindowsAbsolutePattern(normalized)) {
      errors.push(allowedPathGuidance(label, path, "absolute and home paths are not allowed"));
      continue;
    }
    if (hasTraversalSegment(normalized)) {
      errors.push(allowedPathGuidance(label, path, "path traversal segments are not allowed anywhere in allowed_paths"));
      continue;
    }
    if (!staysInsideRepo(path, repoRoot)) errors.push(allowedPathGuidance(label, path, "path must not escape the repo"));
  }
  return errors;
}

/**
 * Validate a forbidden (deny-only) path policy list: no NUL bytes, no broad
 * deny patterns, and repo-relative deny patterns must stay inside the repo.
 */
export function validateForbiddenPathPolicy(paths: string[] | undefined, label: string, repoRoot: string): string[] {
  const errors: string[] = [];
  for (const path of paths ?? []) {
    if (path.includes("\0")) {
      errors.push(`${label} path contains a NUL byte: ${path}`);
      continue;
    }
    if (isBroadDenyPattern(path)) {
      errors.push(`${label} path is too broad for a deny-only pattern: ${path}`);
      continue;
    }
    if (isRepoRelativePattern(path) && !staysInsideRepo(path, repoRoot)) {
      errors.push(`${label} repo-relative deny pattern must stay inside repo root: ${path}`);
    }
  }
  return errors;
}

/**
 * Path-policy gate for allowed-path lists (aliases the allowed-path validator).
 */
export function validatePathPolicy(paths: string[] | undefined, label: string, repoRoot: string): string[] {
  return validateAllowedPathPolicy(paths, label, repoRoot);
}

/**
 * Parse a path-list environment variable (comma, colon, or newline separated).
 */
export function parsePathListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,:\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
