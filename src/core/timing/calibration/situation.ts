/** A move's calibration situation, and the "obvious recapture" rule the fast reply shares. */

import { loadPosition } from "@core/chess/fen";
import { material } from "@core/chess/material";
import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, parseUci } from "@core/chess/san";
import type { TimingCalibrationSituation } from "@core/constants/timing-calibration";

/** Material balance from `color`'s point of view; null on an invalid FEN. */
function balance(fen: string, color: "w" | "b"): number | null {
	const m = material(fen);
	return m ? (color === "w" ? m.diff : -m.diff) : null;
}

/**
 * Whether `move` in `fen` is an obvious recapture: the last move (`lastMove`, played from
 * `priorFen`) captured on a square, `move` captures back on it, and afterwards the mover's
 * material balance is at least what it was before that capture.
 */
export function isObviousRecapture(
	priorFen: string | null | undefined,
	lastMove: string | undefined,
	fen: string,
	move: string
): boolean {
	if (!priorFen || !lastMove) return false;
	const last = classifyMove(priorFen, lastMove);
	const square = parseUci(lastMove)?.to;
	if (!last?.isCapture || !square) return false;
	const facts = classifyMove(fen, move, lastMove);
	if (!facts?.isRecapture) return false;
	const color = loadPosition(fen)?.turn();
	const after = applyMoves(fen, [move]);
	if (!color || !after) return false;
	const before = balance(priorFen, color);
	const now = balance(after, color);
	return before !== null && now !== null && now >= before;
}

/** Whether any legal move in `fen` is an obvious recapture of `lastMove` (played from `priorFen`). */
export function obviousRecaptureAvailable(
	priorFen: string | null | undefined,
	lastMove: string | undefined,
	fen: string
): boolean {
	if (!priorFen || !lastMove) return false;
	const square = parseUci(lastMove)?.to;
	const board = loadPosition(fen);
	if (!square || !board || !classifyMove(priorFen, lastMove)?.isCapture) return false;
	return board
		.moves({ verbose: true })
		.filter((m) => m.to === square && (m.isCapture() || m.isEnPassant()))
		.some((m) => isObviousRecapture(priorFen, lastMove, fen, `${m.from}${m.to}${m.promotion ?? ""}`));
}

export interface SituationInput {
	isOnlyLegal: boolean;
	inBook: boolean;
	obviousRecapture: boolean;
	inCheck: boolean;
}

/** The calibration situation, most specific first. */
export function calibrationSituation(s: SituationInput): TimingCalibrationSituation {
	if (s.isOnlyLegal) return "forced";
	if (s.inBook) return "book";
	if (s.obviousRecapture) return "recapture";
	if (s.inCheck) return "check";
	return "ordinary";
}
