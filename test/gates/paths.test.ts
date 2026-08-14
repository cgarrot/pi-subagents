import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  parsePathListEnv,
  resolveChildCwd,
  validateAllowedPathPolicy,
  validateForbiddenPathPolicy,
  validatePathPolicy,
} from "../../src/gates/paths.js";

const repoRoot = resolve("/repo/zob-harness");

describe("resolveChildCwd", () => {
  it("defaults to repo root", () => {
    const { cwd, errors } = resolveChildCwd(repoRoot, undefined);
    assert.equal(cwd, repoRoot);
    assert.deepEqual(errors, []);
  });
  it("accepts a repo-relative cwd", () => {
    const { cwd, errors } = resolveChildCwd(repoRoot, "packages/pi-subagents");
    assert.ok(cwd.startsWith(`${repoRoot}/`));
    assert.deepEqual(errors, []);
  });
  it("rejects an escaping cwd", () => {
    const { errors } = resolveChildCwd(repoRoot, "/tmp/outside");
    assert.deepEqual(errors, [`Child cwd must stay inside repo root. Requested: /tmp/outside`]);
  });
});

describe("validateAllowedPathPolicy", () => {
  it("accepts repo-relative allowed paths", () => {
    assert.deepEqual(validateAllowedPathPolicy(["packages/", "reports/"], "allowed", repoRoot), []);
  });
  it("rejects absolute and home paths", () => {
    const errors = validateAllowedPathPolicy(["/etc", "~/keys"], "allowed", repoRoot);
    assert.ok(errors.some((e) => e.includes("absolute and home paths are not allowed")), JSON.stringify(errors));
  });
  it("rejects broad roots", () => {
    const errors = validateAllowedPathPolicy([".", "./"], "allowed", repoRoot);
    assert.ok(errors.some((e) => e.includes("broad repo roots are not allowed")), JSON.stringify(errors));
  });
  it("F7: quotes the offending path so a broad root '.' never renders as '..'", () => {
    const errors = validateAllowedPathPolicy(["."], "allowed_paths", repoRoot);
    assert.ok(errors.length > 0, "a broad root must be rejected");
    const msg = errors.join("\n");
    assert.ok(msg.includes("stay inside repo root: `.`"), `path must be backtick-quoted in the message: ${msg}`);
    assert.ok(!msg.includes("repo root: .."), `ambiguous unquoted '..' form must be gone: ${msg}`);
  });
  it("rejects traversal segments", () => {
    const errors = validateAllowedPathPolicy(["packages/../.."], "allowed", repoRoot);
    assert.ok(errors.some((e) => e.includes("path traversal segments")), JSON.stringify(errors));
  });
  it("rejects NUL bytes", () => {
    const errors = validateAllowedPathPolicy(["packages/\0evil"], "allowed", repoRoot);
    assert.ok(errors.some((e) => e.includes("NUL bytes are not allowed")), JSON.stringify(errors));
  });
});

describe("validateForbiddenPathPolicy", () => {
  it("accepts specific deny patterns", () => {
    assert.deepEqual(validateForbiddenPathPolicy(["packages/pi-subagents/dist/"], "forbidden", repoRoot), []);
  });
  it("rejects broad deny patterns", () => {
    const errors = validateForbiddenPathPolicy(["/", "*", "**", "~"], "forbidden", repoRoot);
    assert.ok(errors.some((e) => e.includes("too broad for a deny-only pattern")), JSON.stringify(errors));
  });
  it("rejects repo-relative denies escaping the repo", () => {
    const errors = validateForbiddenPathPolicy(["../outside/"], "forbidden", repoRoot);
    assert.ok(errors.some((e) => e.includes("must stay inside repo root")), JSON.stringify(errors));
  });
  it("rejects NUL bytes", () => {
    const errors = validateForbiddenPathPolicy(["a\0b"], "forbidden", repoRoot);
    assert.ok(errors.some((e) => e.includes("contains a NUL byte")), JSON.stringify(errors));
  });
});

describe("validatePathPolicy", () => {
  it("behaves like the allowed-path validator", () => {
    assert.deepEqual(validatePathPolicy(["packages/"], "allowed", repoRoot), validateAllowedPathPolicy(["packages/"], "allowed", repoRoot));
    assert.ok(validatePathPolicy(["/etc"], "allowed", repoRoot).length > 0);
  });
});

describe("parsePathListEnv", () => {
  it("splits on comma, colon, and newline", () => {
    assert.deepEqual(parsePathListEnv("a,b:c\n d"), ["a", "b", "c", "d"]);
  });
  it("returns empty for empty input", () => {
    assert.deepEqual(parsePathListEnv(undefined), []);
    assert.deepEqual(parsePathListEnv(""), []);
  });
});
