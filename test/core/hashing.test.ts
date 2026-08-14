// test/core/hashing.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256, sha256Hex } from "../../src/core/index.js";

describe("hashing: sha256", () => {
  it("matches a known sha-256 digest", () => {
    assert.equal(
      sha256("hello"),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("is deterministic", () => {
    assert.equal(sha256("abc"), sha256("abc"));
  });

  it("differs across inputs", () => {
    assert.notEqual(sha256("a"), sha256("b"));
  });

  it("sha256Hex is an alias of sha256", () => {
    assert.equal(sha256Hex("xyz"), sha256("xyz"));
  });
});
