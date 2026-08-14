/**
 * src/models/routing.ts — declarative child model resolution and honest
 * fallback chains (A -> B -> parent).
 *
 * Resolution priority (documented):
 *   explicitModel -> agentModel -> class model -> parentModel -> undefined.
 *
 * The fallback chain is built honestly and traced: the resolved result exposes
 * the actual model chosen and a `status` ('direct' or 'fallback'), plus the
 * ordered list of models tried, so callers (lanes) can record a visible
 * 'model_fallback' without hiding the fallback behind an opaque success.
 *
 * Pure module: zero @earendil-works/* imports, zero child_process.
 */
import { normalizeModelClass, type ModelClass } from "./classes.js";
import type { ModelScopeSource } from "./scope.js";

/** A mapping from pi-subagents class to its preferred model id. */
export type ModelByClassMap = Partial<Record<ModelClass, string>>;

export type ModelRouteStatus = "direct" | "fallback";

/**
 * Result of a model route decision. `model` is the effective model (may be the
 * parent sentinel), `tried` is the ordered list of candidate models considered.
 * status 'direct' means the first available candidate was chosen; 'fallback'
 * means a later chain entry (or parent) was selected. `source` reports WHICH
 * input won ('explicit' | 'agent' | 'class' | 'inherited'; the parent/session
 * default maps to 'inherited') so downstream gates (model scope, C3) can apply
 * source-dependent severity. Optional because chain-selection helpers do not
 * track provenance.
 */
export interface ModelRouteResult {
  model?: string;
  status: ModelRouteStatus;
  source?: ModelScopeSource;
  tried: readonly string[];
}

export interface ResolveChildModelInput {
  /** Explicit model override (highest priority). */
  explicitModel?: string;
  /** Model declared on the agent definition. */
  agentModel?: string;
  /** Requested routing class (pi-subagents or harness vocabulary). */
  modelClass?: ModelClass | string;
  /** Preferred model per class. */
  classModels?: ModelByClassMap;
  /** Fallback per-class map keyed by class name (normalized or harness). */
  modelByClass?: Partial<Record<string, string>>;
  /** Parent/session default model — used as the last-resort sentinel. */
  parentModel?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the child model with the documented priority
 * explicit -> agent -> class -> parent -> undefined.
 * Never throws; never probes availability.
 */
export function resolveChildModel(input: ResolveChildModelInput): ModelRouteResult {
  const explicitModel = nonEmpty(input.explicitModel);
  if (explicitModel) {
    return { model: explicitModel, status: "direct", source: "explicit", tried: [explicitModel] };
  }

  const agentModel = nonEmpty(input.agentModel);
  if (agentModel) {
    return { model: agentModel, status: "direct", source: "agent", tried: [agentModel] };
  }

  const normalizedClass = normalizeModelClass(input.modelClass);
  if (normalizedClass) {
    const candidates: string[] = [];
    const fromClassMap = nonEmpty(input.classModels?.[normalizedClass]);
    if (fromClassMap) candidates.push(fromClassMap);
    if (input.modelByClass) {
      const direct = nonEmpty(input.modelByClass[normalizedClass]);
      if (direct) candidates.push(direct);
      const harness = normalizeModelClass(normalizedClass);
      const harnessNames =
        harness === "cheap" ? ["cheap_scout"] :
        harness === "balanced" ? ["balanced_worker"] :
        ["strong_reasoning", "strong_oracle", "high_context"];
      for (const name of harnessNames) {
        const mapped = nonEmpty(input.modelByClass[name]);
        if (mapped) candidates.push(mapped);
      }
    }
    const unique: string[] = [];
    for (const candidate of candidates) {
      if (!unique.includes(candidate)) unique.push(candidate);
    }
    if (unique.length > 0) {
      return { model: unique[0], status: "direct", source: "class", tried: unique };
    }
  }

  const parentModel = nonEmpty(input.parentModel);
  if (parentModel) {
    return { model: parentModel, status: "fallback", source: "inherited", tried: [parentModel] };
  }

  return { model: undefined, status: "fallback", tried: [] };
}

/**
 * F3 quota-safe default class models: map EVERY class (cheap/balanced/
 * capable) to the parent/session model. Availability rationale: the parent
 * model is the one model guaranteed available for this session (the parent
 * runs on it), so a class-routed child never silently switches provider or
 * burns a different provider's quota (the F3 bug: ollama-cloud parent spawning
 * openai-codex children). Hosts that want per-class routing pass an explicit
 * `classModels` map, which REPLACES this default entirely.
 */
export function parentInheritingClassModels(parentModel: string | undefined): ModelByClassMap | undefined {
  const model = nonEmpty(parentModel);
  return model ? { cheap: model, balanced: model, capable: model } : undefined;
}

/**
 * Build the honest fallback chain for a class: [preferred (A), ...classChain
 * (B), parent]. Duplicates are removed preserving order; empty/undefined
 * entries are skipped. The parent is always the final sentinel and is never
 * probed by callers.
 */
export function buildModelFallbackChain(
  preferred: string | undefined,
  classChain: readonly (string | undefined)[],
  parentModel: string | undefined,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    chain.push(trimmed);
  };
  push(preferred);
  for (const candidate of classChain) push(candidate);
  push(parentModel);
  return chain;
}

/**
 * Select the effective model from a fallback chain, marking direct vs fallback.
 *
 * An availability predicate (default: everything is available) lets callers
 * honestly skip candidates that were already ruled out (e.g. via the shared
 * availability cache), so a later chain entry is marked 'fallback'. The parent
 * sentinel, when reached, means "reuse the parent session / no dedicated child".
 *
 * 'direct' means the very first candidate in the chain was selected;
 * 'fallback' means a later candidate (or the parent sentinel) was selected.
 */
export function selectModelFromChain(
  chain: readonly string[],
  parentModel: string | undefined,
  isAvailable: (model: string) => boolean = () => true,
): ModelRouteResult {
  const parent = nonEmpty(parentModel);
  const tried: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const model = nonEmpty(chain[i]);
    if (!model) continue;
    tried.push(model);
    if (!isAvailable(model)) continue;
    if (parent && model === parent) {
      // Parent sentinel: reuse parent session, do not spawn a dedicated child.
      return { model, status: "fallback", tried };
    }
    // First available non-parent candidate wins; index > 0 => fallback.
    return { model, status: i === 0 ? "direct" : "fallback", tried };
  }
  return { model: undefined, status: "fallback", tried };
}
