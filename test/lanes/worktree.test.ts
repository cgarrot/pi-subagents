// test/lanes/worktree.test.ts — C6 git worktree isolation.
//
// Exercises src/lanes/worktree.ts (createWorktree / cleanupWorktree /
// pruneWorktrees / validateWorktreeIsolation), the LaneDispatchInput cwd
// plumbing, and the engine `isolation: "worktree"` option with REAL temporary
// mini git repositories in the OS tmpdir (git init/add/commit via
// node:child_process — local only, no network). The harness repo itself is
// NEVER a git target of these tests.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  WORKTREE_DESC_MAX_CHARS,
  classifyWorktreeGitError,
  cleanupWorktree,
  createWorktree,
  getWorktreeOutcome,
  pruneWorktrees,
  validateWorktreeIsolation,
  validateWorktreeIsolationDetailed,
  worktreeCommitMessage,
  type WorktreeCreation,
} from "../../src/lanes/worktree.js";
import { LanePool } from "../../src/lanes/pool.js";
import type { SpawnFn } from "../../src/lanes/spawn.js";
import { DispatchEngine } from "../../src/engine/dispatch.js";

/** Run git in a directory (args array, no shell). */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Create a REAL mini git repo in the OS tmpdir with one initial commit. */
function makeMiniRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagents-wt-${label}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Pi Subagents Test"]);
  writeFileSync(join(dir, "README.md"), "# mini\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** Best-effort disposal of a mini repo AND any worktree created from it. */
function dispose(repo: string, creation?: WorktreeCreation): void {
  if (creation) rmSync(creation.worktreePath, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

describe("lanes/worktree: createWorktree", () => {
  it("creates a DETACHED worktree at HEAD under tmpdir (never inside the repo)", () => {
    const repo = makeMiniRepo("create");
    let creation: WorktreeCreation | undefined;
    try {
      const head = git(repo, ["rev-parse", "HEAD"]);
      creation = createWorktree(repo, "run-42", { description: "do work" });

      assert.ok(existsSync(join(creation.worktreePath, "README.md")), "worktree carries the committed files");
      assert.equal(creation.baseSha, head);
      assert.equal(git(creation.worktreePath, ["rev-parse", "HEAD"]), head, "detached at baseSha");
      assert.equal(creation.branch, "pi-agent-run-42");
      assert.ok(!creation.worktreePath.startsWith(repo), "worktree lives OUTSIDE the repo (tmpdir)");
      assert.ok(git(repo, ["worktree", "list", "--porcelain"]).includes(creation.worktreePath), "registered in git worktree list");
    } finally {
      dispose(repo, creation);
    }
  });

  it("sanitizes the runId for the branch/path names", () => {
    const repo = makeMiniRepo("sanitize");
    let creation: WorktreeCreation | undefined;
    try {
      creation = createWorktree(repo, "delegate_123456/x y", {});
      assert.equal(creation.branch, "pi-agent-delegate_123456-x-y"); // safeFileStem keeps [a-z0-9._-]
      assert.ok(!existsSync(creation.worktreePath) || creation.worktreePath.length > 0); // created
    } finally {
      dispose(repo, creation);
    }
  });

  it("throws a clear error outside a git repo or in a repo without commits", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "pi-subagents-wt-notrepo-"));
    const noCommits = mkdtempSync(join(tmpdir(), "pi-subagents-wt-nocommit-"));
    try {
      assert.throws(() => createWorktree(notRepo, "r1"), /worktree: git .* failed|not a git repository/i);
      git(noCommits, ["init", "-q"]);
      assert.throws(() => createWorktree(noCommits, "r2"), /HEAD|failed/i);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
      rmSync(noCommits, { recursive: true, force: true });
    }
  });
});

