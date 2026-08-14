#!/usr/bin/env node
// test/fixtures/bin/fake-pi.mjs — fake `pi` binary for headless lanes tests.
//
// Reads the task from stdin (one-shot) or the final positional arg, and emits
// the exact NDJSON sequence observed in the stdin spike:
//   session -> agent_start -> turn_start -> message_start -> message_update*
//   -> turn_end -> agent_end -> agent_settled
// and exits 0.
//
// Option `--fail`: emits partial updates then exits non-zero (3) WITHOUT
// emitting agent_end / agent_settled, so tests can exercise a clean failure.
//
// Option `--escalate <msg>` (B5 ask_master tests): emits the normal NDJSON
// sequence for one assistant turn, then atomically writes the escalation file
// `<PI_SUBAGENTS_ESCALATION_DIR>/<PI_SUBAGENTS_RUN_ID>.escalation.json`
// ({runId, message, timestamp}) — mirroring child/escalation.ts — and exits
// with the escalation code 42. When the env vars are absent the file is NOT
// written (tests the parent's clean no-file fallback); the exit stays 42.
//
// Option `--usage-turns <N>`: emits N assistant turns whose message_end
// usage GROWS CUMULATIVELY (pi re-encodes the whole conversation each turn):
// input/cacheRead/totalTokens/cost grow per turn. Used by the B4 anti-
// double-counting cost-tracking tests (deltas or last-usage, never the sum).
//
// Option `--turns <N>` (B3 graceful turn-limit tests): emits N assistant
// message_end turns separated by a small delay (FAKE_PI_TURN_DELAY_MS,
// default 60) so the parent can soft-steer / hard-abort at deterministic
// turn boundaries. The final turn's text is `answer:<task>`; earlier turns
// emit `turn <i> of <N>`. With `--turns-deliverable`, the final turn's text
// also carries a base.v1-compliant suffix so engine output gates pass.
//
// All real `pi` options (--session, --model, --thinking, --tools,
// --append-system-prompt, -e, -p, --no-extensions, --mode) are parsed and
// ignored; the fixture only cares about the task payload.

const argv = process.argv.slice(2);
const fail = argv.includes("--fail");
const positional = [];
let usageTurns = 0;
let turnsMode = 0;
let escalateMessage;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--fail") continue;
  if (a === "--escalate") {
    escalateMessage = String(argv[i + 1] ?? "");
    i += 1;
    continue;
  }
  if (a === "--usage-turns") {
    usageTurns = Math.max(0, Math.floor(Number(argv[i + 1]) || 0));
    i += 1;
    continue;
  }
  if (a === "--turns") {
    turnsMode = Math.max(0, Math.floor(Number(argv[i + 1]) || 0));
    i += 1;
    continue;
  }
  if (a === "--turns-deliverable") continue;
  if (
    a === "--session" ||
    a === "--model" ||
    a === "--thinking" ||
    a === "--tools" ||
    a === "--append-system-prompt" ||
    a === "--mode" ||
    a === "-e"
  ) {
    i += 1; // skip option value
    continue;
  }
  if (a === "-p" || a === "--no-extensions") continue;
  positional.push(a);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const stdinTask = (await readStdin()).trim();
const task = stdinTask || positional.join(" ");

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const ts = Date.now();

emit({
  type: "session",
  version: 3,
  id: "fake-session",
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
});
emit({ type: "agent_start" });
emit({ type: "turn_start" });
emit({
  type: "message_start",
  message: { role: "user", content: [{ type: "text", text: task }], timestamp: ts },
});
emit({
  type: "message_end",
  message: { role: "user", content: [{ type: "text", text: task }], timestamp: ts },
});
emit({
  type: "message_start",
  message: { role: "assistant", content: [], model: "gpt-5.5", provider: "openai-codex" },
});

const answer = `answer:${task}`;

if (escalateMessage !== undefined) {
  // B5 escalation mode: one assistant turn announcing the escalation, then
  // the ask_master side effect (atomic escalation-file write) + exit 42.
  const turnText = `escalating to master: ${escalateMessage}`;
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (let i = 0; i < turnText.length; i += 3) {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: turnText.slice(i, i + 3) } });
  }
  emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
  emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: turnText }], model: "gpt-5.5", provider: "openai-codex" },
  });
  emit({ type: "turn_end" });
  emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: turnText }] }] });
  emit({ type: "agent_settled" });
  const runId = process.env.PI_SUBAGENTS_RUN_ID;
  const escalationDir = process.env.PI_SUBAGENTS_ESCALATION_DIR;
  if (runId && escalationDir && escalateMessage.length > 0) {
    const { mkdirSync, renameSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(escalationDir, { recursive: true });
    const target = join(escalationDir, `${runId}.escalation.json`);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runId, message: escalateMessage, timestamp: Date.now() }), "utf8");
    renameSync(tmp, target);
  }
  process.exit(42);
}

if (turnsMode > 0) {
  // B3 multi-turn mode: N assistant message_end turns with inter-turn delays
  // so soft-steer / hard-abort land on deterministic turn boundaries.
  const deliverable = argv.includes("--turns-deliverable");
  const delayMs = Math.max(0, Math.floor(Number(process.env.FAKE_PI_TURN_DELAY_MS ?? "60") || 0));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const finalText = deliverable
    ? `${answer}\nEvidence: proof provided\nRisks/blockers: none\nCompliance: satisfied\ndeliverable_delivered: yes`
    : answer;
  for (let turn = 1; turn <= turnsMode; turn++) {
    emit({ type: "message_start", message: { role: "assistant", content: [], model: "gpt-5.5", provider: "openai-codex" } });
    const turnText = turn === turnsMode ? finalText : `turn ${turn} of ${turnsMode}`;
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    for (let i = 0; i < turnText.length; i += 3) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: turnText.slice(i, i + 3) } });
    }
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: turnText }], model: "gpt-5.5", provider: "openai-codex" },
    });
    emit({ type: "turn_end" });
    if (turn < turnsMode) await sleep(delayMs);
  }
  emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: finalText }] }] });
  emit({ type: "agent_settled" });
  process.exit(0);
}

if (usageTurns > 0) {
  // Multi-turn mode with growing cumulative usage per message_end.
  for (let turn = 1; turn <= usageTurns; turn++) {
    emit({ type: "message_start", message: { role: "assistant", content: [], model: "gpt-5.5", provider: "openai-codex" } });
    const turnText = turn === usageTurns ? answer : `turn ${turn} of ${usageTurns}`;
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    for (let i = 0; i < turnText.length; i += 3) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: turnText.slice(i, i + 3) } });
    }
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
    if (fail) {
      process.exit(3);
    }
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: turnText }],
        model: "gpt-5.5",
        provider: "openai-codex",
        usage: {
          input: 1000 * turn,
          output: 100 * turn,
          cacheRead: 2000 * (turn - 1),
          cacheWrite: 0,
          totalTokens: 1100 * turn,
          cost: { total: 0.001 * turn },
        },
      },
    });
    emit({ type: "turn_end" });
  }
  emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }] });
  emit({ type: "agent_settled" });
  process.exit(0);
}

emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
for (let i = 0; i < answer.length; i += 3) {
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer.slice(i, i + 3) },
  });
}
emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } });

if (fail) {
  // Clean failure path: no agent_end / agent_settled, non-zero exit.
  process.exit(3);
}

emit({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: answer }],
    model: "gpt-5.5",
    provider: "openai-codex",
  },
});
emit({ type: "turn_end" });
emit({
  type: "agent_end",
  messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }],
});
emit({ type: "agent_settled" });
process.exit(0);
