// test/shared/config.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  configFilePath,
  loadConfig,
  DEFAULT_CONFIG,
  HARD_MAX_MAX_CHAIN,
  HARD_MAX_MAX_PARALLEL,
  HARD_MIN_MAX_CHAIN,
  HARD_MIN_MAX_PARALLEL,
} from "../../src/shared/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-config-"));
}

function writeConfig(cwd: string, value: unknown): void {
  const dir = join(cwd, ".subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(value), "utf8");
}

describe("shared/config: defaults", () => {
  it("uses documented defaults when no file and no env", () => {
    const dir = tempDir();
    try {
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.defaultScope, "both");
      assert.equal(cfg.maxParallel, 4);
      assert.equal(cfg.maxChain, 8);
      assert.equal(cfg.ledgerDir, ".pi/logs/runs");
      assert.equal(cfg.backgroundTtlMs, 10 * 60_000);
      assert.equal(cfg.defaultAgentsDir, ".pi/agents");
      assert.equal(cfg.hud, false);
      assert.deepEqual(cfg.models.classes, { cheap: "", balanced: "", capable: "" });
      assert.deepEqual(cfg.models.fallbackChain, ["cheap", "balanced", "capable"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults match DEFAULT_CONFIG", () => {
    const dir = tempDir();
    try {
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.maxParallel, DEFAULT_CONFIG.maxParallel);
      assert.equal(cfg.maxChain, DEFAULT_CONFIG.maxChain);
      assert.equal(cfg.defaultScope, DEFAULT_CONFIG.defaultScope);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shared/config: config file", () => {
  it("reads a config.json at <cwd>/.subagents/config.json", () => {
    const dir = tempDir();
    try {
      writeConfig(dir, {
        defaultScope: "project",
        maxParallel: 6,
        maxChain: 12,
        ledgerDir: "custom/ledger",
        backgroundTtlMs: 5000,
        defaultAgentsDir: "custom/agents",
        hud: true,
        models: { classes: { cheap: "m1", balanced: "m2", capable: "m3" }, fallbackChain: ["capable", "cheap"] },
      });
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.defaultScope, "project");
      assert.equal(cfg.maxParallel, 6);
      assert.equal(cfg.maxChain, 12);
      assert.equal(cfg.ledgerDir, "custom/ledger");
      assert.equal(cfg.backgroundTtlMs, 5000);
      assert.equal(cfg.defaultAgentsDir, "custom/agents");
      assert.equal(cfg.hud, true);
      assert.deepEqual(cfg.models.classes, { cheap: "m1", balanced: "m2", capable: "m3" });
      assert.deepEqual(cfg.models.fallbackChain, ["capable", "cheap"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gracefully falls back to defaults when config.json is absent", () => {
    const dir = tempDir();
    try {
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.maxParallel, DEFAULT_CONFIG.maxParallel);
      assert.equal(cfg.ledgerDir, ".pi/logs/runs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gracefully falls back to defaults when config.json is unparseable", () => {
    const dir = tempDir();
    try {
      const cfgPath = join(dir, ".subagents", "config.json");
      mkdirSync(join(dir, ".subagents"), { recursive: true });
      writeFileSync(cfgPath, "not json{{{", "utf8");
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.maxParallel, DEFAULT_CONFIG.maxParallel);
      assert.equal(cfg.defaultScope, "both");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("configFilePath resolves to <cwd>/.subagents/config.json", () => {
    const dir = tempDir();
    try {
      assert.equal(configFilePath(dir), join(dir, ".subagents", "config.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shared/config: env overrides", () => {
  it("env SUBAGENTS_* override the file", () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { maxParallel: 2, defaultScope: "project", hud: false });
      const cfg = loadConfig(dir, {
        SUBAGENTS_SCOPE: "user",
        SUBAGENTS_MAX_PARALLEL: "5",
        SUBAGENTS_LEDGER: "env/ledger",
        SUBAGENTS_HUD: "true",
        SUBAGENTS_MODEL_CHEAP: "env-cheap",
        SUBAGENTS_MODEL_FALLBACK: "capable,balanced",
      });
      assert.equal(cfg.defaultScope, "user");
      assert.equal(cfg.maxParallel, 5);
      assert.equal(cfg.ledgerDir, "env/ledger");
      assert.equal(cfg.hud, true);
      assert.equal(cfg.models.classes.cheap, "env-cheap");
      assert.deepEqual(cfg.models.fallbackChain, ["capable", "balanced"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clamps maxParallel to [1,8] even from env", () => {
    const dir = tempDir();
    try {
      const low = loadConfig(dir, { SUBAGENTS_MAX_PARALLEL: "0" });
      assert.equal(low.maxParallel, HARD_MIN_MAX_PARALLEL);
      const high = loadConfig(dir, { SUBAGENTS_MAX_PARALLEL: "999" });
      assert.equal(high.maxParallel, HARD_MAX_MAX_PARALLEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clamps maxChain to [1,16] even from env", () => {
    const dir = tempDir();
    try {
      const low = loadConfig(dir, { SUBAGENTS_MAX_CHAIN: "0" });
      assert.equal(low.maxChain, HARD_MIN_MAX_CHAIN);
      const high = loadConfig(dir, { SUBAGENTS_MAX_CHAIN: "999" });
      assert.equal(high.maxChain, HARD_MAX_MAX_CHAIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores invalid env ints (falls back to file/default)", () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { maxParallel: 3 });
      const cfg = loadConfig(dir, { SUBAGENTS_MAX_PARALLEL: "abc" });
      assert.equal(cfg.maxParallel, 3);
      const fresh = loadConfig(dir, { SUBAGENTS_BACKGROUND_TTL_MS: "-5" });
      assert.equal(fresh.backgroundTtlMs, DEFAULT_CONFIG.backgroundTtlMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env MAX overrides file bounds via clamp", () => {
    const dir = tempDir();
    try {
      writeConfig(dir, { maxParallel: 3 });
      const cfg = loadConfig(dir, { SUBAGENTS_MAX_PARALLEL: "8" });
      assert.equal(cfg.maxParallel, 8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
