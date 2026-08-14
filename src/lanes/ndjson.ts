/**
 * src/lanes/ndjson.ts — incremental NDJSON stream parser into ChildResult.
 *
 * Ported from the harness NDJSON buffering / `processLine` (child-runner.ts
 * cr:396-433), mirroring the stdin-spike event order:
 *   session -> agent_start -> turn_start -> message_start -> message_update*
 *   -> turn_end -> agent_end -> agent_settled.
 *
 * Semantics (per the spike verdict):
 *   - message_update + assistantMessageEvent.text_delta streams output;
 *   - message_end + role assistant sets final output / stopReason / model;
 *   - agent_end + messages array refines output from the last assistant msg;
 *   - agent_settled marks the TERMINAL SUCCESS marker (the last NDJSON line).
 *
 * Pure module: zero @earendil-works/* imports, zero child_process, zero fs.
 */
import type { AssistantLikeMessage, ChildResult } from "../core/types.js";
import { parseJsonLine, textFromMessage } from "../core/records.js";

export interface NdjsonParserOptions {
  /** Incremental update callback (result mutated before each emit). */
  onUpdate?: (result: ChildResult) => void;
}

/**
 * Streaming NDJSON line parser. Feed chunked stdout via `push`, then `flush`
 * after close to drain any trailing unterminated line.
 */
export class NdjsonStreamParser {
  private buffer = "";
  private finalText = "";
  /** Previous assistant message_end usage snapshot (delta accumulation base). */
  private lastUsage?: NonNullable<AssistantLikeMessage["usage"]>;
  /** True once any usage-bearing event was applied (agent_end fallback guard). */
  private sawUsage = false;
  private readonly onUpdate?: (result: ChildResult) => void;

  /** True once `agent_settled` has been observed (terminal success marker). */
  settled = false;

  constructor(
    readonly result: ChildResult,
    options?: NdjsonParserOptions,
  ) {
    this.onUpdate = options?.onUpdate;
  }

  /**
   * Accumulate one usage snapshot with DELTA semantics (B4 anti-
   * double-counting). The child pi re-encodes the whole conversation each
   * turn, so consecutive message_end usage snapshots are CUMULATIVE for
   * input/cache: summing them directly would re-count the growing context
   * (benchmark pi-small-dense §1.4/§3.2). Run totals therefore accumulate
   * `max(0, current - previous)` per field, which equals the LAST cumulative
   * snapshot for monotonic counters. `contextTokens` keeps the OTHER
   * semantics — current context size — as the LAST totalTokens snapshot
   * (overwritten, never summed; pi9 activity.ts:111-119).
   */
  private applyUsageDelta(usage: NonNullable<AssistantLikeMessage["usage"]>): void {
    const acc = this.result.usage;
    const previous = this.lastUsage;
    const delta = (current: number | undefined, prior: number | undefined): number =>
      Math.max(0, (current ?? 0) - (prior ?? 0));
    acc.input += delta(usage.input, previous?.input);
    acc.output += delta(usage.output, previous?.output);
    acc.cacheRead += delta(usage.cacheRead, previous?.cacheRead);
    acc.cacheWrite += delta(usage.cacheWrite, previous?.cacheWrite);
    acc.cost += delta(usage.cost?.total, previous?.cost?.total);
    acc.contextTokens = usage.totalTokens ?? acc.contextTokens;
    this.lastUsage = usage;
    this.sawUsage = true;
  }

  /** True once the terminal `agent_settled` marker was parsed. */
  get hasSettled(): boolean {
    return this.settled;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.processLine(line);
  }

  /** Drain any trailing unterminated (non-empty) buffer line. */
  flush(): void {
    if (this.buffer.trim()) this.processLine(this.buffer);
    this.buffer = "";
  }

  private processLine(line: string): void {
    const event = parseJsonLine(line);
    if (!event) return;

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta ?? "";
      this.finalText += delta;
      this.result.output = this.finalText;
      this.onUpdate?.(this.result);
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = textFromMessage(event.message);
      if (text) {
        this.finalText = text;
        this.result.output = text;
      }
      this.result.stopReason = event.message.stopReason;
      this.result.errorMessage = event.message.errorMessage;
      if (event.message.model) {
        this.result.model = `${event.message.provider ?? ""}/${event.message.model}`.replace(/^\//, "");
      }
      // One assistant turn per message_end (counted even without usage so
      // assistantTurnSeen derivations keep working for usage-less providers).
      this.result.usage.turns += 1;
      if (event.message.usage) {
        this.applyUsageDelta(event.message.usage);
      }
      this.onUpdate?.(this.result);
      return;
    }

    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const assistantMessages = event.messages.filter((message) => message.role === "assistant");
      const last = assistantMessages.at(-1);
      const text = textFromMessage(last);
      if (text) this.result.output = text;
      // Defensive fallback: a provider that omits usage on message_end but
      // carries it on the final messages array gets the LAST assistant usage
      // applied once (delta from zero = the snapshot itself).
      if (!this.sawUsage && last?.usage) {
        this.applyUsageDelta(last.usage);
        if (this.result.usage.turns === 0) this.result.usage.turns = 1;
      }
      return;
    }

    if (event.type === "agent_settled") {
      this.settled = true;
    }
  }
}
