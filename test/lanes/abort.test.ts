// test/lanes/abort.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachBoundedAbort, type BoundedAbortChild } from "../../src/lanes/abort.js";

function fakeChild() {
  const kills: string[] = [];
  let killed = false;
  const child: BoundedAbortChild = {
    get killed() {
      return killed;
    },
    kill(signal?: NodeJS.Signals): boolean {
      kills.push(signal ?? "");
      if (signal === "SIGKILL") killed = true;
      return true;
    },
  };
  return { child, kills };
}

describe("lanes/abort: attachBoundedAbort", () => {
  it("sends SIGTERM immediately, then SIGKILL after the grace window", async () => {
    const controller = new AbortController();
    const { child, kills } = fakeChild();
    const handle = attachBoundedAbort(child, controller.signal, { killGraceMs: 40 });

    controller.abort();
    assert.deepEqual(kills, ["SIGTERM"]);

    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.ok(kills.includes("SIGKILL"), "expected SIGKILL after grace");
    assert.equal(child.killed, true);
    handle.dispose();
  });

  it("fires onAbort synchronously when the signal aborts", () => {
    const controller = new AbortController();
    const { child } = fakeChild();
    let called = false;
    const handle = attachBoundedAbort(child, controller.signal, {
      onAbort: () => {
        called = true;
      },
    });
    controller.abort();
    assert.equal(called, true);
    handle.dispose();
  });

  it("aborts immediately if the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const { child, kills } = fakeChild();
    const handle = attachBoundedAbort(child, controller.signal);
    assert.deepEqual(kills, ["SIGTERM"]);
    handle.dispose();
  });

  it("dispose removes the signal listener so later aborts do nothing", () => {
    const controller = new AbortController();
    const { child, kills } = fakeChild();
    const handle = attachBoundedAbort(child, controller.signal, { killGraceMs: 30 });
    handle.dispose();
    controller.abort();
    assert.deepEqual(kills, []);
  });
});
