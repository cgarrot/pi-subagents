/**
 * src/models/catalog.ts — the "explicit verified model" gate.
 *
 * Port of the ZOB harness `validateExplicitModelOverride` (model-availability.ts)
 * for pi-subagents. In the harness the gate reads `.pi/model-catalog.json` from
 * the repo root directly; here the catalog source is INJECTED (a pure
 * `VerifiedModelCatalog` value) so this module stays free of fs and of any
 * Pi/harness import. The caller (NODE layer / registry) reads the file and
 * produces the `VerifiedModelCatalog` via `catalogFromParsed`.
 *
 * Security contract (the lock the oracle identified before any lanes spawn):
 *   - An EXPLICIT model override is verified against the catalog and BLOCKS
 *     with status 'model_unavailable' when it is missing, unreadable, absent,
 *     or not `resolutionStatus === 'verified'`.
 *   - There is NEVER a silent fallback for an explicit model. The explicit
 *     model either passes (honest `ok:true`) or blocks with remediation.
 *   - The A -> B -> parent fallback chain remains reserved to CLASS-based
 *     routing in routing.ts, never to an explicit request.
 *
 * Pure module: zero @earendil-works/* imports, zero fs, zero child_process.
 */
import { isRecord } from "../core/records.js";

/** Blocking status returned when an explicit model is not verified. */
export const EXPLICIT_MODEL_UNAVAILABLE = "model_unavailable" as const;

export type ExplicitModelStatus = typeof EXPLICIT_MODEL_UNAVAILABLE;

/** Honest remediation guidance attached to every blocking gate result. */
export const EXPLICIT_MODEL_REMEDIATION =
  "omit the model to use the parent/session default, or choose a model in the verified model catalog with resolutionStatus=verified after confirming current provider availability for this session";

/**
 * Injectable verified model catalog. `present` is false when no catalog file
 * exists; `readError` is set when the file existed but could not be parsed as
 * JSON; `models` is the model-id -> entry map when a readable catalog has one.
 */
export interface VerifiedModelCatalog {
  /** True when a catalog source is present (file exists). */
  present: boolean;
  /** Set when the source is present but could not be read as JSON. */
  readError?: string;
  /** model id -> entry. Only set for a readable catalog with a models object. */
  models?: Readonly<Record<string, Readonly<{ resolutionStatus?: string }>>>;
}

export type ExplicitModelVerification =
  | { ok: true; errors: readonly [] }
  | { ok: false; status: ExplicitModelStatus; errors: readonly string[]; remediation: string };

/**
 * Pure normalizer for an already-parsed catalog value (e.g. `JSON.parse` of a
 * model catalog file). Returns a `VerifiedModelCatalog` without reading any fs.
 * A non-record or a value without a `models` object yields `present:true` with
 * no `models` (the gate reports the missing-models case).
 */
export function catalogFromParsed(value: unknown): VerifiedModelCatalog {
  if (!isRecord(value)) return { present: true };
  const models = isRecord(value.models) ? value.models : undefined;
  if (!models) return { present: true };
  const normalized: Record<string, { resolutionStatus?: string }> = {};
  for (const [id, raw] of Object.entries(models)) {
    const entry = isRecord(raw) ? raw : undefined;
    if (entry) {
      normalized[id] = {
        resolutionStatus: typeof entry.resolutionStatus === "string" ? entry.resolutionStatus : undefined,
      };
    }
  }
  return { present: true, models: normalized };
}

/** Build a blocking gate result with a single case-specific reason. */
function unavailable(model: string, reason: string): ExplicitModelVerification {
  return {
    ok: false,
    status: EXPLICIT_MODEL_UNAVAILABLE,
    errors: [`explicit model override '${model}' is not allowed for child launch: ${reason}`],
    remediation: EXPLICIT_MODEL_REMEDIATION,
  };
}

/**
 * Verify an explicit model override against an injected `VerifiedModelCatalog`.
 *
 * Returns `{ok:true}` when no override is given, or when the override is
 * present in the catalog with `resolutionStatus === 'verified'`. Otherwise
 * returns a blocking `{ok:false, status:'model_unavailable', errors, remediation}`
 * result. Never falls back silently; never probes availability.
 */
export function validateExplicitModelOverride(
  modelOverride: string | undefined,
  catalog: VerifiedModelCatalog | undefined,
): ExplicitModelVerification {
  const model = modelOverride?.trim();
  if (!model) return { ok: true, errors: [] };

  if (!catalog) return unavailable(model, "verified model catalog is missing");
  if (!catalog.present) return unavailable(model, "verified model catalog is missing");
  if (catalog.readError) {
    return unavailable(model, `verified model catalog could not be read as JSON (${catalog.readError})`);
  }
  if (!catalog.models) return unavailable(model, "verified model catalog has no models object");

  const entry = catalog.models[model];
  if (!entry) return unavailable(model, "model is not present in the verified model catalog");

  if (entry.resolutionStatus !== "verified") {
    const status = entry.resolutionStatus ?? "missing";
    return unavailable(model, `catalog resolutionStatus is '${status}', not 'verified'`);
  }

  return { ok: true, errors: [] };
}
