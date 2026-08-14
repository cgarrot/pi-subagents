/**
 * src/gates/types.ts — gate-local type definitions ported from the ZOB harness.
 * Kept out of src/core (which is frozen/ported) so the gates layer stays
 * self-contained. Zero @earendil-works/* imports, zero fs side effects.
 */

import type { ChildThinkingLevel } from "../core/types.js";

/** Agent descriptor consumed by the tool-allowlist gate. */
export interface HarnessAgent {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ChildThinkingLevel | string;
  prompt: string;
  source: "project" | "user";
  filePath: string;
}

/** Damage-control rule: a risky pattern and why it is blocked. */
export interface DamageRule {
  pattern: string;
  reason: string;
  ask?: boolean;
}

/** Damage-control rule set (safe subset; no bodies stored). */
export interface DamageRules {
  bashToolPatterns: DamageRule[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
}

/** Advisory budget sidecar carried by delegation / sandbox metadata. */
export interface BudgetSidecar {
  mode: "advisory";
  advisory: true;
  budgetEnforced: false;
  strictRequested: boolean;
  strictEnabled: false;
  raw?: string;
  maxCostUsd?: number;
  maxRuns?: number;
  maxDurationMs?: number;
  maxParallelChildren?: number;
}

/** A single required element of an output contract. */
export interface OutputRequirement {
  name: string;
  pattern: string;
  message: string;
}

/** A named output contract: an id, description, applicable agents, requirements. */
export interface OutputContract {
  id: string;
  description: string;
  agentNames: string[];
  required: OutputRequirement[];
}
