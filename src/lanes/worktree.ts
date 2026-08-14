/**
 * src/lanes/worktree.ts — C6 git worktree isolation (benchmark tintinweb §4g,
 * worktree.ts:65-189).
 *
 * Runs a child inside a DISPOSABLE git worktree of the repo:
 *   - createWorktree: verifies git + HEAD (baseSha), then
 *     `git worktree add --detach <tmpdir>/... HEAD`;
 *   - cleanupWorktree: dirty tree -> `git add -A` + `git commit --no-verify
 *     -m "pi-agent: <desc truncated to 200>"` + `git branch pi-agent-<runId>`
 *     (timestamp suffix on name conflict) + `git worktree remove`; a clean
 *     tree with HEAD unchanged is removed without any branch (hasChanges
 *     false); a tree whose HEAD MOVED (the child committed itself) keeps the
 *     child's commits on the branch without an extra commit;
 *   - pruneWorktrees: crash recovery (`git worktree prune`).
 *
 * Bounds (I8 named constants): every git invocation runs with a named timeout
 * (WORKTREE_GIT_TIMEOUT_MS); the auto-commit description is truncated to
 * WORKTREE_DESC_MAX_CHARS; branch-name conflicts retry with timestamp
 * suffixes (WORKTREE_BRANCH_CONFLICT_ATTEMPTS). Only `git` is invoked via
 * node:child_process with an args array (no shell). The auto-commit identity
 * is forced per invocation (-c user.name/user.email) so it works in hermetic
 * mini repos without ambient git config — the branch/commit is machine-
 * authored by design.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildResult } from "../core/types.js";
import { safeFileStem } from "../core/paths.js";

/** Named timeout bound for every git invocation (crash safety). */
export const WORKTREE_GIT_TIMEOUT_MS = 30_000;
/** Auto-commit description bound: truncated to 200 chars (benchmark bound). */
export const WORKTREE_DESC_MAX_CHARS = 200;
/** Branch prefix for preserved agent work (benchmark: pi-agent-<agentId>). */
export const WORKTREE_BRANCH_PREFIX = "pi-agent-";
/** Retries with fresh timestamp suffixes when the branch name is taken. */
export const WORKTREE_BRANCH_CONFLICT_ATTEMPTS = 3;
/** Forced identity for the machine-authored auto-commit (hermetic repos). */
export const WORKTREE_COMMIT_IDENTITY = { name: "pi-subagents", email: "pi-subagents@localhost" } as const;

/** Options for `createWorktree`. */
export interface WorktreeOptions {
  /** Description used in the auto-commit message (truncated to 200 chars). */
  description?: string;
  /** Base directory for the worktree (default: os tmpdir, NEVER inside the repo). */
  baseDir?: string;
  /** Named timeout bound for git invocations (default WORKTREE_GIT_TIMEOUT_MS). */
  gitTimeoutMs?: number;
}

/** A created (disposable) worktree awaiting a child run + cleanup. */
export interface WorktreeCreation {
  /** Absolute repo root the worktree was created from. */
  repoRoot: string;
  /** Absolute worktree path (the child's cwd). */
  worktreePath: string;
  /** Branch cleanup creates when changes exist: pi-agent-<sanitized runId>. */
  branch: string;
  /** HEAD sha of the repo at creation time (detached base of the worktree). */
  baseSha: string;
  /** Sanitized run id the branch name derives from. */
  runId: string;
  /** Carried description for the auto-commit message. */
  description?: string;
  /** Named timeout bound used by cleanup git invocations. */
  gitTimeoutMs: number;
}

/** Post-cleanup outcome attached to the enriched child result. */
export interface WorktreeRunOutcome {
  worktreePath: string;
  baseSha: string;
  /** Created branch (present only when changes/commits were preserved). */
  branch?: string;
  /** True when the worktree had changes or a moved HEAD at cleanup. */
  hasChanges: boolean;
  /** True when CLEANUP itself created the auto-commit (dirty tree). */
  committed: boolean;
  /** HEAD sha the branch points at (cleanup commit or the child's commit). */
  commitSha?: string;
  /** True when the worktree directory was successfully removed. */
  removed: boolean;
  /** Set when cleanup itself failed (best-effort, never throws to the run). */
  cleanupError?: string;
}

/** ChildResult enriched with the C6 worktree outcome (engine attaches it). */
export type WorktreeChildResult = ChildResult & { worktree?: WorktreeRunOutcome };

/** Classified worktree gate failure kinds (preflight, cycle-4 honesty fix). */
export type WorktreeErrorKind = "non_git_repo" | "no_commits" | "git_error";

/** Upper bound on the classified git detail carried in tool `details`. */
const WORKTREE_DETAIL_MAX_CHARS = 200;

