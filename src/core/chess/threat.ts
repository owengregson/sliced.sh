/**
 * The "basically forced" reply (owner, 2026-09-13): the opponent attacks a piece of ours with a
 * piece worth less — a pawn on a knight, a knight on a rook — so the piece has to move (or the
 * attacker has to go). Pure chess.js reading of the position to move in.
 */

import { loadPosition } from "@core/chess/fen";
import { PIECE_VALUES, type PieceType } from "@core/chess/material";
import { parseUci } from "@core/chess/san";
import type { Color, Square } from "@typedefs/game";

export interface CheapThreat {
	/** Our piece under attack. */
	attacked: Square;
	/** The cheaper enemy piece attacking it. */
	attacker: Square;
	attackedValue: number;
	attackerValue: number;
}

/**
 * Every piece of the side to move attacked by an enemy piece of strictly lower value. Kings are
 * left out (a check is a different regime), and so are pawns (nothing is cheaper).
 */
export function cheapThreats(fen: string): CheapThreat[] {
	const chess = loadPosition(fen);
	if (!chess) return [];
	const us: Color = chess.turn();
	const them: Color = us === "w" ? "b" : "w";
	const out: CheapThreat[] = [];
	for (const row of chess.board()) {
		for (const cell of row) {
			if (!cell || cell.color !== us || cell.type === "k" || cell.type === "p") continue;
			const attackedValue = PIECE_VALUES[cell.type as PieceType];
			for (const from of chess.attackers(cell.square, them)) {
				const attacker = chess.get(from);
				if (!attacker) continue;
				const attackerValue = PIECE_VALUES[attacker.type as PieceType];
				if (attackerValue < attackedValue)
					out.push({ attacked: cell.square, attacker: from, attackedValue, attackerValue });
			}
		}
	}
	return out;
}

/** The cheap threat `uci` answers — moving the attacked piece, or taking the attacker — if any. */
export function threatAnswered(fen: string, uci: string): CheapThreat | null {
	const parts = parseUci(uci);
	if (!parts) return null;
	for (const threat of cheapThreats(fen)) {
		if (parts.from === threat.attacked || parts.to === threat.attacker) return threat;
	}
	return null;
}
