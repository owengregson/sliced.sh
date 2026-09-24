/**
 * tools/move-review/collect.ts — engine evidence for the move-review benchmark.
 *
 * Replays the games of `chessigma-brilliant-benchmark.json` (100 chess.com games, each with the
 * 1-based ply of one move chess.com's Game Review badged brilliant) and runs Stockfish 19 **full**
 * on positions of each game with the extension's review search shape (`REVIEW`: MultiPV, depth,
 * movetime cap). One frame per position answers both halves of a verdict — the "before" lines of
 * the move played from it and the "after" score of the move that led to it — so classification
 * (`score.ts`) runs offline, as often as a threshold changes, without touching the engine.
 *
 *   bun tools/move-review/collect.ts --out <file.jsonl> [--mode labelled|all|list] [--games 0-99]
 *        [--list <game:index per line>] [--threads 4] [--hash 64] [--depth <REVIEW.targetDepth>]
 *        [--movetime <REVIEW.movetimeMs>]
 *
 * The dataset is the owner's local copy of Chessigma's download, at the repository root and
 * git-ignored; it is not shipped and not versioned here.
 *
 * The modes are described in `collect/plan.ts`. The output is JSONL, one frame per line, appended;
 * a rerun skips frames already present (`collect/resume.ts`). Nothing here runs in the extension.
 */

import "../lib/defines";
import { appendFile } from "node:fs/promises";
import { REVIEW } from "@core/constants/review";
import type { EvalLine } from "@typedefs/engine";
import { Chess } from "chess.js";
import { flagValue } from "../lib/cli";
import { createReviewReferee } from "../lib/engine/review-referee";
import {
	isCollectMode,
	type PositionList,
	parsePositionList,
	positionsToSearch,
} from "./collect/plan";
import {
	assertSameEngine,
	assertSameSettings,
	frameKey,
	repairInterruptedAppend,
} from "./collect/resume";
import { loadDataset, replayGame } from "./dataset";
import { type EvidenceFrame, readFrames } from "./evidence";

/** Evidence keeps UCI PVs only; `score.ts` never reads SAN. */
const withoutSan = (lines: readonly EvalLine[]): EvalLine[] =>
	lines.map(({ pvSan: _san, ...line }) => ({ ...line, pvSan: [] }));

async function main(argv: readonly string[]): Promise<void> {
	const arg = (name: string): string | undefined => flagValue(argv, name);
	const out = arg("out");
	if (!out) throw new Error("--out <file.jsonl> is required");
	const mode = arg("mode") ?? "labelled";
	if (!isCollectMode(mode)) throw new Error("--mode is labelled, marked, all, list or accept");
	let positions: PositionList = { listed: new Map(), accepts: new Map() };
	if (mode === "list" || mode === "accept") {
		const file = arg("list");
		if (!file) throw new Error(`--mode ${mode} needs --list <file>`);
		positions = parsePositionList(await Bun.file(file).text(), mode);
	}
	const [from, to] = (arg("games") ?? "0-99").split("-").map(Number);
	const threads = Number(arg("threads") ?? 4);
	const hashMb = Number(arg("hash") ?? 64);
	const depth = Number(arg("depth") ?? REVIEW.targetDepth);
	const movetimeMs = Number(arg("movetime") ?? REVIEW.movetimeMs);

	const { games, sha256: datasetSha256 } = await loadDataset(arg("dataset"));
	const existing = await readFrames(out);
	assertSameSettings(existing, datasetSha256, depth, movetimeMs);
	const done = new Set(existing.map(frameKey));
	const engine = await createReviewReferee({
		variant: "full",
		threads,
		hashMb,
		timeoutMs: 60_000,
		newGameEachSearch: false,
	});
	const provenance = {
		...engine.provenance,
		datasetSha256,
		requestedDepth: depth,
		movetimeMs,
		multiPv: mode === "accept" ? 1 : REVIEW.multiPv,
	};
	assertSameEngine(existing, provenance);
	await repairInterruptedAppend(out);

	const started = performance.now();
	let searched = 0;
	for (let game = from ?? 0; game <= (to ?? games.length - 1) && game < games.length; game++) {
		const entry = games[game];
		if (!entry) continue;
		const { root, moves } = replayGame(entry);
		const indices = positionsToSearch(mode, entry, moves.length, positions.listed.get(game));
		// A fresh table per game, as the extension's review engine gets on `ucinewgame`.
		engine.newGame();
		for (const { index, capture } of mode === "accept" ? (positions.accepts.get(game) ?? []) : []) {
			if (done.has(frameKey({ game, index, accept: capture }))) continue;
			const board = new Chess(root);
			for (const move of moves.slice(0, index + 1)) board.move(move);
			const frame = await engine.search({
				fen: root,
				moves: moves.slice(0, index + 1),
				movetimeMs,
				depth,
				multiPv: 1,
				searchmoves: [capture],
			});
			const record: EvidenceFrame = {
				provenance: { ...provenance, multiPv: 1 },
				game,
				index,
				accept: capture,
				fen: board.fen(),
				depth: frame.depth,
				complete: frame.complete,
				elapsedMs: Math.round(frame.elapsedMs),
				lines: withoutSan(frame.lines),
			};
			await appendFile(out, `${JSON.stringify(record)}\n`);
			searched += 1;
		}
		for (const index of indices) {
			if (done.has(frameKey({ game, index }))) continue;
			const board = new Chess(root);
			for (const move of moves.slice(0, index)) board.move(move);
			if (board.isGameOver()) continue;
			const frame = await engine.search({
				fen: root,
				moves: moves.slice(0, index),
				movetimeMs,
				depth,
				multiPv: REVIEW.multiPv,
			});
			const record: EvidenceFrame = {
				provenance,
				game,
				index,
				fen: board.fen(),
				depth: frame.depth,
				complete: frame.complete,
				elapsedMs: Math.round(frame.elapsedMs),
				lines: withoutSan(frame.lines),
			};
			await appendFile(out, `${JSON.stringify(record)}\n`);
			searched += 1;
		}
		const rate = searched > 0 ? (performance.now() - started) / searched : 0;
		console.log(`game ${game}: ${searched} frames so far, ${Math.round(rate)} ms/frame`);
	}
	engine.dispose();
	process.exit(0);
}

await main(process.argv);
