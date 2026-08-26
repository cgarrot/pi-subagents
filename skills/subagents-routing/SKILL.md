---
name: subagents-routing
description: Route subagent work through the pi-subagents hot lane pool and model fallback chain (A→B→parent, explicit model_fallback status). Use before delegating subagent tasks when lane/model selection, fallback routing, or gate enforcement matters.
---

# subagents-routing

Skill for users of the standalone **pi-subagents** package (the modular
extraction of the ZOB harness `delegate_agent` / `delegate_task`). Use it
whenever you dispatch a subagent task through the lane pool and engine, or
when agent/contract/model routing is uncertain.

## Mandatory routing check

1. If you are not certain which agent to use, inspect the agent cards:
   project cards live in `<cwd>/.pi/agents/*.md`, user cards in
   `~/.pi/agents/*.md` (available in every session; a project card overrides a
   user card with the same name). You can read those folders with `read`/`ls`.
   The human-facing `/agents catalog` command prints the same body-free catalog
   (agents carry a `promptHash`, never the prompt body; `noExecution: true`,
   `childDispatchAllowed: false`, `bodyStored: false`).
2. Choose the agent by the deliverable you need (see below).
3. **Model routing is advisory unless current availability is proven.** An
   explicit `model` override must be present in the *verified model catalog*
   with `resolutionStatus === 'verified'` before it is allowed to launch a
   child — otherwise preflight **blocks** with status `model_unavailable` and
   a remediation message. A desired/configured/catalogued model is a
   preference, never proof of current provider availability. Prefer omitting
   `model` (parent/session default) or requesting a `model_class`
   (`cheap | balanced | capable`) so routing uses the honest fallback chain.
4. Fallback is **never silent**: when a class-route falls through to a later
   candidate or to the parent sentinel, the resolved route carries an explicit
   `model_fallback` status and the ordered list of models tried.
5. Normally omit `outputContract`; the engine infers it from the selected
   agent. Set it only for an intentional, exact override with a known valid id.
6. Normally omit `tools`; the engine infers the selected agent's declared
   tools. Use `tools` only to narrow, never to add.

## Common agent routing

- Need read-only facts, file mapping, gaps, or context: use `explore`.
- Need an implementation plan, TDD ladder, stop conditions, or handoff: use `planner`.
- Need bounded source edits: use `implementer` with scoped `allowed_paths`.
- Need skeptical review, audit verdict, or `no_ship`: use `oracle`.
- Need verification/reproduction evidence: use `qa`.

## Six-part delegation contract (mandatory)

Every dispatched task must carry the six-part contract before any spawn. The
engine validates it up front (invariant I2) and refuses to launch a child on
any violation.

```text
1. TASK: [atomic goal]
2. EXPECTED OUTCOME: [observable deliverable/verdict]
3. REQUIRED TOOLS: [allowed tools only]
4. MUST DO: [positive constraints]
5. MUST NOT DO: [hard stops]
6. CONTEXT: [paths, prior evidence, downstream use]
```

## Model rules

- **Explicit verified**: an explicit `model` override is allowed only when it
  is in the verified model catalog (`resolutionStatus: 'verified'`) AND you
  have current provider-availability proof for this session. Otherwise omit it.
- **Class fallback**: request a `model_class` (`cheap`/`balanced`/`capable`)
  and the router builds the honest chain `A → B → parent`. The chosen model
  and the `direct`/`fallback` status are always exposed; the parent is the
  last-resort sentinel and is never probed.
- **No silent fallback** (invariant I10/I14): a fallback is always explicit and
  visible in the run record.
- Never downgrade oracle/security work to a weak or unverified default.

## Safety

- `allowed_paths` are capability grants: repo-relative only, never absolute,
  home-relative (`~`), traversal (`..`), or broad roots (`.`). Write tools
  (`edit`/`write`) require non-empty repo-relative `allowed_paths` or the
  write-scope gate blocks preflight.
- `forbidden_paths` are deny-only; they may be repo-local, absolute, or
  home-relative when specific and safe, but broad roots are refused.
- One child = one isolated process (`--no-extensions` + child adapter), never
  a shell (invariant I4).
- Do not ask subagents to mark parent goals/TODOs complete directly; children
  return evidence/claims for parent review.
- Children never dispatch children, never mutate parent TODOs, and never write
  outside their owned paths.
- Subagents must not `git commit` / `git push` / `git tag` unless explicitly
  authorized; the parent owns commit policy.

## Honest statuses

A delegation run is reported with honest statuses:
`queued → running → complete | failed | aborted | preflight_failed`. A
`preflight_failed` run means a gate blocked the launch (no child was spawned);
never report that as a delivery success. Output is accepted only when it
validates against the output contract (final `deliverable_delivered: yes`
marker + required sections).

## Lane pool notes

- v1 is **spawn-per-task** with a stable `--session` per lane: a chain of tasks
  on the same lane reuses the same session path (one boot, context continuity).
- The pool is bounded (idle TTL, `SIGTERM → 5s → SIGKILL`, max size).
- v2 warm-loop (one long-lived `pi` serving N tasks) is a separate spike, out
  of scope here.
