// test/core/records.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRecord, parseJsonLine, textFromMessage } from "../../src/core/index.js";

describe("records: parseJsonLine", () => {
  it("parses a valid JSON line", () => {
    const ev = parseJsonLine('{"type":"msg","toolName":"read"}');
    assert.ok(ev);
    assert.equal(ev.type, "msg");
  });

  it("returns undefined for non-JSON", () => {
    assert.equal(parseJsonLine("not json"), undefined);
  });

  it("returns undefined for non-object JSON", () => {
    assert.equal(parseJsonLine('"just a string"'), undefined);
  });
});

describe("records: textFromMessage", () => {
  it("joins text blocks", () => {
    const t = textFromMessage({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    assert.equal(t, "a\nb");
  });

  it("skips non-text blocks", () => {
    const t = textFromMessage({ content: [{ type: "tool_use", id: "1" }, { type: "text", text: "only" }] });
    assert.equal(t, "only");
  });

  it("returns empty for no content", () => {
    assert.equal(textFromMessage({}), "");
    assert.equal(textFromMessage(undefined), "");
  });
});

describe("records: isRecord", () => {
  it("distinguishes records from primitives", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord("x"), false);
  });
});
