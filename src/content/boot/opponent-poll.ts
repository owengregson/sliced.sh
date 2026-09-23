/**
 * chess.com renders the player card after the board, so the read that follows `gameStarted`
 * (or the one at boot, at `document_start`) answers nothing or a rating-less name — and a
 * rating-less opponent is what the worker's strength layer treats as "no opponent", i.e. the
 * slider's Elo instead of the matched one (owner's report after a mid-game reload, 2026-09-11).
 * Re-read until the rating is there, bounded.
 */

import type { SiteAdapter } from "@content/adapters/adapter";
import type { GamePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";

export interface OpponentPoll {
	/** Send the opponent now, and keep re-reading until it carries a rating. */
	read(): void;
	stop(): void;
}

export function createOpponentPoll(
	adapter: SiteAdapter,
	post: (msg: GamePortMessage) => void,
	disposed: () => boolean
): OpponentPoll {
	let timer: ReturnType<typeof setInterval> | null = null;
	let attempts = 0;
	const stop = (): void => {
		if (timer === null) return;
		clearInterval(timer);
		timer = null;
	};
	const readOnce = (): boolean => {
		const op = adapter.getOpponent();
		if (op) post({ kind: "opponent", ...op });
		return op !== null && op.ratingEstimate !== null;
	};
	return {
		read() {
			stop();
			if (readOnce() || disposed()) return;
			attempts = 0;
			timer = setInterval(() => {
				attempts += 1;
				if (readOnce() || attempts >= TIMINGS.opponentReadRetryMax) stop();
			}, TIMINGS.opponentReadRetryMs);
		},
		stop,
	};
}
