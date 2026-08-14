# pi-subagents

Standalone, modular extraction of the ZOB harness subagents system
(`delegate_agent` / `delegate_task`) — a mirror of the pi-mesh pattern.

- **Pure core** — the core (`core/gates/registry/models/lanes/engine/shared`)
  imports nothing from `@earendil-works/*`. Pi only appears in the thin
  extension adapter (`src/extension`, with local `pi-types.ts`).
- **Hot session pool (lanes)** — a bounded pool of warm child sessions.
- **Model routing with fallback** — explicit `A→B→parent` chain, no silent
  fallback; fallback carries an explicit `model_fallback` status.
- **Ported gates** — the ZOB delegation gates carried over.

## Target layout

```text
packages/pi-subagents/
├── package.json               # pi-subagents-extension 0.1.0, zero runtime deps
├── tsconfig.json              # strict, ESM, NodeNext, outDir dist
├── .gitignore                 # node_modules, dist
├── index.ts                   # re-export default from src/extension/index.js
├── LICENSE                    # MIT
├── README.md                  # this file
├── src/
│   ├── core/index.ts          # pure core (no Pi import)
│   ├── gates/index.ts         # ported gates
│   ├── registry/index.ts      # registry
│   ├── models/index.ts        # model routing types
│   ├── lanes/index.ts         # LanePool — single mutable state
│   ├── engine/index.ts        # execution engine
│   ├── extension/
│   │   ├── index.ts           # thin Pi adapter (default export)
│   │   └── pi-types.ts        # local Pi type shims
│   └── cli/index.ts           # CLI entry
├── child/README.md            # child adapter notes
├── agents/                    # default subagent cards (see agents/README.md)
│   ├── explore.md planner.md implementer.md oracle.md qa.md
│   └── README.md              # override guide
├── skills/
│   └── subagents-routing/
│       └── SKILL.md           # routing skill for pi-subagents users
├── scripts/
│   ├── subagents-smoke.mjs    # headless E2E smoke (fake-pi, no real pi)
│   └── run-tests.mjs          # portable recursive test runner
└── test/                      # unit + engine + lanes + gates + models suites
```

## Single mutable state: the LanePool

The only mutable state in the system is the **LanePool** (`src/lanes`). Every
hot child session lives in exactly one lane; every operation flows through the
pool. Everything else is derived or stateless, which keeps the system
testable and auditable.

### v1 verdict (delivered): spawn-per-task + stable session

Per the **stdin spike verdict**, `pi` exits after a task (stdin is one-shot —
there is no built-in multi-task loop). Therefore **v1** dispatches each task
as a fresh one-shot spawn (`pi --mode json -p --no-extensions`), but reuses a
**STABLE `--session` path per lane**. A chain of tasks on the same lane keeps
context continuity through the same session file: **one boot per lane for N
tasks** (demonstrated headless by the smoke: two chain steps share one
`sessionPath`).

The **v2 warm-loop** (one long-lived `pi` serving N tasks via a child
extension) is a **separate future spike**, out of scope here.

## Model routing

Resolution priority: `explicitModel → agentModel → class model → parentModel`.

- **Explicit model** is verified against an injected verified model catalog;
  it **blocks** with `model_unavailable` (no child spawned) unless it is
  present with `resolutionStatus === 'verified'`. **No silent fallback.**
- **Class routing** (`cheap | balanced | capable`) builds the honest fallback
  chain `A → B → parent`; the parent is the last-resort sentinel and is never
  probed. The chosen model + `direct`/`fallback` status are always exposed.
- The model probe is an optional injected hook fired **off the critical path**
  (fire-and-forget, never awaited before spawn) with a shared long-TTL cache.

## Invariants (I1–I15)

- **I1** — ledger hash-only, `bodyStored: false`; never store raw bodies.
- **I2** — six-part contract validated before any spawn.
- **I3** — `allowed_paths` repo-relative only, forbidden deny-only, broad roots refused.
- **I4** — one child = one isolated pi process (`--no-extensions` + child adapter), never a shell.
- **I5** — honest statuses `queued → running → complete | failed | aborted | preflight_failed`.
- **I6** — output validated against the output contract (`*.v1` + final marker) before acceptance.
- **I7** — zero loop: anti-duplicate, abort `SIGTERM → 5s → SIGKILL`, named timeouts.
- **I8** — every bound is a named constant.
- **I9** — core (`core/gates/registry/models/lanes/engine/shared`) imports nothing from `@earendil-works/*`; extension = thin adapter with local `pi-types.ts`.
- **I10** — model probe: no silent fallback (fallback = explicit routing with `model_fallback` status).
- **I11** — injectable runner (spawner/stdio) → deterministic tests without Pi.
- **I12** — optional hooks (goal, mesh, models) never required by the core.
- **I13** — model probe off the critical path + shared long-TTL cache.
- **I14** — honest fallback chain `A→B→parent` with `model_fallback` status.
- **I15** — bounded hot lane pool (idle TTL, `SIGTERM→SIGKILL`, max size).

