/**
 * src/engine/attestation.ts — C4: hash-verified run attestation sidecars.
 *
 * Inspired by the pi-background-tasks benchmark (`bg_run_pi_attested` writes
 * a local attestation sidecar after a successful run; reports/pi-subagents/
 * benchmark/deep/pi-background-tasks.md §4.2): every settled delegation run
 * gets a `pi-subagents.attestation.v1` sidecar at
 * `<ledgerDir>/attestations/<runId>.json` recording WHAT ran (agent/model/
 * exitCode/stopReason/status), WHEN (startedAt/endedAt) and at WHAT cost
 * (usage) — plus hash-only evidence of the artifacts: `outputHash` (sha-256
 * of the full child output) and `sessionHash` (sha-256 of the session file
 * when present).
 *
 * HASH-ONLY INVARIANT (I1): the sidecar NEVER contains a body — no output,
 * task, prompt, stderr, or escalation text; only sha-256 digests plus scalar
 * metadata. Like the benchmark, this is LOCAL EVIDENCE, not cryptographic
 * proof (no signing): it detects post-settle tampering of the output/session
 * and divergence between the sidecar and the ledger-recorded hashes.
 *
 * `verifyAttestation` recomputes digests from caller-provided artifacts and
 * returns detailed per-check results (name/ok/expected/actual); checks that
 * cannot be performed (missing artifact) are reported `skipped` and never
 * flip `valid`. `verifyAttestationSidecar` reads a sidecar ref and returns
 * `undefined` when absent/unreadable (clean fallback — callers expose
 * `verified` only when a sidecar exists and NEVER block on verification).
 *
 * Zero @earendil-works/* imports; uses only node:fs and node:path.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../core/hashing.js";
import type { ChildResult } from "../core/types.js";
import type { DelegationRunView } from "./runs.js";

/** Sidecar schema marker (versioned; bump on breaking shape changes). */
export const ATTESTATION_SCHEMA = "pi-subagents.attestation.v1";

/** Token usage snapshot copied into the sidecar (B4 run totals). */
export type AttestationUsage = ChildResult["usage"];

/**
 * The attestation sidecar payload. Hash-only: every field is a scalar or a
 * sha-256 digest — raw bodies are structurally absent (see invariant I1).
 */
export interface Attestation {
  schema: typeof ATTESTATION_SCHEMA;
  runId: string;
  agent: string;
  model?: string;
  exitCode: number;
  stopReason?: string;
  /** sha-256 of the FULL child output (undefined when the output was empty). */
  outputHash?: string;
  /** sha-256 of the session file contents when the file exists at settle. */
  sessionHash?: string;
  usage: AttestationUsage;
  /** ISO timestamps of the run view start/end. */
  startedAt: string;
  endedAt: string;
  /** Terminal run status at settle (complete/failed/aborted/steered/escalated). */
  status: string;
}

/** One named verification outcome (detailed checks for consumers). */
export interface AttestationCheck {
  name: string;
  ok: boolean;
  expected?: string;
  actual?: string;
  /** True when the check could not be performed (missing artifact) — never flips `valid`. */
  skipped?: boolean;
}

/** Artifacts to verify against; each is optional (absent => skipped check). */
export interface VerifyAttestationOptions {
  /** Raw child output — recomputed to sha-256 and compared to `outputHash`. */
  output?: string;
  /**
   * Known digest of the child output (e.g. the run-view/ledger `outputHash`)
   * used when the raw body is unavailable — compared directly.
   */
  outputHash?: string;
  /** Session file path — contents re-hashed and compared to `sessionHash`. */
  sessionFile?: string;
}

/** Result of `verifyAttestation`: overall validity + per-check detail. */
export interface AttestationVerification {
  valid: boolean;
  checks: AttestationCheck[];
}

/** Sidecar-level verification result (ref + mismatch names for responses). */
export interface SidecarVerification {
  ref: string;
  verified: boolean;
  mismatches: string[];
  checks: AttestationCheck[];
}

