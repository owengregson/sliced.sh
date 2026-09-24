/**
 * tools/timing-calibration/heads.ts — the ChessMimic bucket distributions of every replayed row.
 *
 *     bun tools/timing-calibration/heads.ts --emit          # → heads-requests.jsonl
 *     tools/data/.venv/bin/python tools/timing-calibration/heads_worker.py   # → heads.jsonl
 *     bun tools/timing-calibration/heads.ts --check [--sample 200]
 *
 * The replayed bot is set to the advertised rating of the human it replays, so the head's inputs
 * are exactly the shipped `buildInputs` of the row's context (tokens from the shipped encoder, the
 * row's clocks, the rating, the band the shipped `selectBand` picks), standardised with the
 * shipped scalers (`standardiseInputs`). The ONNX run is batched in native onnxruntime
 * (`heads_worker.py`, the same fp16 band files); `--check` re-runs a sample through the shipped
 * onnxruntime-web path (`createTimingInference`) and fails above
 * `TIMING_CONSTANTS.chessmimic.fixtureProbTolerance`.
 *
 * `--models DIR --scalers FILE` point both halves at a candidate band set (the finetuner's), in
 * which case the requests and outputs are written with a `--tag` suffix.
 */

import "../lib/defines";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MODELS_DIR } from "@core/constants/models";
import { buildInputs } from "@core/timing/chessmimic-head";
import {
	type BandScalers,
	CHESSMIMIC_SCALERS,
	standardiseInputs,
} from "@core/timing/chessmimic-scalers";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { TimingContext } from "@core/timing/types";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";
import { flagValue, hasFlag } from "../lib/cli";
import { ROOT } from "../lib/paths";
import {
	type CorpusGame,
	DATA_DIR,
	JsonlWriter,
	PATHS,
	readJsonl,
	rowsOf,
	type TimingRow,
} from "./common";
import { SELECT_PATH, type Selection } from "./select";

export interface HeadRequest {
	id: string;
	band: string;
	ids: number[];
	rating: number;
	clocks: [number, number, number];
}

export interface HeadResult {
	id: string;
	band: string;
	probs: number[];
}

export function headsPath(tag = ""): string {
	return path.join(DATA_DIR, `heads${tag ? `.${tag}` : ""}.jsonl`);
}

/** The timing context the session builds for a replayed row (engine-free parts). */
export function rowContext(game: CorpusGame, row: TimingRow): TimingContext {
	return {
		fen: row.fen,
		ply: row.ply,
		moves: game.ucis.slice(0, row.ply),
		myColor: row.color,
		chosenMove: row.move,
		lines: [],
		evalBeforeOppMove: null,
		expectedOppReply: null,
		myClockMs: row.clockMs,
		oppClockMs: row.oppClockMs,
		baseSec: row.baseMs / 1000,
		incSec: row.incMs / 1000,
		oppThinkMsHistory: [],
		myThinkMsHistory: [],
		site: "chesscom",
		targetElo: row.rating,
		profile: "balanced",
		engineReady: true,
		inputMethod: "drag",
		autoQueen: true,
		nowMs: 0,
	};
}

/** The replayed rows of the selection, game by game. */
export async function* selectedRows(): AsyncGenerator<{ game: CorpusGame; rows: TimingRow[] }> {
	const selection = (await Bun.file(SELECT_PATH).json()) as Selection;
	const sides = new Map<string, Set<string>>();
	for (const s of selection.sides) {
		const set = sides.get(s.gameId) ?? new Set();
		set.add(s.color);
		sides.set(s.gameId, set);
	}
	for await (const g of readJsonl<CorpusGame>(PATHS.selectGames)) {
		const colors = sides.get(g.gameId);
		if (!colors) continue;
		yield { game: g, rows: rowsOf(g).filter((r) => colors.has(r.color) && !r.first) };
	}
}

