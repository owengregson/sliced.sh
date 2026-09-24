/**
 * The position feed for one tab: which readings the session acts on. A reconnecting content script
 * replays `hello` + the last `position` *and* its outbox (Task 21), so the same ply can arrive
 * twice; an older ply can arrive late; and chess.com's DOM renderer can publish our own hand
 * caught mid-move. Only a genuinely new reading is admitted — the others still deliver what they
 * carry that is new (the move history, a clock tick, the time control).
 */

import { historyFromSan } from "@core/chess/history";
import { log } from "@core/logger";
import type { PositionSnapshot } from "@typedefs/game";
import type { SessionCore } from "./core";
import type { EffectsFeed } from "./effects-feed";
import type { LobbyHold } from "./lobby-hold";
import { positionFeedKey } from "./position-rules";
import type { TimeControlProfile } from "./time-control";

export interface PositionFeedParts {
	effects: EffectsFeed;
	lobby: LobbyHold;
	profile: TimeControlProfile;
}

export class PositionFeed {
	/** Feed dedupe (Task 21 replays `lastPosition` and the outbox on reconnect). */
	private lastKey: string | null = null;

	constructor(
		private readonly core: SessionCore,
		private readonly parts: PositionFeedParts
	) {}

	/** A new game: its first reading is new whatever the previous game last saw. */
	reset(): void {
		this.lastKey = null;
	}

	/**
	 * Is `snapshot` a new reading the session must act on? A repeat is absorbed here (what it
	 * carries that is new is taken), an older ply and our own hand mid-move are dropped.
	 */
	admit(snapshot: PositionSnapshot): boolean {
		const core = this.core;
		const key = positionFeedKey(snapshot);
		if (key === this.lastKey) {
			this.onRepeated(snapshot);
			return false;
		}
		if (
			core.game?.gameId === snapshot.gameId &&
			core.snapshot !== null &&
			snapshot.ply < core.snapshot.ply
		) {
			log.debug("game-session: ignoring an older ply", {
				tabId: core.tabId,
				ply: snapshot.ply,
				have: core.snapshot.ply,
			});
			return false;
		}
		if (this.ownHandsDoing(snapshot)) {
			this.salvageFromOwnHand(snapshot);
			log.debug("game-session: position ignored — our own hand is mid-move on this ply", {
				tabId: core.tabId,
				ply: snapshot.ply,
				uci: core.rec?.chosen.uci ?? null,
			});
			return false;
		}
		this.lastKey = key;
		return true;
	}

	/**
	 * The reading the session already holds, again (`positionFeedKey` matched). The exact board can
	 * arrive before its move-list/bridge metadata, and a clock can tick on an unmoved board; take
	 * what is new without restarting preparation or input.
	 */
	private onRepeated(snapshot: PositionSnapshot): void {
		const core = this.core;
		// Recover only the missing effects report; a metadata correction must not restart
		// preparation or input.
		this.parts.effects.recover(snapshot);
		const current = core.snapshot;
		// Move history may catch up without a board/clock change, including after game over.
		// Recover log reviews without restarting the playing pipeline or replaying effects.
		if (
			current &&
			snapshot.moveHistory &&
			snapshot.moveHistory.join(" ") !== current.moveHistory?.join(" ")
		) {
			const restored = historyFromSan(snapshot.moveHistory, snapshot.fen);
			if (restored) {
				current.moveHistory = [...snapshot.moveHistory];
				core.history.restore(restored);
				this.parts.effects.historyRestored(snapshot, restored);
			}
		}
		if (current && snapshot.capturedAt > current.capturedAt) {
			// Keep the same object so a clock tick cannot invalidate an in-flight search.
			current.clocks = snapshot.clocks;
			current.capturedAt = snapshot.capturedAt;
			core.history.update(snapshot);
			// A clock tick on an unmoved board is exactly the lobby hold's evidence.
			this.parts.lobby.review("a clock reading");
			core.notify();
		}
	}

