/**
 * Rating-parameterised move selection — Part I §7.2 steps 1–9 (Task 14), with
 * Appendix E §1.5/§1.8 as the reference implementation. Pure apart from the
 * seeded `ctx.rng` and the per-game `ctx.state` counters it advances.
 */

import { classifyMove } from "@core/chess/move-classify";
import type { Phase } from "@core/chess/phase";
import { applyMoves, parseUci, uciToSan } from "@core/chess/san";
import { opponentClockPressure } from "@core/timing/opponent-pressure";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { blunderTerms, drawTargetLoss, pickBlunder } from "./blunder-model";
import { SELECTION_CONSTANTS as C } from "./constants";
import { betaFor, cpEffective, effectiveElo, gapFor, sigmaFor, tauFor, winProb } from "./elo-map";
import { heuristicPriorDetailed, type PriorTerm } from "./prior";
import { avoidRepetition } from "./repetition";
import type { SelectionContext, SelectionState } from "./types";

export { cpEffective, winProb } from "./elo-map";

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
	/** Appendix E §3.5 endgame τ multiplier (1 outside endgames / inside the 1200–1800 band). */
	endgameTau: number;
}

/** Appendix E §3.5: τ ×1.5 in endgames below 1200, ×0.7 from 1800. */
export function endgameTauFor(E: number, phase: Phase | undefined): number {
	if (phase !== "endgame") return 1;
	if (E < C.endgame.weakElo) return C.endgame.weakTau;
	if (E >= C.endgame.strongElo) return C.endgame.strongTau;
	return 1;
}

/**
 * σ, τ (with the streak and endgame terms), G and β for `E`, the current state
 * and phase (§7.2 steps 3 and 7; Appendix E §3.5).
 */
export function selectionParams(
	E: number,
	state: Pick<SelectionState, "top1Streak">,
	phase?: Phase,
	tauScale = 1
): SelectionParams {
	const streak = state.top1Streak >= C.tau.streakLength;
	const endgameTau = endgameTauFor(E, phase);
	return {
		tau: tauFor(E) * (streak ? C.tau.streakMultiplier : 1) * endgameTau * tauScale,
		sigma: sigmaFor(E),
		gap: gapFor(E),
		beta: betaFor(E),
		streak,
		endgameTau,
	};
}

export interface ResolvedPriors {
	values: Map<string, number>;
	/** The multiplicative terms behind each value (heuristic rows, hybrid boost). */
	terms: Map<string, PriorTerm[]>;
}

/** `resolvePriors` with the per-line terms kept for the rationale. */
export function resolvePriorsDetailed(
	lines: readonly EvalLine[],
	ctx: SelectionContext,
	prior?: ReadonlyMap<string, number>
): ResolvedPriors {
	const heuristic = prior === undefined ? heuristicPriorDetailed(ctx.fen, lines, ctx) : null;
	const values = new Map<string, number>();
	const terms = new Map<string, PriorTerm[]>();
	for (const line of lines) {
		const uci = line.pvUci[0];
		if (uci === undefined) continue;
		const lineTerms: PriorTerm[] = [];
		let value: number;
		if (heuristic) {
			const b = heuristic.get(uci);
			value = b?.value ?? 1;
			lineTerms.push(...(b?.terms ?? []));
		} else {
			value = prior?.get(uci) ?? 1;
			if (prior?.has(uci)) lineTerms.push({ rule: "supplied", factor: value });
		}
		if (ctx.selectionMode === "hybrid" && uci === ctx.engineBestmove) {
			value *= C.hybridBestmovePrior;
			lineTerms.push({ rule: "hybrid-bestmove", factor: C.hybridBestmovePrior });
		}
		values.set(uci, value);
		terms.set(uci, lineTerms);
	}
	return { values, terms };
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
	return resolvePriorsDetailed(lines, ctx, prior).values;
}

