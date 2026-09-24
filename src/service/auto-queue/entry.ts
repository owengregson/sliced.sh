/**
 * One tab's pending queue click and its durable form. An entry lives from the end of a game
 * until the next game is observed (or the queue is cancelled); the playing session beside it
 * outlives entries and carries the break schedule and the once-only rematch marks.
 */

import { TIMINGS } from "@core/constants/timings";
import type { Rng } from "@core/rng";
import type { AutoQueueView } from "@service/auto-queue/types";
import type { PendingAutoQueue, PendingAutoQueues, PlayingSession } from "@typedefs/storage";

export interface Entry extends AutoQueueView {
	gameId: string | null;
	timer?: unknown;
	controller?: AbortController;
	/**
	 * The rematch step (2026-09-13) still to run at `dueAt` (`pending`), or running now
	 * (`running`: the offer is out, `dueAt` is when the ordinary click follows).
	 */
	rematch?: { opponent: string; phase: "pending" | "running" };
	/** The pre-click poll for an incoming offer while `rematch` is pending. */
	poll?: unknown;
}

/**
 * The first wait after a game: the ordinary short delay (one draw from `rng`) — also when a break
 * is due but a rematch step comes first — or the rest of the session's break.
 */
export function firstWait(
	session: PlayingSession,
	rematch: string | null,
	now: number,
	rng: Rng
): { delay: number; status: "waiting" | "break" } {
	const [lo, hi] = TIMINGS.autoQueueDelayRangeMs;
	// A due break waits for the rematch step: the delay is the ordinary short one.
	if (session.breakUntil === null || rematch !== null)
		return { delay: lo + rng.next() * Math.max(0, hi - lo), status: "waiting" };
	return { delay: Math.max(0, session.breakUntil - now), status: "break" };
}

/** The entry a persisted record resumes (only records with a deadline have one). */
export function entryFromRecord(record: PendingAutoQueue, dueAt: number, now: () => number): Entry {
	return {
		gameId: record.gameId,
		dueAt,
		attempts: 0,
		status: record.session?.breakUntil === dueAt && dueAt > now() ? "break" : "waiting",
		...(record.rematch !== undefined
			? { rematch: { opponent: record.rematch, phase: "pending" as const } }
			: {}),
	};
}

/** The durable records of every tracked tab: its entry's deadline and its playing session. */
export function recordsOf(
	tabIds: readonly number[],
	entries: ReadonlyMap<number, Entry>,
	sessions: ReadonlyMap<number, PlayingSession>
): PendingAutoQueues {
	const records: PendingAutoQueues = {};
	for (const tabId of tabIds) {
		const entry = entries.get(tabId);
		const session = sessions.get(tabId);
		records[String(tabId)] = {
			gameId: entry?.gameId ?? session?.gameId ?? null,
			dueAt: entry?.dueAt ?? null,
			...(session ? { session: { ...session } } : {}),
			...(entry?.rematch?.phase === "pending" ? { rematch: entry.rematch.opponent } : {}),
		};
	}
	return records;
}
