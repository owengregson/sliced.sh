/** Session boundaries are checked after games, never by interrupting active play. */
import { TIMINGS } from "@core/constants/timings";
import type { Rng } from "@core/rng";
import type { Settings } from "@typedefs/settings";
import type { PlayingSession } from "@typedefs/storage";

function sampleMinutes(min: number, max: number, rng: Rng): number {
	return (min + rng.next() * Math.max(0, max - min)) * TIMINGS.autoQueueMinuteMs;
}

export function beginPlayingSession(
	gameId: string | null,
	now: number,
	settings: Settings["automation"],
	rng: Rng
): PlayingSession {
	return {
		gameId,
		startedAt: now,
		endsAt:
			now +
			sampleMinutes(settings.autoQueueSessionMinMinutes, settings.autoQueueSessionMaxMinutes, rng),
		completedGames: 0,
		lastFinishedGameId: null,
		breakUntil: null,
	};
}

/** Returns false for a replay; otherwise records this game and samples at most one break. */
export function finishPlayingSessionGame(
	session: PlayingSession,
	gameId: string | null,
	now: number,
	settings: Settings["automation"],
	rng: Rng
): boolean {
	if (session.completedGames > 0 && session.lastFinishedGameId === gameId) return false;
	session.gameId = gameId;
	session.lastFinishedGameId = gameId;
	session.completedGames += 1;
	if (session.breakUntil === null && now >= session.endsAt)
		session.breakUntil =
			now + sampleMinutes(settings.autoQueueBreakMinMinutes, settings.autoQueueBreakMaxMinutes, rng);
	return true;
}
