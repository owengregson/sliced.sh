/** The shape check every persisted or saved auto-queue record passes through. */

import type { PendingAutoQueues, PlayingSession } from "@typedefs/storage";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deadline(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER
	);
}

function gameId(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function playingSession(value: unknown): PlayingSession | undefined {
	if (!record(value)) return undefined;
	if (!gameId(value.gameId) || !gameId(value.lastFinishedGameId)) return undefined;
	if (!deadline(value.startedAt) || !deadline(value.endsAt) || value.endsAt <= value.startedAt)
		return undefined;
	if (
		typeof value.completedGames !== "number" ||
		!Number.isSafeInteger(value.completedGames) ||
		value.completedGames < 0
	)
		return undefined;
	if (value.breakUntil !== null && (!deadline(value.breakUntil) || value.breakUntil < value.endsAt))
		return undefined;
	// The once-only rematch marks (2026-09-13): a list of usernames, or nothing. A malformed list
	// drops only itself — the session's deadlines are still worth keeping.
	const rematched = Array.isArray(value.rematched)
		? value.rematched.filter((name): name is string => typeof name === "string" && name !== "")
		: [];
	return {
		gameId: value.gameId,
		startedAt: value.startedAt,
		endsAt: value.endsAt,
		completedGames: value.completedGames,
		lastFinishedGameId: value.lastFinishedGameId,
		breakUntil: value.breakUntil,
		...(rematched.length > 0 ? { rematched } : {}),
	};
}

/** Only canonical tab ids and finite deadlines are accepted; returned records are detached. */
export function validated(value: unknown): PendingAutoQueues {
	const valid: PendingAutoQueues = {};
	if (!record(value)) return valid;
	for (const [tab, pending] of Object.entries(value)) {
		const tabId = Number(tab);
		if (!Number.isSafeInteger(tabId) || tabId < 0 || String(tabId) !== tab || !record(pending))
			continue;
		const { dueAt } = pending;
		if (!gameId(pending.gameId)) continue;
		const session = playingSession(pending.session);
		if (dueAt !== null && !deadline(dueAt)) continue;
		if (dueAt === null && !session) continue;
		// A pending rematch step names its opponent; it only means something with a deadline.
		const rematch =
			dueAt !== null && typeof pending.rematch === "string" && pending.rematch !== ""
				? pending.rematch
				: undefined;
		valid[tab] = {
			gameId: pending.gameId,
			dueAt,
			...(session ? { session } : {}),
			...(rematch !== undefined ? { rematch } : {}),
		};
	}
	return valid;
}
