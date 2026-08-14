/**
 * src/gates/tools.ts — tool-list parsing and allowlist validation (pure).
 * Ported verbatim from the ZOB harness safety gates.
 */

import type { HarnessAgent } from "./types.js";

/**
 * Parse a comma-separated tool list into a trimmed, de-duplicated array.
 * Returns `undefined` when the input is empty/absent.
 */
export function parseToolList(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  return input
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/**
 * Validate requested tools against an agent's declared allowlist. Returns an
 * array of errors (empty array when valid or no tools requested).
 */
export function validateToolList(agent: HarnessAgent, requestedTools: string[] | undefined): string[] {
  const errors: string[] = [];
  const allowed = new Set(agent.tools ?? []);
  if (!requestedTools || requestedTools.length === 0) return errors;
  if (allowed.size === 0) return [`Agent '${agent.name}' has no declared tool allowlist; refusing tool override.`];
  for (const tool of requestedTools) {
    if (!/^[a-zA-Z0-9_-]+$/.test(tool)) errors.push(`Invalid tool name '${tool}'`);
    if (!allowed.has(tool)) errors.push(`Tool '${tool}' is not allowed for agent '${agent.name}'. Allowed: ${[...allowed].join(", ")}`);
  }
  return errors;
}
