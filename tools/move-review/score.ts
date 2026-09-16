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
 * Nothing here runs in the extension.
 */

import "../human-match/defines";
import { createHash } from "node:crypto";
import path from "node:path";
import { BOOKS, THEORY_BOOKS } from "@core/constants/books";
import { ENGINE_DIR, ENGINE_FILES } from "@core/constants/engine-files";
import {
	classifyMoveQuality,
	DEFAULT_MOVE_QUALITY_TUNING,
	type MoveQualityTuning,
	passedBrilliantGates,
	type ReviewFrame,
} from "@core/engine/move-quality";
import { theoryMoves } from "@core/strength/book/book-policy";
import { loadBook, type PolyglotBook } from "@core/strength/book/polyglot";
import { Chess } from "chess.js";
import { ROOT } from "./engine";
import {
	assertFrameProvenance,
	type BenchmarkGame,
	brilliantPlies,
	DEFAULT_DATASET,
	type EvidenceFrame,
	readFrames,
} from "./evidence";

function args(name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < process.argv.length; i++)
		if (process.argv[i] === `--${name}` && process.argv[i + 1] !== undefined)
			values.push(process.argv[i + 1] as string);
	return values;
}

const frameFiles = args("frames").flatMap((value) => value.split(","));
if (frameFiles.length === 0) throw new Error("--frames <file.jsonl> is required");

const tuning: MoveQualityTuning = {
	classification: { ...DEFAULT_MOVE_QUALITY_TUNING.classification },
	brilliant: { ...DEFAULT_MOVE_QUALITY_TUNING.brilliant },
};
for (const assignment of args("set")) {
	const [key, value] = assignment.split("=");
	const [group, field] = (key ?? "").split(".");
	const target = tuning[group as keyof MoveQualityTuning] as Record<string, number> | undefined;
	if (!target || field === undefined || !(field in target) || !Number.isFinite(Number(value)))
		throw new Error(`--set ${assignment}: unknown field or value`);
	target[field] = Number(value);
}

const datasetText = await Bun.file(args("dataset")[0] ?? path.join(ROOT, DEFAULT_DATASET)).text();
const games = JSON.parse(datasetText) as BenchmarkGame[];
const datasetSha256 = createHash("sha256").update(datasetText).digest("hex");
const wasmSha256 = createHash("sha256")
	.update(
		new Uint8Array(await Bun.file(path.join(ROOT, ENGINE_DIR, ENGINE_FILES.full.wasm)).arrayBuffer())
	)
	.digest("hex");
const frames = new Map<string, EvidenceFrame>();
const provenance = new Map<string, NonNullable<EvidenceFrame["provenance"]>>();
const allowLegacy = process.argv.includes("--allow-legacy");
for (const file of frameFiles)
	for (const frame of await readFrames(file)) {
		// Restricted acceptance probes are not position evaluations and never replace them.
		if (frame.accept !== undefined) continue;
		const source = frame.provenance;
		assertFrameProvenance(frame, datasetSha256, wasmSha256, allowLegacy);
		if (source) provenance.set(JSON.stringify(source), source);
		frames.set(`${frame.game}:${frame.index}`, frame);
	}

// `--books-dir <dir>` scores candidate books without replacing the bundled ones.
const booksDir = args("books-dir")[0] ?? path.join(ROOT, BOOKS.dir);
const readBook = async (name: string): Promise<PolyglotBook | null> => {
	const file = Bun.file(path.join(booksDir, name));
	return (await file.exists()) ? loadBook(new Uint8Array(await file.arrayBuffer())) : null;
};
const books = await Promise.all(THEORY_BOOKS.map((name) => readBook(BOOKS[name])));
// The live review's own rule (`BookPolicy.bookMoves`).
const inBook = (fen: string, uci: string): boolean =>
	theoryMoves(...books.map((book) => book?.lookup(fen) ?? [])).includes(uci);

const header = (pgn: string, tag: string): number | undefined => {
	const value = new RegExp(`\\[${tag} "(\\d+)"\\]`).exec(pgn)?.[1];
	return value === undefined ? undefined : Number(value);
};

const frameOf = (game: number, index: number): ReviewFrame | undefined => {
	const frame = frames.get(`${game}:${index}`);
	return frame ? { lines: frame.lines, depth: frame.depth, complete: frame.complete } : undefined;
};

interface Called {
	game: number;
	ply: number;
	san: string;
	rating: number | undefined;
	reason?: string;
	loss?: number;
	played?: number;
	alternative?: number;
	/** `shape:concession` of every offer the gates saw. */
	offers?: string[];
}

const distribution: Record<string, number> = {};
const labelledQualities: Record<string, number> = {};
const labelledReasons: Record<string, number> = {};
const missed: Called[] = [];
const overCalls: Called[] = [];
const recalledCalls: Called[] = [];
/** chess.com's other marks (`GreatFind`, `Blunder`, …) next to the classifier's rating. */
const marks: Array<{ game: number; ply: number; san: string; chesscom: string; ours: string }> = [];
let labelledTotal = 0;
let recalled = 0;
let labelledClassified = 0;
let otherClassified = 0;
let unclassified = 0;
let negativeClassified = 0;
let falsePositives = 0;
let missingFrames = 0;
const negativeCalls: Called[] = [];

