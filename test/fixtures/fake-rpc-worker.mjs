#!/usr/bin/env node
// test/fixtures/fake-rpc-worker.mjs — deterministic stand-in for a real
// `pi --mode rpc` child. It speaks the documented JSONL subset only:
// responses correlated by id, session events interleaved. No model, no deps.
//
// Env:
//   FAKE_RPC_BUSY_MS   how long a turn runs before settling (default 300)
//   FAKE_RPC_EXIT_ON   "prompt" | "abort" | "stop" to simulate a crash
//   FAKE_RPC_BAD_LINE  "1" to emit one non-JSON line (protocol_error test)
import { createInterface } from "node:readline";

const BUSY_MS = Number(process.env.FAKE_RPC_BUSY_MS ?? "300");
const EXIT_ON = process.env.FAKE_RPC_EXIT_ON ?? "";

const state = {
  streaming: false,
  abortedCount: 0,
  promptCount: 0,
  steerCount: 0,
  followUpCount: 0,
  lastMessage: "",
  steeringMode: "one-at-a-time",
  settleTimer: null,
};

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const respond = (id, command, success, data, error) =>
  emit({ id, type: "response", command, success, ...(data !== undefined ? { data } : {}), ...(error !== undefined ? { error } : {}) });

function settle(aborted) {
  if (!state.streaming) return;
  if (state.settleTimer !== null) {
    clearTimeout(state.settleTimer);
    state.settleTimer = null;
  }
  state.streaming = false;
  emit({ type: "turn_end" });
  emit({ type: "agent_end" });
  emit({ type: "agent_settled", aborted });
}

function startTurn(message) {
  state.promptCount += 1;
  state.lastMessage = message;
  state.streaming = true;
  emit({ type: "turn_start" });
  emit({ type: "agent_start" });
  state.settleTimer = setTimeout(() => settle(false), BUSY_MS);
}

process.stderr.write("fake-rpc-worker ready\n");
if (process.env.FAKE_RPC_BAD_LINE === "1") process.stdout.write("not-json-at-all\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      respond(id, "get_state", true, {
        isStreaming: state.streaming,
        pendingMessageCount: 0,
        steeringMode: state.steeringMode,
        promptCount: state.promptCount,
        steerCount: state.steerCount,
        followUpCount: state.followUpCount,
        abortedCount: state.abortedCount,
        lastMessage: state.lastMessage,
      });
      break;
    case "prompt":
      if (state.streaming && cmd.streamingBehavior === undefined) {
        respond(id, "prompt", false, undefined, "cannot prompt while streaming (use steer or followUp)");
        break;
      }
      respond(id, "prompt", true, { disposition: "started" });
      if (EXIT_ON === "prompt") {
        setTimeout(() => process.exit(3), 5);
        break;
      }
      if (!state.streaming) startTurn(String(cmd.message ?? ""));
      else state.lastMessage = String(cmd.message ?? "");
      break;
    case "steer":
      state.steerCount += 1;
      state.lastMessage = String(cmd.message ?? "");
      respond(id, "steer", true, { queued: true });
      break;
    case "follow_up":
      state.followUpCount += 1;
      state.lastMessage = String(cmd.message ?? "");
      respond(id, "follow_up", true, { queued: true });
      break;
    case "abort": {
      const wasStreaming = state.streaming;
      if (wasStreaming) state.abortedCount += 1;
      respond(id, "abort", true, { aborted: wasStreaming });
      if (EXIT_ON === "abort") {
        setTimeout(() => process.exit(4), 5);
        break;
      }
      // Real pi settles after the abort response; setImmediate keeps the
      // response first while still being deterministic.
      if (wasStreaming) setImmediate(() => settle(true));
      break;
    }
    case "abort_bash":
      respond(id, "abort_bash", true, { note: "noop-for-agent-bash" });
      break;
    case "set_steering_mode":
      state.steeringMode = String(cmd.mode ?? "one-at-a-time");
      respond(id, "set_steering_mode", true, { steeringMode: state.steeringMode });
      break;
    case "stop":
      respond(id, "stop", true, {});
      setTimeout(() => process.exit(0), 5);
      break;
    case "hang":
      // Deliberately no response: exercises the client-side timeout.
      break;
    default:
      respond(id, String(cmd.type ?? "unknown"), false, undefined, "unknown command");
      break;
  }
});

rl.on("close", () => process.exit(0));
