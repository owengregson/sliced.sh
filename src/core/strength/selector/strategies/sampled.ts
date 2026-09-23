/**
 * The §7.2 base policy (steps 2–8): perceive every candidate through σ(E) jitter, maybe inject a
 * deliberate error, else sample within G(E) of the best by `exp(−loss/τ)·prior^β`.
 */

import type { ChosenMove } from "@typedefs/game";
import { blunderTerms, drawTargetLoss, pickBlunder } from "../../blunder-model";
import { SELECTION_CONSTANTS as C } from "../../constants";
import { searchedCp } from "../../conversion";
import { gapFor, sigmaFor, winProb } from "../../elo-map";
import { fmt } from "../../format";
import { type Candidate, hangsPiece, matedLineFilter, populationStd } from "../candidate";
import { boostedPriors, finishPick, type SelectionFrame, toCandidate } from "../frame";
import { type SelectionParams, selectionParams } from "../params";

/** Step 7's σ, τ, G and β, with the opponent-only rush lift and their rationale rows. */
function sampledParams(frame: SelectionFrame): SelectionParams {
	const { ctx, rationale, rush, baselineE } = frame;
	const { state } = ctx;
	const params = selectionParams(frame.E, state, ctx.phase, ctx.tauScale ?? 1);
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
	return params;
}

/**
 * Step 6: the blunder channel. Draws its coin (and, when it fires, the target loss); returns the
 * injected error, or `null` when it does not fire or nothing loses enough.
 */
function injectedBlunder(
	frame: SelectionFrame,
	cands: readonly Candidate[],
	getsMated: (c: Candidate) => boolean
): ChosenMove | null {
	const { ctx, rationale, baselineE } = frame;
	const { rng, state } = ctx;
	const cpStd = populationStd(cands.map((c) => c.cpEff));
	const terms = blunderTerms(baselineE, {
		myClockMs: ctx.myClockMs,
		cpStd,
		blunderScale: frame.maxStrength ? 0 : ctx.blunderScale,
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
			return finishPick(frame, pick, "blunder");
		}
		rationale.push(`blunder: no candidate with loss ≥ ${C.blunder.minLoss}, base policy`);
	}
	return null;
}

/** The base policy: always decides (the last strategy in `selectMove`). */
export function selectSampled(frame: SelectionFrame): ChosenMove {
	const { ctx, rationale, usable, rush, baselineE } = frame;
	const { rng } = ctx;
	if (ctx.engineResultKind === "unrestricted")
		rationale.push(
			"unrestricted referee fallback: rated sampling, no native strength-limited choice"
		);
	const params = sampledParams(frame);

	// Step 8's prior reaches the chooser only from here on (§7 C2): the whole usable set, boosted.
	const priors = boostedPriors(frame, usable);
	if (frame.conversion.active)
		rationale.push("conversion: retaining the win with rating-sensitive progress");

	// Steps 2–4: cpEff, jitter, win-probability loss.
	const cands = frame.ranked.map((r) => {
		const c = toCandidate(frame, r, priors);
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
	const blunder = injectedBlunder(frame, cands, getsMated);
	if (blunder) return blunder;

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
	return finishPick(frame, pick, "sampled");
}
