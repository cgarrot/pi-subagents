/**
 * src/models/classes.ts — model class definitions and vocabulary normalization.
 *
 * pi-subagents normalizes the ZOB harness model-class vocabulary
 * (cheap_scout / balanced_worker / strong_reasoning / strong_oracle /
 * high_context) into three coarse routing classes:
 *
 *   - cheap     -> cheap_scout
 *   - balanced  -> balanced_worker
 *   - capable   -> strong_reasoning, strong_oracle, high_context
 *
 * Pure module: zero @earendil-works/* imports, zero child_process, zero fs
 * side effects.
 */

export const MODEL_CLASSES = ["cheap", "balanced", "capable"] as const;

/** Coarse routing class used across pi-subagents lanes. */
export type ModelClass = (typeof MODEL_CLASSES)[number];

/** Exact vocabulary used by the ZOB harness model router. */
export const HARNESS_CLASSES = [
  "cheap_scout",
  "balanced_worker",
  "strong_reasoning",
  "strong_oracle",
  "high_context",
] as const;

export type HarnessClass = (typeof HARNESS_CLASSES)[number];

/** pi-subagents class -> harness class names that map onto it. */
export const CLASS_TO_HARNESS_CLASSES: Record<ModelClass, readonly HarnessClass[]> = {
  cheap: ["cheap_scout"],
  balanced: ["balanced_worker"],
  capable: ["strong_reasoning", "strong_oracle", "high_context"],
};

/** Harness class name -> pi-subagents class. */
export const HARNESS_TO_CLASS: Record<HarnessClass, ModelClass> = {
  cheap_scout: "cheap",
  balanced_worker: "balanced",
  strong_reasoning: "capable",
  strong_oracle: "capable",
  high_context: "capable",
};

export function isModelClass(value: unknown): value is ModelClass {
  return typeof value === "string" && (MODEL_CLASSES as readonly string[]).includes(value);
}

/**
 * Normalize a class identifier to a pi-subagents ModelClass. Accepts both the
 * pi-subagents vocabulary (cheap/balanced/capable) and the harness vocabulary
 * (cheap_scout/balanced_worker/strong_reasoning/strong_oracle/high_context).
 * Returns undefined for anything unrecognized.
 */
export function normalizeModelClass(value: unknown): ModelClass | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (isModelClass(trimmed)) return trimmed;
  if ((HARNESS_CLASSES as readonly string[]).includes(trimmed)) {
    return HARNESS_TO_CLASS[trimmed as HarnessClass];
  }
  return undefined;
}

/** List the harness classes that map onto a pi-subagents class. */
export function modelClassToHarnessClasses(value: unknown): readonly HarnessClass[] {
  const normalized = normalizeModelClass(value);
  if (!normalized) return [];
  return CLASS_TO_HARNESS_CLASSES[normalized];
}
