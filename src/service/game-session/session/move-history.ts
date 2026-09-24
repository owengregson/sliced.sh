/**
 * The game as the session has followed it: the UCI moves, the history root every search is keyed
 * on, the position before the current one (what the §7.4 premove policy replays our move from),
 * and the pace both sides have played at. One per session, reset for every game.
 */

import { historyFromSan, matchingHistory, type PositionHistory } from "@core/chess/history";
import { applyMoves } from "@core/chess/san";
import type { PositionSnapshot } from "@typedefs/game";
import { uciOf } from "./position-rules";

export class MoveHistory {
	/** The UCI moves of the game, in order (the pipeline reads this very array). */
	moves: string[] = [];
	/** The position before the current one — what the §7.4 premove policy replays our move from. */
	priorFen: string | null = null;
	oppThinkMs: number[] = [];
	myThinkMs: number[] = [];
	lastOppMoveAt: number | null = null;
	lastMyMoveAt: number | null = null;
	private positionHistory: PositionHistory | null = null;

	/** A new game: nothing of the previous one is history of this one. */
	reset(): void {
		this.moves = [];
		this.positionHistory = null;
		this.oppThinkMs = [];
		this.myThinkMs = [];
		this.lastOppMoveAt = null;
		this.lastMyMoveAt = null;
		this.priorFen = null;
	}

	/** The history root for `fen` — the game's, when it reaches `fen`, else `fen` on its own. */
	historyFor(fen: string): PositionHistory {
		return matchingHistory(this.positionHistory, fen) ?? { fen, moves: [] };
	}

	/** The page's complete SAN list caught up on an unmoved board: adopt it as the history. */
	restore(restored: PositionHistory): void {
		this.positionHistory = restored;
		this.moves = [...restored.moves];
	}

	update(snapshot: PositionSnapshot, newMoves: string[] = []): void {
		const restored = snapshot.moveHistory ? historyFromSan(snapshot.moveHistory, snapshot.fen) : null;
		if (restored) {
			this.positionHistory = restored;
			this.moves = [...restored.moves];
			return;
		}
		if (matchingHistory(this.positionHistory, snapshot.fen)) return;
		const current = this.positionHistory;
		const advanced =
			current &&
			matchingHistory({ fen: current.fen, moves: [...current.moves, ...newMoves] }, snapshot.fen);
		this.positionHistory = advanced ?? { fen: snapshot.fen, moves: [] };
	}

	/** Record the move that produced `snapshot` and the pace it was played at. */
	track(previous: PositionSnapshot | null, snapshot: PositionSnapshot): void {
		const last = snapshot.lastMove;
		if (!last || !previous) {
			this.update(snapshot);
			return;
		}
		const uci = uciOf(previous.fen, last.from, last.to);
		if (uci !== null && this.moves[this.moves.length - 1] !== uci) this.moves.push(uci);
		this.update(snapshot, uci === null ? [] : [uci]);
		const at = snapshot.capturedAt;
		const byMe = snapshot.myColor !== null && snapshot.sideToMove !== snapshot.myColor;
		if (byMe) this.lastMyMoveAt = at;
		else {
			if (this.lastMyMoveAt !== null) this.oppThinkMs.push(Math.max(0, at - this.lastMyMoveAt));
			this.lastOppMoveAt = at;
		}
	}

	/**
	 * Two plies landed in one position (a queued premove fired the instant the opponent replied),
	 * so `track` — which reads `lastMove` alone — can only see the second. Record both in order, and
	 * point `priorFen` at the position our premove was actually played from, which is what the
	 * *next* premove replays our move from.
	 */
	noteTwoPlies(fromFen: string, reply: string, ours: string, snapshot: PositionSnapshot): void {
		if (this.moves[this.moves.length - 1] !== reply) this.moves.push(reply);
		if (this.moves[this.moves.length - 1] !== ours) this.moves.push(ours);
		this.update(snapshot, [reply, ours]);
		const afterReply = applyMoves(fromFen, [reply]);
		if (afterReply !== null) this.priorFen = afterReply;
		const at = snapshot.capturedAt;
		// `> 0` because `track` may already have run for this position (the deferred settle), which
		// moves `lastMyMoveAt` to the premove itself and leaves nothing to measure.
		const think = this.lastMyMoveAt === null ? 0 : at - this.lastMyMoveAt;
		if (think > 0) this.oppThinkMs.push(think);
		this.lastOppMoveAt = at;
	}

	/** The content script saw an opponent move before any position carried it. */
	observed(byMe: boolean, atMs: number): void {
		if (!byMe && this.lastOppMoveAt === null) this.lastOppMoveAt = atMs;
	}
}
