/**
 * src/engine/memory.ts — C5 persistent per-agent memory.
 *
 * Benchmark reference (reports/pi-subagents/benchmark/deep/
 * tintinweb-pi-subagents.md §4f, memory.ts): each agent may carry a durable
 * MEMORY.md that is injected into its SYSTEM PROMPT on every dispatch, giving
 * cross-session knowledge continuity. Three scopes:
 *
 *   user    → `<agentDir>/agent-memory/<agent-name>/` (default agentDir
 *             `<homedir>/.pi/agent`, i.e. `~/.pi/agent/agent-memory/…`)
 *   project → `<cwd>/.pi/agent-memory/<agent-name>/`
 *   local   → `<cwd>/.pi/agent-memory-local/<agent-name>/`
 *
 * The agent itself maintains MEMORY.md with its own read/write/edit tools;
 * agents WITHOUT write/edit get an explicit READ-ONLY block (they may consult
 * but never modify memory).
 *
 * Security (anti-traversal):
 *   - `isUnsafeName`: agent names must match `[a-zA-Z0-9][a-zA-Z0-9._-]*`
 *     (max 128) — no path separators, no leading dot, no traversal shapes.
 *   - `safeMemoryRead`: refuses symlinked memory FILES and DIRS (lstat).
 *   - `ensureMemoryDir`: mkdir recursive, refuses symlinked target dirs.
 *
 * The memory block is ALWAYS appended to the agent system prompt by the
 * dispatch layer — never into the task. Zero @earendil-works/* imports.
 */
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Persistent memory scope: where the agent's MEMORY.md lives. */
export type MemoryScope = "user" | "project" | "local";

/** Memory file name inside the per-agent memory dir. */
export const MEMORY_FILE_NAME = "MEMORY.md";

/** Max lines of MEMORY.md injected into the system prompt (benchmark: 200). */
export const MEMORY_MAX_LINES = 200;

/** Header of the injected memory block. */
export const MEMORY_BLOCK_HEADER = "[AGENT MEMORY — PERSISTENT]";

/** Marker appended when the memory file exceeds the line budget. */
export const MEMORY_TRUNCATION_MARKER = "[memory truncated";

/** Whitelist for agent memory names: `[a-zA-Z0-9][a-zA-Z0-9._-]*`, max 128. */
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Max agent-name length accepted for memory paths. */
const MAX_NAME_LENGTH = 128;

/**
 * True when the agent name is unsafe to embed in a memory path (empty, too
 * long, or outside the whitelist — blocks `../` traversal, separators,
 * absolute shapes, and hidden-dot names).
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return true;
  return !SAFE_NAME_PATTERN.test(name);
}

/**
 * Validate a frontmatter `memory:` value into a MemoryScope. Anything other
 * than `user` | `project` | `local` (including absent) degrades to undefined
 * (memory disabled) — garbage never crashes discovery.
 */
export function parseMemoryScope(value: string | undefined): MemoryScope | undefined {
  return value === "user" || value === "project" || value === "local" ? value : undefined;
}

/**
 * Resolve the per-agent memory dir for a scope (see module header for the
 * three exact locations). `agentDir` overrides the user-scope root (the global
 * agent dir); it defaults to `~/.pi/agent`. Throws on unsafe agent names and
 * unknown scopes — callers de-grade to a warning, never traverse.
 */
export function resolveMemoryDir(scope: MemoryScope, agentName: string, cwd: string, agentDir?: string): string {
  if (isUnsafeName(agentName)) {
    throw new Error(`refusing unsafe agent memory name: ${JSON.stringify(agentName)}`);
  }
  switch (scope) {
    case "user":
      return join(agentDir ?? join(homedir(), ".pi", "agent"), "agent-memory", agentName);
    case "project":
      return join(cwd, ".pi", "agent-memory", agentName);
    case "local":
      return join(cwd, ".pi", "agent-memory-local", agentName);
    default:
      throw new Error(`unknown memory scope: ${JSON.stringify(scope)}`);
  }
}

/**
 * Safely read `<memoryDir>/MEMORY.md`. Returns undefined when the dir or file
 * is absent. THROWS when the memory dir or the memory file is a symlink —
 * symlinked memory is an attack surface (reads through links to arbitrary
 * targets) and is refused outright (lstat, never follow).
 */
