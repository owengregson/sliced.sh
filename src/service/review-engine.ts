/**
 * The move-review engine (owner, 2026-09-14): one lazily booted Stockfish 19 **full** instance in
 * the offscreen document, on its own port (`PORT_NAMES.reviewEngine`), shared by every session's
 * `BoardEffectsReporter`.
 *
 * Its own WASM memory, transposition table and UCI stream isolate playing-engine options and
 * commands, but both engines still compete for CPU and memory bandwidth. `setPlayBusy` pauses
 * review admission during foreground preparation without unloading the warm engine. Thinking and
 * mouse activity leave background search running; the reporter separately admits classification. It never
 * falls back to the small network (the offscreen host refuses to for this port) and never limits
 * its strength — a rating is only as good as the evaluation behind it.
 *
 * One search at a time from a small priority queue (`move` > `ponder` > `panel`, the reporter's
 * urgency); a more urgent request stops the running one, which still answers with the deepest
 * iteration it completed. A failed boot or a failed search drops the engine and backs off along
 * `REVIEW.retryBackoffMs` (a second at first, longer only while it keeps failing) instead of
 * retrying on every request. `release()` frees the engine when ratings are switched off; the next
 * request boots it again.
 *
 * Parts: `review-engine/engine.ts` (the queue, boot and back-off), `review-engine/backend.ts` (the
 * remote full-network backend and its readiness check), `review-engine/request.ts` (request
 * bounds, urgency and result identity).
 */

export { fullReviewReady, type ReviewBackend, reviewThreads } from "@service/review-engine/backend";
export { ReviewEngine, type ReviewEngineOptions } from "@service/review-engine/engine";
