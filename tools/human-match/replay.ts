/**
 * tools/human-match/replay.ts — the human move-match harness (§8.1 steps 2–3 of
 * docs/research/human-move-selection-ideas-2026-09-13.md): *does our wrapper make the bot's move
 * distribution more or less like a human's at that rating?*
 *
 * For every corpus position it runs the **full selection wrapper** — the referee lines, Maia at
 * `selfElo` = the player's rating and `oppoElo` = the opponent's, the rails, the draw — as repeated
 * seeded `selectMove` calls (`--draws`, default 2000) to estimate the final sampling distribution
 * `q(m)`, and reports per rating bucket (1000 / 1300 / 1600 / 1900 / 2200 / 2500, nearest):
 *
 *   primary    E[log q(m_human)], top-1 agreement, E[q(m_human)] — and the same for raw Maia `p`;
 *   secondary  ACPL, inaccuracy / mistake / blunder rates (≥ 10 / 20 / 30 % win-probability drop),
 *              piece-hang rate per 40 moves, mate-found rate, same-piece-as-last-move rate, lag-1
 *              autocorrelation of loss — each for the bot (expectation under `q`) **and** for the
 *              humans of the same bucket, so every secondary number is a target, not a guess;
 *   meters     mean `klFromMaia`, `railedMass`, `unscoredMass`, Maia's share of the draws.
 *
 * Inputs
 *   --corpus FILE.jsonl   rows from tools/data/10_sample_lichess.py (schema in 10_human_match.md)
 *   --frames FILE.json    referee frames keyed by row id (written by an earlier --engine run via
 *                         --frames-out), or --engine to search with the vendored Stockfish under Bun
 *                         the way the pipeline does: MultiPV breadth by rating, one extra
 *                         `searchmoves` pass for Maia's unscored favourites, and a separate
 *                         single-root score of the human move when the pool never ranked it
 *                         (used for the human baseline only — never in the pool);
 *   --policies FILE.json  Maia answers keyed by row id (from --policies-out), or --maia to run the
 *                         shipped ONNX models (size by `maiaSizeFor(selfElo)`, or --size);
 *   --fixture             smoke run on test/fixtures/strength/maia-draw.json: its lines and 5M
 *                         policies (the fixture predates the 79M-only package of 2026-09-13 and
 *                         keeps the 5M / 23M answers), with a **synthetic** human move drawn once
 *                         from Maia — every metric path runs, none of the numbers mean anything.
 *
 *   --draws N --seed S --limit N --movetime MS --size 79m --out report.md --json report.json
 *
 * Cost is the referee search (`--engine`): ≈ 0.6–0.9 s per position; cache with --frames-out.
 *
 * The stages live in `replay/`: the corpus and its caches, the referee frame, the per-row replay,
 * the per-bucket aggregation and the markdown report. This file is their public entry and the CLI.
 */

import "./defines";
import { MAIA } from "@core/constants/maia";
import { maiaSizeFor } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import { createRefereeEngine } from "../lib/engine/referee";
import type { RefereeEngine } from "../lib/engine/types";
import { createMaiaRunner, type MaiaRunner } from "../lib/maia";
import { aggregate } from "./replay/aggregate";
import { parseReplayArgs, type ReplayArgs } from "./replay/args";
import {
	type CorpusRow,
	FIXTURE_DEFAULT_KEY,
	type FixturePolicyKey,
	type FrameRecord,
	fixtureCorpus,
	type ReplayInputs,
	readCorpus,
	rowId,
} from "./replay/corpus";
import { refereeFrame } from "./replay/referee-frame";
import { type RowResult, replayRow } from "./replay/replay-row";
import { markdown } from "./replay/report";

export type { BucketReport } from "./replay/aggregate";
export { BUCKETS, bucketOf, type CorpusRow, type FrameRecord } from "./replay/corpus";
export { markdown } from "./replay/report";