export function safeMemoryRead(memoryDir: string): string | undefined {
  let dirStat;
  try {
    dirStat = lstatSync(memoryDir);
  } catch {
    return undefined; // no memory dir yet
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error(`refusing memory read: symlinked memory dir: ${memoryDir}`);
  }
  const memoryFile = join(memoryDir, MEMORY_FILE_NAME);
  let fileStat;
  try {
    fileStat = lstatSync(memoryFile);
  } catch {
    return undefined; // no memory file yet
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`refusing memory read: symlinked memory file: ${memoryFile}`);
  }
  if (!fileStat.isFile()) return undefined;
  return readFileSync(memoryFile, "utf8");
}

/**
 * Ensure the memory dir exists (mkdir recursive). Refuses symlinked targets:
 * an existing symlink at the memory-dir path is never written through, and a
 * post-mkdir re-check guards the create race. Returns the dir.
 */
export function ensureMemoryDir(memoryDir: string): string {
  let before;
  try {
    before = lstatSync(memoryDir);
  } catch {
    before = undefined;
  }
  if (before?.isSymbolicLink()) {
    throw new Error(`refusing symlinked memory dir: ${memoryDir}`);
  }
  mkdirSync(memoryDir, { recursive: true });
  if (lstatSync(memoryDir).isSymbolicLink()) {
    throw new Error(`refusing symlinked memory dir: ${memoryDir}`);
  }
  return memoryDir;
}

/** Options for `buildMemoryBlock`. */
export interface MemoryBlockOptions {
  /** True when the agent has NO write/edit tools: consult-only memory. */
  readOnly?: boolean;
}

/** Format instructions for agents with read/write memory access. */
const READ_WRITE_INSTRUCTIONS = [
  "- This is YOUR persistent memory; it is injected into your system prompt on every dispatch of this agent.",
  `- At the end of a task, use your write/edit tools to update ${MEMORY_FILE_NAME}: append concise, durable knowledge (decisions, conventions, paths, corrections) that future sessions of this agent will need.`,
  "- Format each entry as a dated heading (`## YYYY-MM-DD — topic`) followed by 1-5 factual lines.",
  "- Append or amend entries; keep the file focused. NEVER store secrets, tokens, or raw transcript bodies.",
];

/** Format instructions for agents with read-only memory access. */
const READ_ONLY_INSTRUCTIONS = [
  "- This is the agent's persistent memory, injected for reference.",
  "- READ-ONLY: you may consult these memories, but you MUST NOT create, modify, move, or delete the memory file (your toolset has no write/edit tools).",
];

/** Clamp memory content to `maxLines` with an explicit omission marker. */
function truncateMemoryLines(content: string | undefined, maxLines: number): string {
  const trimmed = (content ?? "").replace(/\r\n/g, "\n").trim();
  if (!trimmed) return "(no memories yet)";
  const lines = trimmed.split("\n");
  if (lines.length <= maxLines) return trimmed;
  const omitted = lines.length - maxLines;
  return [
    ...lines.slice(0, maxLines),
    `… ${MEMORY_TRUNCATION_MARKER} — ${omitted} more lines beyond the ${maxLines}-line limit]`,
  ].join("\n");
}

/**
 * Build the memory block appended to the agent SYSTEM PROMPT: header + access
 * mode + MEMORY.md content (truncated to MEMORY_MAX_LINES) + format
 * instructions. `readOnly: true` produces the explicit consult-only block for
 * agents without write/edit tools. Read errors (symlinks, unsafe paths)
 * propagate — the dispatch layer degrades to a warning, never a crash.
 */
export function buildMemoryBlock(memoryDir: string, options: MemoryBlockOptions = {}): string {
  const readOnly = options.readOnly ?? false;
  const content = safeMemoryRead(memoryDir);
  const shown = truncateMemoryLines(content, MEMORY_MAX_LINES);
  return [
    MEMORY_BLOCK_HEADER,
    `Memory file: ${join(memoryDir, MEMORY_FILE_NAME)}`,
    `Access: ${readOnly ? "READ-ONLY" : "READ/WRITE"}`,
    "",
    shown,
    "",
    "[MEMORY FORMAT]",
    ...(readOnly ? READ_ONLY_INSTRUCTIONS : READ_WRITE_INSTRUCTIONS),
  ].join("\n");
}
