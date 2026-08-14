/**
 * src/lanes/abort.ts — bounded child-process abort: SIGTERM, then SIGKILL after
 * a grace period if the child is still alive.
 *
 * Ported from the harness abort sequence (child-runner.ts cr:439-452). The
 * timeout is unref()'d so a pending kill timer never keeps the event loop alive
 * (I15: no process/thread leaks).
 */
export interface BoundedAbortChild {
  kill(signal?: NodeJS.Signals): boolean;
  readonly killed: boolean;
}

export interface AbortOptions {
  /** Grace between SIGTERM and SIGKILL in ms (default 5000). */
  killGraceMs?: number;
  /** Called (synchronously) when the abort fires. */
  onAbort?: () => void;
}

export interface BoundedAbortHandle {
  abort: () => void;
  dispose: () => void;
}

export const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Attach a bounded abort to a child process driven by an optional AbortSignal.
 * When the signal fires (or is already aborted) the child is sent SIGTERM, then
 * SIGKILL after `killGraceMs` if not yet dead. Returns a handle whose `abort`
 * triggers the same sequence manually and `dispose` removes the signal listener.
 */
export function attachBoundedAbort(
  child: BoundedAbortChild,
  signal: AbortSignal | undefined,
  options: AbortOptions = {},
): BoundedAbortHandle {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const abort = (): void => {
    options.onAbort?.();
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, killGraceMs);
    timer.unref();
  };

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  const dispose = (): void => {
    signal?.removeEventListener("abort", abort);
  };

  return { abort, dispose };
}
