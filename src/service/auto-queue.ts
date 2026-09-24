/**
 * Retry post-game controls until a new game is observed, retaining the original wait deadline.
 *
 * Parts: `auto-queue/queue.ts` (the `AutoQueue`: timers, the queue click, the rematch step and
 * persistence), `auto-queue/entry.ts` (one tab's pending click, its first wait and its durable
 * record), `auto-queue/types.ts` (the options and the panel view).
 */

export { AutoQueue } from "@service/auto-queue/queue";
export type { AutoQueueOptions, AutoQueueView } from "@service/auto-queue/types";
