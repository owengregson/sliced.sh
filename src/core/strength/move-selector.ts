/** Rating-aware selection with shared mate, repetition, conversion and piece-safety guards. */

import { loadPosition } from "@core/chess/fen";
import { classifyMove } from "@core/chess/move-classify";
import type { Phase } from "@core/chess/phase";
import { hangsOutright } from "@core/chess/safety";
import { applyMoves, legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { GENERATE_VERIFY } from "@core/constants/generate-verify";
import { MAIA } from "@core/constants/maia";
import { requestEloForTarget } from "@core/engine/options";
import { policyEntropy, temperPolicy } from "@core/policy/maia-policy";
import { maiaMaxCpLoss, upperVerificationProgress, usesMaia } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import { createRng, type Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, MaiaMeters } from "@typedefs/game";
import { blunderTerms, drawTargetLoss, pickBlunder } from "./blunder-model";
import { SELECTION_CONSTANTS as C } from "./constants";
import { conversionPool, isImmediateMate, searchedCp } from "./conversion";
import {
	betaFor,
	cpEffective,
	effectiveElo,
	eloRamp,
	gapFor,
	sigmaFor,
	tauFor,
	winProb,
} from "./elo-map";
import { drawDistribution, type GvInput, generateAndVerify, gvKl } from "./generate-verify";
import {
	drawMaiaFromSurvivors,
	type MaiaDraw,
	type MaiaPractical,
	maiaDrawRecord,
	maiaSurvivors,
	policyProbabilities,
} from "./maia-select";
import { isMaxStrength } from "./max-strength";
import { heuristicPriorDetailed, type PriorTerm } from "./prior";
import { compareLines, moveQuality, rankedLines } from "./quality";
import { avoidRepetition } from "./repetition";
import {
	maiaCalibrationPoint,
	maiaEloTimeClass,
	maiaSelfElo,
	pressureTerms,
	sliderEloOffset,
} from "./selection-elo";
import { usesNativeSelection } from "./selection-mode";
import { simplificationFactors } from "./simplification";
import type { SelectionContext, SelectionState } from "./types";

export { cpEffective, winProb } from "./elo-map";

export function createSelectionState(): SelectionState {
	return { top1Streak: 0, blunderDamperLeft: 0, previousOwnMoves: [], tiltMovesLeft: 0 };
}

/**
 * §7.2 step 5 / H9: the probability a searched mate-in-≤ `mateInMax` is played at `E` — 1 from
 * `mateAlwaysElo`, else `mateProbBase + mateProbBase·(E − mateProbEloFloor)/mateProbEloSpan`
 * clamped to [0, 1] (0.5 at 800, 1 at 1400).
 */
export function mateRampProbability(E: number): number {
	const NP = C.neverPlay;
	if (E >= NP.mateAlwaysElo) return 1;
	return clamp(
		NP.mateProbBase + (NP.mateProbBase * (E - NP.mateProbEloFloor)) / NP.mateProbEloSpan,
		0,
		1
	);
}

/** H1: the probability the hang rail fires at the Maia rating `E` — 0 below `offElo`, 1 from `fullElo`. */
export function hangRailProbability(E: number): number {
	return eloRamp(E, MAIA.hangRail.offElo, 0, MAIA.hangRail.fullElo, 1);
}

/**
 * H12: the probability an adverse swing tilts the player at the Maia rating `E` — `probAtFloor`
 * at or below `probFullElo`, falling linearly to 0 at `probFloorElo`.
 */
export function tiltProbability(E: number): number {
	const T = MAIA.tilt;
	return T.probAtFloor * clamp((T.probFloorElo - E) / (T.probFloorElo - T.probFullElo), 0, 1);
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
	/** 1-based rank by original raw engine score; 0 when there is no credible score. */
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

/** A line the engine scores as a forced loss for us. */
function isMatedLine(c: Candidate): boolean {
	return c.mate !== undefined && c.mate < 0;
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

/**
 * §7.2 step 5's mated-line rule, shared by the base policy and the Maia draw (H16): a mated line
 * is excluded while an unmated alternative exists, except that below `matedAllowBelowElo` the
 * deep ones (≥ `matedMinDepth`) are allowed with `matedAllowProb`, drawn once per move. Returns
 * the "excluded as mated" predicate and leaves its rows in `rationale`.
 */
function matedLineFilter(
	cands: readonly Candidate[],
	E: number,
	rng: Rng,
	rationale: string[]
): (c: Candidate) => boolean {
	const NP = C.neverPlay;
	const alternativeExists = cands.some((c) => !isMatedLine(c));
	const deep = (c: Candidate) => Math.abs(c.mate ?? 0) >= NP.matedMinDepth;
	let allowDeepMated = false;
	if (
		alternativeExists &&
		E < NP.matedAllowBelowElo &&
		cands.some((c) => isMatedLine(c) && deep(c))
	) {
		allowDeepMated = rng.chance(NP.matedAllowProb);
		if (allowDeepMated)
			rationale.push(
				`never-play: E<${NP.matedAllowBelowElo}, deep mated lines allowed (p=${NP.matedAllowProb})`
			);
	}
	const getsMated = (c: Candidate) =>
		alternativeExists && isMatedLine(c) && !(allowDeepMated && deep(c));
	const matedExcluded = cands.filter(getsMated).length;
	if (matedExcluded > 0) rationale.push(`never-play: ${matedExcluded} mated line(s) excluded`);
	return getsMated;
}

/** §7.2 step 9: build the `ChosenMove` and advance the per-game state. */
function finish(
	pick: Candidate,
	source: ChosenMove["source"],
	reference: readonly EvalLine[],
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
	// H12: what we thought this move was worth, for the next position's tilt trigger; an unscored
	// pick (rank 0) leaves nothing comparable. The tilt, once set, counts down here on every path.
	if (pick.rank === 0) delete state.lastPickCp;
	else state.lastPickCp = pick.cpRaw;
	if (state.tiltMovesLeft > 0) state.tiltMovesLeft -= 1;
	if (pick.terms.length > 0)
		rationale.push(`prior: ${pick.terms.map((t) => `${t.rule} ×${fmt(t.factor)}`).join(", ")}`);
	const san = pick.line.pvSan[0] ?? uciToSan(ctx.fen, pick.uci) ?? pick.uci;
	const measured = moveQuality(reference, pick.line);
	if (source === "mate") {
		delete measured.cpLoss;
		measured.quality.eligible = false;
		measured.quality.reason = "mate";
	}
	const chosen: ChosenMove = {
		uci: pick.uci,
		san,
		from: parts.from,
		to: parts.to,
		source,
		rankInLines: pick.rank,
		...measured,
		rationale,
	};
	if (parts.promotion !== undefined) chosen.promotion = parts.promotion;
	return chosen;
}

/** The lines whose first move is legal in `fen`: max-strength mode's only check on the engine's lines. */
function legalLines(lines: readonly EvalLine[], fen: string): EvalLine[] {
	const legal = new Set(legalMoves(fen));
	return lines.filter((line) => legal.has(line.pvUci[0] ?? ""));
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
	const { pressure, baselineReduction, pressureReduction, rush } = pressureTerms({
		fen: ctx.fen,
		myClockMs: ctx.myClockMs,
		oppClockMs: ctx.oppClockMs,
		baseMs: ctx.baseMs,
		incrementMs: ctx.incrementMs,
	});
	// The added pace penalty broadens ordinary plausible choices. Existing forced-loss
	// and deliberate-error rules retain their pre-rush rating inputs.
	const baselineE = effectiveElo(ctx.targetElo - baselineReduction, ctx.form);
	const E = effectiveElo(ctx.targetElo - pressureReduction, ctx.form);
	// Max-strength mode (owner, 2026-09-15: "just play the absolute best possible move in every
	// situation"): the strongest searched legal line is taken below. The repetition preference, which
	// avoids even a first repeat and can drop the engine's best line, is off — the engine searches
	// with the game's history. The conversion pool stays: it removes only a line whose PV reaches a
	// drawn board (stalemate, dead position, an actual threefold) while its score claims a win, which
	// only a stale score can put on top.
	const maxStrength = isMaxStrength(ctx.targetElo);
	const repetition = maxStrength
		? { lines: legalLines(lines, ctx.fen), avoided: false }
		: avoidRepetition(lines, ctx.fen, ctx.history);
	const conversion = conversionPool(repetition.lines, ctx);
	const bestConversionCp = Math.max(...conversion.lines.map(searchedCp));
	const conversionLossCap = Math.max(
		C.conversion.maxLossCp,
		gapFor(baselineE),
		rush > 0 ? C.opponentPressure.raceExpandedLossCp : 0
	);
	const usable = conversion.lines.filter(
		(line) =>
			line.pvUci[0] !== undefined &&
			(!conversion.active || searchedCp(line) >= bestConversionCp - conversionLossCap)
	);
	if (usable.length === 0) throw new RangeError("selectMove: no lines with a move");
	const { rng, state } = ctx;
	const NP = C.neverPlay;

	// Step 1: effective Elo.
	const rationale: string[] = [`E=${fmt(E, 1)} (target ${ctx.targetElo}, form ${fmt(ctx.form)})`];
	if (repetition.avoided) rationale.push("repetition: preserving the advantage with a new position");
	if (conversion.avoidedDraw)
		rationale.push("conversion: avoiding a searched stalemate or dead position");

	// Rank by actual engine score; clamped policy scores are only used for sampling.
	const rankedAll = usable
		.map((line, i) => ({ line, i, cpRaw: cpEffective(line.score) }))
		.sort((a, b) => compareLines(a.line, b.line) || a.i - b.i);
	const originalRanks = rankedLines(lines);
	const topCpRaw = cpEffective(originalRanks[0]?.score ?? { cp: 0 });
	const winTopRaw = winProb(topCpRaw);

	// §7 C1: the heuristic prior walks every PV through chess.js, so it is resolved lazily — over
	// the whole set only when the base policy samples, over the tie band alone in Maia mode. The
	// best usable line always rides along because the prior's environment is relative to it.
	const priorCtx = { ...ctx, targetElo: ctx.targetElo - pressureReduction };
	const bestUsable = rankedAll[0]?.line;
	const bestProgress = Math.max(...usable.map((line) => conversion.progress.get(line) ?? 0));
	const boostedPriors = (subset: readonly EvalLine[]): ResolvedPriors => {
		const withBest =
			bestUsable === undefined || subset.includes(bestUsable) ? subset : [bestUsable, ...subset];
		const priors = resolvePriorsDetailed(withBest, priorCtx, prior);
		for (const line of withBest) {
			const uci = line.pvUci[0] ?? "";
			const terms = priors.terms.get(uci) ?? [];
			let value = priors.values.get(uci) ?? 1;
			if (
				conversion.active &&
				bestProgress > 0 &&
				conversion.progress.get(line) === bestProgress &&
				searchedCp(line) >= bestConversionCp - C.conversion.progressLossCp
			) {
				value *= C.endgame.wonTechnique;
				terms.push({ rule: "conversion-progress", factor: C.endgame.wonTechnique });
			}
			const facts = pressureReduction > 0 ? classifyMove(ctx.fen, uci, ctx.lastMove) : null;
			if (facts?.isCheck || facts?.isRecapture) {
				const factor = 1 + (C.opponentPressure.forcingPrior - 1) * pressure;
				value *= factor;
				terms.push({ rule: "clock-forcing", factor });
			}
			priors.values.set(uci, value);
			priors.terms.set(uci, terms);
		}
		return priors;
	};

	const toCandidate = (r: (typeof rankedAll)[number], priors?: ResolvedPriors): Candidate => {
		const uci = r.line.pvUci[0] ?? "";
		return {
			line: r.line,
			uci,
			rank: originalRanks.findIndex((line) => line.pvUci[0] === uci) + 1,
			cpRaw: r.cpRaw,
			cpEff: r.cpRaw,
			loss: 0,
			lossRaw: winTopRaw - winProb(r.cpRaw),
			prior: priors?.values.get(uci) ?? 1,
			terms: priors?.terms.get(uci) ?? [],
			mate: r.line.score.mate,
		};
	};

	// The one rating everything about a Maia move agrees on (H2/H5/H12): the pipeline issued the
	// query at `maiaSelfElo` with the same pressure, slider and context terms; the selector adds the
	// ambiguity term from the model's own entropy and, when tilted, the tilt penalty. Computed here,
	// before the mate guard, so the mate ramp judges at it too.
	const maiaMode = ctx.maia !== undefined && usesMaia(ctx.targetElo);
	let maiaE: number | undefined;
	let maiaPolicy: PolicyResult | undefined;
	let entropy = 0;
	if (ctx.maia !== undefined && maiaMode) {
		entropy = policyEntropy(ctx.maia.moves);
		const ambiguityEloPenalty = MAIA.context.ambiguityElo * entropy;
		const eloInput = {
			targetElo: ctx.targetElo,
			form: ctx.form,
			blunderScale: ctx.blunderScale,
			pressureReduction,
			contextEloPenalty: ctx.contextEloPenalty,
			baseMs: ctx.baseMs,
			incrementMs: ctx.incrementMs,
			calibration: ctx.maiaCalibration,
		};
		// H12: an adverse swing since our last move tilts the player with a rating-dependent
		// probability; judged at the pre-tilt rating so the trigger does not feed itself.
		if (
			state.lastPickCp !== undefined &&
			topCpRaw <= state.lastPickCp - MAIA.tilt.swingCp &&
			state.tiltMovesLeft === 0
		) {
			const pTilt = tiltProbability(maiaSelfElo({ ...eloInput, ambiguityEloPenalty }));
			if (pTilt > 0 && rng.chance(pTilt)) {
				state.tiltMovesLeft = MAIA.tilt.moves;
				rationale.push(
					`tilt: eval fell ${fmt(state.lastPickCp - topCpRaw, 0)} cp since our last move (p=${fmt(pTilt, 2)}), −${MAIA.tilt.elo} Elo for ${MAIA.tilt.moves} moves`
				);
			}
		}
		const tiltElo = state.tiltMovesLeft > 0 ? MAIA.tilt.elo : 0;
		maiaE = maiaSelfElo({ ...eloInput, ambiguityEloPenalty: ambiguityEloPenalty + tiltElo });
		// The calibrated temperature reshapes the whole answer once, so the rails, verification
		// and the draw all see the distribution the calibration was fitted with. Entropy (above)
		// stays the model's own: it measures the position, not the sampling.
		const calibration = maiaCalibrationPoint(eloInput);
		maiaPolicy = temperPolicy(ctx.maia, calibration.temperature);
		rationale.push(
			`maia calibration: ${maiaEloTimeClass(eloInput)} conditioning ${fmt(calibration.conditioningElo, 0)} temperature ${fmt(calibration.temperature, 3)}`
		);
		const slider = sliderEloOffset(ctx.blunderScale);
		rationale.push(
			`maia E=${fmt(maiaE, 1)} (pressure −${fmt(pressureReduction, 0)}, slider ${slider > 0 ? "−" : "+"}${fmt(Math.abs(slider), 0)}, context −${fmt(ctx.contextEloPenalty ?? 0, 0)}, ambiguity −${fmt(ambiguityEloPenalty, 0)} [entropy ${fmt(entropy, 2)}]${tiltElo > 0 ? `, tilt −${tiltElo} (${state.tiltMovesLeft} left)` : ""})`
		);
	}

	// Never randomly decline an immediate board mate. A searched forced mate follows §7.2 step 5
	// (H9): mate-in-≤ `mateInMax` is played with `mateRampProbability` (1 from `mateAlwaysElo`);
	// deeper mates, and a declined one, fall through to the ordinary draw with every line that would
	// throw the win (raw loss ≥ `throwWinLoss`) excluded — a missed mate must not become a thrown win.
	const immediateMate = rankedAll.find((r) => isImmediateMate(ctx.fen, r.line.pvUci[0] ?? ""));
	if (immediateMate) {
		rationale.push("mate: immediate legal checkmate");
		return finish(toCandidate(immediateMate), "mate", lines, ctx, rationale);
	}
	const forcedMate = rankedAll
		.filter((r) => (r.line.score.mate ?? 0) > 0)
		.sort((a, b) => (a.line.score.mate ?? 0) - (b.line.score.mate ?? 0))[0];
	let throwWinFilter = false;
	if (forcedMate) {
		const n = forcedMate.line.score.mate ?? 0;
		const rampE = maiaE ?? baselineE;
		if (n <= NP.mateInMax) {
			const p = mateRampProbability(rampE);
			if (p >= 1 || rng.chance(p)) {
				rationale.push(
					`mate: preserving forced mate-in-${n}${p < 1 ? ` (p=${fmt(p, 2)} at E=${fmt(rampE, 0)})` : ""}`
				);
				return finish(toCandidate(forcedMate), "mate", lines, ctx, rationale);
			}
			rationale.push(`mate: mate-in-${n} declined (p=${fmt(p, 2)} at E=${fmt(rampE, 0)})`);
		} else {
			rationale.push(`mate: mate-in-${n} is beyond ${NP.mateInMax}, ordinary policy`);
		}
		throwWinFilter = true;
		rationale.push(`mate: throw-win filter, lines with loss ≥ ${NP.throwWinLoss} excluded`);
	}
	let ranked = throwWinFilter
		? rankedAll.filter((r) => winTopRaw - winProb(r.cpRaw) < NP.throwWinLoss)
		: rankedAll;
	if (pressureReduction > 0)
		rationale.push(`opponent clock pressure: accuracy −${fmt(pressureReduction, 0)} Elo`);
	const finishPick = (pick: Candidate, source: ChosenMove["source"]): ChosenMove => {
		const chosen = finish(pick, source, lines, ctx, rationale);
		if (rush > 0 && chosen.quality?.eligible) {
			chosen.quality.eligible = false;
			chosen.quality.reason = "opponent-rush";
		}
		return chosen;
	};
	// Above the Maia cutoff — the product's one strength division (owner, 2026-09-15) — the full
	// network's strongest guarded continuation is the move, whatever policy answer is on hand.
	if (ctx.targetElo > MAIA.eloMax) {
		const best = ranked[0];
		if (!best) throw new RangeError("selectMove: no lines");
		rationale.push(
			maxStrength
				? "full-strength engine: max strength: the engine's best move"
				: "full-strength engine: strongest guarded continuation"
		);
		return finishPick(toCandidate(best), "engine-elo");
	}
	// Maia's mass on what the search scored, before the repetition/conversion guards (§7 D2).
	const maiaProb = maiaPolicy === undefined ? undefined : policyProbabilities(maiaPolicy);
	let scoredMassBefore = 0;
	if (maiaProb !== undefined) {
		const seen = new Set<string>();
		for (const line of lines) {
			const uci = line.pvUci[0];
			if (uci === undefined || seen.has(uci)) continue;
			seen.add(uci);
			scoredMassBefore += maiaProb.get(uci) ?? 0;
		}
	}
	const metersFor = (
		selfElo: number,
		draw: {
			railedMass: number;
			unscoredMass: number;
			klFromMaia: number;
			maiaRank: number;
			survivors: number;
		},
		verified?: { candidates: number; verifyDepth: number }
	): MaiaMeters => ({
		selfElo,
		entropy,
		railedMass: draw.railedMass,
		unscoredMass: draw.unscoredMass,
		klFromMaia: draw.klFromMaia,
		rank: draw.maiaRank,
		survivors: draw.survivors,
		...(verified === undefined ? {} : verified),
	});
	// Through `MAIA.eloMax`, the human policy draws the move over the engine's
	// scored lines — the main set and the extra `searchmoves` lines the pipeline added for Maia's
	// unscored favourites (`ctx.maiaExtra`, 2026-09-12) alike — with the rails on the engine's raw
	// scores, judged at `maiaE`. No perception jitter and no injected blunder channel here — the
	// population's error rate is in the distribution — so the `b` that would have applied is logged
	// and nothing else of step 6 runs. `null` (nothing scored with enough mass, or the rails emptied
	// the set) falls through to the ordinary policy.
	if (maiaPolicy !== undefined && maiaProb !== undefined && maiaE !== undefined) {
		const cands = ranked.map((r) => toCandidate(r));
		const extra = new Set(ctx.maiaExtra ?? []);
		const getsMated = matedLineFilter(cands, maiaE, rng, rationale);
		// H1: the hang rail ramps in with the rating, one draw per move, and below `cheapViewElo`
		// sees only one ply ahead. `lossCap` inside the draw stays the absolute backstop.
		const hangP = hangRailProbability(maiaE);
		const hangRailOn = hangP >= 1 || (hangP > 0 && rng.chance(hangP));
		const cheapView = maiaE < MAIA.hangRail.cheapViewElo;
		const hangs = (c: Candidate): boolean =>
			hangRailOn &&
			c.lossRaw >= NP.hangPieceLoss &&
			(cheapView ? hangsOutright(ctx.fen, c.uci) : hangsPiece(c.line, c.lossRaw, ctx.fen));
		const railState =
			hangP <= 0
				? `off (E<${MAIA.hangRail.offElo})`
				: hangP >= 1
					? "on"
					: `${hangRailOn ? "fired" : "skipped"} (p=${fmt(hangP, 2)})`;
		rationale.push(
			`maia hang rail: ${railState}${hangRailOn ? `, ${cheapView ? "one-ply" : "deep-PV"} view` : ""}`
		);
		const b = blunderTerms(baselineE, {
			myClockMs: ctx.myClockMs,
			cpStd: populationStd(cands.map((c) => c.cpRaw)),
			blunderScale: ctx.blunderScale,
			state,
			...(ctx.baseMs === undefined ? {} : { baseMs: ctx.baseMs }),
		}).b;
		// H11: the technique prior decides only inside Maia's near-indifference band, and is
		// resolved for that band alone (§7 C1). Kept so the pick's own terms reach the rationale.
		let bandPriors: ResolvedPriors | undefined;
		const tieBreak = (band: readonly string[]): ReadonlyMap<string, number> => {
			const members = new Set(band);
			bandPriors = boostedPriors(usable.filter((line) => members.has(line.pvUci[0] ?? "")));
			// Simplification also applies outside the tie band and in verification. Strip it
			// from this older prior so the plain draw cannot count the same preference twice.
			return new Map(
				[...bandPriors.values].map(([uci, value]) => {
					const factor =
						bandPriors?.terms.get(uci)?.find((t) => t.rule === "endgame-simplification")?.factor ?? 1;
					return [uci, value / factor];
				})
			);
		};
		const byUci = new Map(cands.map((c) => [c.uci, c]));
		const bestSearchedCp = Math.max(...cands.map((c) => searchedCp(c.line)));
		const set = maiaSurvivors(
			cands.map((c) => ({
				uci: c.uci,
				mated: getsMated(c),
				hangs: hangs(c),
				lossRaw: c.lossRaw,
				cpLoss:
					searchedCp(c.line) === bestSearchedCp ? 0 : Math.max(0, bestSearchedCp - searchedCp(c.line)),
				extra: extra.has(c.uci),
			})),
			maiaPolicy,
			maiaE,
			rationale,
			{ scoredMassBefore }
		);
		let draw: MaiaDraw | null = null;
		let verified: { candidates: number; verifyDepth: number } | undefined;
		if (set !== null) {
			const simplification = simplificationFactors(ctx.fen, usable, ctx.phase);
			const exchangeRows = set.survivors.filter((s) => simplification.has(s.uci));
			if (exchangeRows.length > 0)
				rationale.push(
					`endgame simplification: safe piece exchanges weighted (${exchangeRows.map((s) => `${s.uci} ×${fmt(simplification.get(s.uci) ?? 1)}`).join(", ")})`
				);
			// H13 (the free approximation): only when behind, and only inside the tie band, a
			// candidate the opponent must answer precisely — and quietly — is preferred. The proxy is
			// documented on `MAIA.practical`; the band's total mass does not move.
			const P = MAIA.practical;
			const practical: MaiaPractical | undefined =
				P.enabled && topCpRaw <= P.behindCp
					? (band: readonly string[]): ReadonlyMap<string, number> => {
							const out = new Map<string, number>();
							for (const uci of band) {
								const c = byUci.get(uci);
								if (c === undefined) continue;
								let bestOther: number | undefined;
								for (const s of set.survivors) {
									const o = s.uci === uci ? undefined : byUci.get(s.uci);
									if (o !== undefined && (bestOther === undefined || o.cpRaw > bestOther))
										bestOther = o.cpRaw;
								}
								if (bestOther === undefined) {
									out.set(uci, 0);
									continue;
								}
								const sharpness = Math.abs(winProb(c.cpRaw) - winProb(bestOther));
								let trickiness = clamp(sharpness / P.minReplyLoss, 0, 1);
								const replySan = c.line.pvSan[1];
								const reply = c.line.pvUci[1];
								let forcing: boolean | undefined;
								if (replySan !== undefined) forcing = /[x+#]/.test(replySan);
								else if (reply !== undefined) {
									const after = applyMoves(ctx.fen, [uci]);
									const facts = after === null ? null : classifyMove(after, reply);
									if (facts !== null) forcing = facts.isCapture || facts.isCheck;
								}
								if (forcing === true) trickiness *= P.forcingReplyWeight;
								out.set(uci, trickiness);
							}
							return out;
						}
					: undefined;
			// Upper verification can use the available referee evidence if the comparison frame
			// missed the deadline. Lower-range missing-frame behavior remains the plain draw.
			if (
				GENERATE_VERIFY.enabled &&
				(ctx.shallowLines !== undefined || upperVerificationProgress(maiaE) > 0)
			) {
				const shallow = new Map<string, number>();
				for (const l of ctx.shallowLines ?? []) {
					const u = l.pvUci[0];
					if (u !== undefined && !shallow.has(u)) shallow.set(u, cpEffective(l.score));
				}
				if (ctx.shallowLines === undefined)
					rationale.push(
						"upper verification: comparison frame unavailable, using bounded referee scores"
					);
				const gvInput: Omit<GvInput, "rng"> = {
					survivors: set.survivors.map((s) => {
						const sc = shallow.get(s.uci);
						return {
							uci: s.uci,
							p: (set.prob.get(s.uci) ?? 0) * (simplification.get(s.uci) ?? 1),
							deepCp: byUci.get(s.uci)?.cpRaw ?? 0,
							...(sc === undefined ? {} : { shallowCp: sc }),
						};
					}),
					E: maiaE,
					...(ctx.shallowDepth === undefined ? {} : { shallowDepth: ctx.shallowDepth }),
				};
				const gv = generateAndVerify({ ...gvInput, rng });
				if (gv !== null) {
					rationale.push(...gv.rationale);
					rationale.push(
						"generate-verify: tie-band terms (technique prior, practical difficulty) skipped — the verification decides among the candidates"
					);
					// Ordinary verification has an exact law; only the upper band needs Monte Carlo.
					// Its separate seed never advances the game's rng.
					const q = drawDistribution(
						gvInput,
						GENERATE_VERIFY.meterSamples,
						createRng(`gv-meter:${ctx.fen}`)
					);
					draw = maiaDrawRecord(
						set,
						maiaPolicy,
						maiaE,
						gv.uci,
						{ klFromMaia: gvKl(q, set.prob), tieBand: 0, practicalBand: 0 },
						rationale
					);
					verified = { candidates: gv.k, verifyDepth: gv.verifyDepth };
				}
			} else if (GENERATE_VERIFY.enabled) {
				rationale.push("generate-verify: no human-depth frame for this search, plain draw");
			}
			if (draw === null)
				draw = drawMaiaFromSurvivors(set, maiaPolicy, maiaE, rng, rationale, {
					tieBreak,
					simplification,
					...(practical === undefined ? {} : { practical }),
				});
		}
		const pick = draw === null ? undefined : byUci.get(draw.uci);
		if (draw !== null && pick !== undefined) {
			if (draw.tieBand > 0 && bandPriors !== undefined) {
				pick.prior = bandPriors.values.get(pick.uci) ?? 1;
				pick.terms = bandPriors.terms.get(pick.uci) ?? [];
				if (
					conversion.active &&
					[...bandPriors.terms.values()].some((terms) =>
						terms.some((t) => t.rule === "conversion-progress")
					)
				)
					rationale.push("conversion: retaining the win with rating-sensitive progress");
			}
			rationale.push(`maia: no injected blunder channel (b=${fmt(b, 4)} would have applied)`);
			const chosen = finishPick(pick, "maia");
			chosen.maiaProb = draw.p;
			chosen.maiaMeters = metersFor(maiaE, draw, verified);
			return chosen;
		}
	}
	if (ctx.engineResultKind === "unrestricted" && usesMaia(ctx.targetElo)) {
		const cap = maiaMaxCpLoss(maiaE ?? E);
		const leading = ranked[0];
		if (Number.isFinite(cap) && leading !== undefined) {
			const best = searchedCp(leading.line);
			ranked = ranked.filter((r) => searchedCp(r.line) === best || best - searchedCp(r.line) <= cap);
			rationale.push(`upper referee fallback: retaining alternatives within ${fmt(cap, 0)} cp`);
		}
	}
	// Retain native rating variation when Hybrid's custom parameters have saturated;
	// the ordinary gap and explicit-error thresholds can otherwise both reject its choice.
	if (
		ctx.engineResultKind !== "unrestricted" &&
		usesNativeSelection(ctx.selectionMode, E) &&
		pressureReduction === 0
	) {
		if (ctx.selectionMode === "hybrid")
			rationale.push(
				`hybrid: native selection at E≥${C.tau.pivotElo} (UCI_Elo ${requestEloForTarget(ctx.targetElo) ?? "unlimited"})`
			);
		const native = ctx.engineBestmove;
		const hasUnmated = ranked.some((r) => (r.line.score.mate ?? 0) >= 0);
		const idx = ranked.findIndex(
			(r) =>
				native !== undefined &&
				r.line.pvUci[0] === native &&
				!!applyMoves(ctx.fen, [native]) &&
				!(ctx.selectionMode === "hybrid" && hasUnmated && (r.line.score.mate ?? 0) < 0)
		);
		// Stockfish's strength limiter can choose outside the completed MultiPV set.
		// Preserve that legal choice, but never resurrect an evaluated move that a
		// guard removed. Its unknown score must not become a zero-loss observation —
		// nor, with a forced mate on the board (H9), a throw of the win nobody can judge.
		if (idx < 0 && native && !throwWinFilter && !lines.some((line) => line.pvUci[0] === native)) {
			const next = applyMoves(ctx.fen, [native]);
			const board = next ? loadPosition(next) : null;
			const probe: EvalLine = {
				multipv: 0,
				depth: 0,
				score: originalRanks[0]?.score ?? {},
				pvUci: [native],
				pvSan: [],
			};
			// An optimistic score lets the existing repetition guard assess the move
			// without rejecting it merely for lacking a score; it is not used to select.
			const guard = avoidRepetition([...lines, probe], ctx.fen, ctx.history);
			const repetitionVeto = guard.avoided && !guard.lines.includes(probe);
			const drawVeto = bestConversionCp >= C.repetition.aheadCp && board?.isDraw();
			if (board && !repetitionVeto && !drawVeto) {
				rationale.push("engine-elo: legal native bestmove outside the scored candidates");
				return finishPick(
					{
						line: { ...probe, score: {} },
						uci: native,
						rank: 0,
						cpRaw: 0,
						cpEff: 0,
						loss: 0,
						lossRaw: 0,
						prior: 1,
						terms: [],
						mate: undefined,
					},
					"engine-elo"
				);
			}
		}
		const r = ranked[idx >= 0 ? idx : 0];
		if (r === undefined) throw new RangeError("selectMove: no lines");
		rationale.push(
			idx >= 0 ? "engine-elo: bestmove" : "engine-elo: bestmove unavailable or vetoed, top line"
		);
		return finishPick(toCandidate(r), "engine-elo");
	}

	if (ctx.engineResultKind === "unrestricted")
		rationale.push(
			"unrestricted referee fallback: rated sampling, no native strength-limited choice"
		);
	const params = selectionParams(E, state, ctx.phase, ctx.tauScale ?? 1);
	if (rush > 0) {
		params.sigma = sigmaFor(baselineE);
		params.tau += C.opponentPressure.raceTauLift * rush;
		params.gap += C.opponentPressure.raceGapExtraCp * rush;
		rationale.push("opponent-only rush: broader ordinary choices; existing error rate retained");
	}
	rationale.push(
		`σ=${fmt(params.sigma, 1)} τ=${fmt(params.tau)} G=${fmt(params.gap, 0)} β=${params.beta}`
	);
	if (params.streak)
		rationale.push(`streak: ${state.top1Streak} top-1 picks, τ×${C.tau.streakMultiplier}`);
	if (params.endgameTau !== 1) rationale.push(`endgame technique: τ×${params.endgameTau}`);
	if (ctx.selectionMode === "hybrid" && ctx.engineBestmove !== undefined)
		rationale.push(`hybrid: prior(${ctx.engineBestmove}) ×${C.hybridBestmovePrior}`);

	// Step 8's prior reaches the chooser only from here on (§7 C2): the whole usable set, boosted.
	const priors = boostedPriors(usable);
	if (conversion.active)
		rationale.push("conversion: retaining the win with rating-sensitive progress");

	// Steps 2–4: cpEff, jitter, win-probability loss.
	const cands = ranked.map((r) => {
		const c = toCandidate(r, priors);
		c.cpEff = c.cpRaw + rng.normal(0, params.sigma);
		return c;
	});
	let best = Number.NEGATIVE_INFINITY;
	for (const c of cands) best = Math.max(best, c.cpEff);
	const winBest = winProb(best);
	for (const c of cands) c.loss = winBest - winProb(c.cpEff);

	// Step 5: never-play filters.
	const getsMated = matedLineFilter(cands, baselineE, rng, rationale);

	// Step 6: blunder channel.
	const cpStd = populationStd(cands.map((c) => c.cpEff));
	const terms = blunderTerms(baselineE, {
		myClockMs: ctx.myClockMs,
		cpStd,
		blunderScale: maxStrength ? 0 : ctx.blunderScale,
		state,
		...(ctx.baseMs === undefined ? {} : { baseMs: ctx.baseMs }),
	});
	rationale.push(
		`b=${fmt(terms.b, 4)} (b0=${fmt(terms.b0, 4)} f_clock=${fmt(terms.fClock, 2)} f_complexity=${terms.fComplexity} scale=${ctx.blunderScale}${terms.damper !== 1 ? ` damper×${terms.damper}` : ""})`
	);
	if (terms.b > 0 && rng.chance(terms.b)) {
		const { kind, target } = drawTargetLoss(rng);
		const pool = cands
			.filter((c) => !getsMated(c) && c.lossRaw >= C.blunder.minLoss)
			.map((c) => ({ ...c, loss: c.lossRaw }));
		const pick = pickBlunder(pool, target);
		if (pick) {
			rationale.push(`blunder: ${kind} target ${fmt(target)} → loss ${fmt(pick.loss)}`);
			return finishPick(pick, "blunder");
		}
		rationale.push(`blunder: no candidate with loss ≥ ${C.blunder.minLoss}, base policy`);
	}

	// Step 7: base policy within G(E) of the best.
	const rawBest = Math.max(...usable.map(searchedCp));
	const rushLossCap = Math.max(gapFor(baselineE), C.opponentPressure.raceExpandedLossCp);
	let pool = cands.filter(
		(c) =>
			!getsMated(c) &&
			best - c.cpEff <= params.gap &&
			(rush === 0 || rawBest - searchedCp(c.line) <= rushLossCap) &&
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
