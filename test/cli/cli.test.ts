// test/cli/cli.test.ts — CLI parsing / exit codes, WITHOUT launching real pi.
// `main` returns the exit code directly and the guarded auto-run never fires
// on import (process.argv[1] is the test runner, not the cli module).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../../src/cli/subagents.js";

const VALID_CONTRACT = `1. TASK: build a thing
2. EXPECTED OUTCOME: a working artifact with evidence
3. REQUIRED TOOLS: read, grep, bash, write
4. MUST DO:
   - verify state before editing.
   - produce evidence before done.
5. MUST NOT DO:
   - no secret reads.
   - no commits.
6. CONTEXT:
   - Paths: packages/x
   - Prior evidence: none
   - Downstream use: verify`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-cli-"));
}

describe("cli: command dispatch / exit codes", () => {
  it("--help exits 0 and prints usage", async () => {
    const code = await main(["--help"]);
    assert.equal(code, 0);
  });

  it("no command exits 2 (usage)", async () => {
    const code = await main([]);
    assert.equal(code, 2);
  });

  it("unknown command exits 2", async () => {
    const code = await main(["nope"]);
    assert.equal(code, 2);
  });

  it("contract validates a six-part task (exit 0)", async () => {
    const code = await main(["contract", VALID_CONTRACT]);
    assert.equal(code, 0);
  });

  it("contract rejects an incomplete task (exit 1)", async () => {
    const code = await main(["contract", "TASK: only a task"]);
    assert.equal(code, 1);
  });

  it("contract with no task exits 2", async () => {
    const code = await main(["contract"]);
    assert.equal(code, 2);
  });

  it("catalog builds a body-free catalog (exit 0, no pi)", async () => {
    const code = await main(["catalog"]);
    assert.equal(code, 0);
  });

  it("agents lists (possibly empty) discovered agents (exit 0, no pi)", async () => {
    const code = await main(["agents"]);
    assert.equal(code, 0);
  });

  it("runs on an empty ledger dir exits 0", async () => {
    const dir = tempDir();
    try {
      const code = await main(["runs", "--sort", "latest"], { SUBAGENTS_LEDGER: dir });
      assert.equal(code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs rejects an unknown --sort by falling back to active (exit 0)", async () => {
    const dir = tempDir();
    try {
      const code = await main(["runs", "--sort", "bogus"], { SUBAGENTS_LEDGER: dir });
      assert.equal(code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli: doctor without real pi", () => {
  it("returns exit 1 with a clear message when the pi command is missing", async () => {
    // Point SUBAGENTS_PI_COMMAND at a nonexistent binary so doctor never
    // boots real pi and reports pi as missing.
    const code = await main(["doctor"], { SUBAGENTS_PI_COMMAND: "/nonexistent/pi-binary-xyz" });
    assert.equal(code, 1);
  });
});
