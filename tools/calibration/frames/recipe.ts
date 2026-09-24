/**
 * tools/calibration/frames/recipe.ts — the three searches of one corpus row, the way the pipeline
 * searches (see `frames.ts`): the main MultiPV frame with its human-depth captures, the extra
 * `searchmoves` pass over Maia's favourites pooled across the grid, and the human move's own line.
 */

import "../../lib/defines";
import { legalMoves } from "@core/chess/san";
import { MAIA } from "@core/constants/maia";
import { HUMAN_DEPTH, SEARCH_BUDGET } from "@core/constants/search";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import type { PolicyResult } from "@core/policy/types";
import { maiaUnscoredMoves, mergeLines } from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import type { CorpusRow } from "../../human-match/replay";
import { createRefereeEngine } from "../../lib/engine/referee";
import type { CapturedCycle, RefereeEngine } from "../../lib/engine/types";
import type { CalibrationRow, FrameCacheRecord, GridPolicy, ScoredRoot, TcClass } from "./schema";

/** `HUMAN_DEPTH`'s range, every integer depth — the human frame for any Maia rating. */
export const CAPTURE_DEPTHS: readonly number[] = (() => {
	const ds = HUMAN_DEPTH.map(([, d]) => d);
	const lo = Math.min(...ds);
	const hi = Math.max(...ds);
	return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
})();

/** The extra pass scores at most this many roots (production: `MAIA.extraCandidates` from one policy). */
export const EXTRA_MAX_ROOTS = 10;

export const MAIN_MOVETIME_MS: Readonly<Record<TcClass, number>> = {
	bullet: SEARCH_BUDGET.moveMs.bullet,
	blitz: SEARCH_BUDGET.moveMs.blitz,
	rapid: SEARCH_BUDGET.moveMs.rapid,
};

/** Referee breadth for a target, as `searchBudget` sizes it for Maia mode (replay.ts's copy). */
export function breadthFor(targetElo: number, legal: number): number {
	const band = SEARCH_BUDGET.selectionCandidates.find((b) => targetElo <= b.maxElo)?.count ?? 0;
	const wanted = Math.max(SEARCH_BUDGET.multiPvMedium, band);
	return legal > 0 ? Math.min(wanted, legal) : wanted;
}

export function rowId(row: CorpusRow, index: number): string {
	return row.id ?? (row.gameId !== undefined ? `${row.gameId}:${row.ply}` : `row:${index}`);
}

function asPolicy(g: GridPolicy): PolicyResult {
	return { moves: g.moves, wdl: g.wdl ?? [0, 1, 0], size: MAIA.defaultSize };
}

/**
 * The extra pass's roots, pooled over the grid. Each policy contributes what
 * `maiaExtraSearchmoves` would search for it (its unscored moves at `p ≥ MAIA.minProb`, gated by
 * `extraMassMin` / `extraTopProb`, its top `extraCandidates`); the union is ordered by the best
 * rank any policy gives a move, then by its highest probability, so every grid rating's first
 * favourites are covered before anyone's sixth. At most `EXTRA_MAX_ROOTS`.
 */
export function gridExtraSearchmoves(
	policies: readonly GridPolicy[],
	lines: readonly EvalLine[],
	fen: string,
	max = EXTRA_MAX_ROOTS
): string[] {
	const best = new Map<string, { rank: number; p: number }>();
	for (const g of policies) {
		const unscored = maiaUnscoredMoves(asPolicy(g), lines, fen);
		let mass = 0;
		for (const [, p] of unscored) mass += p;
		const top = unscored[0]?.[1] ?? 0;
		if (mass < MAIA.extraMassMin && top < MAIA.extraTopProb) continue;
		unscored.slice(0, MAIA.extraCandidates).forEach(([uci, p], rank) => {
			const held = best.get(uci);
			if (!held) best.set(uci, { rank, p });
			else best.set(uci, { rank: Math.min(rank, held.rank), p: Math.max(p, held.p) });
		});
	}
	return [...best]
		.sort((a, b) => a[1].rank - b[1].rank || b[1].p - a[1].p || (a[0] < b[0] ? -1 : 1))
		.slice(0, max)
		.map(([uci]) => uci);
}

function roots(cycle: CapturedCycle): ScoredRoot[] {
	return cycle.lines.map((l) => ({ uci: l.uci, score: l.score }));
}

/** The three searches of one row. `policies` may be empty (no extra pass). */
export async function computeFrame(
	engine: RefereeEngine,
	row: CalibrationRow,
	id: string,
	policies: readonly GridPolicy[]
): Promise<FrameCacheRecord> {
	const started = performance.now();
	const legal = legalMoves(row.fen);
	const target = row.bucket ?? row.selfElo;
	const movetimeMs = MAIN_MOVETIME_MS[row.tc] ?? SEARCH_BUDGET.moveMs.blitz;
	const depthCap = automaticDepthForElo(target);
	const main = await engine.search({
		fen: row.fen,
		movetimeMs,
		depth: depthCap,
		multiPv: breadthFor(target, legal.length),
		captureDepths: CAPTURE_DEPTHS,
		strictCycles: true,
	});
	let lines = main.lines;
	const extra: string[] = [];
	const searchmoves = gridExtraSearchmoves(policies, lines, row.fen);
	if (searchmoves.length > 0) {
		const pass = await engine.search({
			fen: row.fen,
			movetimeMs: Math.max(SEARCH_BUDGET.minMovetimeMs, Math.min(MAIA.extraSearchMs, movetimeMs)),
			multiPv: searchmoves.length,
			searchmoves,
			strictCycles: true,
		});
		const mainCount = lines.length;
		lines = mergeLines(lines, pass.lines);
		for (const line of lines.slice(mainCount))
			if (line.pvUci[0] !== undefined) extra.push(line.pvUci[0]);
	}
	const byDepth: Record<number, ScoredRoot[]> = {};
	const byDepthAt: Record<number, number> = {};
	for (const d of CAPTURE_DEPTHS) {
		const cycle = main.byDepth?.[d];
		if (!cycle) continue;
		byDepth[d] = roots(cycle);
		byDepthAt[d] = cycle.depth;
	}
	const record: FrameCacheRecord = {
		id,
		lines,
		bestmove: main.bestmove,
		extra,
		depth: main.depth,
		complete: main.complete,
		byDepth,
		byDepthAt,
		ms: 0,
	};
	if (legal.includes(row.humanMove) && !lines.some((l) => l.pvUci[0] === row.humanMove)) {
		const own = await engine.search({
			fen: row.fen,
			movetimeMs,
			depth: depthCap,
			multiPv: 1,
			searchmoves: [row.humanMove],
			strictCycles: true,
		});
		const line = own.lines[0];
		if (line) record.humanLine = line;
	}
	record.ms = Math.round(performance.now() - started);
	return record;
}

export async function createFrameEngine(): Promise<RefereeEngine> {
	return createRefereeEngine({ threads: 1, hashMb: 32, timeoutMs: 15_000 });
}
