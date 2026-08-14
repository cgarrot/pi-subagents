/**
 * src/lanes/args.ts — isolated child argument construction for pi-subagents
 * lanes (v1 spawn-per-task).
 *
 * Ported from the ZOB harness `buildIsolatedChildArgs` (child-runner.ts
 * cr:43-56) and the child args sequence (cr:370-399). Pure module: zero
 * @earendil-works/* imports, zero child_process.
 */

export interface IsolatedChildArgsInput {
  providerExtension?: string;
  codexFastModeExtension?: string;
  childSafetyExtension?: string;
}

/**
 * Build the fixed isolated-args prefix: `--mode json -p --no-extensions`,
 * then `-e <ext>` once per deduplicated non-empty extension.
 */
export function buildIsolatedChildArgs(input: IsolatedChildArgsInput = {}): string[] {
  const args = ["--mode", "json", "-p", "--no-extensions"];
  const extensions = [
    ...new Set(
      [
        input.providerExtension,
        input.codexFastModeExtension,
        input.childSafetyExtension,
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  for (const extension of extensions) args.push("-e", extension);
  return args;
}

export interface ChildFlagsInput {
  sessionPath: string;
  model?: string;
  thinking?: string;
  tools?: string;
  agentPrompt?: string;
}

/**
 * Build the child flags appended after the isolated prefix: `--session <path>`
 * plus optional `--model`, `--thinking`, `--tools`, `--append-system-prompt`.
 * NO `--session-offset`: pi (>= 0.84) resumes a `--session` file AS-IS and
 * rejects the unknown option (`Error: Unknown option: --session-offset`,
 * exit 1) — the continuation byte-offset stays parent-side metadata only.
 * The task itself is NOT placed here — v1 injects the task via stdin one-shot.
 */
export function buildChildFlags(input: ChildFlagsInput): string[] {
  const args = ["--session", input.sessionPath];
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);
  if (input.tools) args.push("--tools", input.tools);
  if (input.agentPrompt) args.push("--append-system-prompt", input.agentPrompt);
  return args;
}
