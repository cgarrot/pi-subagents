import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RULES,
  blockedFeedback,
  parsePathListEnv,
  pathMatches,
  validateRuntimeWritePolicy,
} from "../../child/policy.js";

describe("DEFAULT_RULES", () => {
  it("carries the expected child-safety rule sets", () => {
    assert.ok(DEFAULT_RULES.bashToolPatterns.some((r) => r.pattern.includes("rm")));
    assert.ok(DEFAULT_RULES.bashToolPatterns.some((r) => r.reason === "privileged command"));
    assert.ok(DEFAULT_RULES.zeroAccessPaths.includes(".env"));
    assert.ok(DEFAULT_RULES.zeroAccessPaths.includes("~/.ssh"));
    assert.ok(DEFAULT_RULES.readOnlyPaths.includes("node_modules/"));
    assert.ok(DEFAULT_RULES.readOnlyPaths.includes("dist/"));
    assert.ok(DEFAULT_RULES.noDeletePaths.includes(".git/"));
  });
});

describe("pathMatches", () => {
  it("matches an exact relative path under the policy root", () => {
    assert.equal(pathMatches("/proj/src/a.ts", "src/a.ts", "/proj"), true);
  });
  it("matches an absolute path under the policy root", () => {
    assert.equal(pathMatches("/proj/src/a.ts", "/proj/src/a.ts", "/proj"), true);
  });
  it("matches a wildcard pattern", () => {
    assert.equal(pathMatches("/proj/src/a.ts", "src/*.ts", "/proj"), true);
    assert.equal(pathMatches("/proj/src/a.test.ts", "src/*.ts", "/proj"), true);
  });
  it("matches a directory prefix pattern ending in '/'", () => {
    assert.equal(pathMatches("/proj/src/a.ts", "src/", "/proj"), true);
    assert.equal(pathMatches("/proj/src/deep/b.ts", "src/", "/proj"), true);
  });
  it("does not match a path outside the pattern", () => {
    assert.equal(pathMatches("/proj/lib/b.ts", "src/*.ts", "/proj"), false);
  });
  it("matches zero-access relative names like .env", () => {
    assert.equal(pathMatches("/proj/.env", ".env", "/proj"), true);
  });
  it("matches wildcard suffix patterns like *.pem", () => {
    assert.equal(pathMatches("/proj/secrets/keys.pem", "*.pem", "/proj"), true);
  });
  it("respects an explicit policyRoot different from cwd", () => {
    assert.equal(pathMatches("/repo/.env", ".env", "/cwd", "/repo"), true);
    assert.equal(pathMatches("/cwd/local.ts", "src/a.ts", "/cwd", "/repo"), false);
  });
});

describe("parsePathListEnv", () => {
  it("splits on comma, colon and newline, trimming empties", () => {
    assert.deepEqual(parsePathListEnv("a,b:c\n d"), ["a", "b", "c", "d"]);
  });
  it("returns [] for undefined, empty or blank input", () => {
    assert.deepEqual(parsePathListEnv(undefined), []);
    assert.deepEqual(parsePathListEnv(""), []);
    assert.deepEqual(parsePathListEnv("   "), []);
  });
});

describe("validateRuntimeWritePolicy", () => {
  it("allows a target inside allowed_paths", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/src/a.ts",
      cwd: "/proj",
      policyRoot: "/proj",
      allowedPaths: ["src/"],
    });
    assert.deepEqual(result, { allowed: true, violations: [] });
  });

  it("blocks a target outside allowed_paths", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/lib/b.ts",
      cwd: "/proj",
      policyRoot: "/proj",
      allowedPaths: ["src/"],
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.violations, ["outside allowed_paths: src/"]);
  });

  it("blocks a forbidden path", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/.env",
      cwd: "/proj",
      policyRoot: "/proj",
      forbiddenPaths: [".env"],
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.violations, ["forbidden path: .env"]);
  });

  it("blocks a zero-access path", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/secrets/keys.pem",
      cwd: "/proj",
      policyRoot: "/proj",
      zeroAccessPaths: ["*.pem"],
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.violations, ["zero-access path: *.pem"]);
  });

  it("blocks a read-only path", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/node_modules/x/index.js",
      cwd: "/proj",
      policyRoot: "/proj",
      readOnlyPaths: ["node_modules/"],
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.violations, ["read-only path: node_modules/"]);
  });

  it("blocks a target outside the sandbox root", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/outside.js",
      cwd: "/proj",
      policyRoot: "/proj",
      sandboxRoot: "sandbox",
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.violations, ["outside sandbox root: sandbox"]);
  });

  it("allows a target inside the sandbox root", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/sandbox/in.js",
      cwd: "/proj",
      policyRoot: "/proj",
      sandboxRoot: "sandbox",
    });
    assert.deepEqual(result, { allowed: true, violations: [] });
  });

  it("aggregates multiple violations", () => {
    const result = validateRuntimeWritePolicy({
      targetPath: "/proj/.env",
      cwd: "/proj",
      policyRoot: "/proj",
      forbiddenPaths: [".env"],
      zeroAccessPaths: [".env"],
    });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.violations, ["zero-access path: .env", "forbidden path: .env"]);
  });
});

describe("blockedFeedback", () => {
  it("reports the tool, reason, and attempted value", () => {
    const msg = blockedFeedback("write", "zero-access path: .env", "/proj/.env");
    assert.ok(msg.includes("ZOB child safety blocked write: zero-access path: .env"));
    assert.ok(msg.includes("Attempted: /proj/.env"));
    assert.ok(msg.includes("Continue safely:"));
    assert.ok(msg.includes("Do not retry the same blocked call."));
  });
});
