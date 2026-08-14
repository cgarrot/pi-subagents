/**
 * src/shared/config.ts — pi-subagents configuration: named bounds, defaults,
 * `<cwd>/.subagents/config.json` + `SUBAGENTS_*` env overrides.
 *
 * Mirror of the pi-mesh `shared/config.ts` pattern (D17, §12): every numeric
 * bound is a named constant here, config.json is optional (graceful fallback
 * to defaults), and env overrides win over file values. Pure module: only
 * `node:fs` for the optional config.json read — no @earendil-works/* imports,
 * no child_process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---- Hard bounds (I8: named constants) ----
export const HARD_MIN_MAX_PARALLEL = 1;
export const HARD_MAX_MAX_PARALLEL = 8;
export const HARD_MIN_MAX_CHAIN = 1;
export const HARD_MAX_MAX_CHAIN = 16;
// B3 graceful turn limits: soft wrap-up steer at maxTurns, hard abort at
// maxTurns + graceTurns (benchmark tintinweb agent-runner.ts:316-321, 903-920).
export const HARD_MIN_MAX_TURNS = 1;
export const HARD_MAX_MAX_TURNS = 200;
export const HARD_MIN_GRACE_TURNS = 1;
export const HARD_MAX_GRACE_TURNS = 20;
// C1 nested subagents: maximum spawn DEPTH (0..4, default 2). 0/1 = off —
// a child at depth 1 can only spawn when depth < max, so max=2 allows exactly
// one nesting level (benchmark tintinweb nested-tools.ts maxSubagentDepth).
export const HARD_MIN_MAX_SUBAGENT_DEPTH = 0;
export const HARD_MAX_MAX_SUBAGENT_DEPTH = 4;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

// ---- Defaults ----
/** Default delegation scope. */
export const DEFAULT_SCOPE = "both" as const;
/** Default hot-pool parallelism (lanes). */
export const DEFAULT_MAX_PARALLEL = 4;
/** Default maximum chain length (sequential sub-tasks). */
export const DEFAULT_MAX_CHAIN = 8;
/** Default hash-only ledger directory, relative to cwd. */
export const DEFAULT_LEDGER_DIR = ".pi/logs/runs";
/** Default background-run retention / settle TTL (10 min). */
export const DEFAULT_BACKGROUND_TTL_MS = 10 * 60_000;
/** Default agent discovery directory, relative to cwd. */
export const DEFAULT_AGENTS_DIR = ".pi/agents";
/** Whether the hot-lane HUD is enabled (off by default in a pure core). */
export const DEFAULT_HUD = false;
/** Default class-level model fallback chain (cheap -> balanced -> capable). */
export const DEFAULT_MODEL_FALLBACK_CHAIN: readonly string[] = ["cheap", "balanced", "capable"];
/** B3: grace turns between the soft wrap-up steer and the hard abort. */
export const DEFAULT_GRACE_TURNS = 5;

/** Clamp a max-subagent-depth value into the hard bounds [0, 4] (default 2). */
export function clampMaxSubagentDepth(value: unknown): number {
  return clampInt(value, DEFAULT_MAX_SUBAGENT_DEPTH, HARD_MIN_MAX_SUBAGENT_DEPTH, HARD_MAX_MAX_SUBAGENT_DEPTH);
}

/** The config file path for a given cwd: `<cwd>/.subagents/config.json`. */
export function configFilePath(cwd: string): string {
  return join(cwd, ".subagents", "config.json");
}

export type Scope = "project" | "user" | "both";

/** Preferred model per routing class (empty string = no explicit model). */
export interface ModelClassMap {
  cheap: string;
  balanced: string;
  capable: string;
}

export interface SubagentsModelsConfig {
  /** Preferred model id per class ('' = fall back to parent/session). */
  classes: ModelClassMap;
  /** Ordered class-level fallback chain (A -> B -> ...). */
  fallbackChain: readonly string[];
}

export interface SubagentsConfig {
  defaultScope: Scope;
  maxParallel: number;
  maxChain: number;
  ledgerDir: string;
  backgroundTtlMs: number;
  defaultAgentsDir: string;
  hud: boolean;
  /**
   * B3 graceful turn-limit default (undefined = UNLIMITED). When set, an
   * assistant-turn count of `defaultMaxTurns` triggers the soft wrap-up steer;
   * bounded to [1, 200] when present (0/invalid = unlimited).
   */
  defaultMaxTurns?: number;
  /** B3 grace turns after the soft steer before the hard abort (1..20, default 5). */
  defaultGraceTurns: number;
  /**
   * C1 nested subagents: maximum spawn depth, clamped to [0, 4] (default 2).
   * 0/1 disable nesting entirely (the child `subagent` tool is never
   * registered: registration requires PI_SUBAGENTS_DEPTH < max).
   */
  maxSubagentDepth: number;
  models: SubagentsModelsConfig;
}

