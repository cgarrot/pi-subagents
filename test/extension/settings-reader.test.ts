// test/extension/settings-reader.test.ts — concrete pi-settings EnabledModelsReader:
// project .pi/settings.json priority over global ~/.pi/agent/settings.json.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPiSettingsEnabledModelsReader } from "../../src/extension/settings-reader.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-scope-reader-${label}-`));
}

function writeSettings(dir: string, relative: string, value: unknown): string {
  const path = join(dir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

describe("settings-reader: project priority over global", () => {
  it("project enabledModels wins over global", () => {
    const dir = tempDir("priority");
    try {
      const project = writeSettings(dir, join(".pi", "settings.json"), { enabledModels: ["project/model-a"] });
      const user = writeSettings(dir, join("home", ".pi", "agent", "settings.json"), { enabledModels: ["global/model-b"] });
      const reader = createPiSettingsEnabledModelsReader(dir, { projectSettingsPath: project, userSettingsPath: user });
      assert.deepEqual(reader.readEnabledModels(), ["project/model-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to global when the project settings lack the key", () => {
    const dir = tempDir("fallback");
    try {
      const project = writeSettings(dir, join(".pi", "settings.json"), { other: true });
      const user = writeSettings(dir, join("home", ".pi", "agent", "settings.json"), { enabledModels: ["global/model-b"] });
      const reader = createPiSettingsEnabledModelsReader(dir, { projectSettingsPath: project, userSettingsPath: user });
      assert.deepEqual(reader.readEnabledModels(), ["global/model-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to global when the project settings file is missing", () => {
    const dir = tempDir("missing-project");
    try {
      const user = writeSettings(dir, join("home", ".pi", "agent", "settings.json"), { enabledModels: ["global/model-b"] });
      const reader = createPiSettingsEnabledModelsReader(dir, {
        projectSettingsPath: join(dir, ".pi", "settings.json"),
        userSettingsPath: user,
      });
      assert.deepEqual(reader.readEnabledModels(), ["global/model-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project EMPTY array still wins (intentional disable -> skip downstream)", () => {
    const dir = tempDir("empty-project");
    try {
      const project = writeSettings(dir, join(".pi", "settings.json"), { enabledModels: [] });
      const user = writeSettings(dir, join("home", ".pi", "agent", "settings.json"), { enabledModels: ["global/model-b"] });
      const reader = createPiSettingsEnabledModelsReader(dir, { projectSettingsPath: project, userSettingsPath: user });
      assert.deepEqual(reader.readEnabledModels(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when neither tier defines enabledModels", () => {
    const dir = tempDir("none");
    try {
      const project = writeSettings(dir, join(".pi", "settings.json"), { theme: "dark" });
      const user = writeSettings(dir, join("home", ".pi", "agent", "settings.json"), {});
      const reader = createPiSettingsEnabledModelsReader(dir, { projectSettingsPath: project, userSettingsPath: user });
      assert.equal(reader.readEnabledModels(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when both files are missing", () => {
    const dir = tempDir("no-files");
    try {
      const reader = createPiSettingsEnabledModelsReader(dir, {
        projectSettingsPath: join(dir, ".pi", "settings.json"),
        userSettingsPath: join(dir, "home", ".pi", "agent", "settings.json"),
      });
      assert.equal(reader.readEnabledModels(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings-reader: robustness (never throws, non-array key ignored)", () => {
  it("a corrupt project JSON falls back to global", () => {
    const dir = tempDir("corrupt");
    try {
      const projectPath = join(dir, ".pi", "settings.json");
      mkdirSync(join(dir, ".pi"), { recursive: true });
      writeFileSync(projectPath, "{ not json", "utf8");
      const user = writeSettings(dir, join("home", ".pi", "agent", "settings.json"), { enabledModels: ["global/model-b"] });
      const reader = createPiSettingsEnabledModelsReader(dir, { projectSettingsPath: projectPath, userSettingsPath: user });
      assert.deepEqual(reader.readEnabledModels(), ["global/model-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a non-array enabledModels value is treated as not defined", () => {
    const dir = tempDir("non-array");
    try {
      const project = writeSettings(dir, join(".pi", "settings.json"), { enabledModels: "openai/gpt-4o" });
      const user = writeSettings(dir, join("home", ".pi", "agent", "settings.json"), { enabledModels: { a: 1 } });
      const reader = createPiSettingsEnabledModelsReader(dir, { projectSettingsPath: project, userSettingsPath: user });
      assert.equal(reader.readEnabledModels(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops non-string and blank entries, keeps raw exact-form entries", () => {
    const dir = tempDir("filter");
    try {
      const project = writeSettings(dir, join(".pi", "settings.json"), {
        enabledModels: ["openai/gpt-4o", 42, null, "  ", "gpt-4o"],
      });
      const reader = createPiSettingsEnabledModelsReader(dir, { projectSettingsPath: project });
      assert.deepEqual(reader.readEnabledModels(), ["openai/gpt-4o", "gpt-4o"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
