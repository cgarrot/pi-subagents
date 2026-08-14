// test/core/formatting.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blockedFeedback,
  capOutput,
  fileToolPreflightFeedback,
  formatChildResultText,
} from "../../src/core/index.js";
import type { ChildResult } from "../../src/core/index.js";

const baseResult: ChildResult = {
  agent: "x",
  task: "t",
  exitCode: 0,
  output: "",
  stderr: "",
  usage: { turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
};

describe("formatting: capOutput", () => {
  it("keeps short output unchanged", () => {
    assert.equal(capOutput("short"), "short");
  });

  it("truncates over-limit output", () => {
    const out = capOutput("x".repeat(200), 100);
    assert.ok(out.endsWith("[truncated: full output stored in tool details]"));
    assert.ok(out.length < 200);
  });
});

describe("formatting: formatChildResultText", () => {
  it("returns (no output) for empty result", () => {
    assert.equal(formatChildResultText(baseResult), "(no output)");
  });

  it("includes failure kind and output", () => {
    const text = formatChildResultText({ ...baseResult, failureKind: "output_gate", output: "hi" });
    assert.ok(text.includes("Failure kind: output_gate"));
    assert.ok(text.includes("hi"));
  });
});

describe("formatting: blockedFeedback / fileToolPreflightFeedback", () => {
  it("builds a blocked feedback message", () => {
    const m = blockedFeedback("bash", "forbidden path", "ls ~/.ssh");
    assert.ok(m.includes("ZOB damage-control blocked bash"));
    assert.ok(m.includes("ls ~/.ssh"));
  });

  it("appends structured diagnostics when provided", () => {
    const m = blockedFeedback("bash", "r", "cmd", {
      executionPerformed: false,
      currentMode: "implement",
      reasonCode: "x",
      retryPolicy: "none",
      safeNextAction: "ask",
    });
    assert.ok(m.includes("current_mode=implement"));
  });

  it("builds a file-tool preflight message", () => {
    const m = fileToolPreflightFeedback({
      executionPerformed: false,
      toolName: "edit",
      reasonCode: "forbidden",
      field: "path",
      pathHash: "h",
      inputHash: "i",
      snapshotHash: "s",
      fingerprintHash: "f",
      retryPolicy: "none",
      safeNextActions: [],
      telemetryRecorded: true,
      deduplicated: false,
      attemptCount: 1,
      unchangedRetryCount: 0,
    });
    assert.ok(m.includes("ZOB file-tool preflight blocked edit"));
  });
});