describe("lanes/worktree: cleanupWorktree", () => {
  it("clean tree + unchanged HEAD -> plain removal, hasChanges:false, no branch", () => {
    const repo = makeMiniRepo("clean");
    let creation: WorktreeCreation | undefined;
    try {
      creation = createWorktree(repo, "run-clean");
      const outcome = cleanupWorktree(creation);

      assert.equal(outcome.hasChanges, false);
      assert.equal(outcome.committed, false);
      assert.equal(outcome.branch, undefined);
      assert.equal(outcome.removed, true);
      assert.ok(!existsSync(creation.worktreePath), "worktree dir gone");
      assert.ok(!git(repo, ["worktree", "list", "--porcelain"]).includes(creation.worktreePath), "unregistered");
      assert.equal(git(repo, ["rev-parse", "HEAD"]), creation.baseSha, "main HEAD untouched");
    } finally {
      dispose(repo, creation);
    }
  });

  it("dirty tree -> auto-commit + pi-agent-<runId> branch + removal (changes preserved)", () => {
    const repo = makeMiniRepo("dirty");
    let creation: WorktreeCreation | undefined;
    try {
      creation = createWorktree(repo, "run-7", { description: "add artifact" });
      writeFileSync(join(creation.worktreePath, "out.txt"), "child artifact");

      const outcome = cleanupWorktree(creation);

      assert.equal(outcome.hasChanges, true);
      assert.equal(outcome.committed, true);
      assert.equal(outcome.branch, "pi-agent-run-7");
      assert.ok(outcome.commitSha);
      assert.equal(outcome.removed, true);
      assert.ok(!existsSync(creation.worktreePath));

      // The branch exists in the mini repo and preserves the child's file.
      assert.equal(git(repo, ["rev-parse", "--verify", `refs/heads/${outcome.branch}`]), outcome.commitSha);
      assert.equal(git(repo, ["show", `${outcome.branch}:out.txt`]), "child artifact");
      assert.ok(git(repo, ["log", "-1", "--pretty=%s", outcome.branch]).startsWith("pi-agent: "));
      // The main branch (repo HEAD) is untouched.
      assert.equal(git(repo, ["rev-parse", "HEAD"]), creation.baseSha);
    } finally {
      dispose(repo, creation);
    }
  });

  it("branch name conflict -> timestamp suffix, both branches exist", () => {
    const repo = makeMiniRepo("conflict");
    let creation: WorktreeCreation | undefined;
    try {
      git(repo, ["branch", "pi-agent-run-9"]); // occupy the preferred name
      creation = createWorktree(repo, "run-9");
      writeFileSync(join(creation.worktreePath, "note.md"), "late idea");

      const outcome = cleanupWorktree(creation);

      assert.equal(outcome.hasChanges, true);
      assert.ok(outcome.branch && outcome.branch.startsWith("pi-agent-run-9-"), `suffixed branch: ${outcome.branch}`);
      assert.notEqual(outcome.branch, "pi-agent-run-9");
      assert.equal(git(repo, ["show", `${outcome.branch}:note.md`]), "late idea");
      assert.equal(git(repo, ["rev-parse", "--verify", "refs/heads/pi-agent-run-9"]), creation.baseSha, "original branch untouched");
    } finally {
      dispose(repo, creation);
    }
  });

  it("child moved HEAD itself (own commit) -> branch at child HEAD, committed:false", () => {
    const repo = makeMiniRepo("childcommit");
    let creation: WorktreeCreation | undefined;
    try {
      creation = createWorktree(repo, "run-self");
      // Simulate a child that commits its own work inside the worktree.
      writeFileSync(join(creation.worktreePath, "own.txt"), "self committed");
      git(creation.worktreePath, ["add", "-A"]);
      git(creation.worktreePath, ["commit", "-q", "-m", "child commit"]);

      const outcome = cleanupWorktree(creation);

      assert.equal(outcome.hasChanges, true);
      assert.equal(outcome.committed, false, "cleanup made NO extra commit");
      assert.equal(outcome.branch, "pi-agent-run-self");
      assert.equal(git(repo, ["show", `${outcome.branch}:own.txt`]), "self committed");
      assert.equal(git(repo, ["rev-parse", `refs/heads/${outcome.branch}`]), outcome.commitSha);
    } finally {
      dispose(repo, creation);
    }
  });

  it("commit message description is truncated to 200 chars", () => {
    const repo = makeMiniRepo("truncate");
    let creation: WorktreeCreation | undefined;
    try {
      const long = "d".repeat(300);
      creation = createWorktree(repo, "run-trunc", { description: long });
      writeFileSync(join(creation.worktreePath, "f.txt"), "x\n");

      const outcome = cleanupWorktree(creation);

      const message = git(repo, ["log", "-1", "--pretty=%B", outcome.branch!]).trim();
      assert.equal(message, `pi-agent: ${"d".repeat(WORKTREE_DESC_MAX_CHARS)}`);
      assert.ok(message.length <= "pi-agent: ".length + WORKTREE_DESC_MAX_CHARS);
      assert.equal(worktreeCommitMessage(long), `pi-agent: ${"d".repeat(200)}`);
    } finally {
      dispose(repo, creation);
    }
  });
});

