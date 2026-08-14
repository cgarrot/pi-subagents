// test/models/catalog.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPLICIT_MODEL_REMEDIATION,
  EXPLICIT_MODEL_UNAVAILABLE,
  catalogFromParsed,
  validateExplicitModelOverride,
  type ExplicitModelVerification,
  type VerifiedModelCatalog,
} from "../../src/models/index.js";

function blocking(verification: ExplicitModelVerification) {
  assert.equal(verification.ok, false);
  if (!verification.ok) {
    assert.equal(verification.status, EXPLICIT_MODEL_UNAVAILABLE);
    assert.equal(verification.remediation, EXPLICIT_MODEL_REMEDIATION);
    assert.ok(verification.errors.length >= 1);
  }
  return verification;
}

/** First gate error message (safe under noUncheckedIndexedAccess). */
function firstError(result: ExplicitModelVerification): string {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.length >= 1);
    return result.errors[0] ?? "";
  }
  return "";
}

const verifiedCatalog: VerifiedModelCatalog = {
  present: true,
  models: { "openai/gpt-4o": { resolutionStatus: "verified" }, "gpt-4o": { resolutionStatus: "verified" } },
};

describe("validateExplicitModelOverride: gate behavior", () => {
  it("passes with no override (empty result)", () => {
    const result = validateExplicitModelOverride(undefined, verifiedCatalog);
    assert.deepEqual(result, { ok: true, errors: [] });
    assert.equal(result.ok, true);
  });

  it("passes a verified explicit model", () => {
    const result = validateExplicitModelOverride("openai/gpt-4o", verifiedCatalog);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("blocks when the catalog is missing (undefined source)", () => {
    const result = blocking(validateExplicitModelOverride("openai/gpt-4o", undefined));
    assert.match(firstError(result), /catalog is missing/);
  });

  it("blocks when the catalog is absent (present=false)", () => {
    const result = blocking(validateExplicitModelOverride("openai/gpt-4o", { present: false }));
    assert.match(firstError(result), /catalog is missing/);
  });

  it("blocks when the catalog could not be read as JSON", () => {
    const result = blocking(validateExplicitModelOverride("openai/gpt-4o", { present: true, readError: "Unexpected token" }));
    assert.match(firstError(result), /could not be read as JSON/);
    assert.match(firstError(result), /Unexpected token/);
  });

  it("blocks when the catalog has no models object", () => {
    const result = blocking(validateExplicitModelOverride("openai/gpt-4o", { present: true }));
    assert.match(firstError(result), /no models object/);
  });

  it("blocks when the model is not present in the catalog", () => {
    const result = blocking(validateExplicitModelOverride("unknown/model", verifiedCatalog));
    assert.match(firstError(result), /not present/);
  });

  it("blocks when the model is present but not verified", () => {
    const catalog: VerifiedModelCatalog = {
      present: true,
      models: { "openai/gpt-4o": { resolutionStatus: "resolved" } },
    };
    const result = blocking(validateExplicitModelOverride("openai/gpt-4o", catalog));
    assert.match(firstError(result), /'resolved'/);
    assert.match(firstError(result), /not 'verified'/);
  });

  it("blocks when the model entry has no resolutionStatus", () => {
    const catalog: VerifiedModelCatalog = { present: true, models: { "openai/gpt-4o": {} } };
    const result = blocking(validateExplicitModelOverride("openai/gpt-4o", catalog));
    assert.match(firstError(result), /'missing', not 'verified'/);
  });

  it("trims whitespace around the override", () => {
    assert.equal(validateExplicitModelOverride("  openai/gpt-4o  ", verifiedCatalog).ok, true);
    assert.equal(validateExplicitModelOverride("   ", verifiedCatalog).ok, true);
  });
});

describe("catalogFromParsed: pure normalization", () => {
  it("normalizes a valid parsed catalog", () => {
    const catalog = catalogFromParsed({
      schema: "zob.model-catalog.v1",
      models: {
        "openai/gpt-4o": { resolutionStatus: "verified", provider: "openai" },
        "other/model": { resolutionStatus: "resolved" },
      },
    });
    assert.equal(catalog.present, true);
    assert.equal(catalog.models?.["openai/gpt-4o"]?.resolutionStatus, "verified");
    assert.equal(catalog.models?.["other/model"]?.resolutionStatus, "resolved");
  });

  it("drops non-record model entries", () => {
    const catalog = catalogFromParsed({ models: { "bad/model": "not-an-object", "good/model": { resolutionStatus: "verified" } } });
    assert.equal(catalog.models?.["bad/model"], undefined);
    assert.equal(catalog.models?.["good/model"]?.resolutionStatus, "verified");
  });

  it("yields present without models for a non-record or model-less value", () => {
    assert.deepEqual(catalogFromParsed("nope"), { present: true });
    assert.deepEqual(catalogFromParsed(null), { present: true });
    assert.deepEqual(catalogFromParsed({}), { present: true });
  });
});

describe("validateExplicitModelOverride: no silent fallback for explicit", () => {
  it("never falls back when a non-verified explicit model is requested", () => {
    const catalog: VerifiedModelCatalog = {
      present: true,
      models: { "balanced/model": { resolutionStatus: "verified" } },
    };
    // Explicit request for an unavailable model must BLOCK, not fall to the verified one.
    const result = blocking(validateExplicitModelOverride("unavailable/model", catalog));
    assert.ok(firstError(result).includes("unavailable/model"));
  });
});
