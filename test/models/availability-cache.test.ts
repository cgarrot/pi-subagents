// test/models/availability-cache.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AvailabilityCache, type ProbeResult } from "../../src/models/index.js";

const base = { repoRoot: "/repo", model: "openai/gpt-4o", providerExtension: "ext" };

function manualClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("AvailabilityCache: TTL and expiration", () => {
  it("returns cached success until TTL expires, then re-probes", async () => {
    const clock = manualClock();
    let probeCalls = 0;
    const cache = new AvailabilityCache(
      async () => { probeCalls += 1; return { ok: true }; },
      { successTtlMs: 1000, now: clock.now },
    );

    const first = await cache.check(base);
    assert.equal(first.ok, true);
    assert.equal(probeCalls, 1);

    // Within TTL -> cached, no probe.
    clock.advance(500);
    const second = await cache.check(base);
    assert.equal(second.ok, true);
    assert.equal(probeCalls, 1);

    // After TTL -> re-probe.
    clock.advance(600);
    await cache.check(base);
    assert.equal(probeCalls, 2);
  });

  it("caches failures for a shorter failure TTL", async () => {
    const clock = manualClock();
    let probeCalls = 0;
    const cache = new AvailabilityCache(
      async () => { probeCalls += 1; return { ok: false, reason: "unavailable" }; },
      { failureTtlMs: 500, successTtlMs: 1000, now: clock.now },
    );

    const first = await cache.check(base);
    assert.equal(first.ok, false);
    assert.equal(first.reason, "unavailable");

    clock.advance(400);
    const cached = await cache.check(base);
    assert.equal(cached.ok, false);
    assert.equal(probeCalls, 1);

    clock.advance(200);
    await cache.check(base);
    assert.equal(probeCalls, 2);
  });

  it("peek never probes and reflects fresh cache state", async () => {
    const cache = new AvailabilityCache(async () => ({ ok: true }), { now: manualClock().now });
    // No cache entry yet -> undefined (critical path, no probe).
    assert.equal(cache.peek(base), undefined);
    await cache.check(base);
    const peeked = cache.peek(base);
    assert.equal(peeked?.ok, true);
  });

  it("respects the injectable now() for expiration", async () => {
    const clock = manualClock();
    let probeCalls = 0;
    const cache = new AvailabilityCache(
      async () => { probeCalls += 1; return { ok: true }; },
      { successTtlMs: 1000, now: clock.now },
    );
    await cache.check(base);
    clock.advance(1001);
    await cache.check(base);
    assert.equal(probeCalls, 2);
  });
});

describe("AvailabilityCache: in-flight dedupe and shared probe", () => {
  it("shares a single in-flight probe across concurrent callers", async () => {
    const cache = new AvailabilityCache(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
      {},
    );

    const [a, b] = await Promise.all([cache.check(base), cache.check(base)]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    // Second call reuses the cached result; both share the same probe.
    const [c, d] = await Promise.all([cache.check(base), cache.check(base)]);
    assert.equal(c.ok, true);
    assert.equal(d.ok, true);
  });

  it("does not invoke the probe on the critical path after a positive cache", async () => {
    let probeCalls = 0;
    const cache = new AvailabilityCache(
      async () => { probeCalls += 1; return { ok: true }; },
      { successTtlMs: 10_000 },
    );
    await cache.check(base);
    await cache.check(base);
    assert.equal(probeCalls, 1);
  });
});

describe("AvailabilityCache: key scoping", () => {
  it("scopes cache by repoRoot, model, and providerExtension", async () => {
    const calls: string[] = [];
    const cache = new AvailabilityCache(
      async (model) => { calls.push(model); return { ok: true }; },
      {},
    );
    await cache.check(base);
    await cache.check({ ...base, model: "other/model" });
    await cache.check({ ...base, providerExtension: "other-ext" });
    assert.deepEqual(calls, ["openai/gpt-4o", "other/model", "openai/gpt-4o"]);
  });

  it("markAvailable seeds a positive result without probing", async () => {
    let probeCalls = 0;
    const cache = new AvailabilityCache(
      async () => { probeCalls += 1; return { ok: true }; },
      {},
    );
    cache.markAvailable(base);
    const r = await cache.check(base);
    assert.equal(r.ok, true);
    assert.equal(probeCalls, 0);
  });
});
