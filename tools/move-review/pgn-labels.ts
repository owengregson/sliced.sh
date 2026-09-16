/**
 * tools/move-review/pgn-labels.ts — a benchmark dataset from chess.com Game Review PGNs.
 *
 * A PGN downloaded from chess.com's review carries the classification it drew on the board as a
 * comment on the move: `[%c_effect g2;square;g2;type;Brilliant;…]` (also `GreatFind`, `Blunder`,
 * … and the end-of-game `Winner` / `Checkmate*` / `Resign*` markers, which are not ratings). This
 * reads every such mark into the dataset shape `collect.ts` and `score.ts` take:
 *
 *   { pgn, ply, brilliants: [1-based plies], labels: { "<1-based ply>": "<chess.com type>" } }
 *
 * `ply` is the first brilliant (the Chessigma dataset's field). The marks a download carries are
 * not a full rating of every move — chess.com attaches only some — so a move with no mark is
 * "unlabelled", not "not brilliant".
 *
 *   bun tools/move-review/pgn-labels.ts <games.pgn> <out.json>
 *
 * Nothing here runs in the extension.
 */

import "../human-match/defines";
import { Chess } from "chess.js";
import type { BenchmarkGame } from "./evidence";

/** Board markers that are not a move rating. */
const NOT_RATINGS = /^(Winner|Checkmate|Resign|Draw|Timeout|Abandon)/;

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: pgn-labels.ts <games.pgn> <out.json>");

const text = await Bun.file(input).text();
const games = text
	.split(/\n\s*\n(?=\[Event )/)
	.map((game) => game.trim())
	.filter((game) => game.length > 0);

const dataset: BenchmarkGame[] = [];
for (const pgn of games) {
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
	dataset.push({ pgn, ply: brilliants[0] ?? 0, brilliants, labels });
	console.log(
		`${chess.getHeaders().White} – ${chess.getHeaders().Black}: ${history.length} plies, labels ${JSON.stringify(labels)}`
	);
}
await Bun.write(output, JSON.stringify(dataset, null, 2));
