/**
 * Typed UCI client (§6.4, Appendix E §5). State machine
 * `idle → searching → stopping → idle` plus `initialising` / `crashed`; one
 * search at a time drawn from a priority FIFO (`move` > `ponder` > `panel`);
 * per-request accumulation of the latest line per multipv index, delivered
 * through a single-slot mailbox when a depth iteration completes or every
 * `TIMINGS.engineInfoCoalesceMs` for partial iterations. Pure: the transport
 * and the timers are injected.
 *
 * The parts live in `./uci-client/`: `engine` (the coordinator and its state machine),
 * `pending-search` (one request: `live-lines`, `frame-capture`, `update-builder`, `coalescer`,
 * `mailbox`), `search-queue`, `ready-waiters`, `applied-options`, `commands` and `score`.
 */

export { UciEngine, type UciEngineOptions } from "./uci-client/engine";
export { FEATURE_DEPTH } from "./uci-client/frame-capture";
export type { UciScheduler } from "./uci-client/scheduler";
export { cpEquivalent } from "./uci-client/score";
