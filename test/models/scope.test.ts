// test/models/scope.test.ts — C3 model scope gate: source-dependent severity,
// exact provider/modelId matching only, skip on absent/empty allowlist.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkModelScope,
  isExactModelEntry,
  type EnabledModelsReader,
  type ModelScopeSource,
} from "../../src/models/index.js";

const ALLOW = ["openai/gpt-4o", "anthropic/claude-sonnet-4"];

/** Fake reader (settings reading is delegated; models stays fs-free). */
function fakeReader(list?: string[]): EnabledModelsReader {
  return { readEnabledModels: () => list };
}

describe("scope: checkModelScope skip semantics (no-op safety)", () => {
  it("skips (allowed, ok) when the allowlist is undefined", () => {
    const result = checkModelScope("openai/gpt-4o", undefined, "explicit");
    assert.equal(result.allowed, true);
    assert.equal(result.severity, "ok");
    assert.match(result.reason, /skipped/);
  });

  it("skips (allowed, ok) when the allowlist is an empty array", () => {
    for (const source of ["explicit", "agent", "class", "inherited"] as const) {
      const result = checkModelScope("openai/gpt-4o", [], source);
      assert.equal(result.allowed, true);
      assert.equal(result.severity, "ok");
      assert.match(result.reason, /skipped/);
    }
  });

  it("skips when the allowlist contains only blank entries (effectively empty)", () => {
    const result = checkModelScope("openai/gpt-4o", ["  ", ""], "explicit");
    assert.equal(result.allowed, true);
    assert.equal(result.severity, "ok");
  });

  it("skips when no model resolved", () => {
    const result = checkModelScope(undefined, ALLOW, "explicit");
    assert.equal(result.allowed, true);
    assert.equal(result.severity, "ok");
    assert.match(result.reason, /no model resolved/);
  });
});

describe("scope: checkModelScope in-scope (exact provider/modelId only)", () => {
  it("allows every source when the model is an exact allowlist entry", () => {
    for (const source of ["explicit", "agent", "class", "inherited"] as const) {
      const result = checkModelScope("anthropic/claude-sonnet-4", ALLOW, source);
      assert.deepEqual(
        { allowed: result.allowed, severity: result.severity },
        { allowed: true, severity: "ok" },
        `source=${source}`,
      );
    }
  });

  it("trims the model before matching", () => {
    const result = checkModelScope("  openai/gpt-4o  ", ALLOW, "explicit");
    assert.equal(result.severity, "ok");
  });
});

describe("scope: checkModelScope source-dependent out-of-scope severity", () => {
  it("explicit out-of-scope -> ERROR (blocking)", () => {
    const result = checkModelScope("google/gemini", ALLOW, "explicit");
    assert.equal(result.allowed, false);
    assert.equal(result.severity, "error");
    assert.match(result.reason, /google\/gemini/);
    assert.match(result.reason, /explicit/);
    assert.match(result.reason, /enabledModels/);
  });

  it("agent out-of-scope -> WARN (allowed, non-blocking)", () => {
    const result = checkModelScope("google/gemini", ALLOW, "agent");
    assert.equal(result.allowed, true);
    assert.equal(result.severity, "warn");
    assert.match(result.reason, /google\/gemini/);
    assert.match(result.reason, /source agent/);
  });

  it("class out-of-scope -> WARN (allowed, non-blocking)", () => {
    const result = checkModelScope("google/gemini", ALLOW, "class");
    assert.equal(result.allowed, true);
    assert.equal(result.severity, "warn");
  });

  it("inherited out-of-scope -> WARN (allowed, non-blocking)", () => {
    const result = checkModelScope("google/gemini", ALLOW, "inherited");
    assert.equal(result.allowed, true);
    assert.equal(result.severity, "warn");
  });

  it("full source matrix: only explicit errors", () => {
    const matrix: Record<ModelScopeSource, "error" | "warn"> = {
      explicit: "error",
      agent: "warn",
      class: "warn",
      inherited: "warn",
    };
    for (const [source, expected] of Object.entries(matrix) as [ModelScopeSource, "error" | "warn"][]) {
      const result = checkModelScope("out/of-scope", ALLOW, source);
      assert.equal(result.severity, expected, `source=${source}`);
      assert.equal(result.allowed, expected === "warn", `allowed for source=${source}`);
    }
  });
});

describe("scope: exact matching only (globs and bare ids silently ignored)", () => {
  it("isExactModelEntry accepts exact provider/modelId only", () => {
    assert.equal(isExactModelEntry("openai/gpt-4o"), true);
    assert.equal(isExactModelEntry(" openai/gpt-4o "), true);
    assert.equal(isExactModelEntry("gpt-4o"), false, "bare id");
    assert.equal(isExactModelEntry("*"), false, "glob");
    assert.equal(isExactModelEntry("openai/*"), false, "provider glob");
    assert.equal(isExactModelEntry("*/gpt-4o"), false, "model glob");
    assert.equal(isExactModelEntry("openai/"), false, "empty model part");
    assert.equal(isExactModelEntry("/gpt-4o"), false, "empty provider part");
    assert.equal(isExactModelEntry("openai/x/y"), false, "more than one slash");
    assert.equal(isExactModelEntry(""), false, "empty");
  });

  it("a bare-id allowlist entry never matches a provider/modelId model", () => {
    const result = checkModelScope("openai/gpt-4o", ["gpt-4o"], "explicit");
    assert.equal(result.allowed, false);
    assert.equal(result.severity, "error");
  });

  it("a glob allowlist entry never matches anything (silently ignored)", () => {
    const result = checkModelScope("openai/gpt-4o", ["*"], "explicit");
    assert.equal(result.allowed, false);
    assert.equal(result.severity, "error");
    const warn = checkModelScope("openai/gpt-4o", ["*"], "agent");
    assert.equal(warn.severity, "warn");
  });

  it("a bare model id can never match an exact allowlist entry", () => {
    const result = checkModelScope("gpt-4o", ALLOW, "explicit");
    assert.equal(result.severity, "error");
  });

  it("matching is case- and whitespace-exact (no normalization)", () => {
    assert.equal(checkModelScope("OpenAI/gpt-4o", ALLOW, "explicit").severity, "error");
    assert.equal(checkModelScope("openai/gpt-4o ", ["openai/gpt-4o"], "explicit").severity, "ok");
  });

  it("mixed allowlists: only the exact entry can match", () => {
    const mixed = ["gpt-4o", "*", "anthropic/claude-sonnet-4"];
    assert.equal(checkModelScope("anthropic/claude-sonnet-4", mixed, "explicit").severity, "ok");
    assert.equal(checkModelScope("gpt-4o", mixed, "explicit").severity, "error");
  });
});

describe("scope: EnabledModelsReader contract (injectable, fs-free models)", () => {
  it("a fake reader returning undefined drives the skip path", () => {
    const reader = fakeReader(undefined);
    const result = checkModelScope("any/model", reader.readEnabledModels(), "explicit");
    assert.equal(result.severity, "ok");
    assert.match(result.reason, /skipped/);
  });

  it("a fake reader returning a list drives exact matching", () => {
    const reader = fakeReader(["openai/gpt-4o"]);
    assert.equal(checkModelScope("openai/gpt-4o", reader.readEnabledModels(), "explicit").severity, "ok");
    assert.equal(checkModelScope("openai/other", reader.readEnabledModels(), "explicit").severity, "error");
  });
});
