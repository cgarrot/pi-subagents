/**
 * src/gates/damage-control.ts — damage-control block metadata, body-like field
 * detection, and fail-closed persistence helpers, plus damage-rule loading.
 *
 * Pure helpers: damageControlBodyLikeFieldViolations,
 * validateDamageControlBlockMetadata, buildDamageControlBlockMetadata,
 * persistDamageControlBlockFailClosed. STATEFUL (fs): loadDamageRules — made
 * injectable via an optional `rulesSource` param so it stays testable. Zero
 * @earendil-works/* imports (the harness `getAgentDir` dependency is dropped).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../core/hashing.js";
import type { ModeName } from "../core/types.js";
import type { DamageRules } from "./types.js";

/** Default damage-control rules (ported from harness `core/constants.ts`). */
export const DEFAULT_RULES: DamageRules = {
  bashToolPatterns: [
    { pattern: "\\brm\\s+(-rf?|--recursive)", reason: "recursive deletion" },
    { pattern: "\\bgit\\s+reset\\s+--hard\\b", reason: "destructive git reset" },
    { pattern: "\\bgit\\s+clean\\s+-", reason: "destructive git clean" },
    { pattern: "\\bgit\\s+add\\s+(-A|\\.)", reason: "bulk git staging" },
    { pattern: "\\bsudo\\b", reason: "privileged command", ask: true },
  ],
  zeroAccessPaths: [".env", ".env.*", "~/.ssh", "~/.aws", "*.pem", "*.key"],
  readOnlyPaths: [".git/", "node_modules/", "dist/", "build/", "package-lock.json", "pnpm-lock.yaml", "bun.lock"],
  noDeletePaths: [".git/", "AGENTS.md", "README.md", ".pi/"],
};

/**
 * Load damage-control rules. STATEFUL via fs when `rulesSource` is absent
 * (reads `<cwd>/.pi/damage-control-rules.json`). When `rulesSource` is
 * provided (JSON string or Partial<DamageRules>) no fs read occurs, keeping
 * the function injectable and testable.
 */
export function loadDamageRules(cwd: string, rulesSource?: string | Partial<DamageRules>): DamageRules {
  let parsed: Partial<DamageRules> | undefined;
  if (rulesSource !== undefined) {
    if (typeof rulesSource === "string") {
      try {
        parsed = JSON.parse(rulesSource) as Partial<DamageRules>;
      } catch {
        return DEFAULT_RULES;
      }
    } else {
      parsed = rulesSource;
    }
  } else {
    const candidate = join(cwd, ".pi", "damage-control-rules.json");
    if (existsSync(candidate)) {
      try {
        parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<DamageRules>;
      } catch {
        return DEFAULT_RULES;
      }
    }
  }
  if (!parsed) return DEFAULT_RULES;
  return {
    bashToolPatterns: parsed.bashToolPatterns ?? DEFAULT_RULES.bashToolPatterns,
    zeroAccessPaths: parsed.zeroAccessPaths ?? DEFAULT_RULES.zeroAccessPaths,
    readOnlyPaths: parsed.readOnlyPaths ?? DEFAULT_RULES.readOnlyPaths,
    noDeletePaths: parsed.noDeletePaths ?? DEFAULT_RULES.noDeletePaths,
  };
}

export const DAMAGE_CONTROL_REASON_CODES = [
  "mode_blocked",
  "zero_access",
  "read_only",
  "protected_delete",
  "destructive_command",
  "approval_denied",
] as const;

export type DamageControlReasonCode = (typeof DAMAGE_CONTROL_REASON_CODES)[number];

export interface DamageControlBlockMetadata {
  schema: "zob.damage-control-block.v1";
  block: true;
  executionPerformed: false;
  currentMode: ModeName;
  toolName: string;
  reasonCode: DamageControlReasonCode;
  ruleDigest: string;
  argumentHash: string;
  argumentCount: number;
  bodyStored: false;
}

const DAMAGE_CONTROL_METADATA_FIELDS = new Set([
  "schema",
  "block",
  "executionPerformed",
  "currentMode",
  "toolName",
  "reasonCode",
  "ruleDigest",
  "argumentHash",
  "argumentCount",
  "bodyStored",
]);
const DAMAGE_CONTROL_BODY_LIKE_FIELDS = new Set([
  "command",
  "path",
  "input",
  "body",
  "prompt",
  "output",
  "stderr",
  "error",
  "diff",
  "patch",
  "message",
  "text",
  "content",
  "secret",
  "token",
  "password",
  "apikey",
  "authorization",
  "credential",
  "credentials",
]);
const DAMAGE_CONTROL_HASH_PATTERN = /^[a-f0-9]{64}$/;

function stableHashInput(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (typeof value === "undefined") return '"[undefined]"';
    const serialized = JSON.stringify(value);
    return serialized === undefined ? JSON.stringify(String(value)) : serialized;
  }
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableHashInput(entry, seen)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableHashInput((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
}

function damageControlArgumentCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object" && value !== null) return Object.keys(value).length;
  return value === undefined ? 0 : 1;
}

