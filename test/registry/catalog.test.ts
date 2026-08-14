// test/registry/catalog.test.ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentCatalog, hasForbiddenBodyKeys, searchAgentCatalog } from "../../src/registry/catalog.js";
import type { ResolveAgentDirs } from "../../src/registry/agents.js";

const FIXTURES = fileURLToPath(new URL("../../../test/fixtures/agents/", import.meta.url));
const PROJECT = join(FIXTURES, "project");
const USER = join(FIXTURES, "user");

const testResolver: ResolveAgentDirs = (_cwd, source) => (source === "user" ? [USER] : [PROJECT]);

describe("registry: buildAgentCatalog", () => {
  it("is a body-free metadata catalog for scope both", () => {
    const catalog = buildAgentCatalog({ cwd: "cwd", scope: "both", resolveAgentDirs: testResolver });
    assert.equal(catalog.schema, "zob.agent-catalog.v1");
    assert.equal(catalog.scope, "both");
    assert.equal(catalog.noExecution, true);
    assert.equal(catalog.childDispatchAllowed, false);
    assert.equal(catalog.bodyStored, false);
    assert.equal(catalog.promptBodiesStored, false);
    // dedupe: exactly one "dup"
    assert.equal(catalog.entries.filter((e) => e.id.toLowerCase() === "dup").length, 1);
    // body-free: no raw prompt, only a promptHash
    for (const entry of catalog.entries) {
      assert.equal("prompt" in entry, false);
      assert.match(entry.promptHash, /^[0-9a-f]{64}$/);
    }
    assert.equal(hasForbiddenBodyKeys(catalog), false);
  });

  it("counts by source", () => {
    const catalog = buildAgentCatalog({ cwd: "cwd", scope: "both", resolveAgentDirs: testResolver });
    assert.equal(catalog.counts.total, catalog.entries.length);
    assert.equal(catalog.counts.project + catalog.counts.user, catalog.counts.total);
    // broken/nofront/README are skipped (no frontmatter name) -> alpha, beta, dup
    assert.equal(catalog.counts.project, 3);
    assert.ok(catalog.counts.user >= 1); // gamma (dup deduped away)
  });

  it("exposes model_class per entry when the card declares it", () => {
    const catalog = buildAgentCatalog({ cwd: "cwd", scope: "project", resolveAgentDirs: testResolver });
    const alpha = catalog.entries.find((e) => e.id === "alpha");
    assert.ok(alpha);
    assert.equal(alpha.modelClass, "cheap");
    assert.equal(hasForbiddenBodyKeys(catalog), false);
  });

  it("scope project includes only project entries", () => {
    const catalog = buildAgentCatalog({ cwd: "cwd", scope: "project", resolveAgentDirs: testResolver });
    assert.ok(catalog.entries.every((e) => e.source === "project"));
    assert.ok(catalog.entries.some((e) => e.id === "alpha"));
    assert.ok(!catalog.entries.some((e) => e.id === "gamma"));
  });
});

describe("registry: hasForbiddenBodyKeys", () => {
  it("rejects nested body-like string keys", () => {
    assert.equal(hasForbiddenBodyKeys({ a: { prompt: "x" } }), true);
    assert.equal(hasForbiddenBodyKeys([{ task: "y" }]), true);
  });

  it("accepts body-free graphs", () => {
    assert.equal(hasForbiddenBodyKeys({ id: "a", promptHash: "abc" }), false);
    assert.equal(hasForbiddenBodyKeys({ tools: ["read"] }), false);
  });
});

describe("registry: searchAgentCatalog", () => {
  const catalog = buildAgentCatalog({ cwd: "cwd", scope: "both", resolveAgentDirs: testResolver });

  it("finds by id", () => {
    const hits = searchAgentCatalog(catalog, "alpha");
    assert.ok(hits.length > 0);
    assert.ok(hits.some((e) => e.id === "alpha"));
  });

  it("finds by description keyword", () => {
    const hits = searchAgentCatalog(catalog, "duplicate");
    assert.ok(hits.length > 0);
  });

  it("clamps limit to [1,20] and respects it", () => {
    assert.equal(searchAgentCatalog(catalog, "", 0).length, 1);
    // >20 is clamped to 20; with fewer entries than 20 all are returned
    assert.equal(searchAgentCatalog(catalog, "", 500).length, catalog.entries.length);
    assert.ok(searchAgentCatalog(catalog, "", 3).length <= 3);
  });
});
