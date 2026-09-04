/**
 * Rating-parameterised move selection — Part I §7.2 steps 1–9 (Task 14), with
 * Appendix E §1.5/§1.8 as the reference implementation. Pure apart from the
 * seeded `ctx.rng` and the per-game `ctx.state` counters it advances.
 */

import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, parseUci, uciToSan } from "@core/chess/san";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { blunderTerms, drawTargetLoss, pickBlunder } from "./blunder-model";
import { SELECTION_CONSTANTS as C } from "./constants";
import { betaFor, cpEffective, effectiveElo, gapFor, sigmaFor, tauFor, winProb } from "./elo-map";
import { heuristicPrior } from "./prior";
import type { SelectionContext, SelectionState } from "./types";

export { cpEffective, winProb } from "./elo-map";

const PREVIOUS_OWN_MOVES_KEPT = 4;

export function createSelectionState(): SelectionState {
	return { top1Streak: 0, blunderDamperLeft: 0, previousOwnMoves: [] };
}

export interface SelectionParams {
	tau: number;
	sigma: number;
	gap: number;
	beta: number;
	/** True when the 12-consecutive-top-1 τ×1.3 term is active. */
	streak: boolean;
}

/** σ, τ (with the streak term), G and β for `E` and the current state (§7.2 steps 3 and 7). */
export function selectionParams(
	E: number,
	state: Pick<SelectionState, "top1Streak">
): SelectionParams {
	const streak = state.top1Streak >= C.tau.streakLength;
	return {
		tau: tauFor(E) * (streak ? C.tau.streakMultiplier : 1),
		sigma: sigmaFor(E),
		gap: gapFor(E),
		beta: betaFor(E),
		streak,
	};
}

/**
 * The prior actually used (§7.2 step 8): the supplied map (default
 * `heuristicPrior`) × 2.0 for the engine's `bestmove` in hybrid mode.
 */
export function resolvePriors(
	lines: readonly EvalLine[],
	ctx: SelectionContext,
	prior?: ReadonlyMap<string, number>
): Map<string, number> {
	const base = prior ?? heuristicPrior(ctx.fen, lines, ctx);
	const out = new Map<string, number>();
	for (const line of lines) {
		const uci = line.pvUci[0];
		if (uci === undefined) continue;
		let value = base.get(uci) ?? 1;
		if (ctx.selectionMode === "hybrid" && uci === ctx.engineBestmove) value *= C.hybridBestmovePrior;
		out.set(uci, value);
	}
	return out;
}

/** Never-play rule 4: the PV shows the opponent capturing next and the line loses ≥ 0.25. */
export function hangsPiece(line: EvalLine, loss: number, fen: string): boolean {
	if (loss < C.neverPlay.hangPieceLoss) return false;
	const replySan = line.pvSan[1];
	if (replySan !== undefined) return replySan.includes("x");
	const ours = line.pvUci[0];
	const reply = line.pvUci[1];
	if (ours === undefined || reply === undefined) return false;
	const after = applyMoves(fen, [ours]);
	if (after === null) return false;
	return classifyMove(after, reply)?.isCapture ?? false;
}

interface Candidate {
	line: EvalLine;
	uci: string;
	/** 1-based rank by raw `cpEff` (1 = the engine's best line). */
	rank: number;
	cpRaw: number;
	cpEff: number;
	loss: number;
	prior: number;
	mate: number | undefined;
}

function populationStd(values: readonly number[]): number {
	if (values.length === 0) return 0;
	let mean = 0;
	for (const v of values) mean += v;
	mean /= values.length;
	let sq = 0;
	for (const v of values) sq += (v - mean) ** 2;
	return Math.sqrt(sq / values.length);
}

function fmt(n: number, digits = 3): string {
	return Number(n.toFixed(digits)).toString();
}

