/**
 * src/models/availability-cache.ts — shared model eligibility cache.
 *
 * Mirrors the ZOB harness probe cache (successCache / inFlight dedupe keyed by
 * [repoRoot, model, providerExtension]) but WITHOUT any process spawn and with
 * a fully injectable probe function. The core never launches a probe — it only
 * consults cached results and invokes the injected probe function lazily,
 * keeping the critical path free of probes.
 *
 * Design (per port manifest B.5):
 *   - long success TTL (default 5 min) instead of the harness 60 s;
 *   - short failure TTL with backoff to avoid a probe storm;
 *   - in-flight dedupe: concurrent checks for the same key share one probe;
 *   - injectable clock `now()` for deterministic tests.
 *
 * Pure module: zero @earendil-works/* imports, zero child_process.
 */

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/** Injectable availability probe. Never spawns a process on its own here. */
export type AvailabilityProbe = (model: string) => Promise<ProbeResult>;

export interface AvailabilityCacheInput {
  repoRoot: string;
  model: string;
  providerExtension?: string;
}

export interface AvailabilityCacheOptions {
  /** Success TTL in ms (default 300_000 = 5 min). */
  successTtlMs?: number;
  /** Failure TTL in ms (default 30_000 = 30 s). */
  failureTtlMs?: number;
  /** Inject a clock for deterministic tests. */
  now?: () => number;
}

interface SuccessEntry {
  expiresAt: number;
}

interface FailureEntry {
  expiresAt: number;
  reason?: string;
}

const DEFAULT_SUCCESS_TTL_MS = 300_000;
const DEFAULT_FAILURE_TTL_MS = 30_000;
const DEFAULT_FAILURE_BACKOFF_MS = 60_000;

function cacheKey(input: AvailabilityCacheInput): string {
  return JSON.stringify([input.repoRoot, input.model, input.providerExtension ?? ""]);
}

export class AvailabilityCache {
  private readonly successCache = new Map<string, SuccessEntry>();
  private readonly failureCache = new Map<string, FailureEntry>();
  private readonly inFlight = new Map<string, Promise<ProbeResult>>();
  private readonly probe: AvailabilityProbe;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;
  private readonly failureBackoffMs: number;

  constructor(probe: AvailabilityProbe, options?: AvailabilityCacheOptions) {
    this.probe = probe;
    this.successTtlMs = options?.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
    this.failureTtlMs = options?.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.failureBackoffMs = Math.max(
      this.failureTtlMs,
      Math.min(this.failureTtlMs * 2, DEFAULT_FAILURE_BACKOFF_MS),
    );
    this.now = options?.now ?? Date.now;
  }

  /**
   * Synchronous cache-only lookup. NEVER invokes the probe — safe on the
   * critical path. Returns a positive result only if a success entry is still
   * fresh; returns a negative result only if a failure entry is still fresh.
   */
  peek(input: AvailabilityCacheInput): ProbeResult | undefined {
    const key = cacheKey(input);
    const now = this.now();

    const success = this.successCache.get(key);
    if (success && success.expiresAt > now) return { ok: true };

    const failure = this.failureCache.get(key);
    if (failure && failure.expiresAt > now) return { ok: false, reason: failure.reason };

    return undefined;
  }

  /**
   * Resolve availability, probing lazily off the critical path. Shares a single
   * in-flight probe across concurrent callers for the same key. Honors the
   * cache: fresh success/failure entries short-circuit without probing.
   */
  async check(input: AvailabilityCacheInput): Promise<ProbeResult> {
    const key = cacheKey(input);
    const cached = this.peek(input);
    if (cached) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.probe(input.model).then(
      (result): ProbeResult => {
        const now = this.now();
        if (result.ok) {
          this.successCache.set(key, { expiresAt: now + this.successTtlMs });
          this.failureCache.delete(key);
        } else {
          this.failureCache.set(key, { expiresAt: now + this.failureTtlMs, reason: result.reason });
          this.successCache.delete(key);
        }
        return result;
      },
      (error: unknown): ProbeResult => {
        const reason = error instanceof Error ? error.message : String(error);
        const now = this.now();
        this.failureCache.set(key, {
          expiresAt: now + this.failureBackoffMs,
          reason: `probe failed: ${reason}`,
        });
        this.successCache.delete(key);
        return { ok: false, reason: `probe failed: ${reason}` };
      },
    ).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, pending);
    return pending;
  }

  /** Force-cache a positive result without probing (e.g. lane boot proof). */
  markAvailable(input: AvailabilityCacheInput): void {
    const key = cacheKey(input);
    this.successCache.set(key, { expiresAt: this.now() + this.successTtlMs });
    this.failureCache.delete(key);
  }

  clear(): void {
    this.successCache.clear();
    this.failureCache.clear();
    this.inFlight.clear();
  }

  /** Number of live cache entries (success + failure), excluding in-flight. */
  get size(): number {
    return this.successCache.size + this.failureCache.size;
  }
}
