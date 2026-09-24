/**
 * The lobby hold (`lobby.ts`, owner 2026-09-13), as the session runs it: the content script's URL
 * flag, the clock-stillness tracker, the last verdict acted on, and the timer that notices the
 * clocks *not* moving — which produces no message, so the confirmation needs a timer. The verdict's
 * edges are handed back to the session, which owns the hand.
 */

import { LOBBY } from "@core/constants/lobby";
import { log } from "@core/logger";
import { isLobbyHold, type LobbyInput, LobbyTracker, type LobbyVerdict } from "../lobby";
import type { SessionCore } from "./core";

export interface LobbyHoldEdges {
	/** `held`: the clocks have proven still — this is the queue screen; release the mouse. */
	confirmed(): void;
	/** Out of a hold (a tick, the URL moving on): a game is on the board. */
	ended(reason: string, verdict: LobbyVerdict): void;
}

export class LobbyHold {
	/** The content script's URL flag (`hello` / `gameStarted`): the exact `/play/online` path. */
	private page = false;
	private readonly tracker = new LobbyTracker();
	private verdict: LobbyVerdict = "none";
	private timer: unknown = null;

	constructor(
		private readonly core: SessionCore,
		private readonly edges: LobbyHoldEdges
	) {}

	/** `hello` states the flag either way; `gameStarted` may only ever assert it. */
	setPage(lobby: boolean): void {
		this.page = lobby;
	}

	/** A new board: the lobby's clock stillness starts over (the URL flag is the caller's). */
	resetStillness(): void {
		this.tracker.reset();
	}

	private input(): LobbyInput {
		const s = this.core.snapshot;
		return {
			lobby: this.page,
			clocks: s ? { w: s.clocks.w.ms, b: s.clocks.b.ms } : null,
			now: this.core.now(),
		};
	}

	/** Is the hand withheld from the mouse right now — the lobby suspected or confirmed? */
	held(): boolean {
		return isLobbyHold(this.tracker.verdict(this.input()));
	}

	/**
	 * Feed the detector whatever just changed — the URL flag, a position, a clock reading, the
	 * opponent, the stillness timer — and act on the verdict's edges. Into a hold: nothing to do
	 * beyond the log, the withheld arm lives in `attachExecutor` / `arm()`. `held` (the clocks have
	 * proven still): a hand already armed is released and the mirror hidden, so the owner's mouse is
	 * theirs to click Play with. Out of a hold (a tick, a move, a rating, the URL moving on): the
	 * hand arms exactly as a fresh game start would, outside any move window — this is ply 0.
	 */
	review(reason: string): void {
		if (this.core.disposed) return;
		const previous = this.verdict;
		const verdict = this.tracker.observe(this.input());
		this.verdict = verdict;
		this.scheduleStill(verdict);
		if (verdict === previous) return;
		const tabId = this.core.tabId;
		if (isLobbyHold(verdict) && !isLobbyHold(previous))
			log.info("game-session: lobby suspected — the hand stays off the mouse", { tabId, reason });
		if (verdict === "held") {
			log.info("game-session: lobby confirmed — the clocks have not moved", {
				tabId,
				stillMs: LOBBY.clockStillMs,
			});
			this.edges.confirmed();
		}
		if (isLobbyHold(previous) && !isLobbyHold(verdict)) this.edges.ended(reason, verdict);
		this.core.notify();
	}

	/** The clocks not moving sends nothing, so `suspected` → `held` is a timer's to notice. */
	private scheduleStill(verdict: LobbyVerdict): void {
		this.clearTimer();
		if (verdict !== "suspected") return;
		const due = this.tracker.stillDueIn(this.core.now());
		if (due === null) return;
		this.timer = this.core.scheduler.setTimeout(() => {
			this.timer = null;
			this.review("the clocks have not moved");
		}, due);
	}

	clearTimer(): void {
		if (this.timer === null) return;
		this.core.scheduler.clearTimeout(this.timer);
		this.timer = null;
	}
}