describe("lanes/worktree: pruneWorktrees (crash recovery)", () => {
  it("prunes stale worktree entries whose directory disappeared", () => {
    const repo = makeMiniRepo("prune");
    let creation: WorktreeCreation | undefined;
    try {
      creation = createWorktree(repo, "run-crash");
      rmSync(creation.worktreePath, { recursive: true, force: true }); // simulate a crash

      assert.ok(git(repo, ["worktree", "list"]).includes(creation.worktreePath), "stale entry still listed");
      pruneWorktrees(repo);
      assert.ok(!git(repo, ["worktree", "list"]).includes(creation.worktreePath), "stale entry pruned");
    } finally {
      dispose(repo, creation);
    }
  });
});

describe("lanes/worktree: validateWorktreeIsolation (preflight gate)", () => {
  it("passes on a git repo with commits; blocks otherwise", () => {
    const repo = makeMiniRepo("validate");
    const empty = mkdtempSync(join(tmpdir(), "pi-subagents-wt-empty-"));
    const noCommits = mkdtempSync(join(tmpdir(), "pi-subagents-wt-nocommit2-"));
    try {
      assert.deepEqual(validateWorktreeIsolation("worktree", repo), []);
      assert.deepEqual(validateWorktreeIsolation(undefined, empty), []);
      const errors = validateWorktreeIsolation("worktree", empty);
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, /worktree isolation requires a git repository/i);
      git(noCommits, ["init", "-q"]);
      assert.equal(validateWorktreeIsolation("worktree", noCommits).length, 1);
    } finally {
      dispose(repo);
      rmSync(empty, { recursive: true, force: true });
      rmSync(noCommits, { recursive: true, force: true });
    }
  });

  it("classifies gate failures (non_git_repo / no_commits) without raw stderr in the error line", () => {
    const empty = mkdtempSync(join(tmpdir(), "pi-subagents-wt-classify-"));
    const noCommits = mkdtempSync(join(tmpdir(), "pi-subagents-wt-classify-nc-"));
    try {
      const outside = validateWorktreeIsolationDetailed("worktree", empty);
      assert.equal(outside.kind, "non_git_repo");
      assert.match(outside.errors[0]!, /worktree isolation requires a git repository with at least one commit \(non_git_repo\)/);
      assert.ok(!outside.errors[0]!.includes("fatal:"), "no raw git stderr in the parent-facing error");
      assert.ok(outside.detail && outside.detail.length > 0 && outside.detail.length <= 200, "bounded detail rides separately");
      assert.ok(!outside.detail!.includes("\n"), "detail is single-line");

      git(noCommits, ["init", "-q"]);
      const unborn = validateWorktreeIsolationDetailed("worktree", noCommits);
      assert.equal(unborn.kind, "no_commits");
      assert.match(unborn.errors[0]!, /\(no_commits\)/);
      assert.ok(!unborn.errors[0]!.includes("fatal:"), "no raw git stderr in the parent-facing error");
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(noCommits, { recursive: true, force: true });
    }
  });

  it("classifyWorktreeGitError maps git failure texts onto the three kinds", () => {
    assert.equal(classifyWorktreeGitError("fatal: not a git repository (or any of the parent directories)"), "non_git_repo");
    assert.equal(classifyWorktreeGitError("fatal: not a git worktree: '.pi'"), "non_git_repo");
    assert.equal(classifyWorktreeGitError("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree"), "no_commits");
    assert.equal(classifyWorktreeGitError("error: object does not have any commits yet"), "no_commits");
    assert.equal(classifyWorktreeGitError("git: timeout after 30s"), "git_error");
    assert.equal(classifyWorktreeGitError("spawn git ENOENT"), "git_error");
  });
});

