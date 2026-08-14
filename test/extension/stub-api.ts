// test/extension/stub-api.ts — a stub ExtensionAPI capturing registrations.
// Mirrors the pi-mesh pattern: tools/commands are recorded so tests can assert
// names, schema shapes, promptSnippets, and drive execute() with a fake ctx.
// The stub also carries an in-memory `events` bus (B7): `on` records handlers
// per channel, `emit` records every emitted payload so event/RPC tests can
// drive handlers and assert emissions.
import type {
  CommandDefinition,
  EventBusApi,
  ExtensionAPI,
  EventHandler,
  SessionContext,
  ToolDefinition,
} from "../../src/extension/pi-types.js";

export interface CapturedApi {
  api: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  entries: Array<{ customType: string; data?: unknown }>;
  events: Array<{ name: string; handler: unknown }>;
  /** Every emit() call on the stub event bus (channel + payload). */
  emitted: Array<{ channel: string; payload?: unknown }>;
  /** Registered event-bus handlers per channel. */
  eventHandlers: Map<string, EventHandler[]>;
}

export function stubApi(): CapturedApi {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const entries: CapturedApi["entries"] = [];
  const events: CapturedApi["events"] = [];
  const emitted: CapturedApi["emitted"] = [];
  const eventHandlers = new Map<string, EventHandler[]>();
  const bus: EventBusApi = {
    on: (channel, handler) => {
      const list = eventHandlers.get(channel) ?? [];
      list.push(handler);
      eventHandlers.set(channel, list);
    },
    emit: (channel, payload) => emitted.push({ channel, payload }),
  };
  const api: ExtensionAPI = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, def) => commands.set(name, def),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    on: (name, handler) => events.push({ name, handler }),
    events: bus,
  };
  return { api, tools, commands, entries, events, emitted, eventHandlers };
}

/** Invoke the handlers registered on one event-bus channel (test driver). */
export function emitTo(captured: CapturedApi, channel: string, payload?: unknown): void {
  for (const handler of captured.eventHandlers.get(channel) ?? []) handler(payload);
}

export function fakeCtx(cwd: string): SessionContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: () => {},
      setWidget: () => {},
      setStatus: () => {},
    },
  };
}

export function toolCtx(cwd: string): SessionContext {
  return fakeCtx(cwd);
}
