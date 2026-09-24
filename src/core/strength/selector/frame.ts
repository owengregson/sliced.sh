/**
 * The shared record every selection stage reads: the ratings the clocks leave, the guarded and
 * ranked lines, and the rationale the stages append to. `prepareSelection` builds it (§7.2 step 1
 * plus the repetition and conversion guards); the stages that follow only narrow `ranked`.
 */

import { classifyMove } from "@core/chess/move-classify";
import type { PolicyResult } from "@core/policy/types";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { SELECTION_CONSTANTS as C } from "../constants";
import { type ConversionPool, conversionPool, searchedCp } from "../conversion";
import { cpEffective, effectiveElo, gapFor, winProb } from "../elo-map";
import { fmt } from "../format";
import { isMaxStrength } from "../max-strength";
import { compareLines, rankedLines } from "../quality";
import { avoidRepetition } from "../repetition";
import { pressureTerms } from "../selection-elo";
import type { SelectionContext } from "../types";
import type { Candidate, RankedLine } from "./candidate";
import { legalLines } from "./candidate";
import { finish } from "./finish";
import { type ResolvedPriors, resolvePriorsDetailed } from "./priors";

/** What `prepareSelection` derives once per position, before any stage draws. */
export interface SelectionInput {
	/** The engine's lines as handed in (the quality reference and the original ranks). */
	lines: readonly EvalLine[];
	ctx: SelectionContext;
	prior: ReadonlyMap<string, number> | undefined;
	/** `pressureTerms(...)` for this position. */
	pressure: number;
	pressureReduction: number;
	rush: number;
	/** E before the race term: forced-loss and deliberate-error rules keep this rating. */
	baselineE: number;
	/** E with the full pressure reduction: the ordinary policy's rating. */
	E: number;
	maxStrength: boolean;
	conversion: ConversionPool;
	bestConversionCp: number;
	/** The guarded lines with a move: what every stage chooses among. */
	usable: EvalLine[];
	/** `usable` by actual engine score (ties by input order). */
	rankedAll: RankedLine[];
	/** `lines` by actual engine score, for the 1-based `Candidate.rank`. */
	originalRanks: EvalLine[];
	topCpRaw: number;
	winTopRaw: number;
	rationale: string[];
}

/** The Maia rating the selector judges a Maia move at (see `maia-rating.ts`). */
export interface MaiaRating {
	/** `maiaSelfElo` with the ambiguity (and any tilt) term; undefined outside Maia mode. */
	maiaE: number | undefined;
	/**
	 * The policy at the calibrated temperature (`MAIA_CALIBRATION`, 2026-09-23): what the rails,
	 * verification and the draw read in place of `ctx.maia`. Undefined outside Maia mode.
	 */
	policy: PolicyResult | undefined;
	/** The policy's normalised entropy (0 outside Maia mode) — the model's own, not the tempered. */
	entropy: number;
}

export interface SelectionFrame extends SelectionInput {
	maia: MaiaRating;
	/** The candidates the stages still consider; the mate guard and referee cap narrow it. */
	ranked: RankedLine[];
	/** H9: a forced mate is on the board, so a line that throws the win is out. */
	throwWinFilter: boolean;
}

/** §7.2 step 1 and the pool guards: everything the stages share, before any draw. */
export function prepareSelection(
	lines: readonly EvalLine[],
	ctx: SelectionContext,
	prior: ReadonlyMap<string, number> | undefined
): SelectionInput {
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
	return {
		lines,
		ctx,
		prior,
		pressure,
		pressureReduction,
		rush,
		baselineE,
		E,
		maxStrength,
		conversion,
		bestConversionCp,
		usable,
		rankedAll,
		originalRanks,
		topCpRaw,
		winTopRaw,
		rationale,
	};
}

/**
 * §7 C1: the heuristic prior walks every PV through chess.js, so it is resolved lazily — over
 * the whole set only when the base policy samples, over the tie band alone in Maia mode. The
 * best usable line always rides along because the prior's environment is relative to it.
 */
export function boostedPriors(frame: SelectionInput, subset: readonly EvalLine[]): ResolvedPriors {
	const { ctx, conversion, bestConversionCp, pressure, pressureReduction } = frame;
	const priorCtx = { ...ctx, targetElo: ctx.targetElo - pressureReduction };
	const bestUsable = frame.rankedAll[0]?.line;
	const bestProgress = Math.max(...frame.usable.map((line) => conversion.progress.get(line) ?? 0));
	const withBest =
		bestUsable === undefined || subset.includes(bestUsable) ? subset : [bestUsable, ...subset];
	const priors = resolvePriorsDetailed(withBest, priorCtx, frame.prior);
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
}

/** A ranked line as a candidate: its original rank, raw loss and (when resolved) its prior. */
export function toCandidate(
	frame: SelectionInput,
	r: RankedLine,
	priors?: ResolvedPriors
): Candidate {
	const uci = r.line.pvUci[0] ?? "";
	return {
		line: r.line,
		uci,
		rank: frame.originalRanks.findIndex((line) => line.pvUci[0] === uci) + 1,
		cpRaw: r.cpRaw,
		cpEff: r.cpRaw,
		loss: 0,
		lossRaw: frame.winTopRaw - winProb(r.cpRaw),
		prior: priors?.values.get(uci) ?? 1,
		terms: priors?.terms.get(uci) ?? [],
		mate: r.line.score.mate,
	};
}

/** `finish` for every stage after the mate guard: an opponent-only rush makes no quality sample. */
export function finishPick(
	frame: SelectionFrame,
	pick: Candidate,
	source: ChosenMove["source"]
): ChosenMove {
	const chosen = finish(pick, source, frame.lines, frame.ctx, frame.rationale);
	if (frame.rush > 0 && chosen.quality?.eligible) {
		chosen.quality.eligible = false;
		chosen.quality.reason = "opponent-rush";
	}
	return chosen;
}
