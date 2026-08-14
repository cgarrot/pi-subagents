// test/registry/agents.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverAgents,
  formatAgentList,
  loadAgentsFromDir,
  parseFrontmatter,
  type AgentCard,
  type ResolveAgentDirs,
} from "../../src/registry/agents.js";

// Fixtures live in the source tree under test/fixtures/agents; from the
// compiled dist/test/registry/ the package root is ../../../ .
const FIXTURES = fileURLToPath(new URL("../../../test/fixtures/agents/", import.meta.url));
const PROJECT = join(FIXTURES, "project");
const USER = join(FIXTURES, "user");

const testResolver: ResolveAgentDirs = (_cwd, source) => (source === "user" ? [USER] : [PROJECT]);

describe("registry: parseFrontmatter", () => {
  it("parses valid frontmatter and body", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: x\ndescription: \"hi\"\n---\nbody!");
    assert.equal(frontmatter.name, "x");
    assert.equal(frontmatter.description, "hi");
    assert.equal(body, "body!");
  });

  it("returns whole file as body when no opening fence", () => {
    const { frontmatter, body } = parseFrontmatter("no frontmatter");
    assert.deepEqual(frontmatter, {});
    assert.equal(body, "no frontmatter");
  });

  it("degrades to empty frontmatter when closing fence missing", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: broken\ndescription: nope");
    assert.deepEqual(frontmatter, {});
    assert.equal(body, "---\nname: broken\ndescription: nope");
  });
});

describe("registry: loadAgentsFromDir", () => {
  it("returns [] for a nonexistent dir", () => {
    assert.deepEqual(loadAgentsFromDir(join(FIXTURES, "does-not-exist"), "project"), []);
  });

  it("loads a valid agent with full metadata", () => {
    const alpha = loadAgentsFromDir(PROJECT, "project").find((a) => a.name === "alpha");
    assert.ok(alpha);
    assert.equal(alpha.description, "Alpha agent for tests");
    assert.deepEqual(alpha.tools, ["read", "grep"]);
    assert.equal(alpha.model, "openai/gpt-4o");
    assert.equal(alpha.thinking, "high");
    assert.equal(alpha.modelClass, "cheap");
    assert.match(alpha.prompt, /You are Alpha/);
    assert.equal(alpha.source, "project");
    assert.equal(alpha.filePath, join(PROJECT, "alpha.md"));
    assert.equal(alpha.filePath.endsWith(".md"), true);
  });

  it("skips .md files without a frontmatter name (broken fence -> not an agent)", () => {
    const broken = loadAgentsFromDir(PROJECT, "project").find((a) => a.filePath.endsWith("broken.md"));
    assert.equal(broken, undefined);
  });

  it("skips .md files without frontmatter at all (whole-file docs are not agents)", () => {
    const nofront = loadAgentsFromDir(PROJECT, "project").find((a) => a.filePath.endsWith("nofront.md"));
    assert.equal(nofront, undefined);
  });

  it("skips README.md (documentation, never a delegation agent)", () => {
    const agents = loadAgentsFromDir(PROJECT, "project");
    assert.equal(agents.find((a) => a.filePath.endsWith("README.md")), undefined);
    assert.equal(agents.some((a) => /^readme$/i.test(a.name)), false);
  });
});

describe("registry: discoverAgents", () => {
  it("scope project returns only project agents (no user)", () => {
    const agents = discoverAgents("cwd", "project", testResolver);
    const names = agents.map((a) => a.name);
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes("dup"));
    assert.ok(!names.includes("gamma"));
    assert.ok(agents.every((a) => a.source === "project"));
  });

  it("scope user returns only user agents (no project)", () => {
    const agents = discoverAgents("cwd", "user", testResolver);
    const names = agents.map((a) => a.name);
    assert.ok(names.includes("gamma"));
    assert.ok(!names.includes("alpha"));
    assert.ok(agents.every((a) => a.source === "user"));
  });

  it("scope both dedupes case-insensitively (project wins) and orders user→project", () => {
    const agents = discoverAgents("cwd", "both", testResolver);
    const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
    // single entry for the case-insensitive duplicate
    assert.equal(agents.filter((a) => a.name.toLowerCase() === "dup").length, 1);
    // last wins via Map → project source wins for "dup"
    assert.equal(byName.get("dup")?.source, "project");
    // user agents precede project agents
    const idxGamma = agents.findIndex((a) => a.name === "gamma");
    const idxAlpha = agents.findIndex((a) => a.name === "alpha");
    assert.ok(idxGamma >= 0 && idxAlpha >= 0 && idxGamma < idxAlpha);
  });

  it("uses the default resolver: project agents under <cwd>/.pi/agents", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-"));
    const agentsDir = join(cwd, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "local.md"), "---\nname: local\n---\nlocal body");
    const agents = discoverAgents(cwd, "project");
    assert.deepEqual(agents.map((a) => a.name), ["local"]);
  });
});

describe("registry: formatAgentList", () => {
  it("renders each agent and source", () => {
    const list: AgentCard[] = [
      { name: "a", description: "desc", tools: ["read"], prompt: "", source: "project", filePath: "x.md" },
    ];
    assert.equal(formatAgentList(list), "- a [project] tools=read: desc");
  });

  it("reports no agents found", () => {
    assert.equal(formatAgentList([]), "No agents found.");
  });
});
