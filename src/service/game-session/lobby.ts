/**
 * The lobby hold (owner, 2026-09-13): "dont lock the mouse on …/play/online/ (no other url) if
 * both timers are locked at 3:00 or some other time and arent moving — this is because this is
 * the QUEUE screen BEFORE you've queued a game".
 *
 * What the lobby looks like from the worker: the content script says the tab is on the exact
 * `/play/online` path (`GameMeta.lobby`), the board is at ply 0, no opponent rating has been read
 * (the top card is a placeholder), and both clocks show the default time control and do not move.
 * Everything else about it is a live game — the page's own game object reports `playing`, so the
 * adapter's page kind is `live-game` and a session starts.
 *
 * The verdicts, in the order the evidence arrives:
 *
 *   - `none`      — not the lobby path. The game is somewhere else; nothing here applies.
 *   - `suspected` — the lobby path, and the clocks have not yet proven anything (no credible
 *                   reading, or still inside `LOBBY.clockStillMs`). A fresh automatic arm is
 *                   withheld from here on; a hand already armed is kept for now.
 *   - `held`      — both clocks unchanged for `LOBBY.clockStillMs` since the first credible
 *                   reading: this is the queue screen. A hand already armed is released.
 *   - `released`  — one clock *ticked* (went down while the other stayed): the game is running
 *                   on the lobby URL after all. The hand arms as a fresh game start would.
 *
 * A reading where *both* clocks changed, or one went up, is not a tick — it is the lobby's own
 * time-control selector (3 min → 5 min), and it restarts the stillness baseline instead of
 * releasing anything. A clock reading of 0 on either side is not credible (the clock component
 * has not rendered) and neither starts the baseline nor compares against it.
 *
 * **Only a running clock ends the hold** (owner, 2026-09-14: "prevent the bot from taking over
 * mouse on url /play/online/ (no player in game yet)"). Two other things used to end it, and both
 * were states the *queue screen itself* can be in:
 *
 *   - **an opponent rating.** `ChesscomAdapter.getOpponent` reads the top player card, and after a
 *     hop back to `/play/online` that card is still the previous opponent's — a rating is readable
 *     with no game on the board at all.
 *   - **a board at ply > 0.** Same staleness: the finished game's moves are still on the board under
 *     the queue URL, and "this board has moves on it" is not "someone is playing".
 *
 * Both were reasoned from a matched game, which does show an opponent and a position before its
 * first tick — but a matched game also *ticks*, within a couple of hundred milliseconds, and
 * `clockTicked` answers `released` immediately rather than waiting out `LOBBY.clockStillMs`. So the
 * cost of dropping them is at most one clock reading, and what they bought was a hold that failed
 * open in exactly the situation it exists for. What remains is a clock that runs, or the URL
 * leaving the lobby.
 */

import { LOBBY } from "@core/constants/lobby";

export interface LobbyClocks {
	w: number;
	b: number;
}

/** The baseline the stillness is measured from: the first credible clock reading, and when. */
export interface LobbyReading extends LobbyClocks {
	at: number;
}

export interface LobbyInput {
	/** The content script's URL flag: the tab is on the exact `/play/online` path. */
	lobby: boolean;
	/** The current clock readings (ms), or `null` before the first position. */
	clocks: LobbyClocks | null;
	/** Wall time of this observation. */
	now: number;
}

export type LobbyVerdict = "none" | "suspected" | "held" | "released";

/** Both clocks rendered: a 0 on either side is a clock component that has not appeared yet. */
export function credibleClocks(clocks: LobbyClocks | null): clocks is LobbyClocks {
	return clocks !== null && clocks.w > 0 && clocks.b > 0;
}

/** One side's clock went down while the other's stayed: a running game, not a selector change. */
export function clockTicked(first: LobbyClocks, clocks: LobbyClocks): boolean {
	return (
		(clocks.w < first.w && clocks.b === first.b) || (clocks.b < first.b && clocks.w === first.w)
	);
}

/** The verdict does not itself hold the hand; `isLobbyHold` says which verdicts do. */
export function isLobbyHold(verdict: LobbyVerdict): boolean {
	return verdict === "suspected" || verdict === "held";
}

/**
 * The pure verdict for one observation against the baseline. A non-tick change of the clocks
 * (the selector) answers `suspected`: the baseline is the tracker's to move, and a changed
 * baseline has proven nothing yet.
 */
export function lobbyVerdict(
	input: LobbyInput,
	first: LobbyReading | null,
	stillMs: number = LOBBY.clockStillMs
): LobbyVerdict {
	if (!input.lobby) return "none";
	const clocks = input.clocks;
	if (first === null || !credibleClocks(clocks)) return "suspected";
	if (clockTicked(first, clocks)) return "released";
	if (clocks.w !== first.w || clocks.b !== first.b) return "suspected";
	return input.now - first.at >= stillMs ? "held" : "suspected";
}

/** The baseline reading, kept per game: `observe` records it, `verdict` only reads it. */
export class LobbyTracker {
	private first: LobbyReading | null = null;

	constructor(private readonly stillMs: number = LOBBY.clockStillMs) {}

	/** A new game on the board: the stillness starts over. */
	reset(): void {
		this.first = null;
	}

	/** The verdict for `input` as things stand, recording nothing. */
	verdict(input: LobbyInput): LobbyVerdict {
		return lobbyVerdict(input, this.first, this.stillMs);
	}

	/**
	 * Record the reading (the first credible one *on the lobby path* is the baseline; a selector
	 * change moves it) and answer. Off the lobby path nothing is measured: the stillness is "since
	 * the first reading on the lobby", so a URL that becomes the lobby starts from zero.
	 */
	observe(input: LobbyInput): LobbyVerdict {
		const clocks = input.clocks;
		if (!input.lobby) this.first = null;
		else if (credibleClocks(clocks)) {
			const first = this.first;
			if (first === null) this.first = { w: clocks.w, b: clocks.b, at: input.now };
			else if (!clockTicked(first, clocks) && (clocks.w !== first.w || clocks.b !== first.b))
				this.first = { w: clocks.w, b: clocks.b, at: input.now };
		}
		return this.verdict(input);
	}

	/**
	 * Milliseconds until an unchanged reading turns `suspected` into `held`, or `null` when there
	 * is no baseline to wait on. The caller's timer; the clocks not moving produces no message.
	 */
	stillDueIn(now: number): number | null {
		const first = this.first;
		if (first === null) return null;
		return Math.max(0, this.stillMs - (now - first.at));
	}
}
