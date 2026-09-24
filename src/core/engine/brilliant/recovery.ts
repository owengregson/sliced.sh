/**
 * Tactical proofs that an offered piece is no gift: an off-square countercapture that wins the
 * material back, a threat that already stood before the move, a short checking mate.
 */

import { loadPosition } from "@core/chess/fen";
import type { Chess, Move } from "chess.js";
import { exchangeGain, gain, type SearchBudget } from "./material";
import type { BrilliantTuning } from "./types";

/**
 * An untouched piece is not a gift when taking it permits an immediate, safe countercapture
 * elsewhere. Check the acceptance branch itself: the engine's main PV may decline the offer.
 * Same-square recovery is already counted by exchangeGain. Do not use a capture's face value:
 * the capturing piece may itself be lost. Null means the shared material-search budget ran out.
 * A checking capture counts only with `checks`: same-square SEE cannot follow the evasion.
 */
export function hasOffSquareRecovery(
	board: Chess,
	capture: Move,
	tuning: BrilliantTuning,
	budget: SearchBudget,
	standing?: Chess | null,
	checks = false
): boolean | null {
	if (standing === null) return false;
	board.move(capture);
	try {
		const needed = gain(capture);
		for (const answer of board.moves({ verbose: true })) {
			if (!answer.captured || answer.to === capture.to || gain(answer) < needed) continue;
			if (!checks && /[+#]/.test(answer.san)) continue;
			const recovered = exchangeGain(board, answer, tuning, budget);
			if (recovered === null) return null;
			if (recovered < needed) continue;
			if (standing === undefined) return true;
			// The moved piece: only a capture that already won this much before the offer was
			// accepted — a deflection's regain exists because of the acceptance, and is a sacrifice.
			const threat = standing
				.moves({ verbose: true })
				.find((move) => move.from === answer.from && move.to === answer.to);
			if (!threat?.captured) continue;
			const already = exchangeGain(standing, threat, tuning, budget);
			if (already === null) return null;
			if (already >= needed) return true;
		}
		return false;
	} finally {
		board.undo();
	}
}

/** The position with the move handed back to the side that just played; `null` out of a check. */
export function passed(board: Chess): Chess | null {
	if (board.isCheck()) return null;
	const fields = board.fen().split(" ");
	fields[1] = board.turn() === "w" ? "b" : "w";
	fields[3] = "-";
	return loadPosition(fields.join(" "));
}

/** A short checking mate proves an ignored piece cannot actually be taken safely. */
export function checkingMate(
	board: Chess,
	attacker: "w" | "b",
	plies: number,
	tuning: BrilliantTuning,
	budget: SearchBudget
): boolean | null {
	if (++budget.nodes > tuning.maxExchangeNodes) return null;
	const moves = board.moves({ verbose: true });
	if (moves.length === 0) return board.isCheck() && board.turn() !== attacker;
	if (plies <= 0) return false;
	const attacking = board.turn() === attacker;
	// Only checking continuations are proof here; a quiet move may have an unexamined defence.
	const candidates = attacking ? moves.filter((move) => /[+#]/.test(move.san)) : moves;
	if (attacking && candidates.some((move) => move.san.endsWith("#"))) return true;
	for (const move of candidates) {
		board.move(move);
		let result: boolean | null;
		try {
			result = checkingMate(board, attacker, plies - 1, tuning, budget);
		} finally {
			board.undo();
		}
		if (result === null) return null;
		if (attacking && result) return true;
		if (!attacking && !result) return false;
	}
	return !attacking;
}
