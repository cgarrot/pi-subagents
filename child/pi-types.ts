/**
 * child/pi-types.ts — local Pi type shims for the child extension adapter.
 *
 * Zero @earendil-works/* imports (invariant I9). This module is the ONLY one
 * in the child adapter that mirrors the Pi ExtensionAPI surface. The adapter
 * wires these types to the real Pi API at load time inside the child lanes.
 */

export interface PiTheme {
  fg(name: string, text: string): string;
}

export interface PiUI {
  setStatus(key: string, status: string | undefined): void;
  readonly theme: PiTheme;
}

export interface PiToolCallInput {
  path?: string;
  command?: string;
  [key: string]: unknown;
}

export interface PiToolCallEvent {
  toolName: string;
  input: PiToolCallInput;
}

export type ToolCallEventType = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";

export function isToolCallEventType(type: ToolCallEventType, event: { toolName: string }): boolean {
  return event.toolName === type;
}

export interface PiSessionStartEvent {}
export interface PiSessionShutdownEvent {}

/** Text content block of a tool result (mirror of the real Pi shape). */
export interface PiToolTextContent {
  type: "text";
  text: string;
}

/** Tool result returned from `execute` (mirror of the real Pi shape). */
export interface PiToolResult {
  content: PiToolTextContent[];
  details?: Record<string, unknown>;
  /** Skip the follow-up LLM call after this tool batch (ends the turn). */
  terminate?: boolean;
}

/**
 * Custom tool definition (subset of the real Pi ToolDefinition used by the
 * child adapter — e.g. the B5 `ask_master` escalation tool).
 */
export interface PiToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** Plain JSON Schema object. */
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partial: PiToolResult) => void,
    ctx?: PiExtensionContext,
  ) => Promise<PiToolResult>;
}

export interface PiExtensionContext {
  readonly cwd: string;
  readonly ui: PiUI;
}

export interface PiSendUserMessageOptions {
  /**
   * Delivery mode when the agent is streaming (mid-turn):
   * - "steer" — queued for delivery after the current assistant turn finishes
   *   executing its tool calls, before the next LLM call.
   * - "followUp" — waits for the agent to finish all tools.
   *
   * Mirror of the real Pi API (docs/extensions.md "pi.sendUserMessage(content,
   * options?)"; dist/core/extensions/types.d.ts:841-843 in package 0.75.5).
   */
  deliverAs?: "steer" | "followUp";
}

export interface ExtensionAPI {
  on(
    event: "session_start",
    handler: (event: PiSessionStartEvent, ctx: PiExtensionContext) => void | Promise<void>,
  ): void;
  on(
    event: "session_shutdown",
    handler: (event: PiSessionShutdownEvent, ctx: PiExtensionContext) => void | Promise<void>,
  ): void;
  on(
    event: "tool_call",
    handler: (
      event: PiToolCallEvent,
      ctx: PiExtensionContext,
    ) => void | undefined | { block: boolean; reason: string } | Promise<void | undefined | { block: boolean; reason: string }>,
  ): void;
  appendEntry(customType: string, data: unknown): void;
  /**
   * Send a real user message to the agent (appears as if typed by the user).
   * Always triggers a turn; `deliverAs` is required while the agent is
   * streaming. Used by the steer-file poll to inject mid-run steering.
   */
  sendUserMessage(content: string, options?: PiSendUserMessageOptions): void;
  /**
   * Register a custom LLM-callable tool. Optional on the shim so hosts and
   * test doubles without tool registration stay valid; the B5 `ask_master`
   * tool degrades to a no-op there.
   */
  registerTool?(tool: PiToolDefinition): void;
}
