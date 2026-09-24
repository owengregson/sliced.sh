/**
 * tools/move-review/labels.ts — the benchmark entry of one chess.com Game Review PGN.
 *
 * A PGN downloaded from chess.com's review carries the classification it drew on the board as a
 * comment on the move: `[%c_effect g2;square;g2;type;Brilliant;…]` (also `GreatFind`, `Blunder`,
 * … and the end-of-game `Winner` / `Checkmate*` / `Resign*` markers, which are not ratings). The
 * marks a download carries are not a full rating of every move — chess.com attaches only some —
 * so a move with no mark is "unlabelled", not "not brilliant".
 */

import { Chess } from "chess.js";
import type { BenchmarkGame } from "./evidence";

/** Board markers that are not a move rating. */
const NOT_RATINGS = /^(Winner|Checkmate|Resign|Draw|Timeout|Abandon)/;

export interface LabelledGame {
	entry: BenchmarkGame;
	white: string | undefined;
	black: string | undefined;
	plies: number;
}

/** `{ pgn, ply, brilliants, labels }` — `ply` is the first brilliant (the Chessigma field). */
export function labelledGame(pgn: string): LabelledGame {
	const chess = new Chess();
	chess.loadPgn(pgn);
	const history = chess.history({ verbose: true });
	// chess.js keys a comment by the position the move produced.
	const plyOfFen = new Map<string, number>();
	for (const [index, move] of history.entries())
		if (!plyOfFen.has(move.after)) plyOfFen.set(move.after, index + 1);
	const labels: Record<string, string> = {};
	for (const { fen, comment } of chess.getComments()) {
		const ply = plyOfFen.get(fen);
		if (ply === undefined) continue;
		for (const effect of comment.matchAll(/\[%c_effect\s+([^\]]*)\]/g))
			for (const entry of (effect[1] ?? "").split(",")) {
				const type = /;type;([A-Za-z]+)/.exec(entry)?.[1];
				if (type && !NOT_RATINGS.test(type)) labels[String(ply)] = type;
			}
	}
	const brilliants = Object.entries(labels)
		.filter(([, type]) => type === "Brilliant")
		.map(([ply]) => Number(ply))
		.sort((a, b) => a - b);
	return {
		entry: { pgn, ply: brilliants[0] ?? 0, brilliants, labels },
		white: chess.getHeaders().White,
		black: chess.getHeaders().Black,
		plies: history.length,
	};
}
