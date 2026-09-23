/**
 * The session's side of the board effects (owner's brief, 2026-09-13): what the move that just
 * landed did, and how good it was — both sides' moves, the rays gated on
 * `Settings.automation.boardEffects`, the rating on `automation.moveQualityChips`, each on its own
 * (owner, 2026-09-15). This feeds the `BoardEffectsReporter` the positions and plies the session
 * follows, recovers a report whose last-move metadata arrived late, and owns the effect layer's
 * erase.
 */

import type { PositionHistory } from "@core/chess/history";
import { matchingHistory } from "@core/chess/history";
import { applyMoves } from "@core/chess/san";
import { BOARD_EFFECT_GAME_END } from "@core/constants/board-effects";
import type { PositionSnapshot } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";
import { BoardEffectsReporter } from "../board-effects";
import type { SessionCore } from "./core";
import type { ReviewAdmission } from "./review-admission";

/** The reporter wired to one session's link, settings, game and opponent. */
export function createSessionReporter(core: SessionCore): BoardEffectsReporter {
	const book = core.deps.book;
	return new BoardEffectsReporter({
		reviewer: () => core.deps.review ?? null,
		post: (cmd) => {
			core.deps.link.post(core.tabId, cmd);
		},
		annotate: (rating) => {
			if (core.game)
				core.deps.link.post(core.tabId, {
					kind: "moveListRating",
					gameId: core.game.gameId,
					rating,
				});
		},
		chips: () => core.settings().automation.moveQualityChips,
		rays: () => core.settings().automation.boardEffects,
		chipsFor: () => core.settings().automation.moveQualityChipsFor,
		...(book?.bookMoves
			? { bookMoves: (fen: string) => book.bookMoves?.(fen) ?? Promise.resolve([]) }
			: {}),
		// Chess.com grades at the mover's rating. The page reports the opponent's; players are
		// paired near their own rating, so it stands in for ours as well.
		rating: () => core.opponentInfo?.ratingEstimate ?? undefined,
		scheduler: core.scheduler,
		now: core.now,
	});
}

/** The arrival whose last-move metadata may still come (only the current one; never a backlog). */
interface PendingArrival {
	previous: PositionSnapshot;
	arrival: PositionSnapshot;
	history: PositionHistory;
}

export class EffectsFeed {
	/** Only the current arrival may recover late last-move metadata; never retain a game backlog. */
	private pendingArrival: PendingArrival | null = null;
	/** The game-end erase of the effect layer, pending while the last move's chip and sound finish. */
	private clearTimer: unknown = null;

	constructor(
		private readonly core: SessionCore,
		private readonly reporter: BoardEffectsReporter,
		private readonly admission: ReviewAdmission
	) {}

	/** Move ratings are on and the session may act — the review engine is worth any work at all. */
	private ratingsOn(): boolean {
		return this.core.mayAct() && this.core.settings().automation.moveQualityChips;
	}

	/**
	 * Board ratings are on: have the review engine booting before the first move lands. The full
	 * network takes a moment to load, and on the queue screen nothing else is waiting for it.
	 */
	warm(): void {
		if (this.ratingsOn()) this.reporter.warm();
	}

	/**
	 * Open our planned move's rating now, so the review engine searches the position it will
	 * produce while the hand waits out the think time (2026-09-14). The playing engine's lines
	 * never feed a rating: they are strength-limited, shaped or shallow. `settings` is the caller's
	 * reading — the pipeline decides on the settings its search started with.
	 */
	preparePlanned(snapshot: PositionSnapshot, uci: string, settings: Settings, inBook = false): void {
		if (!this.core.mayAct() || !settings.automation.moveQualityChips) return;
		this.reporter.prepare({
			beforeFen: snapshot.fen,
			history: this.core.historyFor(snapshot.fen),
			uci,
			ply: snapshot.ply,
			...(inBook ? { inBook: true } : {}),
		});
	}

	/** The history caught up on the same board: review what it now proves, finishing a game over. */
	historyRestored(snapshot: PositionSnapshot, restored: PositionHistory): void {
		if (!this.ratingsOn()) return;
		this.reporter.backfill({ fen: snapshot.fen, history: restored }, snapshot.ply);
		if (this.core.state === "game-over") this.reporter.finish();
	}

	/**
	 * A settings write: move ratings off stops the review work now rather than at the next
	 * position, whatever board effects say (the review engine itself is released by `game-stack`);
	 * on, it catches the review up with the position the session holds.
	 */
	settingsChanged(on: boolean): void {
		const snapshot = this.core.snapshot;
		if (!this.core.settings().automation.moveQualityChips) this.reporter.cancel();
		else if (on && snapshot) {
			this.reporter.backfill(
				{ fen: snapshot.fen, history: this.core.historyFor(snapshot.fen) },
				snapshot.ply
			);
		}
	}

