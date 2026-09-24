/**
 * Maia's part in an own-move search: whether it selects the move, the history it is queried
 * with, and the root sets its referee searches run over.
 */

import { loadPosition } from "@core/chess/fen";
import { matchingHistory, type PositionHistory } from "@core/chess/history";
import { legalMoves, playUci } from "@core/chess/san";
import { BOOK } from "@core/constants/books";
import { MAIA, MAIA_INPUT } from "@core/constants/maia";
import { MAIA_SEARCH, SEARCH_BUDGET } from "@core/constants/search";
import { requestEloForTarget } from "@core/engine/options";
import { usesMaia } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import { effectiveElo } from "@core/strength/elo-map";
import type { EvalLine } from "@typedefs/engine";

import type { SearchBudget } from "./budget";

/** What decides whether an own-move search is Maia's referee search. */
export interface MaiaSearchInput {
	targetElo: number;
	/** A policy port exists for this session (`RecommendationPipelineDeps.policy`). */
	policy: boolean;
	/** The position is a clock race (`clockRacePolicy` non-null): the engine is faster, skip Maia. */
	clockRace: boolean;
}

/**
 * Whether Maia selects the move. Predicted-position searches use the same decision for
 * strength, breadth and feature depth so their cache entries remain reusable.
 */
export function maiaSearchMode(input: MaiaSearchInput): boolean {
	return input.policy && !input.clockRace && usesMaia(input.targetElo);
}

/**
 * Maia supplies population opening choices below the book threshold. The book remains
 * available as a fallback when the policy query returns no answer.
 */
export function maiaPlaysOpening(input: { targetElo: number; form: number }): boolean {
	return usesMaia(input.targetElo) && effectiveElo(input.targetElo, input.form) < BOOK.maiaOnlyElo;
}

/**
 * The strength an own-move search runs at: Maia's referee search is at **full strength** (no
 * `elo`, which the UCI client turns into `UCI_LimitStrength false`), everything else at the
 * native `UCI_Elo` for the target when the engine calibrates that far.
 */
export function refereeElo(targetElo: number, maia: boolean): number | undefined {
	return maia ? undefined : requestEloForTarget(targetElo);
}

/**
 * The Maia query's position history: the last `MAIA_INPUT.history` positions oldest → newest,
 * ending with `fen` itself, replayed from the validated game history. `[fen]` when there is no
 * history that reaches this board (the encoder repeats the earliest position to fill).
 */
export function maiaHistoryFens(history: PositionHistory | undefined, fen: string): string[] {
	const valid = matchingHistory(history, fen);
	const board = valid ? loadPosition(valid.fen) : null;
	if (!valid || !board) return [fen];
	const fens = [board.fen()];
	for (const move of valid.moves) {
		if (!playUci(board, move)) return [fen];
		fens.push(board.fen());
	}
	// Preserve the caller's exact final FEN string after validating the replay.
	fens[fens.length - 1] = fen;
	return fens.slice(-MAIA_INPUT.history);
}

/**
 * Maia's legal moves the referee search left unscored (no line in `scored` starts with them),
 * each at `p ≥ MAIA.minProb`, most likely first. The extra referee search draws its
 * `searchmoves` from the front of this list.
 */
export function maiaUnscoredMoves(
	policy: PolicyResult,
	scored: readonly EvalLine[],
	fen: string
): Array<[uci: string, p: number]> {
	const legal = new Set(legalMoves(fen));
	const seen = new Set(scored.map((line) => line.pvUci[0]));
	const prob = new Map<string, number>();
	for (const [uci, p] of policy.moves) {
		if (!legal.has(uci) || seen.has(uci)) continue;
		prob.set(uci, Math.max(prob.get(uci) ?? 0, p));
	}
	return [...prob].filter(([, p]) => p >= MAIA.minProb).sort((a, b) => b[1] - a[1]);
}

/**
 * Unscored moves earn a referee search when their combined probability or top probability
 * passes its threshold. Return at most extraCandidates roots.
 */
export function maiaExtraSearchmoves(unscored: ReadonlyArray<readonly [string, number]>): string[] {
	let mass = 0;
	for (const [, p] of unscored) mass += p;
	const top = unscored[0]?.[1] ?? 0;
	if (mass < MAIA.extraMassMin && top < MAIA.extraTopProb) return [];
	return unscored.slice(0, MAIA.extraCandidates).map(([uci]) => uci);
}

/** Maia's legal moves for `fen`, most likely first (ties by UCI), duplicates folded to the max. */
function maiaRankedLegal(policy: PolicyResult, fen: string): Array<[uci: string, p: number]> {
	const legal = new Set(legalMoves(fen));
	const prob = new Map<string, number>();
	for (const [uci, p] of policy.moves) {
		if (!legal.has(uci)) continue;
		prob.set(uci, Math.max(prob.get(uci) ?? 0, p));
	}
	return [...prob].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Cover Maia's legal probability mass, retain available engine continuations, and fill
 * to the minimum root count. Sort roots for stable cache identity. An unreadable board
 * or a policy with no legal moves yields an empty set.
 */
export function shapedRootSet(
	policy: PolicyResult,
	fen: string,
	knownTopMoves: readonly string[] = []
): string[] {
	const K = MAIA_SEARCH.shaped;
	const ranked = maiaRankedLegal(policy, fen);
	if (ranked.length === 0) return [];
	const legal = new Set(legalMoves(fen));
	const roots = new Set<string>();
	let total = 0;
	for (const [, p] of ranked) total += p;
	let covered = 0;
	for (const [uci, p] of ranked) {
		if (roots.size >= K.maxRoots || covered >= K.massCover * total) break;
		roots.add(uci);
		covered += p;
	}
	let forced = 0;
	for (const uci of knownTopMoves) {
		if (forced >= K.knownTopMoves) break;
		if (!legal.has(uci) || roots.has(uci)) continue;
		roots.add(uci);
		forced += 1;
	}
	for (const [uci] of ranked) {
		if (roots.size >= K.minRoots) break;
		roots.add(uci);
	}
	return [...roots].sort();
}

/** One Maia-shaped search: its roots and the budget it runs at. */
export interface ShapedSearchPlan {
	searchmoves: string[];
	/** Root count and budget after any confidence-based reduction. */
	budget: SearchBudget;
	/** Whether Maia's top probability qualifies for a shorter search. */
	confident: boolean;
}

/**
 * Size a search over Maia's roots, shortening confident choices toward the search floor.
 * Predicted-position and own-move searches share this shape for cache reuse. Return null
 * when the policy or an independent engine continuation is unavailable.
 */
export function shapedSearchPlan(
	policy: PolicyResult,
	fen: string,
	knownTopMoves: readonly string[] | undefined,
	budget: SearchBudget,
	targetElo = 0
): ShapedSearchPlan | null {
	const legal = new Set(legalMoves(fen));
	if (!knownTopMoves?.some((uci) => legal.has(uci))) return null;
	const searchmoves = shapedRootSet(policy, fen, knownTopMoves);
	if (searchmoves.length === 0) return null;
	const K = MAIA_SEARCH.shaped;
	const top = maiaRankedLegal(policy, fen)[0]?.[1] ?? 0;
	const confident = top >= K.confidentProb && targetElo <= MAIA.upperVerification.fromElo;
	const floor = SEARCH_BUDGET.minMovetimeMs;
	const movetimeMs = confident
		? Math.max(floor, budget.movetimeMs - K.confidentTimeFraction * (budget.movetimeMs - floor))
		: budget.movetimeMs;
	return {
		searchmoves,
		budget: { ...budget, multiPv: searchmoves.length, movetimeMs },
		confident,
	};
}
