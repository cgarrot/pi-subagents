/**
 * src/lanes — hot session pool (v1 spawn-per-task). Single mutable state.
 *
 * v1 (delivered): each task is a fresh one-shot spawn (`pi --mode json -p
 * --no-extensions`) with a STABLE `--session` reused per lane for chain context
 * continuity. The spawner is injectable (I11), the model probe is an optional
 * injected hook fired off the critical path, and abort is bounded
 * (SIGTERM -> 5s -> SIGKILL).
 *
 * v2 warm-loop (one `pi` serving N tasks via a child extension) is OUT OF
 * SCOPE here — documented as a separate spike.
 */
export * from "./args.js";
export * from "./ndjson.js";
export * from "./abort.js";
export * from "./spawn.js";
export * from "./pool.js";
export * from "./steer.js";
export * from "./escalation.js";