function damageControlFieldIsBodyLike(field: string): boolean {
  const normalized = field.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (normalized === "bodystored" || normalized.endsWith("hash") || normalized.endsWith("digest")) return false;
  return [...DAMAGE_CONTROL_BODY_LIKE_FIELDS].some((bodyLike) => (
    normalized === bodyLike || normalized.startsWith(bodyLike) || normalized.endsWith(bodyLike)
  )) || (normalized.startsWith("raw") && DAMAGE_CONTROL_BODY_LIKE_FIELDS.has(normalized.slice(3)));
}

/**
 * Detect body-like fields anywhere in a value (hash-only/body-free safety).
 * Returns a sorted list of field paths (empty when none are body-like).
 */
export function damageControlBodyLikeFieldViolations(value: unknown): string[] {
  const violations: string[] = [];
  const seen = new WeakSet<object>();

  function visit(candidate: unknown, path: string): void {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [field, entry] of Object.entries(candidate)) {
      const fieldPath = `${path}.${field}`;
      if (damageControlFieldIsBodyLike(field)) violations.push(fieldPath);
      visit(entry, fieldPath);
    }
  }

  visit(value, "$");
  return violations.sort();
}

/**
 * Validate a damage-control block metadata object: allowed fields only,
 * body-free posture, and correct scalar/hash constraints. Returns errors.
 */
export function validateDamageControlBlockMetadata(value: unknown): string[] {
  const errors = damageControlBodyLikeFieldViolations(value).map((path) => `${path} is a forbidden body-like field`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [...errors, "$ must be an object"];
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!DAMAGE_CONTROL_METADATA_FIELDS.has(field)) errors.push(`$.${field} is not allowed`);
  }
  if (record.schema !== "zob.damage-control-block.v1") errors.push("$.schema must equal zob.damage-control-block.v1");
  if (record.block !== true) errors.push("$.block must be true");
  if (record.executionPerformed !== false) errors.push("$.executionPerformed must be false");
  if (typeof record.currentMode !== "string" || record.currentMode.length === 0) errors.push("$.currentMode must be a non-empty mode");
  if (typeof record.toolName !== "string" || record.toolName.length === 0) errors.push("$.toolName must be a non-empty tool name");
  if (!DAMAGE_CONTROL_REASON_CODES.includes(record.reasonCode as DamageControlReasonCode)) errors.push("$.reasonCode must be a stable damage-control reason code");
  if (typeof record.ruleDigest !== "string" || !DAMAGE_CONTROL_HASH_PATTERN.test(record.ruleDigest)) errors.push("$.ruleDigest must be a lowercase sha256 hash");
  if (typeof record.argumentHash !== "string" || !DAMAGE_CONTROL_HASH_PATTERN.test(record.argumentHash)) errors.push("$.argumentHash must be a lowercase sha256 hash");
  if (!Number.isSafeInteger(record.argumentCount) || (record.argumentCount as number) < 0) errors.push("$.argumentCount must be a non-negative safe integer");
  if (record.bodyStored !== false) errors.push("$.bodyStored must be false");
  return [...new Set(errors)].sort();
}

/**
 * Build a valid damage-control block metadata object, throwing if the result
 * would not pass validation (fail-closed).
 */
export function buildDamageControlBlockMetadata(input: {
  toolName: string;
  currentMode: ModeName;
  reasonCode: DamageControlReasonCode;
  ruleIdentity: string;
  attemptedInput: unknown;
}): DamageControlBlockMetadata {
  const metadata: DamageControlBlockMetadata = {
    schema: "zob.damage-control-block.v1",
    block: true,
    executionPerformed: false,
    currentMode: input.currentMode,
    toolName: input.toolName,
    reasonCode: input.reasonCode,
    ruleDigest: sha256Hex(input.ruleIdentity),
    argumentHash: sha256Hex(stableHashInput(input.attemptedInput)),
    argumentCount: damageControlArgumentCount(input.attemptedInput),
    bodyStored: false,
  };
  const errors = validateDamageControlBlockMetadata(metadata);
  if (errors.length > 0) throw new Error(`unsafe damage-control metadata: ${errors.join("; ")}`);
  return metadata;
}

/**
 * Persist a damage-control block fail-closed through an injected append
 * callback. Returns whether telemetry was recorded.
 */
export function persistDamageControlBlockFailClosed(
  metadata: DamageControlBlockMetadata,
  appendEntry: (customType: "zob-damage-control", data: DamageControlBlockMetadata) => void,
): { block: true; telemetryRecorded: boolean } {
  try {
    const errors = validateDamageControlBlockMetadata(metadata);
    if (errors.length > 0) throw new Error(`unsafe damage-control metadata: ${errors.join("; ")}`);
    appendEntry("zob-damage-control", metadata);
    return { block: true, telemetryRecorded: true };
  } catch {
    return { block: true, telemetryRecorded: false };
  }
}
