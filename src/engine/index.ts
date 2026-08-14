/**
 * src/engine — execution engine (core pur, node/fs only, no Pi import).
 *
 * Assembles gates -> registry -> models -> lanes -> result:
 *   runs.ts       delegation run lifecycle (queued -> running -> terminal)
 *   dispatch.ts   preflight-gated single/parallel/chain dispatch
 *   background.ts bounded background run registry (get/await with timeout)
 *   monitor.ts    bounded monitor state, trimming, liveness, list/sort
 *   ledger.ts     hash-only / body-free delegation ledger
 *   context.ts    C2 `--main` condensed context projection (provider-injected)
 *   memory.ts     C5 persistent per-agent memory (scopes user/project/local)
 *
 * Zero @earendil-works/* imports.
 */
/** Streaming child progress event (consumed via engine/per-run onChildEvent). */
export type { ChildProgressEvent } from "../core/types.js";
export * from "./runs.js";
export * from "./dispatch.js";
export * from "./background.js";
export * from "./monitor.js";
export * from "./ledger.js";
export * from "./steer.js";
export * from "./context.js";
export * from "./memory.js";