	/**
	 * Is this reading our own hand, caught mid-move, rather than a position that moved on?
	 *
	 * chess.com's DOM renderer mutates the `.piece` elements while a piece is off its square. When
	 * the markup marks that with `.piece.dragging` the adapter reads nothing (`ChessComAdapter.read`);
	 * when it does not, the placement no longer corroborates the bridge FEN, so the hybrid reading
	 * falls through to an **approximate** FEN with the mover missing and the adapter publishes it —
	 * measured against `test/fixtures/chesscom-computer.html`: one extra position, same ply, the
	 * rook gone from the placement. Treating that as a real change cancelled the execution mid-drag
	 * (`cancelInFlight`) and erased the mark for the move being played (`BoardMarks.clear`), which is
	 * the mark disappearing "when the mouse starts its action" on the DOM renderer.
	 *
	 * A position that genuinely moved on advances the ply — the move list is what `ply` is read from
	 * — so *same game, same ply, same side to move, while the hand is running the move the board is
	 * marked for* is our own hand and nothing else. Everything that means the recommendation is
	 * genuinely dead — the switch, `Shift+X`, game end, the tab navigating, a ply that actually
	 * advanced — runs exactly as before.
	 *
	 * **Nothing the dropped reading carried is lost.** There is no position poll in the adapter —
	 * `AdapterBase.apply` records `lastKey` / `lastColor` / `lastTimeControl` before it decides to
	 * publish, and the adapter's only interval runs `probe()` — so a dropped reading is never
	 * re-offered and "the next reading will carry it" is not an argument. Field by field:
	 *
	 * - `site`, `gameId`, `ply`, `sideToMove` — identical to the snapshot we are on, by the guard.
	 * - `fen` — the artefact itself (a piece missing from the board). Discarding it is the point.
	 * - `myColor` — cannot be new: the guard needs a recommendation, and a recommendation needs
	 *   `mayActOn`, which needs a known colour.
	 * - `lastMove` — the same ply means the same last move.
	 * - `clocks`, `capturedAt` — newer, and deliberately not taken: they belong to a position the
	 *   session is not on. They are superseded by the next real reading, one move later at most,
	 *   and nothing between now and then reads them (the plan in flight is already made).
	 * - `timeControl` — **the one thing that can be new**, because §4.3's one-shot republish
	 *   (`AdapterBase.apply`'s `timeControlLearned`) is timed to land in exactly this window: the
	 *   re-ask runs every `TIMINGS.adapterTimeControlRetryMs` and the hand's action is seconds
	 *   long. `salvageFromOwnHand` takes it before the rest of the reading is dropped.
	 *
	 * `lastKey` is left alone as well, so a republish of this very reading after the hand
	 * stops is still considered rather than deduped away.
	 *
	 * This is a question and nothing else: the salvage is a separate call at the one call site, so
	 * that short-circuiting or reordering the `if` cannot silently lose it.
	 */
	private ownHandsDoing(snapshot: PositionSnapshot): boolean {
		const core = this.core;
		const current = core.snapshot;
		const rec = core.rec;
		if (!current || !rec || core.game?.gameId !== snapshot.gameId) return false;
		if (snapshot.ply !== current.ply || snapshot.sideToMove !== current.sideToMove) return false;
		return core.executor?.runningMove()?.rec === rec;
	}

	/**
	 * What a reading `ownHandsDoing` is about to drop still has to deliver: §4.3's time control.
	 * The site answers `timeControl.get()` only once the game has actually started, the adapter
	 * republishes the unmoved position to deliver it exactly once, and the re-ask runs on a 1 s
	 * timer — so its arrival lands inside the seconds the hand's action takes. `reprofile` is the
	 * same call `onPosition` would have made: idempotent (once per game), and safe while a move is
	 * in flight for the same documented reason `MoveExecutor.setTimeControlClass` is — the running
	 * move keeps the plan it was given and the new profile is read by the next one.
	 */
	private salvageFromOwnHand(snapshot: PositionSnapshot): void {
		this.parts.profile.reprofile(snapshot);
	}
}