/** §7.2 step 9: build the `ChosenMove` and advance the per-game state. */
function finish(
	pick: Candidate,
	source: ChosenMove["source"],
	topCpRaw: number,
	ctx: SelectionContext,
	rationale: string[]
): ChosenMove {
	const parts = parseUci(pick.uci);
	if (!parts) throw new RangeError(`selectMove: invalid uci "${pick.uci}"`);
	const state = ctx.state;
	state.top1Streak = pick.rank === 1 ? state.top1Streak + 1 : 0;
	state.blunderDamperLeft =
		source === "blunder" ? C.blunder.damperMoves : Math.max(0, state.blunderDamperLeft - 1);
	state.previousOwnMoves.push(pick.uci);
	if (state.previousOwnMoves.length > PREVIOUS_OWN_MOVES_KEPT) state.previousOwnMoves.shift();
	const san = pick.line.pvSan[0] ?? uciToSan(ctx.fen, pick.uci) ?? pick.uci;
	const chosen: ChosenMove = {
		uci: pick.uci,
		san,
		from: parts.from,
		to: parts.to,
		source,
		rankInLines: pick.rank,
		cpLoss: Math.max(0, topCpRaw - pick.cpRaw),
		rationale,
	};
	if (parts.promotion !== undefined) chosen.promotion = parts.promotion;
	return chosen;
}

/**
 * `selectMove(lines, ctx, prior?) → ChosenMove` — §7.2 steps 1–9. `lines` are
 * side-to-move POV; `prior` defaults to `heuristicPrior`.
 */