/**
 * Classify a git failure detail into a worktree error kind:
 *   non_git_repo — `fatal: not a git repository` (outside any repo)
 *   no_commits   — unresolvable HEAD (`ambiguous argument 'HEAD'` /
 *                  `unknown revision` / `does not have any commits yet`)
 *   git_error    — any other git failure (timeout, permission, …)
 * Pure string classification — no fs, no spawn.
 */
export function classifyWorktreeGitError(detail: string): WorktreeErrorKind {
  const text = detail.toLowerCase();
  if (text.includes("not a git repository") || text.includes("not a git worktree")) return "non_git_repo";
  if (
    text.includes("unknown revision") ||
    text.includes("ambiguous argument") ||
    text.includes("bad revision") ||
    text.includes("does not have any commits yet")
  ) {
    return "no_commits";
  }
  return "git_error";
}

/** Classified worktree preflight outcome (clean errors; detail carried apart). */
export interface WorktreeGateOutcome {
  /** Clean, classified gate-error lines — NO raw git stderr (parent-facing). */
  errors: string[];
  /** Failure kind when the gate blocked (undefined when it passed). */
  kind?: WorktreeErrorKind;
  /** Bounded raw git detail (single line, ≤200 chars) for tool `details` only. */
  detail?: string;
}

/** Read the C6 worktree outcome from a child result (undefined when absent). */
export function getWorktreeOutcome(result: ChildResult): WorktreeRunOutcome | undefined {
  const outcome = (result as WorktreeChildResult).worktree;
  return outcome !== null && typeof outcome === "object" ? outcome : undefined;
}

interface GitFailure extends Error {
  stderr?: string | Buffer;
}

/** Run `git <args>` in `cwd` with a named timeout; wraps failures with context. */
function gitIn(cwd: string, args: readonly string[], timeoutMs: number): string {
  try {
    // stdio: stderr piped (never leaks to the parent's stderr — node:test
    // would surface it as TAP noise); stdin ignored (git is never interactive).
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as GitFailure).stderr;
    const detail = (typeof stderr === "string" && stderr.trim()) || (Buffer.isBuffer(stderr) && stderr.toString("utf8").trim()) || (error as Error).message;
    throw new Error(`worktree: git ${args.join(" ")} failed (cwd ${cwd}): ${detail}`);
  }
}

/** True when refs/heads/<branch> exists (quiet rev-parse probe, never throws). */
function branchExists(cwd: string, branch: string, timeoutMs: number): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** Auto-commit message: "pi-agent: <desc>" with newlines collapsed + 200-char truncation. */
export function worktreeCommitMessage(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim().slice(0, WORKTREE_DESC_MAX_CHARS);
  return `pi-agent: ${flat}`;
}

/**
 * Preflight validator: `worktree` isolation requires a git repository with
 * at least one commit (a resolvable HEAD). Returns blocking errors otherwise.
 */
export function validateWorktreeIsolation(isolation: string | undefined, repoRoot: string, opts: { gitTimeoutMs?: number } = {}): string[] {
  return validateWorktreeIsolationDetailed(isolation, repoRoot, opts).errors;
}

/**
 * Classified preflight validator (cycle 4): the gate error line carries ONLY
 * the classification (`… with at least one commit (non_git_repo)`) — the raw
 * git stderr stays out of the parent-facing message and rides `detail`
 * (bounded, single-line) for tool `details` payloads instead.
 */
export function validateWorktreeIsolationDetailed(
  isolation: string | undefined,
  repoRoot: string,
  opts: { gitTimeoutMs?: number } = {},
): WorktreeGateOutcome {
  if (isolation !== "worktree") return { errors: [] };
  const timeoutMs = opts.gitTimeoutMs ?? WORKTREE_GIT_TIMEOUT_MS;
  try {
    gitIn(resolve(repoRoot), ["rev-parse", "HEAD"], timeoutMs);
    return { errors: [] };
  } catch (error) {
    const raw = (error as Error).message;
    const kind = classifyWorktreeGitError(raw);
    const detail = raw.replace(/\s+/g, " ").trim().slice(0, WORKTREE_DETAIL_MAX_CHARS);
    return {
      errors: [`worktree isolation requires a git repository with at least one commit (${kind})`],
      kind,
      detail,
    };
  }
}

/**
 * Create a disposable DETACHED worktree of `repoRoot` at HEAD, placed under
 * `opts.baseDir ?? tmpdir()` (never inside the repo). The path embeds the
 * sanitized runId + timestamp + pid + random suffix so concurrent runs never
 * collide. Throws a descriptive error when the target is not a git repo or
 * has no commits.
 */
