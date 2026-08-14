/**
 * src/lanes/steer.ts — mid-run steering channel (parent side, B2).
 *
 * Writes a `<runId>.steer` file that a child adapter (child/index.ts, loaded
 * with `-e`) would poll between tool calls to receive a mid-run steering
 * message. The write is ATOMIC: the payload is written to a temp file in the
 * same directory, then `renameSync`'d over the target, so a polling child never
 * observes a partially-written steer file.
 *
 * B2 STATUS (COMPLETE — parent + child): the child adapter (child/index.ts)
 * polls the file at every tool_call hook when PI_SUBAGENTS_STEER_FILE points
 * at this run's steer file, injects the payload as a REAL user message via
 * pi.sendUserMessage(message, { deliverAs: "steer" }) — queued for delivery
 * after the current turn's tool calls, before the next LLM call — then
 * deletes the file (consume-once). SPIKE evidence: pi docs/extensions.md
 * "pi.sendUserMessage(content, options?)" (package 0.75.5 lines 1291-1315;
 * 0.84.1 lines 1412-1438) and dist/core/extensions/types.d.ts lines 841-843
 * (`sendUserMessage(content, options?: { deliverAs?: "steer" | "followUp" })`).
 * F1 (SDK in-process AgentSession.steer) remains an alternative for tighter
 * steering loops, not a requirement.
 *
 * Zero @earendil-works/* imports.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Default steer dir relative to a repo root: `<root>/.pi/steer`. */
export const DEFAULT_STEER_DIR = ".pi/steer";

/** Structured payload written to a `<runId>.steer` file. */
export interface SteerFilePayload {
  runId: string;
  message: string;
  timestamp: number;
}

/** Resolve the absolute steer file path for a run id. */
export function steerFilePath(runId: string, dir: string): string {
  return join(dir, `${runId}.steer`);
}

/**
 * Atomically write a steering message for `runId` into `dir`. Creates the dir
 * if missing. Returns the absolute steer file path.
 */
export function steer(runId: string, message: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const target = steerFilePath(runId, dir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload: SteerFilePayload = { runId, message, timestamp: Date.now() };
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, target);
  return target;
}
