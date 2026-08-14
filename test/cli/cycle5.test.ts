// test/cli/cycle5.test.ts — cycle-5 real-session fixes:
//   P1: symlink-safe auto-run guard (isCliEntry + a REAL bin invocation via a
//       symlinked argv[1], the exact zob-harness/packages/pi-subagents case),
//   P4: `subagents runs` aggregates ONE line per runId (min started, max
//       ended, terminal status, duration, clean preflight_failed status),
//   P7: doctor boot one-shot spawns pi with --no-session (no orphan sessions).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { isCliEntry, main } from "../../src/cli/subagents.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-cycle5-"));
}

// --------------------------------------------------------------- P1

describe("cli: P1 symlink-safe auto-run guard", () => {
  it("isCliEntry matches when argv[1] is a SYMLINK to the module's real path", () => {
    const dir = tempDir();
    try {
      const realEntry = join(dir, "real-entry.js");
      writeFileSync(realEntry, "// entry\n", "utf8");
      const link = join(dir, "link-entry.js");
      symlinkSync(realEntry, link);
      // import.meta.url is Node's FULLY resolved real path — on macOS the
      // tmpdir itself is a symlink (/var -> /private/var), so resolve the
      // target too before building the module URL.
      const moduleUrl = pathToFileURL(realpathSync(realEntry)).href;
      assert.equal(isCliEntry(link, moduleUrl), true);
      assert.equal(isCliEntry(realEntry, moduleUrl), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isCliEntry rejects other files, missing argv[1], and unresolvable paths", () => {
    const dir = tempDir();
    try {
      const other = join(dir, "other.js");
      writeFileSync(other, "// other\n", "utf8");
      const moduleUrl = pathToFileURL(join(dir, "real.js")).href;
      assert.equal(isCliEntry(other, moduleUrl), false);
      assert.equal(isCliEntry(undefined, moduleUrl), false);
      assert.equal(isCliEntry(join(dir, "does-not-exist.js"), moduleUrl), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("importing the CLI module never fires the auto-run (guard is import-safe)", () => {
    // This test file imports src/cli/subagents.js at the top; reaching this
    // assertion with the test process alive proves the guard did not hijack
    // the runner's exit even though argv[1] IS this test file (a true entry).
    const selfUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
    assert.equal(isCliEntry(fileURLToPath(import.meta.url), selfUrl), true);
    assert.equal(isCliEntry(fileURLToPath(import.meta.url), pathToFileURL(fileURLToPath(new URL("../../src/cli/subagents.js", import.meta.url))).href), false);
  });

  it("E2E: node <symlink-to-compiled-cli> --version prints the version (was silent)", () => {
    const distCli = fileURLToPath(new URL("../../../dist/src/cli/subagents.js", import.meta.url));
    if (!existsSync(distCli)) {
      assert.ok(false, `compiled CLI not found at ${distCli} — build first (npx tsc)`);
    }
    const dir = tempDir();
    try {
      // Simulate the zob-harness/packages/pi-subagents bin symlink: argv[1] is
      // the symlink while import.meta.url resolves to distCli's real path.
      const link = join(dir, "subagents");
      symlinkSync(distCli, link);
      const res = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8", timeout: 30_000 });
      assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
      assert.match(res.stdout, /subagents \d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------- P4

/** Capture process.stdout.write during an async CLI main() call. */
async function captureRunsOut(env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const origWrite = stdout.write.bind(process.stdout);
  stdout.write = (chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    const code = await main(["runs"], env);
    return { code, out: chunks.join("") };
  } finally {
    stdout.write = origWrite;
  }
}

describe("cli: P4 runs aggregates one line per runId", () => {
  it("aggregates start/end/continue events per runId with min started, max ended, terminal status", async () => {
    const dir = tempDir();
    try {
      const file = join(dir, "2025-01-15.jsonl");
      const lines = [
        // run A: simple start -> end
        { event: "start", runId: "delegate-a", agent: "alpha", timestamp: "2025-01-15T10:00:00.000Z" },
        { event: "end", runId: "delegate-a", agent: "alpha", status: "complete", latencyMs: 4500, timestamp: "2025-01-15T10:00:04.500Z" },
        // run B: multiple events for the SAME runId (continued/restarted) —
        // previously printed one line PER EVENT with a wrong `started=` (the
        // end event's timestamp fallback).
        { event: "start", runId: "delegate-b", agent: "beta", timestamp: "2025-01-15T11:00:00.000Z" },
        { event: "end", runId: "delegate-b", agent: "beta", status: "complete", latencyMs: 1000, timestamp: "2025-01-15T11:00:01.000Z" },
        { event: "end", runId: "delegate-b", agent: "beta", status: "complete", latencyMs: 2000, timestamp: "2025-01-15T11:05:02.000Z" },
        // run C: LEGACY preflight_failed event with NO explicit status field —
        // previously rendered a permanent `?`.
        { event: "preflight_failed", runId: "delegate-c", agent: "gamma", timestamp: "2025-01-15T12:00:00.000Z" },
      ];
      appendFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

      const { code, out } = await captureRunsOut({ SUBAGENTS_LEDGER: dir });
      assert.equal(code, 0);
      const runLines = out.split("\n").filter((line) => line.includes("\t"));
      assert.equal(runLines.length, 3, `expected 1 line per runId, got:\n${out}`);
      assert.ok(out.includes("runs (3, sort=active)"));

      const a = runLines.find((line) => line.startsWith("delegate-a\t"));
      assert.ok(a, `run A line missing in:\n${out}`);
      assert.ok(a!.includes("\tcomplete\t"));
      assert.ok(a!.includes("started=2025-01-15T10:00:00.000Z"), `min timestamp as started:\n${a}`);
      assert.ok(a!.includes("ended=2025-01-15T10:00:04.500Z"));
      assert.ok(a!.includes("duration=4500ms"));
      assert.ok(a!.includes("agent=alpha"));

      const b = runLines.find((line) => line.startsWith("delegate-b\t"));
      assert.ok(b, `run B line missing in:\n${out}`);
      assert.ok(b!.includes("started=2025-01-15T11:00:00.000Z"), `started must be the MIN event timestamp:\n${b}`);
      assert.ok(b!.includes("ended=2025-01-15T11:05:02.000Z"));
      assert.ok(b!.includes("duration=2000ms"), `last latency wins:\n${b}`);

      const c = runLines.find((line) => line.startsWith("delegate-c\t"));
      assert.ok(c, `run C line missing in:\n${out}`);
      assert.ok(c!.includes("\tpreflight_failed\t"), `clean preflight_failed status (no permanent '?'):\n${c}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflight_failed ledger events now carry an explicit status field (dispatch side)", async () => {
    const dir = tempDir();
    try {
      const file = join(dir, "2025-01-15.jsonl");
      // New-format line as dispatch.ts now writes it (status present).
      appendFileSync(
        file,
        JSON.stringify({ event: "preflight_failed", runId: "delegate-pf", agent: "alpha", status: "preflight_failed", timestamp: "2025-01-15T13:00:00.000Z" }) + "\n",
        "utf8",
      );
      const { out } = await captureRunsOut({ SUBAGENTS_LEDGER: dir });
      assert.ok(out.includes("delegate-pf\tpreflight_failed\t"), `explicit status honored:\n${out}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------- P7

describe("cli: P7 doctor boot one-shot uses --no-session", () => {
  it("bootPiOnce spawns pi with --no-session (no orphan session files)", async () => {
    const dir = tempDir();
    try {
      const argsFile = join(dir, "args.log");
      const recPi = join(dir, "rec-pi.mjs");
      // Recording fake pi: appends its argv, then exits 0 (--version probe and
      // the one-shot stdin boot both succeed deterministically). Shebang +
      // 0o755 because bootPiOnce/checkPiAvailable spawn it WITHOUT a shell.
      writeFileSync(
        recPi,
        [
          // Absolute-node shebang: the injected env carries no PATH.
          `#!${process.execPath}`,
          "import { appendFileSync } from 'node:fs';",
          "appendFileSync(process.env.REC_PI_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');",
          "if (process.argv.includes('--version')) process.exit(0);",
          "let d = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (c) => { d += c; });",
          "process.stdin.on('end', () => process.exit(0));",
          "setTimeout(() => process.exit(0), 5000);",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );
      const code = await main(["doctor", "--timing"], { SUBAGENTS_PI_COMMAND: recPi, REC_PI_ARGS: argsFile });
      assert.equal(code, 0);
      const recorded = readFileSync(argsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const boot = recorded.find((args) => args.includes("--no-session"));
      assert.ok(boot, `boot spawn must pass --no-session; recorded=${JSON.stringify(recorded)}`);
      assert.ok(boot!.includes("--mode") && boot!.includes("-p") && boot!.includes("--no-extensions"));
      assert.ok(recorded.some((args) => args.includes("--version")), "version probe also recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