export function createWorktree(repoRoot: string, runId: string, opts: WorktreeOptions = {}): WorktreeCreation {
  const root = resolve(repoRoot);
  const timeoutMs = opts.gitTimeoutMs ?? WORKTREE_GIT_TIMEOUT_MS;
  const baseSha = gitIn(root, ["rev-parse", "HEAD"], timeoutMs).trim();
  const stem = safeFileStem(runId);
  const baseDir = resolve(opts.baseDir ?? tmpdir());
  const worktreePath = join(baseDir, `pi-subagents-wt-${stem}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  gitIn(root, ["worktree", "add", "--detach", worktreePath, "HEAD"], timeoutMs);
  return {
    repoRoot: root,
    worktreePath,
    branch: `${WORKTREE_BRANCH_PREFIX}${stem}`,
    baseSha,
    runId: stem,
    description: opts.description,
    gitTimeoutMs: timeoutMs,
  };
}

/** Resolve the branch name for preserved work: timestamp suffix on conflict. */
function resolveBranchName(creation: WorktreeCreation): string {
  const timeoutMs = creation.gitTimeoutMs;
  if (!branchExists(creation.repoRoot, creation.branch, timeoutMs)) return creation.branch;
  for (let attempt = 0; attempt < WORKTREE_BRANCH_CONFLICT_ATTEMPTS; attempt++) {
    const candidate = `${creation.branch}-${Date.now()}`;
    if (!branchExists(creation.repoRoot, candidate, timeoutMs)) return candidate;
  }
  return `${creation.branch}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Remove a worktree from its repo (plain remove first, force as fallback). */
function removeWorktree(repoRoot: string, worktreePath: string, timeoutMs: number): void {
  try {
    gitIn(repoRoot, ["worktree", "remove", worktreePath], timeoutMs);
  } catch {
    gitIn(repoRoot, ["worktree", "remove", "--force", worktreePath], timeoutMs);
  }
}

/**
 * Cleanup after the child run (benchmark cleanupWorktree, worktree.ts:102-164):
 *   - dirty tree -> `git add -A` + auto-commit (--no-verify) + branch
 *     pi-agent-<runId> (timestamp suffix on conflict) + worktree remove;
 *   - clean tree with HEAD unchanged -> plain removal, hasChanges:false;
 *   - clean tree with HEAD MOVED (child committed itself) -> branch at the
 *     child's HEAD (committed:false, commitSha = the child's commit).
 * Always removes the worktree; throws only on git failures.
 */
export function cleanupWorktree(creation: WorktreeCreation, opts: { gitTimeoutMs?: number } = {}): WorktreeRunOutcome {
  const timeoutMs = opts.gitTimeoutMs ?? creation.gitTimeoutMs;
  const dirty = gitIn(creation.worktreePath, ["status", "--porcelain"], timeoutMs).trim().length > 0;
  const headSha = gitIn(creation.worktreePath, ["rev-parse", "HEAD"], timeoutMs).trim();
  const headChanged = headSha !== creation.baseSha;

  if (!dirty && !headChanged) {
    removeWorktree(creation.repoRoot, creation.worktreePath, timeoutMs);
    return { worktreePath: creation.worktreePath, baseSha: creation.baseSha, hasChanges: false, committed: false, removed: !existsSync(creation.worktreePath) };
  }

  let commitSha = headSha;
  let committed = false;
  if (dirty) {
    gitIn(creation.worktreePath, ["add", "-A"], timeoutMs);
    gitIn(
      creation.worktreePath,
      [
        "-c",
        `user.name=${WORKTREE_COMMIT_IDENTITY.name}`,
        "-c",
        `user.email=${WORKTREE_COMMIT_IDENTITY.email}`,
        "commit",
        "--no-verify",
        "-m",
        worktreeCommitMessage(creation.description ?? creation.runId),
      ],
      timeoutMs,
    );
    committed = true;
    commitSha = gitIn(creation.worktreePath, ["rev-parse", "HEAD"], timeoutMs).trim();
  }

  const branch = resolveBranchName(creation);
  gitIn(creation.worktreePath, ["branch", branch], timeoutMs);
  removeWorktree(creation.repoRoot, creation.worktreePath, timeoutMs);
  return { worktreePath: creation.worktreePath, baseSha: creation.baseSha, branch, hasChanges: true, committed, commitSha, removed: !existsSync(creation.worktreePath) };
}

/**
 * Crash recovery (benchmark pruneWorktrees, worktree.ts:189): prune stale
 * worktree administrative entries whose directories are gone.
 */
export function pruneWorktrees(repoRoot: string, opts: { gitTimeoutMs?: number } = {}): void {
  const timeoutMs = opts.gitTimeoutMs ?? WORKTREE_GIT_TIMEOUT_MS;
  gitIn(resolve(repoRoot), ["worktree", "prune"], timeoutMs);
}
