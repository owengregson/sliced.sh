/**
 * The one-ply sanity check a scramble hold is released against: does this move leave the moved
 * piece to be taken for less than it is worth? Not a search — a human in time trouble does not
 * search either — just "is the piece I am about to drop simply hanging".
 */

import { loadPosition } from "./fen";
import { PIECE_VALUES, type PieceType } from "./material";
import { playUci } from "./san";

/**
 * `true` when, after `uci`, the opponent can capture the moved piece with a cheaper piece, or take
 * it without any recapture — net of whatever `uci` itself captured. `false` for an illegal move or
 * an unreadable position (the caller checks legality first; this only answers the value question).
 */
export function hangsOutright(fen: string, uci: string): boolean {
	const board = loadPosition(fen);
	if (!board) return false;
	const move = playUci(board, uci);
	if (!move) return false;
	const to = move.to;
	const moved: PieceType = move.promotion ?? move.piece;
	const movedValue = PIECE_VALUES[moved];
	const gained = move.captured ? PIECE_VALUES[move.captured] : 0;
	for (const reply of board.moves({ verbose: true })) {
		if (reply.to !== to || !reply.captured) continue;
		const attackerValue = PIECE_VALUES[reply.piece];
		if (attackerValue < movedValue - gained) return true;
		board.move(reply);
		const recapture = board.moves({ verbose: true }).some((m) => m.to === to && m.captured);
		board.undo();
		if (!recapture && gained < movedValue) return true;
	}
	return false;
}
