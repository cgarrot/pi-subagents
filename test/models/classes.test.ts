// test/models/classes.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLASS_TO_HARNESS_CLASSES,
  HARNESS_TO_CLASS,
  isModelClass,
  MODEL_CLASSES,
  modelClassToHarnessClasses,
  normalizeModelClass,
} from "../../src/models/index.js";

describe("classes: vocabulary", () => {
  it("defines cheap/balanced/capable", () => {
    assert.deepEqual([...MODEL_CLASSES], ["cheap", "balanced", "capable"]);
  });

  it("maps each pi-subagents class to harness classes", () => {
    assert.deepEqual(CLASS_TO_HARNESS_CLASSES.cheap, ["cheap_scout"]);
    assert.deepEqual(CLASS_TO_HARNESS_CLASSES.balanced, ["balanced_worker"]);
    assert.deepEqual(CLASS_TO_HARNESS_CLASSES.capable, [
      "strong_reasoning",
      "strong_oracle",
      "high_context",
    ]);
  });

  it("reverses harness classes back to pi-subagents classes", () => {
    assert.equal(HARNESS_TO_CLASS.cheap_scout, "cheap");
    assert.equal(HARNESS_TO_CLASS.balanced_worker, "balanced");
    assert.equal(HARNESS_TO_CLASS.strong_reasoning, "capable");
    assert.equal(HARNESS_TO_CLASS.strong_oracle, "capable");
    assert.equal(HARNESS_TO_CLASS.high_context, "capable");
  });
});

describe("classes: normalization", () => {
  it("accepts pi-subagents vocabulary", () => {
    assert.equal(normalizeModelClass("cheap"), "cheap");
    assert.equal(normalizeModelClass("balanced"), "balanced");
    assert.equal(normalizeModelClass("capable"), "capable");
  });

  it("accepts harness vocabulary", () => {
    assert.equal(normalizeModelClass("cheap_scout"), "cheap");
    assert.equal(normalizeModelClass("balanced_worker"), "balanced");
    assert.equal(normalizeModelClass("strong_reasoning"), "capable");
    assert.equal(normalizeModelClass("strong_oracle"), "capable");
    assert.equal(normalizeModelClass("high_context"), "capable");
  });

  it("returns undefined for unknown classes", () => {
    assert.equal(normalizeModelClass("super_duper"), undefined);
    assert.equal(normalizeModelClass(undefined), undefined);
    assert.equal(normalizeModelClass(42), undefined);
  });

  it("isModelClass narrows only the coarse classes", () => {
    assert.equal(isModelClass("cheap"), true);
    assert.equal(isModelClass("capable"), true);
    assert.equal(isModelClass("cheap_scout"), false);
  });

  it("modelClassToHarnessClasses returns the mapped list", () => {
    assert.deepEqual(modelClassToHarnessClasses("capable"), [
      "strong_reasoning",
      "strong_oracle",
      "high_context",
    ]);
    assert.deepEqual(modelClassToHarnessClasses("bogus"), []);
  });
});
