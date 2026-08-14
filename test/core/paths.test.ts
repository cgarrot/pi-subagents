// test/core/paths.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expandHome,
  isSafeArtifactName,
  newRunId,
  pathMatches,
  resolveRepoPath,
  safeFileStem,
  safeRunId,
} from "../../src/core/index.js";

const CWD = "/repo";

describe("paths: pathMatches", () => {
  it("matches a trailing-slash directory prefix", () => {
    assert.equal(pathMatches("/repo/src/a.ts", "src/", CWD, "/repo"), true);
    assert.equal(pathMatches("/repo/other/a.ts", "src/", CWD, "/repo"), false);
  });

  it("matches wildcard patterns", () => {
    assert.equal(pathMatches("/repo/a/file.ts", "*.ts", CWD, "/repo"), true);
  });

  it("matches exact relative includes", () => {
    assert.equal(pathMatches("/repo/x", "x", CWD, "/repo"), true);
  });
});

describe("paths: safeFileStem", () => {
  it("sanitizes and trims", () => {
    assert.equal(safeFileStem("  A/B:C  "), "A-B-C");
    assert.equal(safeFileStem(""), "agent");
  });
});

describe("paths: newRunId / safeRunId", () => {
  it("generates a prefixed run id", () => {
    const id = newRunId("run");
    assert.ok(id.startsWith("run_"));
  });

  it("safeRunId falls back to a generated id", () => {
    const id = safeRunId(undefined, "task");
    assert.ok(id.startsWith("task_"));
  });
});

describe("paths: resolveRepoPath", () => {
  it("resolves inside the root", () => {
    const r = resolveRepoPath("/repo", "src/a.ts");
    assert.equal(r.errors.length, 0);
    assert.equal(r.path, "/repo/src/a.ts");
  });

  it("rejects escapes", () => {
    const r = resolveRepoPath("/repo", "../outside");
    assert.ok(r.errors.length > 0);
  });
});

describe("paths: isSafeArtifactName / expandHome", () => {
  it("accepts safe names", () => {
    assert.equal(isSafeArtifactName("a-b_1.ts"), true);
    assert.equal(isSafeArtifactName("../bad"), false);
    assert.equal(isSafeArtifactName("dir/file"), false);
  });

  it("expands home", () => {
    assert.equal(expandHome("~/x"), `${process.env.HOME}/x`);
  });
});