export function selectMove(
	lines: readonly EvalLine[],
	ctx: SelectionContext,
	prior?: ReadonlyMap<string, number>
): ChosenMove {
	if (lines.length === 0) throw new RangeError("selectMove: no lines");
	const { rng, state } = ctx;
	const NP = C.neverPlay;

	// Step 1: effective Elo.
	const E = effectiveElo(ctx.targetElo, ctx.form);
	const rationale: string[] = [`E=${fmt(E, 1)} (target ${ctx.targetElo}, form ${fmt(ctx.form)})`];

	// Rank by raw cpEff (1 = best); stable, so engine order breaks ties.
	const ranked = lines
		.map((line, i) => ({ line, i, cpRaw: cpEffective(line.score) }))
		.sort((a, b) => b.cpRaw - a.cpRaw || a.i - b.i);
	const topCpRaw = ranked[0]?.cpRaw ?? 0;
	const priors = resolvePriors(lines, ctx, prior);

	const toCandidate = (r: (typeof ranked)[number], rank: number): Candidate => ({
		line: r.line,
		uci: r.line.pvUci[0] ?? "",
		rank,
		cpRaw: r.cpRaw,
		cpEff: r.cpRaw,
		loss: 0,
		prior: priors.get(r.line.pvUci[0] ?? "") ?? 1,
		mate: r.line.score.mate,
	});

	// §7.1 `engine-elo`: play the engine's Elo-limited bestmove verbatim.
	if (ctx.selectionMode === "engine-elo") {
		const idx = ranked.findIndex((r) => r.line.pvUci[0] === ctx.engineBestmove);
		const r = ranked[idx >= 0 ? idx : 0];
		if (r === undefined) throw new RangeError("selectMove: no lines");
		rationale.push(idx >= 0 ? "engine-elo: bestmove" : "engine-elo: bestmove absent, top line");
		return finish(toCandidate(r, (idx >= 0 ? idx : 0) + 1), "engine-elo", topCpRaw, ctx, rationale);
	}

	const params = selectionParams(E, state);
	rationale.push(
		`σ=${fmt(params.sigma, 1)} τ=${fmt(params.tau)} G=${fmt(params.gap, 0)} β=${params.beta}`
	);
	if (params.streak)
		rationale.push(`streak: ${state.top1Streak} top-1 picks, τ×${C.tau.streakMultiplier}`);
	if (ctx.selectionMode === "hybrid" && ctx.engineBestmove !== undefined)
		rationale.push(`hybrid: prior(${ctx.engineBestmove}) ×${C.hybridBestmovePrior}`);

	// Steps 2–4: cpEff, jitter, win-probability loss.
	const cands = ranked.map((r, i) => {
		const c = toCandidate(r, i + 1);
		c.cpEff = c.cpRaw + rng.normal(0, params.sigma);
		return c;
	});
	let best = Number.NEGATIVE_INFINITY;
	for (const c of cands) best = Math.max(best, c.cpEff);
	const winBest = winProb(best);
	for (const c of cands) c.loss = winBest - winProb(c.cpEff);

	// Step 5: never-play filters.
	const isMated = (c: Candidate) => c.mate !== undefined && c.mate < 0;
	const alternativeExists = cands.some((c) => !isMated(c));
	let allowDeepMated = false;
	if (
		alternativeExists &&
		E < NP.matedAllowBelowElo &&
		cands.some((c) => isMated(c) && Math.abs(c.mate ?? 0) >= NP.matedMinDepth)
	) {
		allowDeepMated = rng.chance(NP.matedAllowProb);
		if (allowDeepMated)
			rationale.push(
				`never-play: E<${NP.matedAllowBelowElo}, deep mated lines allowed (p=${NP.matedAllowProb})`
			);
	}
	const getsMated = (c: Candidate) =>
		alternativeExists && isMated(c) && !(allowDeepMated && Math.abs(c.mate ?? 0) >= NP.matedMinDepth);
	const matedExcluded = cands.filter(getsMated).length;
	if (matedExcluded > 0) rationale.push(`never-play: ${matedExcluded} mated line(s) excluded`);

	let throwsWin: (c: Candidate) => boolean = () => false;
	const mates = cands.filter((c) => c.mate !== undefined && c.mate > 0 && c.mate <= NP.mateInMax);
	if (mates.length > 0) {
		const p =
			E >= NP.mateAlwaysElo
				? 1
				: clamp(
						NP.mateProbBase + (NP.mateProbBase * (E - NP.mateProbEloFloor)) / NP.mateProbEloSpan,
						0,
						1
					);
		if (rng.chance(p)) {
			mates.sort((a, b) => (a.mate ?? 0) - (b.mate ?? 0) || a.rank - b.rank);
			const pick = mates[0];
			if (pick !== undefined) {
				rationale.push(`mate: mate-in-${pick.mate} played (p=${fmt(p)})`);
				return finish(pick, "mate", topCpRaw, ctx, rationale);
			}
		}
		rationale.push(
			`mate: mate-in-≤${NP.mateInMax} missed (p=${fmt(p)}); loss ≥ ${NP.throwWinLoss} excluded`
		);
		throwsWin = (c) => c.loss >= NP.throwWinLoss;
	}

	// Step 6: blunder channel.
	const cpStd = populationStd(cands.map((c) => c.cpEff));
	const terms = blunderTerms(E, {
		myClockMs: ctx.myClockMs,
		cpStd,
		blunderScale: ctx.blunderScale,
		state,
	});
	rationale.push(
		`b=${fmt(terms.b, 4)} (b0=${terms.b0} f_clock=${fmt(terms.fClock, 2)} f_complexity=${terms.fComplexity} scale=${ctx.blunderScale}${terms.damper !== 1 ? ` damper×${terms.damper}` : ""})`
	);
	if (terms.b > 0 && rng.chance(terms.b)) {
		const { kind, target } = drawTargetLoss(rng);
		const pool = cands.filter((c) => !getsMated(c) && !throwsWin(c) && c.loss >= C.blunder.minLoss);
		const pick = pickBlunder(pool, target);
		if (pick) {
			rationale.push(`blunder: ${kind} target ${fmt(target)} → loss ${fmt(pick.loss)}`);
			return finish(pick, "blunder", topCpRaw, ctx, rationale);
		}
		rationale.push(`blunder: no candidate with loss ≥ ${C.blunder.minLoss}, base policy`);
	}

	// Step 7: base policy within G(E) of the best.
	let pool = cands.filter(
		(c) =>
			!getsMated(c) &&
			!throwsWin(c) &&
			best - c.cpEff <= params.gap &&
			!hangsPiece(c.line, c.loss, ctx.fen)
	);
	if (pool.length === 0) pool = cands.filter((c) => !getsMated(c));
	if (pool.length === 0) pool = cands;
	const weights = pool.map(
		(c) => Math.exp(-c.loss / params.tau) * Math.max(c.prior, C.basePriorFloor) ** params.beta
	);
	const pick = rng.weighted(pool, weights);
	rationale.push(
		`sampled: ${pool.length}/${cands.length} in gap, loss ${fmt(pick.loss)}, prior ${fmt(pick.prior, 2)}`
	);
	return finish(pick, "sampled", topCpRaw, ctx, rationale);
}