	/**
	 * Board effects for the moves that produced `snapshot`, either side's (owner's brief,
	 * 2026-09-13). The effect list is pure chess and goes out at once; the quality chip follows
	 * independently when the review evidence is ready
	 * (`BoardEffectsReporter`). Two plies land in one position when a queued premove fired the
	 * instant the opponent moved (Fix F): the site marks *our* move, played from a position this
	 * session never saw, so `landedPlies` recovers their reply and both are reported, theirs first.
	 *
	 * `history` is the session's history root for `previous.fen`, read by the caller before
	 * `MoveHistory.track` advanced it. After the report the position itself is handed to the
	 * reporter (`observe`): the review engine starts on it at once, whichever side is to move.
	 */
	report(
		previous: PositionSnapshot | null,
		snapshot: PositionSnapshot,
		history: PositionHistory | null
	): void {
		const settings = this.core.settings();
		// Either switch alone keeps the reporter going (owner, 2026-09-15); it strips what is off.
		if (
			!this.core.mayAct() ||
			(!settings.automation.boardEffects && !settings.automation.moveQualityChips)
		) {
			this.pendingArrival = null;
			this.reporter.cancel();
			return;
		}
		if (previous && previous.gameId === snapshot.gameId && snapshot.ply > previous.ply) {
			this.pendingArrival =
				!snapshot.lastMove && history ? { previous, arrival: snapshot, history } : null;
		} else if (this.pendingArrival?.arrival !== snapshot) {
			this.pendingArrival = null;
		}
		if (previous !== null && previous.gameId !== snapshot.gameId) {
			// A different game's board: nothing drawn for the old one belongs on this one.
			this.clear();
		} else {
			this.reportLandedMoves(previous, snapshot, history);
		}
		this.reporter.backfill(
			{ fen: snapshot.fen, history: this.core.historyFor(snapshot.fen) },
			snapshot.ply
		);
		if (this.core.state === "game-over") {
			this.reporter.finish();
			// The final position can reach the session just after the game over: its move is still
			// rated and sounded; log-only catch-up reviews can continue after the erase.
			if (this.clearTimer !== null) this.scheduleClear();
			return;
		}
		this.reporter.observe({ fen: snapshot.fen, history: this.core.historyFor(snapshot.fen) });
	}

	/** Backfill one missing report on the same board, without invalidating its playing state. */
	recover(snapshot: PositionSnapshot): void {
		const pending = this.pendingArrival;
		const last = snapshot.lastMove;
		if (
			!pending ||
			!last ||
			this.core.snapshot !== pending.arrival ||
			snapshot.gameId !== pending.arrival.gameId ||
			snapshot.ply !== pending.arrival.ply ||
			snapshot.fen !== pending.arrival.fen
		)
			return;
		const settings = this.core.settings();
		if (
			!this.core.mayAct() ||
			(!settings.automation.boardEffects && !settings.automation.moveQualityChips)
		) {
			this.pendingArrival = null;
			return;
		}
		const plies = BoardEffectsReporter.landedPlies(pending.previous.fen, last, snapshot.fen);
		// A stale lastMove can be legal in the previous position. Legality alone is not proof:
		// replay must reach this exact normalized FEN (including counters) and the reported ply.
		if (
			!plies ||
			plies.length !== snapshot.ply - pending.previous.ply ||
			!matchingHistory({ fen: pending.previous.fen, moves: plies }, snapshot.fen)
		)
			return;
		this.pendingArrival = null;
		pending.arrival.lastMove = last;
		this.reportLandedMoves(pending.previous, snapshot, pending.history);
	}

	/** The `report` half of `report`: the plies between `previous` and `snapshot`. */
	private reportLandedMoves(
		previous: PositionSnapshot | null,
		snapshot: PositionSnapshot,
		history: PositionHistory | null
	): void {
		const last = snapshot.lastMove;
		if (!previous || !last || !history) return;
		const plies = BoardEffectsReporter.landedPlies(previous.fen, last, snapshot.fen);
		if (
			!plies ||
			plies.length !== snapshot.ply - previous.ply ||
			!matchingHistory({ fen: previous.fen, moves: plies }, snapshot.fen)
		)
			return;
		const lastMine = snapshot.myColor !== null && snapshot.sideToMove !== snapshot.myColor;
		const moves: Array<{
			beforeFen: string;
			historyFen: string;
			historyMoves: readonly string[];
			uci: string;
			ply: number;
			mine: boolean;
		}> = [];
		let fen = previous.fen;
		const trail = [...history.moves];
		for (const [i, uci] of plies.entries()) {
			const isLast = i === plies.length - 1;
			moves.push({
				beforeFen: fen,
				historyFen: history.fen,
				historyMoves: [...trail],
				uci,
				ply: previous.ply + i,
				mine: isLast ? lastMine : !lastMine,
			});
			const next = applyMoves(fen, [uci]);
			if (next === null) return;
			fen = next;
			trail.push(uci);
		}
		this.reporter.report({ moves });
	}

	/** A new game's first reading: no arrival of the previous game may recover into it. */
	forgetArrival(): void {
		this.pendingArrival = null;
	}

	/**
	 * Erase the effect layer. Deliberately *not* part of `BoardMarks.clear()`: that runs on every
	 * new position, and a batch drawn for the move that produced it would be wiped in the same
	 * turn. The effect layer is cleared only when the game it belongs to is over — the assistant
	 * off, `Shift+X`, a new game, the game ending, the tab going.
	 */
	clear(): void {
		this.cancelClear();
		this.pendingArrival = null;
		this.reporter.cancel();
		this.admission.update();
		this.core.deps.link.post(this.core.tabId, { kind: "clearEffects" });
	}

	/**
	 * The game is over: finish log reviews, but erase the layer only once the last move's chip and
	 * sound have run (`BOARD_EFFECT_GAME_END`). The page reports the game over in the same instant as
	 * the mating position, and an erase at once silenced the checkmate (owner, 2026-09-15).
	 */
	clearAfterGame(): void {
		this.pendingArrival = null;
		this.reporter.finish();
		this.admission.update();
		this.scheduleClear();
	}

	private scheduleClear(): void {
		this.cancelClear();
		this.clearTimer = this.core.scheduler.setTimeout(() => {
			this.clearTimer = null;
			if (!this.core.disposed) this.core.deps.link.post(this.core.tabId, { kind: "clearEffects" });
		}, BOARD_EFFECT_GAME_END.clearDelayMs);
	}

	cancelClear(): void {
		if (this.clearTimer === null) return;
		this.core.scheduler.clearTimeout(this.clearTimer);
		this.clearTimer = null;
	}
}
