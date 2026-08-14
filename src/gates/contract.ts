/**
 * src/gates/contract.ts — six-part delegation contract validation (pure).
 * Ported verbatim from the ZOB harness safety gates. No fs/env side effects.
 */

/** Render the six-part delegation contract template with a task line. */
export function formatContractTemplate(task = "[atomic goal]"): string {
  return `1. TASK: ${task}
2. EXPECTED OUTCOME: [observable artifact, verdict, or changed file set]
3. REQUIRED TOOLS: [allowed tools / APIs only]
4. MUST DO:
   - Restate constraints before tool use.
   - Verify existing state before changing anything.
   - Produce concrete evidence before claiming done.
5. MUST NOT DO:
   - No secret reads or writes.
   - No broad destructive commands.
   - No commits unless explicitly requested.
6. CONTEXT:
   - Paths:
   - Prior evidence:
   - Downstream use:

FINAL FORMAT:
- Verdict / result
- Evidence (files, commands, outputs)
- Risks / blockers
- Compliance line
- deliverable_delivered: yes/no`;
}

const CONTRACT_PARTS: Array<{ label: string; pattern: RegExp }> = [
  { label: "TASK", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?TASK\s*:/i },
  { label: "EXPECTED OUTCOME", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?EXPECTED\s+OUTCOME\s*:/i },
  { label: "REQUIRED TOOLS", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?(?:REQUIRED\s+TOOLS|TOOLS)\s*:/i },
  { label: "MUST DO", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?MUST\s+DO\s*:/i },
  { label: "MUST NOT DO", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?MUST\s+NOT(?:\s+DO)?\s*:/i },
  { label: "CONTEXT", pattern: /(?:^|\n)\s*(?:\d+\.\s*)?CONTEXT\s*:/i },
];

/**
 * Validate that a task string contains all six contract sections in order,
 * each with a non-empty body. Returns an array of human-readable errors
 * (empty array when valid).
 */
export function validateSixPartContract(task: string): string[] {
  const errors: string[] = [];
  const matches = CONTRACT_PARTS.map((part) => {
    const match = part.pattern.exec(task);
    return { ...part, index: match?.index ?? -1, end: match ? match.index + match[0].length : -1 };
  });

  for (const match of matches) {
    if (match.index === -1) errors.push(`Missing contract section: ${match.label}`);
  }
  if (errors.length > 0) return errors;

  for (let index = 1; index < matches.length; index += 1) {
    const current = matches[index];
    const previous = matches[index - 1];
    if (current !== undefined && previous !== undefined && current.index < previous.index) {
      errors.push(`Contract section out of order: ${current.label}`);
    }
  }

  const ordered = [...matches].sort((left, right) => left.index - right.index);
  for (const [index, match] of ordered.entries()) {
    const next = ordered[index + 1];
    const body = task.slice(match.end, next?.index ?? task.length).trim();
    if (!body || /^\[.*\]$/.test(body)) errors.push(`Empty contract section: ${match.label}`);
  }
  return errors;
}
