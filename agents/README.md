# agents/ — default subagent cards

Five generic default subagent cards ship with pi-subagents. They are the
fallback when a project does **not** define its own agents. Each card is a
plain `.md` file with YAML-like frontmatter plus a prompt body.

| Card | Role | model_class | tools |
| --- | --- | --- | --- |
| `explore` | read-only fact/file/gap mapping | `cheap` | read, grep, find, ls |
| `planner` | read-only plan + handoff contract | `balanced` | read, grep, find, ls |
| `implementer` | bounded source edits + verdict | `capable` | read, grep, find, ls, edit, write, bash |
| `oracle` | skeptical review + no_ship | `capable` | read, grep, find, ls |
| `qa` | verification / reproduction | `balanced` | read, grep, find, ls, bash |

## Frontmatter fields

- `name` — lower-case agent id (discovery is case-insensitive; last-wins dedupe).
- `description` — what the agent does; used by catalog search.
- `tools` — comma-separated allowlist (capability grant, never a way to add tools).
- `thinking` — `low | medium | high | xhigh`.
- `model_class` — declared routing class: `cheap | balanced | capable`
  (mapped to the harness vocabulary `cheap_scout` / `balanced_worker` /
  `strong_reasoning|strong_oracle|high_context`). This is the class a caller
  requests for model routing + fallback. An explicit `model` override is
  optional and, when set, is gated against the verified model catalog.
- body — the agent system prompt.

## Overriding for a project (recommended)

The defaults are generic. A project should override them with project-local
agents so routing, tool grants and prompts match its own conventions.

Project agents live in `.pi/agents/*.md` (scope `project`). The engine
discovers them via the injectable `resolveAgentDirs`; the default resolver
returns `<cwd>/.pi/agents` for project scope and `[]` for user scope. A
project agent with the same name as a default **overrides** it (case-insensitive
last-wins dedupe), so you can replace `implementer` with a project-specific
`implementer` without touching this package.

Example project override `/.pi/agents/implementer.md`:

```md
---
name: implementer
description: Project implementation agent bound to src/.
tools: read, grep, find, ls, edit, write, bash
thinking: high
model_class: capable
---
You are the project implementer. Only edit under src/ and test/.
```

User-scope agents (scope `user`) are resolved through `resolveAgentDirs`
(empty by default in the standalone package). When scope is `both`, user
agents are discovered first, then project agents override them.

## Safety

- Tool lists are allowlists; a write tool (`edit`/`write`) requires non-empty
  repo-relative `allowed_paths` or the write-scope gate blocks preflight.
- Agents never commit, never dispatch children, and never mark parent-owned
  goals/TODOs complete directly — they return evidence/claims for parent review.
