// test/engine/ledger.test.ts — hash-only / body-free ledger.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendLedgerFile,
  bodyFreeDelegationLedgerEntry,
  delegationLedgerMeta,
  hasRawBodyKey,
  DELEGATION_LEDGER_RAW_KEYS,
} from "../../src/engine/ledger.js";
import { sha256 } from "../../src/core/hashing.js";

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pi-subagents-ledger-${label}-`));
}

describe("engine/ledger: body-free hashing", () => {
  it("replaces every raw-body key with <key>Hashes + <key>Count and flags bodyStored:false", () => {
    const sanitized = bodyFreeDelegationLedgerEntry({
      runId: "r1",
      task: "the full task body",
      output: "the output body",
      error: "boom",
      meta: { nested: "kept" },
      numbers: [1, 2],
    }) as Record<string, unknown>;

    assert.equal(sanitized.bodyStored, false);
    assert.equal(sanitized.promptBodiesStored, false);
    assert.equal(sanitized.outputBodiesStored, false);
    assert.equal(sanitized.runId, "r1");
    assert.deepEqual(sanitized.taskHashes, [sha256("the full task body")]);
    assert.equal(sanitized.taskCount, 1);
    assert.deepEqual(sanitized.outputHashes, [sha256("the output body")]);
    assert.deepEqual(sanitized.errorHashes, [sha256("boom")]);
    // Non-body keys pass through untouched.
    assert.deepEqual(sanitized.meta, { nested: "kept" });
    assert.deepEqual(sanitized.numbers, [1, 2]);
    // No raw-body key remains anywhere (top-level or nested).
    assert.equal(hasRawBodyKey(sanitized), false);
    for (const key of DELEGATION_LEDGER_RAW_KEYS) assert.equal(key in sanitized, false);
  });

  it("handles arrays of string bodies and nested body keys", () => {
    const sanitized = bodyFreeDelegationLedgerEntry({ gateErrors: ["e1", "e2"], child: { stderr: "x", ok: true } });
    assert.deepEqual(sanitized.gateErrorsHashes, [sha256("e1"), sha256("e2")]);
    assert.equal(sanitized.gateErrorsCount, 2);
    assert.deepEqual((sanitized.child as Record<string, unknown>).stderrHashes, [sha256("x")]);
    assert.equal((sanitized.child as Record<string, unknown>).ok, true);
  });
});

describe("engine/ledger: appendLedgerFile (injectable dir, hash-only)", () => {
  it("writes a body-free JSONL line to <dir>/<day>.jsonl with a timestamp", () => {
    const dir = tempDir("append");
    const ledgerDir = join(dir, "runs");
    try {
      const now = new Date("2024-01-15T12:00:00Z");
      appendLedgerFile(dir, { event: "end", runId: "r1", task: "secret body", output: "out body" }, { dir: ledgerDir, now: () => now });
      const day = now.toISOString().slice(0, 10);
      const file = join(ledgerDir, `${day}.jsonl`);
      assert.equal(existsSync(file), true);
      const line = readFileSync(file, "utf8").trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(parsed.bodyStored, false);
      assert.equal(parsed.event, "end");
      assert.equal(parsed.runId, "r1");
      assert.deepEqual(parsed.taskHashes, [sha256("secret body")]);
      assert.equal(parsed.taskCount, 1);
      assert.equal(typeof parsed.timestamp, "string");
      // No raw body keys persisted.
      for (const key of DELEGATION_LEDGER_RAW_KEYS) assert.equal(key in parsed, false);
      assert.equal(Object.keys(readdirSync(ledgerDir)).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine/ledger: delegationLedgerMeta", () => {
  it("captures source, parentToolCallId, mode, and index", () => {
    assert.deepEqual(delegationLedgerMeta("delegate_task", "p1", "parallel", 2), {
      source: "delegate_task",
      parentToolCallId: "p1",
      delegationMode: "parallel",
      index: 2,
    });
    assert.deepEqual(delegationLedgerMeta("delegate_agent", undefined, "single"), {
      source: "delegate_agent",
      parentToolCallId: undefined,
      delegationMode: "single",
      index: undefined,
    });
  });
});