export function requestFor(
	ctx: TimingContext,
	id: string,
	scalers: Readonly<Record<string, BandScalers>>
): HeadRequest {
	const inputs = buildInputs(ctx);
	const std = standardiseInputs(inputs, scalers[inputs.band]);
	return {
		id,
		band: inputs.band,
		ids: [...inputs.moveTokens, ...inputs.fenTokens],
		rating: std.scaledRating,
		clocks: std.clockFeatures,
	};
}

/**
 * The context the head is queried with. `withMove` is the upstream training contract (the timed
 * move as the last token of the 12-move window, `buildInputs(ctx, chosenMove)` on the finetune
 * branch), reproduced here by appending the move to the history the shipped encoder windows.
 */
function queryContext(ctx: TimingContext, withMove: boolean): TimingContext {
	return withMove ? { ...ctx, moves: [...ctx.moves, ctx.chosenMove] } : ctx;
}

async function emit(
	tag: string,
	scalers: Readonly<Record<string, BandScalers>>,
	withMove: boolean
): Promise<void> {
	const out = new JsonlWriter(path.join(DATA_DIR, `heads-requests${tag ? `.${tag}` : ""}.jsonl`));
	let n = 0;
	for await (const { game, rows } of selectedRows()) {
		for (const r of rows) {
			out.write(requestFor(queryContext(rowContext(game, r), withMove), r.id, scalers));
			n++;
		}
	}
	await out.close();
	console.log(`${n} head requests`);
}

async function check(tag: string, modelsDir: string, sample: number): Promise<void> {
	const results = new Map<string, HeadResult>();
	for await (const r of readJsonl<HeadResult>(headsPath(tag))) {
		results.set(r.id, r);
		if (results.size >= sample * 50) break;
	}
	const inference = createTimingInference({
		runtime: () =>
			createOrtRuntime({
				importModule: (url) => import(url),
				getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
				threads: 1,
			}),
		store: {
			get: async (name) =>
				new Uint8Array(await Bun.file(path.join(ROOT, modelsDir, name)).arrayBuffer()),
		},
	});
	let checked = 0;
	let worst = 0;
	outer: for await (const { game, rows } of selectedRows()) {
		for (const r of rows) {
			const py = results.get(r.id);
			if (!py) continue;
			const inputs = buildInputs(rowContext(game, r));
			const reply = await inference.handle({ kind: "timing", id: r.id, inputs });
			if (!reply.probs) throw new Error(`TS inference failed for ${r.id}`);
			if (reply.band !== py.band)
				throw new Error(`band mismatch ${r.id}: ${reply.band} vs ${py.band}`);
			for (let i = 0; i < reply.probs.length; i++)
				worst = Math.max(worst, Math.abs((reply.probs[i] ?? 0) - (py.probs[i] ?? 0)));
			if (++checked >= sample) break outer;
		}
	}
	inference.dispose();
	const tol = TIMING_CONSTANTS.chessmimic.fixtureProbTolerance;
	console.log(
		`${checked} rows checked against onnxruntime-web: max |Δp| ${worst.toExponential(2)} (tolerance ${tol})`
	);
	if (checked === 0 || worst > tol) process.exit(1);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const tag = flagValue(argv, "tag", "") ?? "";
	const modelsDir = flagValue(argv, "models", MODELS_DIR) ?? MODELS_DIR;
	const scalersFile = flagValue(argv, "scalers");
	const scalers = scalersFile
		? ((await Bun.file(scalersFile).json()) as Record<string, BandScalers>)
		: CHESSMIMIC_SCALERS;
	if (hasFlag(argv, "emit")) await emit(tag, scalers, hasFlag(argv, "with-move"));
	else if (hasFlag(argv, "check"))
		await check(tag, modelsDir, Number(flagValue(argv, "sample", "200")));
	else throw new Error("heads.ts: --emit or --check");
	process.exit(0);
}

if (import.meta.main) await main();
