import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDamageControlBlockMetadata,
  damageControlBodyLikeFieldViolations,
  loadDamageRules,
  persistDamageControlBlockFailClosed,
  validateDamageControlBlockMetadata,
  DEFAULT_RULES,
} from "../../src/gates/damage-control.js";

describe("DEFAULT_RULES", () => {
  it("carries expected damage-control rule sets", () => {
    assert.ok(DEFAULT_RULES.bashToolPatterns.some((r) => r.pattern.includes("rm")));
    assert.ok(DEFAULT_RULES.zeroAccessPaths.includes(".env"));
    assert.ok(DEFAULT_RULES.readOnlyPaths.includes("node_modules/"));
    assert.ok(DEFAULT_RULES.noDeletePaths.includes(".git/"));
  });
});

describe("loadDamageRules (injectable rules source)", () => {
  it("merges an injected object with defaults", () => {
    const rules = loadDamageRules("/tmp/cwd", { zeroAccessPaths: ["secrets/"] });
    assert.deepEqual(rules.zeroAccessPaths, ["secrets/"]);
    assert.deepEqual(rules.readOnlyPaths, DEFAULT_RULES.readOnlyPaths);
  });
  it("parses an injected JSON string", () => {
    const rules = loadDamageRules("/tmp/cwd", JSON.stringify({ noDeletePaths: ["LOCK.md"] }));
    assert.deepEqual(rules.noDeletePaths, ["LOCK.md"]);
    assert.deepEqual(rules.bashToolPatterns, DEFAULT_RULES.bashToolPatterns);
  });
  it("falls back to defaults on invalid JSON", () => {
    const rules = loadDamageRules("/tmp/cwd", "{ not json");
    assert.deepEqual(rules, DEFAULT_RULES);
  });
  it("falls back to defaults when no source given and no file present", () => {
    const rules = loadDamageRules("/tmp/definitely-not-a-repo-root");
    assert.deepEqual(rules, DEFAULT_RULES);
  });
});

describe("damageControlBodyLikeFieldViolations", () => {
  it("flags body-like fields", () => {
    const violations = damageControlBodyLikeFieldViolations({ command: "rm -rf", meta: { prompt: "x" } });
    assert.deepEqual(violations, ["$.command", "$.meta.prompt"]);
  });
  it("ignores hash/digest/bodyStored fields", () => {
    const violations = damageControlBodyLikeFieldViolations({ argumentHash: "a".repeat(64), bodyStored: false });
    assert.deepEqual(violations, []);
  });
  it("returns empty for primitive/undefined input", () => {
    assert.deepEqual(damageControlBodyLikeFieldViolations(null), []);
    assert.deepEqual(damageControlBodyLikeFieldViolations(undefined), []);
    assert.deepEqual(damageControlBodyLikeFieldViolations(42), []);
  });
});

describe("validateDamageControlBlockMetadata", () => {
  const valid = buildDamageControlBlockMetadata({
    toolName: "bash",
    currentMode: "implement",
    reasonCode: "destructive_command",
    ruleIdentity: "default/rm",
    attemptedInput: { command: "rm -rf /" },
  });

  it("accepts a valid metadata object", () => {
    assert.deepEqual(validateDamageControlBlockMetadata(valid), []);
  });
  it("rejects an unknown field", () => {
    assert.deepEqual(validateDamageControlBlockMetadata({ ...valid, extra: true }), ["$.extra is not allowed"]);
  });
  it("rejects a body-like field", () => {
    const errors = validateDamageControlBlockMetadata({ ...valid, command: "x" });
    assert.ok(errors.some((e) => e === "$.command is a forbidden body-like field"), JSON.stringify(errors));
  });
  it("rejects a bad schema", () => {
    assert.deepEqual(validateDamageControlBlockMetadata({ ...valid, schema: "zob.other.v1" }), ["$.schema must equal zob.damage-control-block.v1"]);
  });
  it("rejects a non-object", () => {
    const errors = validateDamageControlBlockMetadata("nope");
    assert.ok(errors.includes("$ must be an object"));
  });
});

describe("buildDamageControlBlockMetadata", () => {
  it("builds a valid, hash-only block metadata", () => {
    const meta = buildDamageControlBlockMetadata({
      toolName: "bash",
      currentMode: "plan",
      reasonCode: "mode_blocked",
      ruleIdentity: "policy",
      attemptedInput: { cmd: "ls" },
    });
    assert.equal(meta.schema, "zob.damage-control-block.v1");
    assert.equal(meta.block, true);
    assert.equal(meta.executionPerformed, false);
    assert.equal(meta.bodyStored, false);
    assert.match(meta.ruleDigest, /^[a-f0-9]{64}$/);
    assert.match(meta.argumentHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(validateDamageControlBlockMetadata(meta), []);
  });
  it("counts array arguments", () => {
    const meta = buildDamageControlBlockMetadata({
      toolName: "bash",
      currentMode: "implement",
      reasonCode: "destructive_command",
      ruleIdentity: "r",
      attemptedInput: ["rm", "-rf", "/"],
    });
    assert.equal(meta.argumentCount, 3);
  });
});

describe("persistDamageControlBlockFailClosed", () => {
  const valid = buildDamageControlBlockMetadata({
    toolName: "bash",
    currentMode: "implement",
    reasonCode: "destructive_command",
    ruleIdentity: "r",
    attemptedInput: { command: "rm" },
  });

  it("appends and records telemetry on valid metadata", () => {
    let appended = 0;
    const result = persistDamageControlBlockFailClosed(valid, () => {
      appended += 1;
    });
    assert.deepEqual(result, { block: true, telemetryRecorded: true });
    assert.equal(appended, 1);
  });

  it("fails closed without telemetry on invalid metadata", () => {
    const result = persistDamageControlBlockFailClosed({ ...valid, extra: "bad" } as never, () => {
      throw new Error("should not be called");
    });
    assert.deepEqual(result, { block: true, telemetryRecorded: false });
  });

  it("fails closed when the append throws", () => {
    const result = persistDamageControlBlockFailClosed(valid, () => {
      throw new Error("append failed");
    });
    assert.deepEqual(result, { block: true, telemetryRecorded: false });
  });
});
