/**
 * The executor's board checks outside the hand: the pre-dispatch position guard and the signal
 * every verification / re-check runs on. A check signal is fresh at the moment it is taken, so the
 * cancel that interrupted an attempt never poisons the check after it; only a *further* cancel
 * arriving during the check (`abort()`) cuts it short.
 */

import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import type { Recommendation, Square } from "@typedefs/game";
import { positionIntact } from "../hand/geometry";
import { checkSquares } from "../verifier";
import type { ExecutorLink } from "./types";

export type PositionVerdict = { outcome: "skipped" | "aborted"; reason: string } | null;

export class BoardChecks {
	/** The current board check's controller (a cancel arriving during the check aborts it). */
	private checkAc: AbortController | null = null;

	constructor(
		private readonly link: ExecutorLink,
		private readonly tabId: number
	) {}

	/** A board-check signal that only a cancel arriving from now on aborts. */
	freshSignal(): AbortSignal {
		this.checkAc = new AbortController();
		return this.checkAc.signal;
	}

	/** The check in flight is over (or the execution that owned it is). */
	clear(): void {
		this.checkAc = null;
	}

	/** `cancel()`: abort the check in flight, if any. */
	abort(): void {
		this.checkAc?.abort();
	}

	/**
	 * `null` when our piece is still on `from` (and `to` is not ours); otherwise the
	 * verdict. Occupancy from the reply answers for free; a replacement without it
	 * asks the adapter the colour-aware `boardCheck` question (bounded, fresh
	 * signal) — never `observeMove`, whose "piece on the destination" answer would
	 * veto a capture. An unanswerable check counts as changed (nothing is
	 * dispatched on a guess); a check cut short by `cancel()` is `aborted`.
	 */
	async positionChanged(
		rec: Recommendation,
		reply: BoardGeometryReply,
		replacement: boolean,
		verifyMoves: boolean | undefined,
		queued = false,
		required = false
	): Promise<PositionVerdict> {
		const changed = { outcome: "skipped", reason: EXECUTOR.reasons.positionChanged } as const;
		// Fix F: a premove is entered in the position *before* the opponent's reply, where its
		// destination is routinely still ours — a recapture is aimed at the piece they are about to
		// take. Only "our piece is still on the from-square" is asked of it; "the destination is not
		// ours" is a rule about a move being legal now, which a premove is not.
		const to = queued ? undefined : rec.chosen.to;
		if (reply.occupancy) {
			return positionIntact(reply, rec.chosen.from, to) ? null : changed;
		}
		if (!replacement || (!verifyMoves && !required)) return null;
		const from = rec.chosen.from;
		const squares: Square[] = to === undefined ? [from] : [from, to];
		const signal = this.freshSignal();
		const seen = await checkSquares(
			this.link,
			this.tabId,
			squares,
			EXECUTOR.recheckTimeoutMs,
			signal
		);
		this.checkAc = null;
		if (seen.outcome === "unavailable") {
			return signal.aborted
				? { outcome: "aborted", reason: EXECUTOR.reasons.aborted }
				: { outcome: "skipped", reason: EXECUTOR.reasons.verificationUnavailable };
		}
		const occ = seen.occupancy;
		if (squares.some((sq) => occ[sq] === undefined)) {
			// A square the adapter could not classify: nothing is dispatched on a guess.
			return { outcome: "skipped", reason: EXECUTOR.reasons.verificationUnavailable };
		}
		return occ[from] === "own" && (to === undefined || occ[to] !== "own") ? null : changed;
	}
}
