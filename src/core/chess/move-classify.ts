/**
 * Tactical/structural facts about a single move (Task 5) — the input to the
 * heuristic prior table (Appendix E §3.4).
 */

import { loadPosition } from "./fen";
import type { PieceType } from "./material";
import { parseUci, playUci, type Uci } from "./san";

export interface MoveClassification {
	isCapture: boolean;
	/** `true` when the move captures on the square `prevMove` just landed on. */
	isRecapture: boolean;
	isCheck: boolean;
	isCastle: boolean;
	isPromotion: boolean;
	/** The side to move had exactly one legal move. */
	isOnlyMove: boolean;
	pieceType: PieceType;
	capturedType: PieceType | null;
	givesMate: boolean;
}

/**
 * Classify `uci` played from `fen`. `prevMove` is the opponent's last move
 * (UCI); a capture on its destination square counts as a recapture.
 * Returns `null` for an invalid FEN or an illegal move.
 */
export function classifyMove(fen: string, uci: Uci, prevMove?: Uci): MoveClassification | null {
	const chess = loadPosition(fen);
	if (!chess) return null;
	const isOnlyMove = chess.moves().length === 1;
	const move = playUci(chess, uci);
	if (!move) return null;
	const isCapture = move.isCapture() || move.isEnPassant();
	const prevTo = prevMove === undefined ? null : (parseUci(prevMove)?.to ?? null);
	return {
		isCapture,
		isRecapture: isCapture && prevTo !== null && prevTo === move.to,
		isCheck: chess.inCheck(),
		isCastle: move.isKingsideCastle() || move.isQueensideCastle(),
		isPromotion: move.isPromotion(),
		isOnlyMove,
		pieceType: move.piece,
		capturedType: move.captured ?? null,
		givesMate: chess.isCheckmate(),
	};
}
