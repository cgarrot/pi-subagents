// test/extension/commands.test.ts — /agents, /runs, /subagents doctor handlers
// read the engine/registry and emit via ctx.ui.notify.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { registerCommands } from "../../src/extension/commands.js";
import { createSubagentsRuntime, type SubagentsRuntime } from "../../src/extension/tools.js";
import type { SessionContext } from "../../src/extension/pi-types.js";
import { stubApi } from "./stub-api.js";

const AGENT_MD = (name: string): string =>
  `---\nname: ${name}\ndescription: test agent\ntools: read\n---\nYou are ${name}.`;

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-cmd-"));
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  writeFileSync(join(dir, ".pi", "agents", "alpha.md"), AGENT_MD("alpha"), "utf8");
  return dir;
}

function notifyCtx(cwd: string, onNotify: (msg: string) => void): SessionContext {
  return { cwd, hasUI: false, ui: { notify: (m) => onNotify(m), setWidget: () => {}, setStatus: () => {} } };
}

describe("extension/commands", () => {
  it("/agents, /runs and /subagents doctor handlers run without throwing", async () => {
    const dir = tempRepo();
    try {
      const runtime: SubagentsRuntime = createSubagentsRuntime(dir);
      const captured = stubApi();
      registerCommands(captured.api, () => runtime);
      const messages: string[] = [];
      const ctx = notifyCtx(dir, (m) => messages.push(m));

      const cases: Array<[string, string]> = [
        ["agents", ""],
        ["agents", "catalog"],
        ["runs", "active"],
        ["runs", "latest"],
        ["subagents", "doctor"],
      ];
      for (const [name, args] of cases) {
        const def = captured.commands.get(name);
        assert.ok(def, `command ${name} not registered`);
        await def.handler(args, ctx);
      }

      assert.ok(messages.length >= cases.length, `expected >=${cases.length} notifications, got ${messages.length}`);
      assert.ok(messages.some((m) => m.includes("alpha")), "agents listing should include alpha");
      assert.ok(messages.some((m) => m.includes("Delegations:")), "/runs should show a summary");
      assert.ok(messages.some((m) => m.includes("pi-subagents doctor")), "/subagents doctor should print health");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
