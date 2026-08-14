/**
 * src/core/hashing.ts — pure hashing helpers. No fs, no @earendil-works/*.
 */
import { createHash } from "node:crypto";

/** Hex sha-256 digest of a string value. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Alias kept for symmetry with the harness. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
