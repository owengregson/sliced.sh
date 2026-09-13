/**
 * The one rating everything about a Maia move agrees on (2026-09-13, §7 B2 and H2/H5 of
 * `docs/research/human-move-selection-ideas-2026-09-13.md`).
 *
 * Before this module the Maia query asked at `effectiveElo(target, form)` while the rails judged
 * at `effectiveElo(target − pressureReduction, form)`, so under opponent clock pressure the two
 * disagreed by up to 100 Elo. Now the pipeline and the selector both call `maiaSelfElo` with the
 * same inputs: the opponent-pressure reduction (`pressureTerms`, the arithmetic `selectMove`
 * always did), the mistakes slider as an Elo offset (`sliderEloOffset`, H2) and the pipeline's
 * context penalty (H5's clock and think terms). Pure.
 */

import { sideToMove } from "@core/chess/fen";
import { isLoneKing } from "@core/chess/material";
import { MAIA } from "@core/constants/maia";
import { clockRacePolicy, opponentClockPressure } from "@core/timing/opponent-pressure";
import { SELECTION_CONSTANTS as C } from "./constants";
import { effectiveElo } from "./elo-map";

/** The clock facts the pressure terms are a function of. */
export interface PressureInput {
	fen: string;
	myClockMs: number;
	oppClockMs: number;
	baseMs?: number | undefined;
	incrementMs?: number | undefined;
}

export interface PressureTerms {
	/** `max(opponentClockPressure, race urgency)` in 0…1. */
	pressure: number;
	/** Ordinary opponent-pressure Elo reduction (≤ `C.opponentPressure.eloReduction`). */
	baselineReduction: number;
	/** The reduction the ordinary policy's E uses (the race term can raise it). */
	pressureReduction: number;
	/** Opponent-only race urgency in 0…1 (0 outside a race). */
	rush: number;
	race: ReturnType<typeof clockRacePolicy>;
}

/** §7.2's opponent-pressure arithmetic, shared by the selector and the pipeline. */
export function pressureTerms(input: PressureInput): PressureTerms {
	const clockContext = {
		ownClockMs: input.myClockMs,
		opponentClockMs: input.oppClockMs,
		baseMs: input.baseMs ?? 0,
		incrementMs: input.incrementMs ?? 0,
	};
	const us = sideToMove(input.fen);
	const race = clockRacePolicy({
		...clockContext,
		loneKing: us !== null && isLoneKing(input.fen, us),
	});
	const pressure = Math.max(opponentClockPressure(clockContext), race?.opponentUrgency ?? 0);
	const baselineReduction =
		pressure >= C.opponentPressure.min ? C.opponentPressure.eloReduction * pressure : 0;
	const rush = race?.opponentOnly && pressure >= C.opponentPressure.min ? race.opponentUrgency : 0;
	const pressureReduction = Math.max(baselineReduction, C.opponentPressure.raceEloReduction * rush);
	return { pressure, baselineReduction, pressureReduction, rush, race };
}

/** H2: the mistakes knob as Elo *below* the target (negative = above). */
export function sliderEloOffset(blunderScale: number): number {
	return MAIA.slider.eloSpan * (Math.max(0, blunderScale) - 1);
}

export interface MaiaEloInput {
	targetElo: number;
	form: number;
	blunderScale: number;
	/** `pressureTerms(...).pressureReduction` for this position. */
	pressureReduction: number;
	/** H5's pipeline-side context penalty (clock and think terms), ≥ 0. Default 0. */
	contextEloPenalty?: number | undefined;
	/** H5's selector-side ambiguity penalty, ≥ 0. Default 0. */
	ambiguityEloPenalty?: number | undefined;
}

/**
 * The rating Maia is asked about and the rails judge at: the target less every reduction, then
 * the form adjustment, floored at `MAIA.context.eloFloor`. The context terms together never
 * exceed `MAIA.context.maxPenalty`.
 */
export function maiaSelfElo(input: MaiaEloInput): number {
	const context = Math.min(
		MAIA.context.maxPenalty,
		Math.max(0, input.contextEloPenalty ?? 0) + Math.max(0, input.ambiguityEloPenalty ?? 0)
	);
	const target =
		input.targetElo - input.pressureReduction - sliderEloOffset(input.blunderScale) - context;
	return Math.max(MAIA.context.eloFloor, effectiveElo(target, input.form));
}
