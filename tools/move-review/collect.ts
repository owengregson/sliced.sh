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
 * `labelled` searches the three positions a labelled verdict needs (before the opponent's last
 * move, before the move, after it); `all` searches every position (for over-calling); `list`
 * searches exactly the positions a file names (re-checking a sample at another depth). The output
 * is JSONL, one frame per line, appended; a rerun skips frames already present, so shards can run
 * in parallel processes over disjoint `--games` ranges and be resumed after an interruption.
 * Nothing here runs in the extension.
 */

import "../human-match/defines";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW } from "@core/constants/review";
import { Chess } from "chess.js";
import { createReviewReferee, ROOT } from "./engine";
import {
	type BenchmarkGame,
	brilliantPlies,
	DEFAULT_DATASET,
	type EvidenceFrame,
	readFrames,
	START_FEN,
} from "./evidence";

function arg(name: string): string | undefined {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? undefined : process.argv[at + 1];
}

const out = arg("out");
if (!out) throw new Error("--out <file.jsonl> is required");
const mode = arg("mode") ?? "labelled";
if (!["labelled", "marked", "all", "list", "accept"].includes(mode))
	throw new Error("--mode is labelled, marked, all, list or accept");
// `list`: exactly the `game:index` positions named one per line in `--list <file>`.
// `accept`: `game:index:capture` lines — the position after move `index`, only `capture` searched.
const listed = new Map<number, number[]>();
const accepts = new Map<number, Array<{ index: number; capture: string }>>();
if (mode === "list" || mode === "accept") {
	const file = arg("list");
	if (!file) throw new Error(`--mode ${mode} needs --list <file>`);
	for (const row of (await Bun.file(file).text()).split("\n")) {
		const [gameText, indexText, capture] = row.trim().split(":");
		const game = Number(gameText);
		const index = Number(indexText);
		if (!Number.isInteger(game) || !Number.isInteger(index)) continue;
		if (mode === "accept" && capture)
			accepts.set(game, [...(accepts.get(game) ?? []), { index, capture }]);
		else listed.set(game, [...(listed.get(game) ?? []), index]);
	}
}
const [from, to] = (arg("games") ?? "0-99").split("-").map(Number);
const threads = Number(arg("threads") ?? 4);
const hashMb = Number(arg("hash") ?? 64);
const depth = Number(arg("depth") ?? REVIEW.targetDepth);
const movetimeMs = Number(arg("movetime") ?? REVIEW.movetimeMs);

const datasetText = await Bun.file(arg("dataset") ?? path.join(ROOT, DEFAULT_DATASET)).text();
const games = JSON.parse(datasetText) as BenchmarkGame[];
const datasetSha256 = createHash("sha256").update(datasetText).digest("hex");
const existing = await readFrames(out);
if (
	existing.some(
		(frame) =>
			frame.provenance?.datasetSha256 !== datasetSha256 ||
			frame.provenance?.requestedDepth !== depth ||
			frame.provenance?.movetimeMs !== movetimeMs
	)
)
	throw new Error(
		"Cannot resume evidence with unknown/different dataset or search settings; use a new --out"
	);
const done = new Set(
	existing.map((frame) =>
		frame.accept === undefined
			? `${frame.game}:${frame.index}`
			: `${frame.game}:${frame.index}:${frame.accept}`
	)
);
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
if (existing.some((frame) => JSON.stringify(frame.provenance) !== JSON.stringify(provenance)))
	throw new Error("Cannot resume evidence from a different engine/network/runtime; use a new --out");
// Repair only a interrupted final append, after validating every complete record above.
if (await Bun.file(out).exists()) {
	const text = await Bun.file(out).text();
	if (text.length > 0 && !text.endsWith("\n")) {
		const tail = text.slice(text.lastIndexOf("\n") + 1);
		try {
			JSON.parse(tail);
			await appendFile(out, "\n");
		} catch {
			await Bun.write(out, text.slice(0, text.lastIndexOf("\n") + 1));
		}
	}
}

const started = performance.now();
let searched = 0;
for (let game = from ?? 0; game <= (to ?? games.length - 1) && game < games.length; game++) {
	const entry = games[game];
	if (!entry) continue;
	const replay = new Chess();
	replay.loadPgn(entry.pgn);
	const history = replay.history({ verbose: true });
	const root = history[0]?.before ?? START_FEN;
	const moves = history.map((m) => m.lan);
	// Position `index` is the one before move `index` (0-based); a labelled move is `ply - 1`.
	const plies =
		mode === "marked"
			? [...new Set([...brilliantPlies(entry), ...Object.keys(entry.labels ?? {}).map(Number)])]
			: brilliantPlies(entry);
	const around = plies.flatMap((ply) => [ply - 2, ply - 1, ply]);
	const indices =
		mode === "all"
			? Array.from({ length: moves.length + 1 }, (_, i) => i)
			: [...new Set(mode === "list" ? (listed.get(game) ?? []) : around)]
					.filter((i) => i >= 0 && i <= moves.length)
					.sort((a, b) => a - b);
	// A fresh table per game, as the extension's review engine gets on `ucinewgame`.
	engine.newGame();
	for (const { index, capture } of mode === "accept" ? (accepts.get(game) ?? []) : []) {
		const key = `${game}:${index}:${capture}`;
		if (done.has(key)) continue;
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
			lines: frame.lines.map(({ pvSan: _san, ...line }) => ({ ...line, pvSan: [] })),
		};
		await appendFile(out, `${JSON.stringify(record)}\n`);
		searched += 1;
	}
	for (const index of mode === "accept" ? [] : indices) {
		if (done.has(`${game}:${index}`)) continue;
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
			lines: frame.lines.map(({ pvSan: _san, ...line }) => ({
				...line,
				pvUci: line.pvUci,
				pvSan: [],
			})),
		};
		await appendFile(out, `${JSON.stringify(record)}\n`);
		searched += 1;
	}
	const rate = searched > 0 ? (performance.now() - started) / searched : 0;
	console.log(`game ${game}: ${searched} frames so far, ${Math.round(rate)} ms/frame`);
}
engine.dispose();
process.exit(0);