/**
 * Never-play rule 4: the PV shows the opponent capturing next and the line
 * loses ≥ 0.25. `loss` is the raw (unjittered) win-fraction loss so the rail is hard.
 */
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
	/** Win-fraction loss from the jittered `cpEff` (policy). */
	loss: number;
	/** Win-fraction loss from the raw `cpRaw` (never-play rails). */
	lossRaw: number;
	prior: number;
	terms: readonly PriorTerm[];
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
	while (state.previousOwnMoves.length > C.prior.previousOwnMovesKept)
		state.previousOwnMoves.shift();
	if (pick.terms.length > 0)
		rationale.push(`prior: ${pick.terms.map((t) => `${t.rule} ×${fmt(t.factor)}`).join(", ")}`);
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
	const repetition = avoidRepetition(lines, ctx.fen, ctx.history);
	const usable = repetition.lines.filter((l) => l.pvUci[0] !== undefined);
	if (usable.length === 0) throw new RangeError("selectMove: no lines with a move");
	const { rng, state } = ctx;
	const NP = C.neverPlay;

	// Step 1: effective Elo.
	const E = effectiveElo(ctx.targetElo, ctx.form);
	const rationale: string[] = [`E=${fmt(E, 1)} (target ${ctx.targetElo}, form ${fmt(ctx.form)})`];
	if (repetition.avoided) rationale.push("repetition: preserving the advantage with a new position");

	// Rank by raw cpEff (1 = best); stable, so engine order breaks ties.
	const ranked = usable
		.map((line, i) => ({ line, i, cpRaw: cpEffective(line.score) }))
		.sort((a, b) => b.cpRaw - a.cpRaw || a.i - b.i);
	const originalRanks = lines
		.filter((line) => line.pvUci[0] !== undefined)
		.sort((a, b) => cpEffective(b.score) - cpEffective(a.score));
	const topCpRaw = cpEffective(originalRanks[0]?.score ?? { cp: 0 });
	const winTopRaw = winProb(topCpRaw);
	const priors = resolvePriorsDetailed(usable, ctx, prior);

	const toCandidate = (r: (typeof ranked)[number], rank: number): Candidate => {
		const uci = r.line.pvUci[0] ?? "";
		return {
			line: r.line,
			uci,
			rank: originalRanks.indexOf(r.line) + 1 || rank,
			cpRaw: r.cpRaw,
			cpEff: r.cpRaw,
			loss: 0,
			lossRaw: winTopRaw - winProb(r.cpRaw),
			prior: priors.values.get(uci) ?? 1,
			terms: priors.terms.get(uci) ?? [],
			mate: r.line.score.mate,
		};
	};
	const pressure = opponentClockPressure({
		ownClockMs: ctx.myClockMs,
		opponentClockMs: ctx.oppClockMs,
		baseMs: ctx.baseMs ?? 0,
		incrementMs: ctx.incrementMs ?? 0,
	});
	const finishPick = (pick: Candidate, source: ChosenMove["source"]): ChosenMove => {
		let chosen = pick;
		if (pressure >= C.opponentPressure.min && !ranked.some((r) => (r.line.score.mate ?? 0) > 0)) {
			const forcing = (uci: string): number => {
				const facts = classifyMove(ctx.fen, uci, ctx.lastMove);
				if (!facts) return 0;
				return facts.isCheck
					? C.opponentPressure.checkWeight
					: facts.isRecapture
						? C.opponentPressure.recaptureWeight
						: facts.isCapture
							? C.opponentPressure.captureWeight
							: 0;
			};
			const safe = ranked
				.map((r, i) => toCandidate(r, i + 1))
				.filter(
					(c) =>
						c.mate === undefined &&
						topCpRaw - c.cpRaw <= C.opponentPressure.maxLossCp &&
						forcing(c.uci) > 0
				)
				.sort((a, b) => forcing(b.uci) - forcing(a.uci) || b.cpRaw - a.cpRaw);
			const alternative = safe[0];
			if (
				alternative &&
				alternative.uci !== pick.uci &&
				(forcing(alternative.uci) > forcing(pick.uci) ||
					topCpRaw - pick.cpRaw > C.opponentPressure.maxLossCp) &&
				rng.chance(pressure)
			) {
				chosen = alternative;
				rationale.push(
					`opponent clock pressure: safe forcing move (${Math.round(pressure * 100)}%, ≤${C.opponentPressure.maxLossCp} cp loss)`
				);
			}
		}
		return finish(
			chosen,
			chosen !== pick && source === "blunder" ? "sampled" : source,
			topCpRaw,
			ctx,
			rationale
		);
	};

	// §7.1 `engine-elo`: play the engine's Elo-limited bestmove verbatim.
	if (ctx.selectionMode === "engine-elo") {
		const idx = ranked.findIndex((r) => r.line.pvUci[0] === ctx.engineBestmove);
		const r = ranked[idx >= 0 ? idx : 0];
		if (r === undefined) throw new RangeError("selectMove: no lines");
		rationale.push(idx >= 0 ? "engine-elo: bestmove" : "engine-elo: bestmove absent, top line");
		return finishPick(toCandidate(r, (idx >= 0 ? idx : 0) + 1), "engine-elo");
	}

	const params = selectionParams(E, state, ctx.phase, ctx.tauScale ?? 1);
	rationale.push(
		`σ=${fmt(params.sigma, 1)} τ=${fmt(params.tau)} G=${fmt(params.gap, 0)} β=${params.beta}`
	);
	if (params.streak)
		rationale.push(`streak: ${state.top1Streak} top-1 picks, τ×${C.tau.streakMultiplier}`);
	if (params.endgameTau !== 1) rationale.push(`endgame technique: τ×${params.endgameTau}`);
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
				return finishPick(pick, "mate");
			}
		}
		rationale.push(
			`mate: mate-in-≤${NP.mateInMax} missed (p=${fmt(p)}); loss ≥ ${NP.throwWinLoss} excluded`
		);
		throwsWin = (c) => c.lossRaw >= NP.throwWinLoss;
	}

	// Step 6: blunder channel.
	const cpStd = populationStd(cands.map((c) => c.cpEff));
	const terms = blunderTerms(E, {
		myClockMs: ctx.myClockMs,
		cpStd,
		blunderScale: pressure >= C.opponentPressure.min ? 0 : ctx.blunderScale,
		state,
		...(ctx.baseMs === undefined ? {} : { baseMs: ctx.baseMs }),
	});
	rationale.push(
		`b=${fmt(terms.b, 4)} (b0=${fmt(terms.b0, 4)} f_clock=${fmt(terms.fClock, 2)} f_complexity=${terms.fComplexity} scale=${ctx.blunderScale}${terms.damper !== 1 ? ` damper×${terms.damper}` : ""})`
	);
	if (terms.b > 0 && rng.chance(terms.b)) {
		const { kind, target } = drawTargetLoss(rng);
		const pool = cands.filter((c) => !getsMated(c) && !throwsWin(c) && c.loss >= C.blunder.minLoss);
		const pick = pickBlunder(pool, target);
		if (pick) {
			rationale.push(`blunder: ${kind} target ${fmt(target)} → loss ${fmt(pick.loss)}`);
			return finishPick(pick, "blunder");
		}
		rationale.push(`blunder: no candidate with loss ≥ ${C.blunder.minLoss}, base policy`);
	}

	// Step 7: base policy within G(E) of the best.
	let pool = cands.filter(
		(c) =>
			!getsMated(c) &&
			!throwsWin(c) &&
			best - c.cpEff <= params.gap &&
			!hangsPiece(c.line, c.lossRaw, ctx.fen)
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
	return finishPick(pick, "sampled");
}
