# RPC worker control (`rpc_*`)

A **controller-owned headless `pi --mode rpc` worker**: instead of killing a
delegated child (history lost) or waiting for its turn, you can abort the
current **turn**, wait for `agent_settled`, and prompt the new instruction with
history intact.

This is the answer to "the worker is stuck in a 10-minute bash and I need it to
change plan now". It is **local-only**: the worker is a child of *your*
session, not a mesh peer. Remote control of a peer is a separate concern.

## Tools (one tool = one action)

| tool | action | honest status |
|---|---|---|
| `rpc_start` | spawn + readiness probe (`get_state`); optional agent card + first task | `started` / `error` |
| `rpc_prompt` | prompt (or `streamingBehavior: steer\|followUp`) | `accepted` / `error` |
| `rpc_abort` | abort the current turn, wait for settlement | `aborted` / `not_streaming` / `error` |
| `rpc_redirect` | abort (only if streaming) → settle → prompt | `redirected` / `error` |
| `rpc_state` | live state of one worker, or list all | `running` / `exited` / `stopped` / `failed` |
| `rpc_stop` | stop the worker and its **process tree** | `stopped` / `not_found` |

Statuses never say `delivered`: a local worker accepts a prompt, it does not
"receive a delivery" in the mesh sense.

## Spawn shape (why it is hermetic)

```
pi --mode rpc --no-session --no-extensions --no-mcp [--model M] [--name N] [-e child/index.ts]
```

- `--no-extensions` is critical: without it the worker loads pi-mesh (and every
  other installed package) and becomes a **phantom mesh peer** — the bug in the
  original `mesh_rpc` PR. Explicit `-e` still works.
- `--no-mcp` avoids booting MCP servers in a short-lived worker.
- `guard: true` loads the child write-safety adapter with
  `allowed_paths` / `forbidden_paths`. Default false: the worker has exactly the
  trust of your own `bash`/`edit` tools.

## Specialist workers (`agent` + `task`)

`rpc_start` can load an **agent card** (the same cards `delegate_*` uses):

```
rpc_start { "agent": "implementer", "task": "fix the flaky test", "cwd": "/repo" }
```

- `agent` → the card's prompt via `--append-system-prompt`, its tools via
  `--tools`, its explicit `model` if present.
- `task` → prompted immediately after the readiness probe (the worker starts a
  turn). Omit it to start an idle worker and prompt later.
- `guard` defaults to **true** for a specialist worker (child write-safety
  adapter + `allowed_paths`/`forbidden_paths`).
- An unknown agent is an honest error listing the available cards.

**Boundary vs `delegate_*`:** an RPC worker is a live, steerable session; it
does **not** run the delegation engine's output-contract gates, attestation or
hash-only run ledger. Use `delegate_*` for a bounded one-shot with a six-part
contract, `rpc_*` when the work may need a mid-course correction.

## Remote control (`mesh_run_control`)

When pi-mesh is installed, a peer authorized by mesh policy can stop or steer
one of your workers:

```
mesh_run_control { "to": "bob", "runId": "rpc_…", "action": "stop" }
mesh_run_control { "to": "bob", "runId": "rpc_…", "action": "steer", "message": "use the cache" }
```

pi-mesh emits the already-authorized request on the local `pi.events` bus
(`mesh-ctl`), this extension answers on `mesh-ctl:reply:<ctlId>`; no package
imports, no shell string on the wire. `run_stop` → `stopped`; `run_steer` uses
`steer` while streaming and a fresh `prompt` when idle. Unknown run ids are
`not_found`.

## Semantics

- `abort` ends the whole turn (the running tool included) but **keeps the
  worker and its session history**. A subsequent `prompt` sees the aborted turn.
- `redirect` is the one-call fast path. If the turn settles before the abort
  lands, `aborted` is `false` (honest) and the new prompt is still sent. If
  settlement times out, the new prompt is **not** sent.
- `rpc_prompt` while streaming: pi requires `steer` or `followUp`. A plain
  prompt is rejected by the worker and surfaced as an error.
- `abort_bash` is deliberately not exposed: on real pi it only aborts a
  **direct RPC bash command**, not the agent's `bash` tool. Promising it would
  be a false promise.

## Limits and platform notes

- Max **4** concurrent workers per session (`RPC_MAX_WORKERS`).
- Prompt bodies ≤ 32 KiB; command timeouts 1 s..10 min; default 30 s.
- `redirect` waits up to 60 s for settlement (`RPC_SETTLE_TIMEOUT_MS`).
- POSIX: stop = SIGTERM to the worker's **process group**, SIGKILL after 2 s.
  Windows: `taskkill /T`, then `/F`; there is no graceful signal there.
- Workers are stopped on `session_shutdown` (they cannot outlive the owner).
  A **crashed** host (SIGKILL) leaves no adoption path for a worker: its
  process tree may survive. The start output prints `pid=…`; after a crash,
  kill that pid (and its process group) manually — the new session's registry
  cannot know the old worker.
- No output/body persistence: the worker's stdout/stderr stay in memory
  (bounded ring), exactly like the rest of this package.

## Verified on real pi

- `get_state`, `prompt`, `agent_settled`, `stop` — full smoke.
- `abort` while a real turn is streaming → `agent_settled aborted=true` in
  **~10 ms**, worker still alive afterwards (the redirect precondition).
- **Mid-tool abort**: with `tools: "bash"`, the worker called
  `bash: sleep 30`; `abort` settled in **3 ms** with `aborted=true`, worker
  still alive. This is the real "stop the 10-minute command" path.
- Re-run it: `npm run rpc:abort-smoke` (needs a model; not in CI).

The RPC `abort_bash` method is still not exposed: it only aborts a direct RPC
bash command, not the agent's bash tool.

## Try it

```bash
npm run build
npm run rpc:smoke                 # fake worker: start→prompt→redirect→abort→stop
RPC_SMOKE_REAL=1 npm run rpc:smoke  # + a real pi worker (one small prompt)
```

Then in a Pi session:

```
rpc_start { "cwd": "/repo" }
rpc_redirect { "runId": "rpc_…", "message": "stop the build, use the cache dir and retry" }
rpc_state { "runId": "rpc_…" }
rpc_stop { "runId": "rpc_…" }
```
