import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  buildChildEnv,
  createDiffGateResult,
  createRollbackMetadata,
  createSandboxMetadata,
  validateDelegationWriteScope,
  validateDelegateTaskWriteScope,
  validateRuntimeWritePolicy,
} from "../../src/gates/write-scope.js";

const repoRoot = resolve("/repo/zob-harness");

describe("validateRuntimeWritePolicy", () => {
  it("allows a target inside allowed paths", () => {
    const { allowed, violations } = validateRuntimeWritePolicy({
      targetPath: "packages/a.ts",
      cwd: repoRoot,
      allowedPaths: ["packages/"],
    });
    assert.equal(allowed, true);
    assert.deepEqual(violations, []);
  });

  it("blocks a zero-access path", () => {
    const { allowed, violations } = validateRuntimeWritePolicy({
      targetPath: ".env",
      cwd: repoRoot,
      zeroAccessPaths: [".env"],
    });
    assert.equal(allowed, false);
    assert.ok(violations.includes("zero-access path: .env"));
  });

  it("blocks a read-only path", () => {
    const { allowed, violations } = validateRuntimeWritePolicy({
      targetPath: "node_modules/x.js",
      cwd: repoRoot,
      readOnlyPaths: ["node_modules/"],
    });
    assert.equal(allowed, false);
    assert.ok(violations.includes("read-only path: node_modules/"));
  });

  it("blocks a forbidden path", () => {
    const { allowed, violations } = validateRuntimeWritePolicy({
      targetPath: "secrets/key.pem",
      cwd: repoRoot,
      forbiddenPaths: ["secrets/"],
    });
    assert.equal(allowed, false);
    assert.ok(violations.includes("forbidden path: secrets/"));
  });

  it("blocks outside allowed paths", () => {
    const { allowed, violations } = validateRuntimeWritePolicy({
      targetPath: "other/x.ts",
      cwd: repoRoot,
      allowedPaths: ["packages/"],
    });
    assert.equal(allowed, false);
    assert.ok(violations.some((v) => v.includes("outside allowed_paths")));
  });

  it("blocks outside sandbox root", () => {
    const { allowed, violations } = validateRuntimeWritePolicy({
      targetPath: "tmp/escape.txt",
      cwd: repoRoot,
      sandboxRoot: "sandbox",
    });
    assert.equal(allowed, false);
    assert.ok(violations.some((v) => v.includes("outside sandbox root")));
  });
});

describe("write-scope delegation gates", () => {
  it("requires allowed paths for write/edit tools", () => {
    assert.deepEqual(validateDelegationWriteScope("delegate_agent", ["write"], undefined), [
      "delegate_agent with write/edit tools requires non-empty allowed_paths",
    ]);
    assert.deepEqual(validateDelegateTaskWriteScope(["edit"], []), [
      "delegate_task with write/edit tools requires non-empty allowed_paths",
    ]);
  });
  it("allows write tools with allowed paths", () => {
    assert.deepEqual(validateDelegationWriteScope("delegate_agent", ["write"], ["packages/"]), []);
  });
  it("allows read-only tools without allowed paths", () => {
    assert.deepEqual(validateDelegationWriteScope("delegate_agent", ["read", "bash"], undefined), []);
  });
});

describe("metadata builders (injectable now)", () => {
  it("builds sandbox metadata with deterministic createdAt", () => {
    const meta = createSandboxMetadata(
      { runId: "r1", repoRoot, sandboxRoot: "sandbox", allowedPaths: ["packages/"] },
      "2024-01-01T00:00:00.000Z",
    );
    assert.equal(meta.schema, "zob.sandbox-metadata.v1");
    assert.equal(meta.runId, "r1");
    assert.equal(meta.createdAt, "2024-01-01T00:00:00.000Z");
    assert.equal(meta.budgetEnforced, false);
    assert.deepEqual(meta.allowedPaths, ["packages/"]);
  });

  it("builds diff-gate result with deterministic evaluatedAt", () => {
    const meta = createDiffGateResult({ runId: "r2", allowed: true, diffHash: "abc" }, "2024-02-02T00:00:00.000Z");
    assert.equal(meta.schema, "zob.diff-gate-result.v1");
    assert.equal(meta.evaluatedAt, "2024-02-02T00:00:00.000Z");
    assert.equal(meta.allowed, true);
  });

  it("builds rollback metadata with deterministic createdAt", () => {
    const meta = createRollbackMetadata({ runId: "r3", baseRef: "main" }, "2024-03-03T00:00:00.000Z");
    assert.equal(meta.schema, "zob.rollback-metadata.v1");
    assert.equal(meta.createdAt, "2024-03-03T00:00:00.000Z");
    assert.equal(meta.rollbackPrepared, true);
    assert.equal(meta.rollbackApplied, false);
  });
});

describe("buildChildEnv (injectable baseEnv)", () => {
  it("keeps only allowlisted base env keys plus ZOB vars", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/u", MY_SECRET: "x", ANTHROPIC_API_KEY: "sk-abc" };
    const env = buildChildEnv(repoRoot, { allowedPaths: ["packages/"], sandboxRoot: "sandbox" }, base);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/u");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-abc");
    assert.equal(env.MY_SECRET, undefined);
    assert.equal(env.ZOB_HARNESS_ROOT, repoRoot);
    assert.equal(env.ZOB_ALLOWED_PATHS, "packages/");
    assert.equal(env.ZOB_SANDBOX_ROOT, "sandbox");
  });

  it("omits path-policy vars when none provided", () => {
    const env = buildChildEnv(repoRoot, {}, { PATH: "/usr/bin" });
    assert.equal(env.ZOB_ALLOWED_PATHS, undefined);
    assert.equal(env.ZOB_FORBIDDEN_PATHS, undefined);
    assert.equal(env.ZOB_SANDBOX_ROOT, undefined);
  });
});
