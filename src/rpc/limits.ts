/**
 * src/rpc/limits.ts — every bound of the RPC worker control plane.
 *
 * Why a dedicated module: the project rule is "every bound is a named
 * constant", and these values are the difference between an honest timeout
 * and a hung turn. They are deliberately conservative.
 */

/** Default per-command timeout (get_state, prompt ack, steer ack). */
export const RPC_DEFAULT_TIMEOUT_MS = 30_000;

/** Readiness probe on start: shorter than a command, long enough for a cold boot. */
export const RPC_START_TIMEOUT_MS = 10_000;

/** `redirect` waits for the aborted turn to settle. A runaway tool can take
 *  longer than a normal command timeout; this is the honest upper bound. */
export const RPC_SETTLE_TIMEOUT_MS = 60_000;

/** Grace between SIGTERM and SIGKILL when stopping a worker. */
export const RPC_STOP_GRACE_MS = 2_000;

/** One stdout line without LF beyond this = protocol_error (never buffer
 *  unbounded output from a misbehaving child). */
export const RPC_MAX_LINE_BYTES = 1_048_576;

/** Last N bytes of stderr kept for diagnostics (never persisted). */
export const RPC_STDERR_RING_BYTES = 8 * 1024;

/** Concurrent controller-owned workers per session. */
export const RPC_MAX_WORKERS = 4;

/** Prompt/steer/redirect message bound (same order as the mesh body bound). */
export const RPC_MAX_MESSAGE_BYTES = 32 * 1024;

/** Terminal runs kept for `rpc_state` after exit/stop (honest status, bounded). */
export const RPC_TOMBSTONE_LIMIT = 20;

/** Live event types kept per worker for diagnostics (memory only). */
export const RPC_EVENT_RING = 50;

/** Worker id shape: r_<base36 time>_<6 random chars>. */
export const RPC_RUN_ID_RAND_CHARS = 6;
