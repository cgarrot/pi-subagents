/**
 * src/extension/pi-types.ts — minimal LOCAL interfaces for the Pi ExtensionAPI
 * surface (mirror of the pi-mesh pattern, invariant I9).
 *
 * ZERO imports from @earendil-works/* (or any Pi package). This is the ONLY
 * module in the package allowed to reference the Pi API shape; the core
 * (core/gates/registry/models/lanes/engine/shared) must stay Pi-free. The real
 * Pi types are wired at load time by the Pi host; these local declarations keep
 * the adapter buildable and testable standalone (with a stub ExtensionAPI).
 *
 * Tool parameters are plain JSON Schema objects (zero-dependency: NO typebox).
 */

/** JSON Schema object (plain, zero-dependency constraint). */
export type JsonSchema = Record<string, unknown>;

/** Stable widget key (id) used to register/update/clear a footer widget. */
export type WidgetKey = string;

/**
 * Footer-widget content. The SAFE form is `string[]` (Pi wraps each line in a
 * Text component and truncates itself); `undefined` clears the widget.
 */
export type WidgetContent = string[] | undefined;

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
}

/** Context passed by Pi to tool execute / command handler / session hooks. */
export interface SessionContext {
  cwd: string;
  hasUI?: boolean;
  /**
   * F3: current session model WHEN the host exposes it on the context. Two
   * shapes: pi >= 0.84 exposes the live Model OBJECT `{ provider, id }`
   * (pi types.d.ts `Model<any>`); other hosts may pass a `"provider/model"`
   * (or bare id) STRING. The adapter normalizes both to a plain
   * `"provider/id"` string before any engine use (normalizeParentModelInput
   * in tools.ts) — object values must NEVER reach `.trim()` directly.
   * Optional: hosts that do not provide it keep full functionality — the
   * subagents runtime then resolves the parent model from the pi settings
   * `defaultModel` (project `.pi/settings.json` over the global
   * `~/.pi/agent/settings.json`) via an injectable reader.
   */
  model?: string | { provider: string; id: string };
  ui: {
    notify(message: string, opts?: { level?: string }): void;
    /** Footer-widget above the editor; string[] is the SAFE form only. */
    setWidget?(id: WidgetKey, content: WidgetContent): void;
    /** Compact status in the built-in footer; undefined clears it. */
    setStatus?(id: string, text: string | undefined): void;
  };
}

/** Alias so the adapter reads naturally alongside the harness manifest. */
export type ExtensionContext = SessionContext;

export type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: ToolResult) => void) | undefined,
  ctx: SessionContext,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string | string[];
  /** Plain JSON Schema object — NOT typebox. */
  parameters: JsonSchema;
  execute: ToolExecuteFn;
}

export interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: SessionContext) => void | Promise<void>;
}

export type SessionEventName = "session_start" | "session_shutdown" | "session_before_fork";

export type SessionHookHandler = (
  event: unknown,
  ctx: SessionContext,
) => void | Promise<void>;

/** Handler for cross-extension event-bus messages. */
export type EventHandler = (payload: unknown) => void;

/**
 * Cross-extension event bus (`pi.events`). Channels are plain strings
 * (`subagents:*` for lifecycle events, `subagents:rpc*` for RPC). Optional on
 * the ExtensionAPI: hosts without a bus keep the extension fully functional
 * (event emission and RPC degrade to harmless no-ops).
 */
export interface EventBusApi {
  on(channel: string, handler: EventHandler): void;
  emit(channel: string, payload?: unknown): void;
}

/** The subset of the Pi ExtensionAPI used by the subagents adapter. */
export interface ExtensionAPI {
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, def: CommandDefinition): void;
  appendEntry(customType: string, data?: unknown): void;
  on(event: SessionEventName, handler: SessionHookHandler): void;
  /** Cross-extension event bus; optional (absent -> no-op wiring). */
  events?: EventBusApi;
}

/** Helper: a single-paragraph text tool result. */
export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const out: ToolResult = { content: [{ type: "text", text }] };
  if (details !== undefined) out.details = details;
  return out;
}
