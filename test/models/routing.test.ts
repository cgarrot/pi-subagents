// test/models/routing.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildModelFallbackChain,
  resolveChildModel,
  selectModelFromChain,
} from "../../src/models/index.js";

describe("routing: resolveChildModel priority", () => {
  const parent = "openai/gpt-4o";

  it("explicit model wins over everything", () => {
    const r = resolveChildModel({
      explicitModel: "anthropic/claude",
      agentModel: "agent/m1",
      modelClass: "capable",
      classModels: { capable: "class/m1" },
      parentModel: parent,
    });
    assert.equal(r.model, "anthropic/claude");
    assert.equal(r.status, "direct");
  });

  it("agent model wins over class and parent", () => {
    const r = resolveChildModel({
      agentModel: "agent/m1",
      modelClass: "balanced",
      classModels: { balanced: "class/m1" },
      parentModel: parent,
    });
    assert.equal(r.model, "agent/m1");
    assert.equal(r.status, "direct");
  });

  it("class model wins over parent", () => {
    const r = resolveChildModel({
      modelClass: "capable",
      classModels: { capable: "class/m1" },
      parentModel: parent,
    });
    assert.equal(r.model, "class/m1");
    assert.equal(r.status, "direct");
  });

  it("falls back to parent when class has no model", () => {
    const r = resolveChildModel({ modelClass: "cheap", parentModel: parent });
    assert.equal(r.model, parent);
    assert.equal(r.status, "fallback");
  });

  it("returns undefined when nothing resolves", () => {
    const r = resolveChildModel({});
    assert.equal(r.model, undefined);
    assert.equal(r.status, "fallback");
    assert.deepEqual(r.tried, []);
  });

  it("resolves class model via modelByClass keyed by class name", () => {
    const r = resolveChildModel({
      modelClass: "capable",
      modelByClass: { capable: "via-map/m1" },
      parentModel: parent,
    });
    assert.equal(r.model, "via-map/m1");
  });

  it("resolves class model via modelByClass keyed by harness vocabulary", () => {
    const r = resolveChildModel({
      modelClass: "strong_oracle",
      modelByClass: { strong_oracle: "oracle/m1" },
      parentModel: parent,
    });
    assert.equal(r.model, "oracle/m1");
  });
});

describe("routing: buildModelFallbackChain", () => {
  it("builds [A, B, parent] and drops empty/duplicate entries", () => {
    const chain = buildModelFallbackChain("A", ["B", "", "B"], "parent");
    assert.deepEqual(chain, ["A", "B", "parent"]);
  });

  it("handles missing primary and parent", () => {
    assert.deepEqual(buildModelFallbackChain(undefined, ["B"], undefined), ["B"]);
    assert.deepEqual(buildModelFallbackChain(undefined, [], undefined), []);
  });

  it("keeps parent as the final sentinel", () => {
    const chain = buildModelFallbackChain("A", ["B"], "P");
    assert.equal(chain[chain.length - 1], "P");
  });
});

describe("routing: selectModelFromChain", () => {
  it("marks the first candidate as direct", () => {
    const r = selectModelFromChain(["A", "B", "parent"], "parent");
    assert.equal(r.model, "A");
    assert.equal(r.status, "direct");
    assert.deepEqual(r.tried, ["A"]);
  });

  it("marks a later candidate as fallback when A is unavailable", () => {
    const r = selectModelFromChain(
      ["A", "B", "parent"],
      "parent",
      (model) => model !== "A",
    );
    assert.equal(r.model, "B");
    assert.equal(r.status, "fallback");
    assert.deepEqual(r.tried, ["A", "B"]);
  });

  it("falls back to the parent sentinel when all class candidates are unavailable", () => {
    const r = selectModelFromChain(
      ["A", "B", "parent"],
      "parent",
      (model) => model === "parent",
    );
    assert.equal(r.model, "parent");
    assert.equal(r.status, "fallback");
    assert.deepEqual(r.tried, ["A", "B", "parent"]);
  });

  it("returns the parent sentinel when the only candidate is the parent", () => {
    const r = selectModelFromChain(["parent"], "parent");
    assert.equal(r.model, "parent");
    assert.equal(r.status, "fallback");
    assert.deepEqual(r.tried, ["parent"]);
  });

  it("returns undefined for an empty chain", () => {
    const r = selectModelFromChain([], "parent");
    assert.equal(r.model, undefined);
    assert.equal(r.status, "fallback");
    assert.deepEqual(r.tried, []);
  });
});