export const DEFAULT_MODEL_CLASSES: ModelClassMap = { cheap: "", balanced: "", capable: "" };

export const DEFAULT_CONFIG: SubagentsConfig = {
  defaultScope: DEFAULT_SCOPE,
  maxParallel: DEFAULT_MAX_PARALLEL,
  maxChain: DEFAULT_MAX_CHAIN,
  ledgerDir: DEFAULT_LEDGER_DIR,
  backgroundTtlMs: DEFAULT_BACKGROUND_TTL_MS,
  defaultAgentsDir: DEFAULT_AGENTS_DIR,
  hud: DEFAULT_HUD,
  defaultMaxTurns: undefined,
  defaultGraceTurns: DEFAULT_GRACE_TURNS,
  maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
  models: {
    classes: { ...DEFAULT_MODEL_CLASSES },
    fallbackChain: [...DEFAULT_MODEL_FALLBACK_CHAIN],
  },
};

// ---- Clamping / parsing helpers ----

function isScope(value: unknown): value is Scope {
  return value === "project" || value === "user" || value === "both";
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Bounded OPTIONAL int (B3 maxTurns): non-finite, non-positive or non-number
 * inputs mean "no limit" (undefined); valid inputs are clamped to [min, max].
 */
function boundedOptionalInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function envInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function envStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envCsv(env: NodeJS.ProcessEnv, key: string): string[] | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Load the pi-subagents config:
 * `defaults < <cwd>/.subagents/config.json < SUBAGENTS_* env`.
 *
 * Env overrides:
 *   SUBAGENTS_SCOPE, SUBAGENTS_MAX_PARALLEL (bounded 1..8),
 *   SUBAGENTS_MAX_CHAIN (bounded 1..16), SUBAGENTS_LEDGER,
 *   SUBAGENTS_BACKGROUND_TTL_MS, SUBAGENTS_AGENTS_DIR, SUBAGENTS_HUD,
 *   SUBAGENTS_MAX_TURNS (bounded 1..200; 0 = unlimited),
 *   SUBAGENTS_GRACE_TURNS (bounded 1..20, default 5),
 *   SUBAGENTS_MODEL_CHEAP / SUBAGENTS_MODEL_BALANCED / SUBAGENTS_MODEL_CAPABLE,
 *   SUBAGENTS_MODEL_FALLBACK (csv).
 *
 * A missing or unparseable config.json is treated as defaults (graceful, I10).
 */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): SubagentsConfig {
  let fileCfg: Partial<SubagentsConfig> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFilePath(cwd), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      fileCfg = parsed as Partial<SubagentsConfig>;
    }
  } catch {
    // missing/invalid config.json -> defaults (graceful)
  }

  const fileModels = fileCfg.models && typeof fileCfg.models === "object" ? fileCfg.models : undefined;
  const fileClasses = fileModels?.classes && typeof fileModels.classes === "object" ? fileModels.classes : undefined;

  const cfg: SubagentsConfig = {
    defaultScope: isScope(fileCfg.defaultScope) ? fileCfg.defaultScope : DEFAULT_SCOPE,
    maxParallel: clampInt(fileCfg.maxParallel, DEFAULT_MAX_PARALLEL, HARD_MIN_MAX_PARALLEL, HARD_MAX_MAX_PARALLEL),
    maxChain: clampInt(fileCfg.maxChain, DEFAULT_MAX_CHAIN, HARD_MIN_MAX_CHAIN, HARD_MAX_MAX_CHAIN),
    ledgerDir: typeof fileCfg.ledgerDir === "string" && fileCfg.ledgerDir.trim() !== "" ? fileCfg.ledgerDir : DEFAULT_LEDGER_DIR,
    backgroundTtlMs: positiveInt(fileCfg.backgroundTtlMs, DEFAULT_BACKGROUND_TTL_MS),
    defaultAgentsDir: typeof fileCfg.defaultAgentsDir === "string" && fileCfg.defaultAgentsDir.trim() !== "" ? fileCfg.defaultAgentsDir : DEFAULT_AGENTS_DIR,
    hud: fileCfg.hud === true,
    defaultMaxTurns: boundedOptionalInt(fileCfg.defaultMaxTurns, HARD_MIN_MAX_TURNS, HARD_MAX_MAX_TURNS),
    defaultGraceTurns: clampInt(fileCfg.defaultGraceTurns, DEFAULT_GRACE_TURNS, HARD_MIN_GRACE_TURNS, HARD_MAX_GRACE_TURNS),
    maxSubagentDepth: clampMaxSubagentDepth(fileCfg.maxSubagentDepth),
    models: {
      classes: {
        cheap: typeof fileClasses?.cheap === "string" ? fileClasses.cheap : DEFAULT_MODEL_CLASSES.cheap,
        balanced: typeof fileClasses?.balanced === "string" ? fileClasses.balanced : DEFAULT_MODEL_CLASSES.balanced,
        capable: typeof fileClasses?.capable === "string" ? fileClasses.capable : DEFAULT_MODEL_CLASSES.capable,
      },
      fallbackChain: Array.isArray(fileModels?.fallbackChain) && fileModels.fallbackChain.every((v) => typeof v === "string")
        ? [...fileModels.fallbackChain]
        : [...DEFAULT_MODEL_FALLBACK_CHAIN],
    },
  };

  // ---- env overrides (highest priority) ----
  const envScope = envStr(env, "SUBAGENTS_SCOPE");
  if (envScope && isScope(envScope)) cfg.defaultScope = envScope;

  const envMaxParallel = envInt(env, "SUBAGENTS_MAX_PARALLEL");
  if (envMaxParallel !== undefined) cfg.maxParallel = clampInt(envMaxParallel, DEFAULT_MAX_PARALLEL, HARD_MIN_MAX_PARALLEL, HARD_MAX_MAX_PARALLEL);

  const envMaxChain = envInt(env, "SUBAGENTS_MAX_CHAIN");
  if (envMaxChain !== undefined) cfg.maxChain = clampInt(envMaxChain, DEFAULT_MAX_CHAIN, HARD_MIN_MAX_CHAIN, HARD_MAX_MAX_CHAIN);

  const envLedger = envStr(env, "SUBAGENTS_LEDGER");
  if (envLedger) cfg.ledgerDir = envLedger;

  const envTtl = envInt(env, "SUBAGENTS_BACKGROUND_TTL_MS");
  if (envTtl !== undefined && envTtl > 0) cfg.backgroundTtlMs = envTtl;

  const envAgentsDir = envStr(env, "SUBAGENTS_AGENTS_DIR");
  if (envAgentsDir) cfg.defaultAgentsDir = envAgentsDir;

  const envHud = envBool(env, "SUBAGENTS_HUD");
  if (envHud !== undefined) cfg.hud = envHud;

  // B3 graceful turn limits (SUBAGENTS_MAX_TURNS=0 -> unlimited).
  const envMaxTurns = envInt(env, "SUBAGENTS_MAX_TURNS");
  if (envMaxTurns !== undefined) {
    cfg.defaultMaxTurns = boundedOptionalInt(envMaxTurns, HARD_MIN_MAX_TURNS, HARD_MAX_MAX_TURNS);
  }

  const envGraceTurns = envInt(env, "SUBAGENTS_GRACE_TURNS");
  if (envGraceTurns !== undefined) {
    cfg.defaultGraceTurns = clampInt(envGraceTurns, DEFAULT_GRACE_TURNS, HARD_MIN_GRACE_TURNS, HARD_MAX_GRACE_TURNS);
  }

  // C1 nested subagents (SUBAGENTS_MAX_DEPTH, clamped 0..4; 0/1 = off).
  const envMaxSubagentDepth = envInt(env, "SUBAGENTS_MAX_DEPTH");
  if (envMaxSubagentDepth !== undefined) {
    cfg.maxSubagentDepth = clampMaxSubagentDepth(envMaxSubagentDepth);
  }

  const envCheap = envStr(env, "SUBAGENTS_MODEL_CHEAP");
  if (envCheap) cfg.models.classes.cheap = envCheap;
  const envBalanced = envStr(env, "SUBAGENTS_MODEL_BALANCED");
  if (envBalanced) cfg.models.classes.balanced = envBalanced;
  const envCapable = envStr(env, "SUBAGENTS_MODEL_CAPABLE");
  if (envCapable) cfg.models.classes.capable = envCapable;

  const envFallback = envCsv(env, "SUBAGENTS_MODEL_FALLBACK");
  if (envFallback) cfg.models.fallbackChain = envFallback;

  return cfg;
}
