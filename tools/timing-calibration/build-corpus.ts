/**
 * tools/timing-calibration/build-corpus.ts — chess.com games → per-move human think times with
 * situation labels.
 *
 *     bun tools/timing-calibration/build-corpus.ts [--games FILE] [--out FILE] [--labels FILE]
 *
 * Reads a `games.jsonl` in the crawl format (`tools/calibration/common.ts` `StoredGame`) and
 * writes
 *
 *   corpus.jsonl   one `CorpusGame` per game (both sides; moves, positions, per-ply labels)
 *   labels.jsonl   one `LabelRow` per (game, ply) — the finetuner's join table (README beside it)
 *   corpus-summary.json   rows per time class × band × split × situation
 *
 * Clock semantics (chess.com PGN): the n-th `[%clk]` is the mover's clock **after** ply n,
 * increment included; so `think = clock before − clock after + increment`, and a side's first
 * move reads its "clock before" as the base (flagged `first`: the site does not run the clock
 * the same way on move one). A premove is recorded as a 0.1 s tick. Lag compensation is folded
 * into the recorded clocks and cannot be separated.
 *
 * The **book** label is what the bot itself knows: the move is in the Polyglot book the product
 * would consult for a player of this rating (`bookOrderFor(E)`: the first book that knows the
 * position, moves with weight share ≥ `BOOK.minWeightShare`), at ply ≤ `BOOK.maxPly`, E ≤
 * `MAIA.eloMax` — the same rules as `createBookPolicy().bookMove` minus the random draw.
 *
 * Parts: `build-corpus/books.ts` (the book questions), `build-corpus/labels.ts` (one game to its
 * corpus record and label rows). `build_corpus.py` is the fast path of the same rules.
 */

import "../lib/defines";
import type { StoredGame } from "../calibration/common";
import { flagValue } from "../lib/cli";
import { loadBooks } from "./build-corpus/books";
import { corpusGame, labelOf } from "./build-corpus/labels";
import { JsonlWriter, PATHS, readJsonl } from "./common";

export { type BookSet, botBookMoves, loadBooks, theoryMovesAt } from "./build-corpus/books";
export { corpusGame, type GameInput, labelOf, situationOf } from "./build-corpus/labels";

const TIME_CLASSES = new Set(["bullet", "blitz", "rapid"]);

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const gamesFile = flagValue(argv, "games", PATHS.games) ?? PATHS.games;
	const outFile = flagValue(argv, "out", PATHS.corpus) ?? PATHS.corpus;
	const labelsFile = flagValue(argv, "labels", PATHS.labels) ?? PATHS.labels;
	const summaryFile = flagValue(argv, "summary", PATHS.summary) ?? PATHS.summary;
	// `--shard k/n`: only games whose index ≡ k (mod n); run n processes and `cat` the outputs.
	const [shardK, shardN] = (flagValue(argv, "shard", "0/1") ?? "0/1").split("/").map(Number);
	let index = -1;
	const books = await loadBooks();
	const corpus = new JsonlWriter(outFile);
	const labels = new JsonlWriter(labelsFile);
	const summary = new Map<string, number>();
	const seen = new Set<string>();
	let games = 0;
	let skipped = 0;
	let rows = 0;
	for await (const g of readJsonl<StoredGame & { tc?: string }>(gamesFile)) {
		if (seen.has(g.uuid)) continue;
		seen.add(g.uuid);
		index++;
		if (shardN !== undefined && shardN > 1 && index % shardN !== shardK) continue;
		const tc = g.time_class;
		if (!TIME_CLASSES.has(tc)) {
			skipped++;
			continue;
		}
		const game = corpusGame(
			{ uuid: g.uuid, tc, control: g.time_control, white: g.white, black: g.black, pgn: g.pgn },
			books
		);
		if (!game) {
			skipped++;
			continue;
		}
		corpus.write(game);
		for (const l of labelOf(game)) {
			labels.write(l);
			rows++;
			const key = `${l.tc}\t${Math.floor(l.rating / 100) * 100}\t${l.split}\t${l.situation}`;
			summary.set(key, (summary.get(key) ?? 0) + 1);
		}
		games++;
		if (games % 1000 === 0) process.stderr.write(`${games} games, ${rows} rows\n`);
	}
	await corpus.close();
	await labels.close();
	const cells = [...summary.entries()]
		.map(([k, n]) => {
			const [tc, band, split, situation] = k.split("\t");
			return { tc, band: Number(band), split, situation, rows: n };
		})
		.sort((a, b) =>
			`${a.tc}${a.band}${a.split}${a.situation}`.localeCompare(
				`${b.tc}${b.band}${b.split}${b.situation}`
			)
		);
	await Bun.write(
		summaryFile,
		`${JSON.stringify({ source: gamesFile, games, skipped, rows, cells }, null, "\t")}\n`
	);
	console.log(
		`${games} games (${skipped} skipped), ${rows} labelled plies → ${outFile}, ${labelsFile}`
	);
}

if (import.meta.main) await main();
