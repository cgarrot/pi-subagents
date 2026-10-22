/**
 * src/rpc/protocol.ts — the minimal pi RPC surface this package speaks.
 *
 * Why not import the host's RpcClient: pi-subagents must not depend on
 * `@earendil-works/pi-coding-agent` (invariant I9). This is the documented
 * JSONL subset: one JSON object per line, responses correlated by `id`,
 * session events interleaved on the same stream.
 */

export type SteeringMode = "all" | "one-at-a-time";

/** A response to a command we sent. */
export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** A session event (`agent_start`, `tool_execution_start`, `agent_settled`, …). */
export interface RpcEventRecord {
  type: string;
  [key: string]: unknown;
}

/** The subset of `get_state` data this package reads. */
export interface RpcState {
  isStreaming?: boolean;
  pendingMessageCount?: number;
  steeringMode?: string;
  sessionId?: string;
  messageCount?: number;
  model?: unknown;
  [key: string]: unknown;
}

export type RpcCommand =
  | { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" }
  | { type: "abort_bash" }
  | { type: "get_state" }
  | { type: "set_steering_mode"; mode: SteeringMode }
  | { type: "stop" };

export interface RpcWorkerOptions {
  cwd: string;
  /** Optional explicit model for the child (`--model`). */
  model?: string;
  /** Optional display name for the child (`--name`). */
  name?: string;
  /** Specialist agent card prompt (`--append-system-prompt`). */
  agentPrompt?: string;
  /** Comma-separated tool allowlist (`--tools`). */
  tools?: string;
  /**
   * Load the child write-safety adapter (`-e child/index.ts`). Off by
   * default: an RPC worker is then exactly as trusted as the session's own
   * bash/edit tools. On, it inherits the delegation policy
   * (`ZOB_ALLOWED_PATHS` / `ZOB_FORBIDDEN_PATHS`).
   */
  guard?: boolean;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  /** Extra env merged over the parent env (tests, run id, policy paths). */
  env?: NodeJS.ProcessEnv;
  /** Injectable binary for tests (`{bin, args}` replaces the pi command). */
  command?: { bin: string; args: string[] };
  defaultTimeoutMs?: number;
}

/** True when a parsed stdout object is a command response. */
export function isResponse(value: unknown): value is RpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "response" &&
    typeof (value as { command?: unknown }).command === "string" &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

/** True when a parsed stdout object is a session event. */
export function isEvent(value: unknown): value is RpcEventRecord {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
