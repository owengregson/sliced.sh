/** Board and PV facts the heuristic prior's rules read. Pure. */

import { loadPosition } from "@core/chess/fen";
import { material, type PieceType } from "@core/chess/material";
import { applyMoves, legalMoves, playUci } from "@core/chess/san";
import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import type { Color, Square } from "@typedefs/game";
import type { Chess } from "chess.js";
import { SELECTION_CONSTANTS as C } from "../constants";

/** One PV ply after the candidate move; `matDiff` is our material balance change from the root. */
export interface PvPly {
	from: Square;
	to: Square;
	isCapture: boolean;
	matDiff: number;
}

export const WAITING_MOVES: Record<Color, readonly string[]> = {
	w: ["a2a3", "h2h3"],
	b: ["a7a6", "h7h6"],
};

export function isMinor(p: PieceType): boolean {
	return p === "n" || p === "b";
}

export function relRank(sq: Square, us: Color): number {
	return us === "w" ? rankOf(sq) : 7 - rankOf(sq);
}

export function walkPv(fen: string, pv: readonly string[], window: number): PvPly[] {
	const chess = loadPosition(fen);
	if (!chess) return [];
	const sign = chess.turn() === "w" ? 1 : -1;
	const start = material(chess.fen())?.diff ?? 0;
	const out: PvPly[] = [];
	for (let i = 0; i < Math.min(pv.length, window); i++) {
		const uci = pv[i];
		if (uci === undefined) break;
		const m = playUci(chess, uci);
		if (!m) break;
		const diff = material(chess.fen())?.diff ?? start;
		out.push({
			from: m.from,
			to: m.to,
			isCapture: m.isCapture() || m.isEnPassant(),
			matDiff: sign * (diff - start),
		});
	}
	return out;
}

export function findKing(chess: Chess, color: Color): Square | null {
	const squares = chess.findPiece({ type: "k", color });
	return squares[0] ?? null;
}

export function hasQueen(chess: Chess, color: Color): boolean {
	return chess.findPiece({ type: "q", color }).length > 0;
}

/** After our capture on `to`, can the opponent legally recapture there? */
export function isDefended(fen: string, uci: string, to: Square): boolean {
	const after = applyMoves(fen, [uci]);
	if (after === null) return true;
	return legalMoves(after).some((m) => m.slice(2, 4) === to);
}

/** Does the file of `sq` hold pawns of both colours? */
export function isClosedFile(chess: Chess, sq: Square): boolean {
	const file = fileOf(sq);
	let white = false;
	let black = false;
	for (let r = 0; r < 8; r++) {
		const s = squareOf(file, r);
		const piece = s ? chess.get(s) : undefined;
		if (piece?.type !== "p") continue;
		if (piece.color === "w") white = true;
		else black = true;
	}
	return white && black;
}

/** Does a pawn of `us` on `to` attack an enemy non-pawn piece? */
export function pawnThreatens(chess: Chess, to: Square, us: Color): boolean {
	const dir = us === "w" ? 1 : -1;
	for (const df of [-1, 1]) {
		const s = squareOf(fileOf(to) + df, rankOf(to) + dir);
		const piece = s ? chess.get(s) : undefined;
		if (piece && piece.color !== us && piece.type !== "p") return true;
	}
	return false;
}

/** PV shows us down ≥ `sacrificeMaterial` for ≥ `sacrificePlies` consecutive plies. */
export function isSacrifice(pv: readonly PvPly[]): boolean {
	let run = 0;
	for (let i = 1; i < pv.length; i++) {
		const ply = pv[i];
		if (ply !== undefined && ply.matDiff <= -C.prior.sacrificeMaterial) {
			run++;
			if (run >= C.prior.sacrificePlies) return true;
		} else run = 0;
	}
	return false;
}
