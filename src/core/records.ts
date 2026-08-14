/**
 * src/core/records.ts — pure JSONL/message record helpers. No fs, no @earendil-works/*.
 */
import type { AssistantLikeMessage, JsonEvent, TextBlock } from "./types.js";

/** Type guard for plain record values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract joined text content from an assistant-like message. */
export function textFromMessage(message: AssistantLikeMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is TextBlock => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Parse a single JSONL line into a JsonEvent, or undefined on failure. */
export function parseJsonLine(line: string): JsonEvent | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) return undefined;
    return value as JsonEvent;
  } catch {
    return undefined;
  }
}
