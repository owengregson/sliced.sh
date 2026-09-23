/**
 * tools/move-review/score.ts — the move classifier against chess.com's brilliant labels.
 *
 * Reads the frames `collect.ts` wrote and classifies moves with the extension's own
 * `classifyMoveQuality` — the same frames the review engine produces live, the same bundled
 * opening books, the movers' ratings from the PGN headers:
 *
 *   recall       of the 100 moves chess.com badged brilliant, how many the classifier badges;
 *   over-calls   brilliant badges on every other classified move, per 1,000 (Chessigma's metric:
 *                0.7 for its detector, 2.3–4.2 for the other free tools). The benchmark pins one
 *                brilliant per game, so an unlabelled badge may still be a real chess.com one —
 *                read the listed moves before trusting the rate.
 *
 *   bun tools/move-review/score.ts --frames a.jsonl[,b.jsonl…] [--json out.json] [--verbose]
 *        [--set brilliant.trivialAlternative=0.85 --set classification.greatGapExpert=0.2 …]
 *
 * Later `--frames` files win where two hold the same position, so a deeper re-check goes last.
 * The dataset is read from the repository root (the owner's git-ignored local copy).
 *
 * Current SF19 measurements and limitations: docs/qa/sf19-brilliant-review-2026-09-16.md.
 * Unlabelled moves are not verified negatives. The six explicit non-Brilliant PGN marks and
 * the separate constructed controls are reported independently of unconfirmed extra calls.
 * Every new evidence frame pins its dataset, engine binary, full network, and search settings.
 *
 * The parts live in `score/`: overrides, books, frames, the classification tally and the
 * report. Nothing here runs in the extension.
 */

import "../lib/defines";
import path from "node:path";
import { BOOKS } from "@core/constants/books";
import { flagValues, hasFlag } from "../lib/cli";
import { ROOT } from "../lib/paths";
import { loadDataset } from "./dataset";
import { theoryLookup } from "./score/books";
import { classifyGames } from "./score/classify";
import { installedWasmSha256, loadFrameSet } from "./score/frames";
import { printCalls, scoreSummary } from "./score/report";
import { tuningWith } from "./score/tuning";

async function main(argv: readonly string[]): Promise<void> {
	const frameFiles = flagValues(argv, "frames").flatMap((value) => value.split(","));
	if (frameFiles.length === 0) throw new Error("--frames <file.jsonl> is required");
	const tuning = tuningWith(flagValues(argv, "set"));
	const { games, sha256: datasetSha256 } = await loadDataset(flagValues(argv, "dataset")[0]);
	const wasmSha256 = await installedWasmSha256();
	const allowLegacy = hasFlag(argv, "allow-legacy");
	const set = await loadFrameSet(frameFiles, datasetSha256, wasmSha256, allowLegacy);
	// `--books-dir <dir>` scores candidate books without replacing the bundled ones.
	const inBook = await theoryLookup(flagValues(argv, "books-dir")[0] ?? path.join(ROOT, BOOKS.dir));
	const override = flagValues(argv, "rating")[0];
	const tally = classifyGames(games, set, {
		tuning,
		inBook,
		forcedRating: override === undefined ? null : override === "none" ? undefined : Number(override),
	});

	const summary = scoreSummary(tally, set, allowLegacy);
	console.log(JSON.stringify(summary, null, 2));
	if (hasFlag(argv, "verbose")) printCalls(tally);
	const jsonOut = flagValues(argv, "json")[0];
	if (jsonOut)
		await Bun.write(
			jsonOut,
			JSON.stringify(
				{
					summary,
					recalled: tally.recalledCalls,
					missed: tally.missed,
					overCalls: tally.overCalls,
					negativeCalls: tally.negativeCalls,
					tuning,
				},
				null,
				2
			)
		);
}

await main(process.argv);