/** Read a text file as utf8; undefined when missing/unreadable (never throws). */
function readFileUtf8(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Build the hash-only attestation for a settled run. `run` supplies the
 * lifecycle view (id/status/timestamps/sessionPath); `result` supplies the
 * settled child facts (agent/model/exitCode/stopReason/usage/output). The
 * session hash is taken from the session file WHEN PRESENT (absent file =>
 * `sessionHash` omitted, not an error). NEVER stores a body.
 */
export function buildAttestation(run: DelegationRunView, result: ChildResult): Attestation {
  const sessionPath = result.sessionPath ?? run.sessionPath;
  const sessionContent = sessionPath ? readFileUtf8(sessionPath) : undefined;
  return {
    schema: ATTESTATION_SCHEMA,
    runId: run.id,
    agent: result.agent || run.agent,
    model: result.model ?? run.model,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    outputHash: result.output ? sha256(result.output) : undefined,
    sessionHash: sessionContent !== undefined ? sha256(sessionContent) : undefined,
    usage: { ...result.usage },
    startedAt: new Date(run.startedAtMs).toISOString(),
    endedAt: new Date(run.endedAtMs ?? run.startedAtMs).toISOString(),
    status: run.status,
  };
}

/**
 * Write the sidecar to `<dir>/<runId>.json` ATOMICALLY (tmp file + rename in
 * the same directory) and return the final path. Creates the directory when
 * missing. Throws on fs errors — callers treat the write as best-effort.
 */
export function writeAttestationSidecar(dir: string, attestation: Attestation): string {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${attestation.runId}.json`);
  const tmpPath = join(dir, `.${attestation.runId}.json.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * Verify an attestation against caller-provided artifacts by RECOMPUTING the
 * digests and comparing. Checks:
 *   - `schema`      — always present;
 *   - `outputHash`  — present when attested: raw `output` re-hashed, or the
 *                     known `outputHash` digest compared directly; skipped
 *                     (never invalid) when neither is supplied;
 *   - `sessionHash` — present when attested: `sessionFile` contents re-hashed;
 *                     skipped when no file supplied or it is unreadable.
 * `valid` is true iff no performed check failed.
 */
export function verifyAttestation(attestation: Attestation, options: VerifyAttestationOptions = {}): AttestationVerification {
  const checks: AttestationCheck[] = [];
  checks.push({
    name: "schema",
    ok: attestation.schema === ATTESTATION_SCHEMA,
    expected: ATTESTATION_SCHEMA,
    actual: attestation.schema,
  });

  if (attestation.outputHash !== undefined) {
    if (typeof options.output === "string") {
      const actual = sha256(options.output);
      checks.push({ name: "outputHash", ok: actual === attestation.outputHash, expected: attestation.outputHash, actual });
    } else if (typeof options.outputHash === "string") {
      checks.push({
        name: "outputHash",
        ok: options.outputHash === attestation.outputHash,
        expected: attestation.outputHash,
        actual: options.outputHash,
      });
    } else {
      checks.push({ name: "outputHash", ok: true, skipped: true, expected: attestation.outputHash });
    }
  }

  if (attestation.sessionHash !== undefined) {
    if (typeof options.sessionFile === "string") {
      const content = readFileUtf8(options.sessionFile);
      if (content === undefined) {
        checks.push({ name: "sessionHash", ok: true, skipped: true, expected: attestation.sessionHash, actual: "<unreadable>" });
      } else {
        const actual = sha256(content);
        checks.push({ name: "sessionHash", ok: actual === attestation.sessionHash, expected: attestation.sessionHash, actual });
      }
    } else {
      checks.push({ name: "sessionHash", ok: true, skipped: true, expected: attestation.sessionHash });
    }
  }

  return { valid: checks.every((check) => check.ok), checks };
}

/**
 * Read and parse a sidecar file; undefined when absent/unreadable/invalid
 * (clean fallback — the caller simply reports no verification).
 */
export function readAttestationSidecar(ref: string): Attestation | undefined {
  const raw = readFileUtf8(ref);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record.schema === ATTESTATION_SCHEMA) return parsed as Attestation;
    }
  } catch {
    // invalid JSON -> no usable sidecar
  }
  return undefined;
}

/**
 * Read + verify a sidecar by ref. Returns undefined when the sidecar is
 * absent/unreadable (callers expose `verified` only when this returns a
 * result); otherwise the verification with `mismatches` listing the FAILED
 * check names. Never throws, never blocks the caller.
 */
export function verifyAttestationSidecar(ref: string, options: VerifyAttestationOptions = {}): SidecarVerification | undefined {
  const attestation = readAttestationSidecar(ref);
  if (!attestation) return undefined;
  const { valid, checks } = verifyAttestation(attestation, options);
  return {
    ref,
    verified: valid,
    mismatches: checks.filter((check) => !check.ok).map((check) => check.name),
    checks,
  };
}
