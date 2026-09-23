/**
 * tools/human-match/replay/corpus.ts — the positions a replay runs over: corpus rows
 * (`tools/data/10_sample_lichess.py`), the referee frames and Maia answers cached per row, the
 * rating buckets, and the checked-in fixture as a synthetic corpus.
 */

import path from "node:path";
import { MAIA, type MaiaSize } from "@core/constants/maia";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import type { EvalLine } from "@typedefs/engine";
import { ROOT } from "../../lib/paths";

/** One corpus position (JSONL). `tools/data/10_human_match.md` is the normative schema. */
export interface CorpusRow {
	/** Unique per row; `${gameId}:${ply}` by convention. */
	id?: string;
	gameId?: string;
	/** Half-moves played before this position. */
	ply: number;
	fen: string;
	/** ≤ `MAIA_INPUT.history` FENs oldest → newest, the last equal to `fen`. */
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	/** The move the human played, UCI. */
	humanMove: string;
	/** The mover's clock before the move, ms. */
	clockMs: number;
	oppClockMs?: number;
	baseMs?: number;
	incrementMs?: number;
	/** The opponent's last move, UCI. */
	lastMove?: string;
	/** The mover's previous move, UCI. */
	prevOwnMove?: string;
	thinkMs?: number;
	bucket?: number;
}

export interface FrameRecord {
	lines: EvalLine[];
	bestmove: string | null;
	/** Roots the extra `searchmoves` pass added to `lines`. */
	extra: string[];
	/** The human move's own referee line when the pool never scored it (baseline only). */
	humanLine?: EvalLine;
}

export const BUCKETS = [1000, 1300, 1600, 1900, 2200, 2500] as const;

export function bucketOf(elo: number): number {
	let best: number = BUCKETS[0];
	for (const b of BUCKETS) if (Math.abs(b - elo) < Math.abs(best - elo)) best = b;
	return best;
}

export function rowId(row: CorpusRow, index: number): string {
	return row.id ?? (row.gameId !== undefined ? `${row.gameId}:${row.ply}` : `row:${index}`);
}

export async function readCorpus(file: string, limit: number): Promise<CorpusRow[]> {
	const text = await Bun.file(file).text();
	const rows: CorpusRow[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		rows.push(JSON.parse(trimmed) as CorpusRow);
		if (limit > 0 && rows.length >= limit) break;
	}
	return rows;
}

interface FixtureFile {
	positions: Array<{
		index: number;
		fen: string;
		historyFens: string[];
		selfElo: number;
		oppoElo: number;
		ply: number;
		policy: Partial<
			Record<FixturePolicyKey, { moves: Array<[string, number]>; wdl: [number, number, number] }>
		>;
		engine: { searchmoves: string[]; bestmove: string | null };
		lines: EvalLine[];
	}>;
}

/**
 * The keys `maia-draw.json` stores its distributions under. The checked-in fixture was written
 * before the package narrowed to the 79M model (2026-09-13) and keeps the real 5M and 23M
 * answers — they are what the pure selector tests replay — so the fixture's keys are wider than
 * the shipped `MaiaSize`.
 */
export type FixturePolicyKey = MaiaSize | "5m" | "23m";
export const FIXTURE_DEFAULT_KEY: FixturePolicyKey = "5m";

export interface ReplayInputs {
	rows: CorpusRow[];
	frames: Map<string, FrameRecord>;
	policies: Map<string, PolicyResult>;
}

/** The checked-in fixture as a corpus: synthetic human moves, one seeded draw from Maia each. */
export async function fixtureCorpus(
	size: FixturePolicyKey,
	seed: string,
	limit: number
): Promise<ReplayInputs> {
	const file = (await Bun.file(
		path.join(ROOT, "test/fixtures/strength/maia-draw.json")
	).json()) as FixtureFile;
	const rng = createRng(`${seed}:synthetic-human`);
	const rows: CorpusRow[] = [];
	const frames = new Map<string, FrameRecord>();
	const policies = new Map<string, PolicyResult>();
	const source = limit > 0 ? file.positions.slice(0, limit) : file.positions;
	for (const p of source) {
		const policy = p.policy[size];
		if (!policy) throw new Error(`fixture has no ${size} policy`);
		const id = `fixture:${p.index}`;
		const humanMove = rng.weighted(
			policy.moves.map(([uci]) => uci),
			policy.moves.map(([, prob]) => prob)
		);
		rows.push({
			id,
			gameId: "fixture",
			ply: p.ply,
			fen: p.fen,
			historyFens: p.historyFens,
			selfElo: p.selfElo,
			oppoElo: p.oppoElo,
			humanMove,
			clockMs: 90_000,
			oppClockMs: 90_000,
			baseMs: 180_000,
			incrementMs: 0,
		});
		frames.set(id, { lines: p.lines, bestmove: p.engine.bestmove, extra: [] });
		// `PolicyResult.size` is the shipped type; the report header names the fixture key.
		policies.set(id, { moves: policy.moves, wdl: policy.wdl, size: MAIA.defaultSize });
	}
	return { rows, frames, policies };
}