for (const [game, entry] of games.entries()) {
	const replay = new Chess();
	replay.loadPgn(entry.pgn);
	const history = replay.history({ verbose: true });
	// `--rating none|<elo>` grades every mover at that rating instead of the PGN's (what the live
	// reporter does when the page reports no rating, or the opponent's for both sides).
	const override = args("rating")[0];
	const forced = override === undefined ? null : override === "none" ? undefined : Number(override);
	const ratings =
		forced === null
			? { w: header(entry.pgn, "WhiteElo"), b: header(entry.pgn, "BlackElo") }
			: { w: forced, b: forced };
	const brilliants = new Set(brilliantPlies(entry));
	/** 0-based indices whose move passed every brilliant gate (the live reporter's window). */
	const sacrifices = new Set<number>();
	labelledTotal += brilliants.size;
	for (const [index, move] of history.entries()) {
		const before = frameOf(game, index);
		if (!before) {
			missingFrames += 1;
			continue;
		}
		if (frames.get(`${game}:${index}`)?.fen !== move.before)
			throw new Error(`Position mismatch ${game}:${index}`);
		const labelled = brilliants.has(index + 1);
		const uci = move.from + move.to + (move.promotion ?? "");
		const verdict = classifyMoveQuality(
			{
				fen: move.before,
				uci,
				before,
				after: frameOf(game, index + 1),
				previous: frameOf(game, index - 1),
				moverRating: ratings[move.color],
				inBook: inBook(move.before, uci),
				recentSacrifice: Array.from(
					{ length: Math.floor(tuning.brilliant.sequencePlies / 2) },
					(_, k) => index - 2 * (k + 1)
				).some((earlier) => sacrifices.has(earlier)),
			},
			tuning
		);
		if (!verdict) {
			unclassified += 1;
			continue;
		}
		if (passedBrilliantGates(verdict)) sacrifices.add(index);
		const call: Called = {
			game,
			ply: index + 1,
			san: move.san,
			rating: ratings[move.color],
			loss: Number(verdict.loss.toFixed(3)),
			played: Number(verdict.playedPoints.toFixed(3)),
			...(verdict.brilliant ? { reason: verdict.brilliant.reason } : {}),
			...(verdict.brilliant
				? { offers: verdict.brilliant.offers.map((o) => `${o.shape}:${o.concession}`) }
				: {}),
		};
		distribution[verdict.quality] = (distribution[verdict.quality] ?? 0) + 1;
		const mark = entry.labels?.[String(index + 1)];
		if (mark !== undefined && mark !== "Brilliant")
			marks.push({ game, ply: index + 1, san: move.san, chesscom: mark, ours: verdict.quality });
		// The brilliant signal is the gates' answer: a sound sacrifice that also starts a forced mate
		// is rated `mate` on the board, but chess.com still badges it brilliant.
		const badged = verdict.brilliant?.brilliant === true && verdict.quality !== "book";
		if (mark !== undefined && mark !== "Brilliant") {
			negativeClassified += 1;
			if (badged) {
				falsePositives += 1;
				negativeCalls.push(call);
			}
		}
		if (labelled) {
			labelledClassified += 1;
			labelledQualities[verdict.quality] = (labelledQualities[verdict.quality] ?? 0) + 1;
			const reason = verdict.brilliant?.reason ?? "no-offer";
			labelledReasons[reason] = (labelledReasons[reason] ?? 0) + 1;
			if (badged) {
				recalled += 1;
				recalledCalls.push(call);
			} else missed.push(call);
		} else {
			otherClassified += 1;
			if (badged) overCalls.push(call);
		}
	}
}

const summary = {
	provenance: [...provenance.values()],
	legacyEvidenceAllowed: allowLegacy,
	frames: frames.size,
	labelled: { classified: labelledClassified, brilliant: recalled, of: labelledTotal },
	labelledQualities,
	labelledReasons,
	others: {
		meaning: "Unpinned moves, NOT verified negatives; extra calls here do not measure precision.",
		classified: otherClassified,
		brilliant: overCalls.length,
		per1000:
			otherClassified > 0 ? Number(((overCalls.length * 1000) / otherClassified).toFixed(2)) : null,
	},
	unclassified,
	missingFrames,
	verifiedNegatives: {
		classified: negativeClassified,
		falsePositives,
		trueNegatives: negativeClassified - falsePositives,
	},
	distribution,
	...(marks.length > 0 ? { marks } : {}),
};
console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes("--verbose")) {
	console.log(
		"missed:",
		missed
			.map(
				(c) =>
					`${c.game}/${c.ply} ${c.san} (${c.rating}) ${c.reason ?? "no-offer"} loss=${c.loss} after=${c.played}`
			)
			.join("\n  ")
	);
	console.log(
		"over-calls:",
		overCalls
			.map((c) => `${c.game}/${c.ply} ${c.san} (${c.rating}) loss=${c.loss} after=${c.played}`)
			.join("\n  ")
	);
}
const jsonOut = args("json")[0];
if (jsonOut)
	await Bun.write(
		jsonOut,
		JSON.stringify(
			{ summary, recalled: recalledCalls, missed, overCalls, negativeCalls, tuning },
			null,
			2
		)
	);