/** The rows plus whatever frames and policies are already known, and the report header so far. */
async function loadInputs(args: ReplayArgs, header: string[]): Promise<ReplayInputs> {
	const frames = new Map<string, FrameRecord>();
	const policies = new Map<string, PolicyResult>();
	let rows: CorpusRow[];
	if (args.fixture) {
		const size: FixturePolicyKey = args.size ?? FIXTURE_DEFAULT_KEY;
		const f = await fixtureCorpus(size, args.seed, args.limit);
		rows = f.rows;
		for (const [k, v] of f.frames) frames.set(k, v);
		for (const [k, v] of f.policies) policies.set(k, v);
		header.push(
			`**Smoke run on test/fixtures/strength/maia-draw.json** (${size}): the "human" move of every position is one seeded draw from Maia's own distribution — the numbers exercise the harness and mean nothing.`
		);
	} else {
		rows = await readCorpus(args.corpus as string, args.limit);
		header.push(`corpus \`${args.corpus}\` (${rows.length} positions)`);
		if (args.frames) {
			const stored = (await Bun.file(args.frames).json()) as Record<string, FrameRecord>;
			for (const [k, v] of Object.entries(stored)) frames.set(k, v);
			header.push(`frames \`${args.frames}\``);
		}
		if (args.policies) {
			const stored = (await Bun.file(args.policies).json()) as Record<string, PolicyResult>;
			for (const [k, v] of Object.entries(stored)) policies.set(k, v);
			header.push(`policies \`${args.policies}\``);
		}
	}
	return { rows, frames, policies };
}

async function main(): Promise<void> {
	const args = parseReplayArgs(process.argv.slice(2));
	const started = performance.now();
	const header: string[] = [];
	const { rows, frames, policies } = await loadInputs(args, header);

	let maia: MaiaRunner | undefined;
	if (args.maia) {
		maia = await createMaiaRunner(1);
		header.push(`Maia: shipped ONNX (${args.size ?? "size by maiaSizeFor(selfElo)"})`);
	}
	let engine: RefereeEngine | undefined;
	if (args.engine) {
		engine = await createRefereeEngine({ threads: 1, hashMb: 32 });
		header.push(
			`referee: vendored Stockfish 19 smallnet, movetime ${args.movetime} ms, depth cap automaticDepthForElo(selfElo), MultiPV by selectionCandidates, extra searchmoves ${MAIA.extraSearchMs} ms`
		);
	}
	header.push(`draws per position: ${args.draws}; seed \`${args.seed}\``);

	const results: RowResult[] = [];
	for (const [index, row] of rows.entries()) {
		const id = rowId(row, index);
		let policy = policies.get(id) ?? null;
		if (policy === null && maia) {
			const size = args.size ?? maiaSizeFor(row.selfElo);
			policy = await maia.query(size, row.historyFens, row.selfElo, row.oppoElo);
			policies.set(id, policy);
		}
		let frame = frames.get(id);
		if (!frame && engine) {
			frame = await refereeFrame(engine, row, policy, args.movetime);
			frames.set(id, frame);
		}
		if (!frame) throw new Error(`${id}: no referee frame (pass --frames FILE or --engine)`);
		const result = replayRow(row, id, frame, policy, args.draws, args.seed);
		results.push(result);
		if ((index + 1) % 25 === 0 || index + 1 === rows.length)
			console.log(
				`${index + 1}/${rows.length} positions (${((performance.now() - started) / 1000).toFixed(0)} s)`
			);
	}
	engine?.dispose();
	await maia?.dispose();

	if (args.framesOut) {
		await Bun.write(args.framesOut, `${JSON.stringify(Object.fromEntries(frames))}\n`);
		console.log(`wrote ${args.framesOut}`);
	}
	if (args.policiesOut) {
		await Bun.write(args.policiesOut, `${JSON.stringify(Object.fromEntries(policies))}\n`);
		console.log(`wrote ${args.policiesOut}`);
	}

	const reports = aggregate(results, args.draws);
	const md = markdown(reports, header);
	if (args.out) {
		await Bun.write(args.out, md);
		console.log(`wrote ${args.out}`);
	} else console.log(md);
	if (args.json) {
		await Bun.write(
			args.json,
			`${JSON.stringify({ header, draws: args.draws, seed: args.seed, buckets: reports }, null, 1)}\n`
		);
		console.log(`wrote ${args.json}`);
	}
	console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (import.meta.main) await main();
