import { CHESS_START_FEN } from "@core/constants/chess";
import type { Chess } from "chess.js";
import { loadPosition } from "./fen";
import { playUci } from "./san";

/** A validated starting position and the actual moves played from it. */
export interface PositionHistory {
	fen: string;
	moves: string[];
}

/** Repetition identity includes turn, castling and only a legally usable en-passant square. */
export function positionKey(fen: string): string {
	return (loadPosition(fen)?.fen() ?? fen).trim().split(/\s+/).slice(0, 4).join(" ");
}

export function replayHistory(history: PositionHistory): Chess | null {
	const chess = loadPosition(history.fen);
	if (!chess) return null;
	for (const move of history.moves) if (!playUci(chess, move)) return null;
	return chess;
}

/** Refuse stale/incomplete move lists instead of searching a position other than the board. */
export function matchingHistory(
	history: PositionHistory | undefined | null,
	fen: string
): PositionHistory | null {
	if (!history) return null;
	const replay = replayHistory(history);
	return replay && replay.fen() === loadPosition(fen)?.fen()
		? { fen: history.fen, moves: [...history.moves] }
		: null;
}

/** Recover a game's history on reconnect only if the complete SAN replay matches the board. */
export function historyFromSan(sans: readonly string[], fen: string): PositionHistory | null {
	const chess = loadPosition(CHESS_START_FEN);
	if (!chess) return null;
	const moves: string[] = [];
	for (const san of sans) {
		try {
			const move = chess.move(san, { strict: false });
			moves.push(`${move.from}${move.to}${move.promotion ?? ""}`);
		} catch {
			return null;
		}
	}
	return chess.fen() === loadPosition(fen)?.fen() ? { fen: CHESS_START_FEN, moves } : null;
}

/**
 * Cache identity keeps the fifty-move clock and all reversible positions. A pawn move,
 * capture or castling-rights loss discards unreachable history, preserving useful cache hits.
 */
export function historyKey(fen: string, moves: readonly string[] = []): string | null {
	const chess = loadPosition(fen);
	if (!chess) return moves.length === 0 ? `${positionKey(fen)}|${fen.split(/\s+/)[4] ?? "0"}` : null;
	let positions = [positionKey(chess.fen())];
	for (const uci of moves) {
		const rights = chess.fen().split(" ")[2];
		const move = playUci(chess, uci);
		if (!move) return null;
		if (move.piece === "p" || move.captured || chess.fen().split(" ")[2] !== rights) positions = [];
		positions.push(positionKey(chess.fen()));
	}
	return `${positionKey(chess.fen())}|${chess.fen().split(" ")[4]}|${positions.sort().join(";")}`;
}
