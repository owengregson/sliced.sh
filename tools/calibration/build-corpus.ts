/**
 * tools/calibration/build-corpus.ts — turn the crawled chess.com games into per-move rows.
 *
 *     bun tools/calibration/build-corpus.ts
 *     bun tools/calibration/build-corpus.ts --games FILE --samples FILE --out FILE --summary FILE
 *
 * Reads `data/calibration/games.jsonl` and `samples.jsonl` (written by `crawl-chesscom.ts`) and
 * writes `corpus.jsonl`: one row per own move of every sampled (game, side), for plies ≥ 16 (the
 * product plays book moves in the opening) and positions with at least two legal moves. The row
 * is a superset of `CorpusRow` in `tools/human-match/replay.ts` (same field names), so the replay
 * can read it directly. `corpus-summary.json` holds the sides / positions table per
 * (time class, bucket, split).
 *
 * Clock notes (chess.com PGN): the n-th `[%clk]` is the mover's clock **after** ply n; the clock
 * runs from the first move, so a side's first think is `base − clk + inc`.
 *
 * The parts live in `build-corpus/`: the PGN reader and replay, the rows of one sampled side, and
 * the summary tally.
 */

import { writeFileSync } from "node:fs";
import { flagOr } from "../lib/cli";
import { readJsonl } from "../lib/jsonl";
import { rowsForSample, splitFor, windowOf } from "./build-corpus/rows";
import { CorpusTally } from "./build-corpus/summary";
import { PATHS, type Sample, type StoredGame } from "./common";

export {
	historyWindow,
	type ParsedPgn,
	parseClockMs,
	parsePgn,
	type ReplayedGame,
	replaySans,
	toUci,
} from "./build-corpus/pgn";
export {
	type CalibrationRow,
	MIN_PLY,
	rowsForSample,
	type SampleContext,
	type Split,
	splitFor,
	windowOf,
} from "./build-corpus/rows";

function main(): void {
	const argv = process.argv.slice(2);
	const gamesFile = flagOr(argv, "games", PATHS.games);
	const samplesFile = flagOr(argv, "samples", PATHS.samples);
	const outFile = flagOr(argv, "out", PATHS.corpus);
	const summaryFile = flagOr(argv, "summary", PATHS.corpusSummary);
	// Samples listed in `--full` keep every own move; the rest keep a contiguous window of
	// `--window` own moves (0 = all), so more games fit the same engine budget — between-game
	// variation dominates the calibration's uncertainty, so games are worth more than moves.
	const window = Number(flagOr(argv, "window", "0"));
	const fullFile = flagOr(argv, "full", "");
	const full = new Set(
		fullFile ? readJsonl<Sample>(fullFile).map((s) => `${s.uuid}:${s.side}`) : []
	);

	const games = new Map<string, StoredGame>();
	for (const g of readJsonl<StoredGame>(gamesFile)) games.set(g.uuid, g);
	const samples = readJsonl<Sample>(samplesFile);

	const tally = new CorpusTally();
	const chunks: string[] = [];
	let missing = 0;
	let unreplayable = 0;
	let rowsTotal = 0;
	for (const s of samples) {
		const g = games.get(s.uuid);
		if (!g) {
			missing++;
			continue;
		}
		const self = s.side === "w" ? g.white : g.black;
		const opp = s.side === "w" ? g.black : g.white;
		const allRows = rowsForSample(g.pgn, {
			uuid: s.uuid,
			side: s.side,
			tc: s.tc,
			bucket: s.bucket,
			player: s.player,
			selfElo: self.rating,
			oppoElo: opp.rating,
			timeControl: g.time_control,
		});
		const rows =
			window > 0 && !full.has(`${s.uuid}:${s.side}`)
				? windowOf(allRows, window, `${s.uuid}:${s.side}`)
				: allRows;
		if (rows.length === 0) {
			unreplayable++;
			continue;
		}
		tally.add(s.tc, s.bucket, splitFor(s.player), rows.length);
		for (const r of rows) chunks.push(JSON.stringify(r));
		rowsTotal += rows.length;
	}
	writeFileSync(outFile, chunks.length > 0 ? `${chunks.join("\n")}\n` : "");
	writeFileSync(
		summaryFile,
		`${JSON.stringify({ rows: rowsTotal, samples: samples.length, missing, unreplayable, cells: tally.table() }, null, "\t")}\n`
	);

	console.log(
		`${rowsTotal} rows from ${samples.length} samples (${missing} missing games, ${unreplayable} with no rows)`
	);
	for (const line of tally.lines()) console.log(line);
}

if (import.meta.main) {
	main();
}
