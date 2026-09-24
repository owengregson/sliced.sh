/** Facts about a recommendation the executor derives on its own. Pure. */

import { loadPosition } from "@core/chess/fen";
import { playUci } from "@core/chess/san";
import { isSquare } from "@core/chess/squares";
import type { MotorMoveKind, MoveCandidate } from "@core/motor/types";
import type { Recommendation } from "@typedefs/game";

/** Exploration candidates from the MultiPV lines, weighted by rank when the session gives no probabilities. */
export function candidatesFromLines(rec: Recommendation): MoveCandidate[] {
	const out: MoveCandidate[] = [];
	rec.lines.forEach((line, i) => {
		const uci = line.pvUci[0];
		if (!uci || uci.length < 4) return;
		const from = uci.slice(0, 2);
		const to = uci.slice(2, 4);
		if (!isSquare(from) || !isSquare(to)) return;
		out.push({ from, to, uci, probability: 1 / (i + 1) });
	});
	return out;
}

/** A delayed receipt may belong to the move before the opponent's already published reply. */
export function isNextOwnTurn(previous: Recommendation, next: Recommendation): boolean {
	const board = loadPosition(previous.fen);
	const target = loadPosition(next.fen);
	if (!board || !target || board.turn() !== target.turn()) return false;
	if (!playUci(board, previous.chosen.uci)) return false;
	for (const reply of board.moves({ verbose: true })) {
		board.move(reply);
		const matches = board.fen() === target.fen();
		board.undo();
		if (matches) return true;
	}
	return false;
}

export function moveKindOf(rec: Recommendation): MotorMoveKind {
	if (rec.chosen.promotion) return "promotion";
	if (rec.chosen.source === "premove") return "premove";
	return "normal";
}
