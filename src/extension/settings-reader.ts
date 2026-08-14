/**
 * src/extension/settings-reader.ts — concrete EnabledModelsReader over the pi
 * settings files (C3 model scope).
 *
 * Reads the pi `enabledModels` allowlist from the two settings tiers, with
 * PROJECT priority (documented tintinweb enabled-models behavior):
 *
 *   1. project  <repoRoot>/.pi/settings.json        (wins when it defines the key)
 *   2. global   ~/.pi/agent/settings.json           (fallback)
 *
 * Priority semantics: when the project settings file exists AND defines
 * `enabledModels` (even as an empty array), the project value wins — an empty
 * project allowlist intentionally disables the scope check downstream (no-op
 * safety). When the project tier does not define the key (missing file,
 * unreadable/corrupt JSON, or key absent/non-array), the global tier is read
 * with the same rules. When neither tier defines `enabledModels`, the reader
 * returns undefined (scope check skipped entirely).
 *
 * Non-string entries are dropped; remaining entries are returned raw (exact
 * `provider/modelId` matching happens in the pure models/scope gate, where
 * globs/bare ids are silently ignored).
 *
 * The reader NEVER throws: any read/parse failure is reported as "tier not
 * configured" so a broken settings file degrades to a skipped check, never a
 * dispatch crash. This module is the extension layer (the only layer allowed
 * to touch pi settings); models/engine stay fs-free.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnabledModelsReader } from "../models/index.js";

/** Options for {@link createPiSettingsEnabledModelsReader} (paths injectable for tests). */
export interface PiSettingsEnabledModelsOptions {
  /** Project settings path (default `<repoRoot>/.pi/settings.json`). */
  projectSettingsPath?: string;
  /** Global settings path (default `~/.pi/agent/settings.json`). */
  userSettingsPath?: string;
}

/** Same tier paths, reused by the F3 defaultModel reader. */
export type PiSettingsTierOptions = PiSettingsEnabledModelsOptions;

/** Parsed settings object of one tier; undefined when absent/corrupt. */
function readSettingsObject(settingsPath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // Corrupt JSON: treat the tier as not configured (fall through).
    return undefined;
  }
}

interface TierResult {
  /** True when this tier DEFINES enabledModels (array value, possibly empty). */
  defined: boolean;
  list?: string[];
}

/** Read `enabledModels` from one settings file; never throws. */
function readTier(settingsPath: string): TierResult {
  const parsed = readSettingsObject(settingsPath);
  if (!parsed) return { defined: false };
  const value = parsed.enabledModels;
  if (!Array.isArray(value)) return { defined: false };
  const list = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return { defined: true, list };
}

/**
 * Build the concrete pi-settings EnabledModelsReader for a repo root.
 * Project settings take priority over the global user settings.
 */
export function createPiSettingsEnabledModelsReader(
  repoRoot: string,
  opts: PiSettingsEnabledModelsOptions = {},
): EnabledModelsReader {
  const projectSettingsPath = opts.projectSettingsPath ?? join(repoRoot, ".pi", "settings.json");
  const userSettingsPath = opts.userSettingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
  return {
    readEnabledModels(): readonly string[] | undefined {
      const project = readTier(projectSettingsPath);
      if (project.defined) return project.list;
      const user = readTier(userSettingsPath);
      if (user.defined) return user.list;
      return undefined;
    },
  };
}

/** Read a non-empty trimmed `defaultModel` string from one tier; never throws. */
function readDefaultModelTier(settingsPath: string): string | undefined {
  const parsed = readSettingsObject(settingsPath);
  const value = parsed?.defaultModel;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * F3 parent-model fallback: read the pi `defaultModel` from the same two
 * settings tiers as `enabledModels`, with PROJECT priority. Returns undefined
 * when neither tier defines a usable string (the engine then dispatches
 * without a parent model — no inheritance, previous behavior). Never throws.
 */
export function readPiDefaultModel(repoRoot: string, opts: PiSettingsTierOptions = {}): string | undefined {
  const projectSettingsPath = opts.projectSettingsPath ?? join(repoRoot, ".pi", "settings.json");
  const userSettingsPath = opts.userSettingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
  return readDefaultModelTier(projectSettingsPath) ?? readDefaultModelTier(userSettingsPath);
}
