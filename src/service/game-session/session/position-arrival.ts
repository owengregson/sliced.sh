/**
 * §3.2 per position: a reading the feed admitted becomes the session's position — the game it
 * belongs to, the scramble hold's release, the cancel of everything for the old position, the
 * premove settle, the history, the state machine and the board effects — and then, if the session
 * may act on it, the opponent's turn or our own move.
 */
import { turnFieldOf } from "@core/chess/fen";
import { log } from "@core/logger";
import type { PositionSnapshot } from "@typedefs/game";
import type { SessionCore } from "./core";
import type { GameLifecycle } from "./lifecycle";
import type { SessionParts } from "./parts";
import { boardKeyOf } from "./position-rules";

export class PositionArrival {
	constructor(
		private readonly core: SessionCore,
		private readonly parts: SessionParts,
		private readonly lifecycle: GameLifecycle
	) {}

	/** A reading `PositionFeed` admitted as new. */
	async arrive(snapshot: PositionSnapshot): Promise<void> {
		const core = this.core;
		if (core.game?.gameId !== snapshot.gameId) {
			this.lifecycle.startGame({
				gameId: snapshot.gameId,
				site: snapshot.site,
				pageKind: core.pageKind,
				myColor: snapshot.myColor,
				...(snapshot.timeControl ? { timeControl: snapshot.timeControl } : {}),
				startedAt: snapshot.capturedAt,
			});
			core.apply("gameStarted");
		}
		core.site = snapshot.site;
		// The colour can arrive after `gameStarted` did (the bridge answers `getPlayingAs()` a moment
		// after the board appears), and the panel reads the game's copy when the snapshot has none.
		// …and it can arrive *wrong* and be corrected later, or be **withdrawn** (`AdapterBase.apply`
		// republishes an authoritative correction on an unmoved position, and withholds the colour
		// altogether once a game has spent its corrections), so this tracks the snapshot exactly rather
		// than filling a blank once.
		//
		// Withdrawal included, which is the whole point of having no `!== null` test here: `view()`
		// falls back to this copy, so keeping the old colour through a withdrawal left the panel
		// telling the owner "Your move · white" — the very colour the site had just contradicted —
		// beside an assistant that had gone silent. A confident wrong statement next to an unexplained
		// silence is the worst of the two, and the refusal only being in the log is no answer: the log
		// is not what the owner reads (review R2-1).
		if (core.game && core.game.myColor !== snapshot.myColor)
			core.game = { ...core.game, myColor: snapshot.myColor };
		// The scramble hold is decided *before* anything is cancelled: a cancel would abandon it.
		const held = this.parts.holds.settle(
			snapshot,
			snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor
		);
		// H7.3: the pre-inferred answer survives the cancel exactly when this is the position it was
		// inferred for — the whole point of inferring it early. Any other position drops it.
		const carried = this.parts.prediction.policy;
		this.parts.cancelInFlight(held !== null);
		this.parts.prediction.policy = carried;
		const previous = core.snapshot;
		// The same board, republished: an exact FEN replacing an approximate one, the time control
		// arriving, a clock tick whose FEN string differs in a counter. The pipeline runs again (the
		// profile or the budget may have changed), but the mark already on the board is left where it
		// is rather than cleared and redrawn: the clear reset the page overlay's dedupe, so even an
		// unchanged move replayed its fade-in. A changed move still replaces it when it is posted.
		const sameBoard =
			previous !== null &&
			core.rec !== null &&
			core.game?.gameId === snapshot.gameId &&
			previous.ply === snapshot.ply &&
			previous.myColor === snapshot.myColor &&
			boardKeyOf(previous.fen) === boardKeyOf(snapshot.fen);
		core.history.priorFen = previous?.fen ?? null;
		core.snapshot = snapshot;
		if (
			core.positionArrivedAt === null ||
			!previous ||
			previous.gameId !== snapshot.gameId ||
			previous.ply !== snapshot.ply ||
			boardKeyOf(previous.fen) !== boardKeyOf(snapshot.fen)
		)
			core.positionArrivedAt = Math.min(snapshot.capturedAt, core.now());
		// Fix F: a premove we entered on the site is settled by *this* position — before the move
		// history, the profile or anything that plans reads either of them.
		this.parts.queue.reconcile(snapshot);
		this.parts.profile.reprofile(snapshot);
		// The lobby hold reads the ply and the clocks of the position the session now holds.
		this.parts.lobby.review("a position");
		// Whatever was marked belonged to the position that has just been superseded: erase it
		// before anything new is drawn, so the board never carries two recommendations at once.
		core.rec = null;
		if (!sameBoard) this.parts.marks.clear();
		const myTurn = snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor;
		const at = core.now();
		core.deps.focus.positionArrived(core.tabId, at);
		core.window.open(at, myTurn);
		// Read before `track`, which advances the history: the board-effect verdict searches the
		// position *before* the move, and it wants the root the next ply's search will also use.
		const beforeHistory = previous ? core.historyFor(previous.fen) : null;
		core.history.track(previous, snapshot);
		this.parts.prediction.policy = this.parts.prediction.currentPolicyFor(snapshot, carried);
		if (!core.apply("positionChanged", { myTurn })) return;
		// After the transition, before the §4.4 gate: the effect layer reports what *happened* on the
		// board, which is true whether or not the colour is known and whether or not it is our turn —
		// but a position the state machine refused (a game already over) is not a move to report.
		this.parts.effects.report(previous, snapshot, beforeHistory);
		core.notify();
		if (!core.mayActOn(snapshot)) {
			// §4.4: everything above is bookkeeping the panel reads and a resume needs (the ply, the
			// clocks, the move list, the focus gate's window). Nothing below it runs while the
			// switch is off — or while the *colour* is unknown: no `go`, no ponder, no premove, no
			// recommendation, no schedule. A colourless position cannot even say whose turn it is,
			// so "not my turn ⇒ ponder" would be a guess too.
			log.debug("game-session: position held", {
				tabId: core.tabId,
				ply: snapshot.ply,
				reason: core.mayAct() ? "colour not known yet" : "the assistant is off",
			});
			return;
		}
		// A snapshot that contradicts itself is held before the branch, so the hold is symmetric
		// (`selfConsistent`). The adapter settles this as it reads (`AdapterBase.reading`); this is the
		// second layer, for a snapshot that reached the worker some other way.
		if (!core.selfConsistent(snapshot)) {
			log.warn("game-session: position held — its sideToMove contradicts its own FEN", {
				tabId: core.tabId,
				ply: snapshot.ply,
				myColor: snapshot.myColor,
				sideToMove: snapshot.sideToMove,
				fenTurn: turnFieldOf(snapshot.fen),
			});
			return;
		}
		if (!myTurn) {
			await this.parts.opponentTurn.start(snapshot);
			return;
		}
		if (held) {
			// The hand is letting go of the held piece right now: that is this position's move. No
			// search, no fast reply — the whole point of the hold is that the decision was made
			// while the opponent was thinking.
			core.rec = held;
			core.apply("recommended");
			core.notify();
			return;
		}
		if (await this.parts.arming.fireOnReply(snapshot)) return;
		if (this.parts.profile.holdForTimeControl(snapshot)) return;
		await this.parts.delivery.runPipeline(snapshot);
	}
}