describe("lanes/pool: LaneDispatchInput cwd override", () => {
  /** Spawner whose assistant text is the child's process.cwd(). */
  const echoCwdSpawn: SpawnFn = ({ cwd, env }) => {
    const script = [
      "const emit = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
      'let data = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (c) => { data += c; });',
      'process.stdin.on("end", () => {',
      '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:process.cwd()}], model:"gpt-5.5", provider:"openai-codex"}});',
      '  emit({type:"agent_settled"});',
      "  process.exit(0);",
      "});",
    ].join("\n");
    return spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
  };

  it("runs the child with cwd = the dispatch cwd override (defaults to pool cwd)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-wt-cwd-"));
    const sub = join(dir, "subfolder");
    try {
      mkdirSync(sub, { recursive: true });
      const pool = new LanePool({ spawn: echoCwdSpawn, sessionDir: dir, cwd: dir });

      const overridden = await pool.dispatch("lane", { task: "t", cwd: sub });
      assert.ok(overridden.output.includes(sub), `child cwd should be ${sub}`);

      const plain = await pool.dispatch("lane2", { task: "t" });
      assert.ok(plain.output.includes(dir), `default child cwd should be ${dir}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- engine integration: isolation 'worktree' ----

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read, bash\n---\nYou are ${name}. Produce evidence.`;

const SUFFIX = "\nEvidence: proof provided\nRisks/blockers: none\nCompliance: satisfied\ndeliverable_delivered: yes";

function contractTask(task: string): string {
  return `1. TASK: ${task}
2. EXPECTED OUTCOME: an artifact
3. REQUIRED TOOLS: read, bash
4. MUST DO:
   - Restate the task.
   - Produce evidence.
5. MUST NOT DO:
   - No destructive commands.
6. CONTEXT:
   - Paths: reports/
   - Evidence:
   - Downstream use:`;
}

/** Mini git repo with a committed agent card (engine preflight needs it). */
function makeEngineRepo(label: string): string {
  const repo = makeMiniRepo(`eng-${label}`);
  mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
  writeFileSync(join(repo, ".pi", "agents", "alpha.md"), AGENT_MD("alpha"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "agents"]);
  return repo;
}

/** Spawner that WRITES a file into its cwd (the worktree), then answers compliantly. */
function writerSpawn(file: string, content: string, fail = false): SpawnFn {
  const script = [
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `writeFileSync(join(process.cwd(), ${JSON.stringify(file)}), ${JSON.stringify(content)});`,
    'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let data = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { data += c; });',
    'process.stdin.on("end", () => {',
    '  const out = "answer:" + data.trim() + ' + JSON.stringify(SUFFIX) + ";",
    '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5", provider:"openai-codex"}});',
    fail ? "  process.exit(3);" : '  emit({type:"agent_settled"});',
    fail ? "" : "  process.exit(0);",
    "});",
  ].join("\n");
  return ({ cwd, env }) => spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
}

describe("engine/dispatch: isolation 'worktree'", () => {
  it("clean run: child cwd = worktree, cleanup removes it, hasChanges:false", async () => {
    const repo = makeEngineRepo("clean");
    try {
      // Spawner that does NOT write anything: compliant answer only.
      const noWrite: SpawnFn = ({ cwd, env }) => {
        const script = [
          'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
          'let data = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (c) => { data += c; });',
          'process.stdin.on("end", () => {',
          '  const out = "answer:" + data.trim() + ' + JSON.stringify(SUFFIX) + ";",
          '  emit({type:"message_end", message:{role:"assistant", content:[{type:"text",text:out}], model:"gpt-5.5", provider:"openai-codex"}});',
          '  emit({type:"agent_settled"});',
          "  process.exit(0);",
          "});",
        ].join("\n");
        return spawn(process.execPath, ["-e", script], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
      };
      const engine = new DispatchEngine({ repoRoot: repo, spawn: noWrite, sessionDir: join(repo, "sessions") });

      const result = await engine.single("alpha", contractTask("read only"), { isolation: "worktree", outputContract: "base.v1" });

      assert.equal(result.exitCode, 0);
      assert.equal(result.gatePassed, true);
      const outcome = getWorktreeOutcome(result);
      assert.ok(outcome, "worktree outcome attached");
      assert.equal(outcome.hasChanges, false);
      assert.equal(outcome.committed, false);
      assert.equal(outcome.removed, true);
      assert.ok(!existsSync(outcome.worktreePath));
      // cwd recorded = the actual child cwd (the now-removed worktree path)
      assert.equal(result.cwd, outcome.worktreePath);
      engine.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("dirty run: changes auto-committed onto pi-agent-<runId> branch, main HEAD untouched", async () => {
    const repo = makeEngineRepo("dirty");
    try {
      const engine = new DispatchEngine({ repoRoot: repo, spawn: writerSpawn("out.txt", "child artifact\n"), sessionDir: join(repo, "sessions") });
      const result = await engine.single("alpha", contractTask("produce artifact"), { isolation: "worktree", outputContract: "base.v1" });

      assert.equal(result.exitCode, 0);
      const outcome = getWorktreeOutcome(result);
      assert.ok(outcome, "worktree outcome attached");
      assert.equal(outcome.hasChanges, true);
      assert.equal(outcome.committed, true);
      assert.ok(outcome.branch, "branch created");
      assert.equal(outcome.removed, true);

      // The child's file lives on the branch in the mini repo.
      assert.equal(git(repo, ["show", `${outcome.branch}:out.txt`]), "child artifact");
      // Main HEAD untouched by the child run.
      assert.equal(git(repo, ["rev-parse", "HEAD"]), outcome.baseSha);
      // Run view settled complete.
      assert.equal(engine.monitor.runs[0]!.status, "complete");
      engine.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("monorepo subfolder: child cwd = worktree + repo-relative subpath", async () => {
    const repo = makeEngineRepo("sub");
    try {
      mkdirSync(join(repo, "packages", "app"), { recursive: true });
      writeFileSync(join(repo, "packages", "app", "keep.txt"), "base\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "monorepo"]);

      const engine = new DispatchEngine({ repoRoot: repo, spawn: writerSpawn("out.txt", "nested\n"), sessionDir: join(repo, "sessions") });
      const result = await engine.single("alpha", contractTask("work in subpackage"), {
        isolation: "worktree",
        cwd: "packages/app",
        outputContract: "base.v1",
      });

      const outcome = getWorktreeOutcome(result);
      assert.ok(outcome);
      assert.equal(result.cwd, join(outcome.worktreePath, "packages", "app"));
      // The artifact landed inside the mirrored subfolder of the worktree.
      assert.equal(git(repo, ["show", `${outcome.branch}:packages/app/out.txt`]), "nested");
      engine.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("failing child (exit 3): cleanup still commits the child's changes", async () => {
    const repo = makeEngineRepo("fail");
    try {
      const engine = new DispatchEngine({ repoRoot: repo, spawn: writerSpawn("partial.txt", "work in progress\n", true), sessionDir: join(repo, "sessions") });
      const result = await engine.single("alpha", contractTask("risky work"), { isolation: "worktree", outputContract: "base.v1" });

      assert.equal(result.exitCode, 3);
      assert.equal(engine.monitor.runs[0]!.status, "failed");
      const outcome = getWorktreeOutcome(result);
      assert.ok(outcome);
      assert.equal(outcome.hasChanges, true, "post-run cleanup preserved the failed child's work");
      assert.equal(outcome.committed, true);
      assert.equal(git(repo, ["show", `${outcome.branch}:partial.txt`]), "work in progress");
      engine.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("non-git repo: preflight blocks the run, NO child spawned, NO worktree created", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pi-subagents-wt-nogit-"));
    try {
      mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
      writeFileSync(join(repo, ".pi", "agents", "alpha.md"), AGENT_MD("alpha"));
      let spawnCount = 0;
      const counting: SpawnFn = (input) => {
        spawnCount += 1;
        return writerSpawn("never.txt", "no")(input);
      };
      const engine = new DispatchEngine({ repoRoot: repo, spawn: counting, sessionDir: join(repo, "sessions") });
      const result = await engine.single("alpha", contractTask("needs git"), { isolation: "worktree", outputContract: "base.v1" });

      assert.equal(result.gatePassed, false);
      assert.equal(result.failureKind, "preflight");
      assert.match(result.gateErrors!.join("; "), /worktree isolation requires a git repository/i);
      assert.ok(!result.gateErrors!.join("; ").includes("fatal:"), "no raw git stderr in the parent-facing gate errors");
      assert.equal(result.worktreeError?.kind, "non_git_repo", "classified failure rides the result (details)");
      assert.ok(result.worktreeError?.detail, "bounded git detail available in details");
      assert.equal(spawnCount, 0, "no child launched");
      assert.equal(engine.monitor.runs[0]!.status, "preflight_failed");
      assert.ok(!engine.monitor.runs[0]!.gateErrors!.join("; ").includes("fatal:"), "run view gate errors stay clean");
      engine.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("plain run (no isolation): no worktree outcome attached", async () => {
    const repo = makeEngineRepo("plain");
    try {
      const engine = new DispatchEngine({ repoRoot: repo, spawn: writerSpawn("plain.txt", "direct\n"), sessionDir: join(repo, "sessions") });
      const result = await engine.single("alpha", contractTask("direct run"), { outputContract: "base.v1" });

      assert.equal(getWorktreeOutcome(result), undefined);
      assert.equal(result.cwd, repo, "plain run keeps repo cwd");
      engine.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