## Tools

The package ports the ZOB delegation tool family onto the pure core (extension
adapter `src/extension`, CLI `src/cli`).

| Tool / command | Surface | Notes |
| --- | --- | --- |
| `delegate_task` | extension tool | strict single child with preflight + write gates |
| `delegate_agent` | extension tool | single / parallel / chain child agents |
| `get_delegation_run` | engine (`BackgroundRunRegistry`) | read current background run state |
| `await_delegation_run` | engine | bounded wait for background settlement |
| `subagents` (CLI) | `src/cli/subagents.ts` | admin surface over the pure core |

`subagents` CLI commands:

```text
subagents agents   [--scope project|user|both]
subagents catalog
subagents contract "<six-part task>"
subagents runs     [--sort active|latest|duration|agent]
subagents doctor   [--timing]
subagents --help
```

## Configuration: `.subagents`

Runtime behaviour is configured via an optional `.subagents` file at the repo
root (project-local defaults) plus injected options at the engine boundary:

- `model.classes` — `cheap | balanced | capable` preferred model ids and the
  per-class fallback chain.
- `model.verifiedCatalog` — explicit-model allowlist (only `resolutionStatus:
  verified` models may be requested explicitly).
- `lanes.maxParallel` — concurrency cap (default 4).
- `lanes.killGraceMs` — abort grace between `SIGTERM` and `SIGKILL` (default 5000).
- `lanes.sessionDir` — session-file dir (default `<cwd>/.pi/agent-sessions`).
- `ledger.dir` — hash-only ledger dir (default `<repoRoot>/.pi/logs/runs`).
- `spawn` — injectable spawner; tests inject the fake-pi fixture (I11).

> The exact `.subagents` schema is resolved by the extension adapter layer; the
> core only consumes injected options (never reads config itself), preserving
> the pure-core invariant.

## Default agents

Five generic default cards ship under `agents/`: `explore`, `planner`,
`implementer`, `oracle`, `qa` — each with `model_class cheap|balanced|capable`.
They are the fallback when a project defines none. See `agents/README.md` for
frontmatter fields and how to override them with project-local `.pi/agents`.

> Note: agent discovery reads `*.md` under an agent dir. The package's
> `agents/README.md` is documentation only; a project agent dir should hold
> only agent cards (or exclude docs) so no spurious `readme` agent is found.

## Scripts

```bash
npm run build            # tsc -p tsconfig.json
npm test                 # build + node --test dist/test
npm run smoke            # scripts/subagents-smoke.mjs (headless E2E, fake-pi)
npm run ci               # build + test + smoke
```

## Smoke (headless, no real pi)

`node scripts/subagents-smoke.mjs` drives the full delegation pipeline with the
**fake-pi** fixture (`test/fixtures/bin/fake-pi.mjs`) injected as the spawner:

1. builds a body-free **catalog** (registry) over the default agents;
2. validates a **six-part contract** and proves preflight **blocks before any
   spawn** (no child launched on gate failure);
3. runs a **single** task through the engine + LanePool;
4. runs a **chain** (2 steps) proving `{previous}` substitution + the **same
   `sessionPath`** (one boot for N tasks);
5. runs **parallel** dispatch under a concurrency cap;
6. verifies **hash-only / body-free ledger** entries (`bodyStored: false`,
   raw bodies stripped to sha-256);
7. runs a **background** delegation and inspects it via `get_delegation_run`.

It exits `0` only when every check passes, otherwise prints the failure and
exits non-zero. Requires a prior `npm run build`.

## Limitations

- **v2 warm-loop** (one long-lived `pi` serving N tasks via a child extension)
  is a future spike; v1 is spawn-per-task with a stable per-lane session.
- **Session files grow**: each lane appends NDJSON to a stable `*.jsonl`
  session file, so long-running chains accumulate session content. v2 will
  add rollover / compaction.
- **Agent discovery reads `*.md`**: a documentation file inside an agent dir
  is parsed as an (empty) agent; keep agent dirs to cards only.
- Extension adapter (`src/extension`) and CLI are the thin Pi-facing layer and
  are the only modules allowed to touch `pi-types.ts`.
