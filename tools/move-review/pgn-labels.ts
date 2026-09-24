/**
 * tools/move-review/pgn-labels.ts — a benchmark dataset from chess.com Game Review PGNs.
 *
 * Reads every review mark of every game (`labels.ts`) into the dataset shape `collect.ts` and
 * `score.ts` take:
 *
 *   { pgn, ply, brilliants: [1-based plies], labels: { "<1-based ply>": "<chess.com type>" } }
 *
 *   bun tools/move-review/pgn-labels.ts <games.pgn> <out.json>
 *
 * Nothing here runs in the extension.
 */

import "../lib/defines";
import { splitGamesTrimmed } from "../lib/pgn/split";
import type { BenchmarkGame } from "./evidence";
import { labelledGame } from "./labels";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: pgn-labels.ts <games.pgn> <out.json>");

const dataset: BenchmarkGame[] = [];
for (const pgn of splitGamesTrimmed(await Bun.file(input).text())) {
	const game = labelledGame(pgn);
	dataset.push(game.entry);
	console.log(
		`${game.white} – ${game.black}: ${game.plies} plies, labels ${JSON.stringify(game.entry.labels)}`
	);
}
await Bun.write(output, JSON.stringify(dataset, null, 2));
