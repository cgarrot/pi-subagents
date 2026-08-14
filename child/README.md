# child/

Standalone child-session adapter (ported from the harness
`.pi/extensions/zob-child-safety/index.ts`).

One child = one isolated pi process (`--no-extensions` + child adapter via
`-e`), never a shell (invariant I4).

## Steer channel (B2)

When the env var `PI_SUBAGENTS_STEER_FILE` points at this run's `<runId>.steer`
file (written atomically by the parent, `src/lanes/steer.ts`), the adapter
polls it at every `tool_call` hook and injects the payload as a real user
message via `pi.sendUserMessage(message, { deliverAs: "steer" })`, then
deletes the file (consume-once). Invalid payloads are consumed and dropped.
No env var = no polling, zero behavior change.
