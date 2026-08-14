/**
 * src/models/scope.ts — the "model scope" gate (C3).
 *
 * Port of the benchmark model-scope semantics (nicopreme model-scope.ts:59 +
 * tintinweb enabled-models.ts) for pi-subagents:
 *
 *   - An EXPLICIT model override outside the `enabledModels` allowlist is an
 *     ERROR: `allowed:false` blocks dispatch (preflight_failed). The caller
 *     never silently reroutes an explicit request.
 *   - A model resolved from the AGENT definition, a routing CLASS, or
 *     INHERITED from the parent/session outside the allowlist is only a WARN:
 *     `allowed:true` with a recorded warning (never blocking). Declarative
 *     routing may fall back honestly; only explicit requests are held to the
 *     strict standard.
 *   - An absent or empty allowlist means the scope check is SKIPPED entirely
 *     (`allowed:true`, severity 'ok', no-op safety): a missing configuration
 *     must not fabricate a violation.
 *
 * Allowlist matching is EXACT on `provider/modelId` entries only (documented
 * tintinweb behavior): glob entries (`*`) and bare model ids (`gpt-4o` without
 * a provider) never match and are silently ignored as match candidates. The
 * check never normalizes providers, never expands globs, never fuzzy-matches.
 *
 * Pure module: zero @earendil-works/* imports, zero fs, zero child_process.
 * The settings source (pi global + project settings.json) is INJECTED through
 * the `EnabledModelsReader` interface; the concrete reader lives in
 * src/extension (the only layer allowed to read pi settings).
 */

/** Where the resolved model came from (mirrors the routing priority chain). */
export type ModelScopeSource = "explicit" | "agent" | "class" | "inherited";

/** Outcome severity: ok (in-scope or skipped), warn (non-blocking), error (blocking). */
export type ModelScopeSeverity = "ok" | "warn" | "error";

/** Result of a model scope check. */
export interface ModelScopeResult {
  /** False ONLY for an explicit out-of-scope model (blocks dispatch). */
  allowed: boolean;
  severity: ModelScopeSeverity;
  /** Human-readable, actionable reason (recorded on errors/warnings). */
  reason: string;
}

/**
 * Injectable source of the pi `enabledModels` allowlist. Concrete readers
 * live outside this pure module (src/extension reads the pi settings files:
 * project `.pi/settings.json` with priority over global `~/.pi/agent/settings.json`).
 * Returns the raw allowlist, or undefined when not configured. Implementations
 * must not throw; a read failure is reported as "not configured" (skip).
 */
export interface EnabledModelsReader {
  readEnabledModels(): readonly string[] | undefined;
}

/**
 * True when an allowlist entry is an exact `provider/modelId` string: exactly
 * one `/` with non-empty provider and model parts and no glob characters.
 * Globs and bare ids are NOT exact entries — they are silently ignored as
 * match candidates (documented tintinweb behavior).
 */
export function isExactModelEntry(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.includes("*")) return false;
  const parts = trimmed.split("/");
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
}

/** Normalize an allowlist: trimmed, non-empty entries (form check stays at match time). */
function normalizeAllowlist(allowedModels: readonly string[]): string[] {
  return allowedModels.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Check a resolved child model against the pi `enabledModels` allowlist.
 *
 *   - `allowedModels` undefined or effectively empty -> SKIP (allowed, 'ok').
 *   - `model` undefined/blank -> SKIP (nothing to validate).
 *   - Exact `provider/modelId` match -> allowed, 'ok'.
 *   - Out of scope + source 'explicit' -> NOT allowed, 'error' (blocking).
 *   - Out of scope + source 'agent'|'class'|'inherited' -> allowed, 'warn'
 *     (recorded, never blocking).
 *
 * Never throws; never probes availability; never reroutes.
 */
export function checkModelScope(
  model: string | undefined,
  allowedModels: readonly string[] | undefined,
  source: ModelScopeSource,
): ModelScopeResult {
  const target = model?.trim();
  if (!allowedModels || allowedModels.length === 0) {
    return {
      allowed: true,
      severity: "ok",
      reason: "model scope check skipped: no enabledModels allowlist configured (absent or empty)",
    };
  }
  const allowlist = normalizeAllowlist(allowedModels);
  if (allowlist.length === 0) {
    return {
      allowed: true,
      severity: "ok",
      reason: "model scope check skipped: no enabledModels allowlist configured (absent or empty)",
    };
  }
  if (!target) {
    return {
      allowed: true,
      severity: "ok",
      reason: "model scope check skipped: no model resolved",
    };
  }

  // Exact provider/modelId matching only; non-exact entries never match.
  const inScope = allowlist.some((entry) => isExactModelEntry(entry) && entry === target);
  if (inScope) {
    return {
      allowed: true,
      severity: "ok",
      reason: `model '${target}' (source ${source}) is within the enabledModels allowlist`,
    };
  }

  const listing = allowlist.join(", ");
  if (source === "explicit") {
    return {
      allowed: false,
      severity: "error",
      reason: `explicit model '${target}' is outside the enabledModels allowlist [${listing}]: explicit out-of-scope models block dispatch; choose a model from enabledModels (exact provider/modelId entries) or extend the allowlist`,
    };
  }
  return {
    allowed: true,
    severity: "warn",
    reason: `model '${target}' (source ${source}) is outside the enabledModels allowlist [${listing}]: proceeding with a recorded warning (non-blocking)`,
  };
}
