/**
 * The last stage of `planMove`: divide the composed think into the §8.4b window phases, scale the
 * hand's motor times to the approach they got, and record the diagnostic features the timing log,
 * the line preview and the re-plan rules read back.
 */
import type { Rng } from "@core/rng";
import { featuresToRecord } from "../features";
import type { MoveBudget } from "../move-budget";
import { allocateWindow } from "../move-window";
import type { Features, TimingContext, TimingPlan } from "../types";
import type { ComposedThink } from "./compose";
import type { NormalisedSample } from "./normalise";

export interface AssembleInput {
	ctx: TimingContext;
	f: Features;
	alloc: number;
	budget: MoveBudget;
	/** The head's floored mean (the normalisation's reference). */
	rawMean: number;
	includesExecution: boolean;
	normalised: NormalisedSample;
	composed: ComposedThink;
	/** The AR(1) residual after the head's sample. */
	eps: number;
	rationale: string[];
	rng: Rng;
}

export function assemblePlan(input: AssembleInput): TimingPlan {
	const { ctx, f, budget, normalised, composed } = input;
	const { mode, motor, race, emergency } = composed;
	const thinkMs = composed.totalS * 1000;
	const motorMs = race || mode === "premove" ? thinkMs : Math.min(motor.totalS * 1000, thinkMs);
	const window = allocateWindow(
		{
			thinkMs,
			mode,
			orientationMs: composed.orientationMs,
			motorMs,
			previewCount: mode === "long" ? 1 : 0,
			emergency,
		},
		input.rng
	);
	const motorScale = Math.min(1, window.approachMs / Math.max(1, motor.totalS * 1000));
	const dragDurationMs = mode === "premove" ? 0 : motor.dragS * 1000 * motorScale;
	const features: Record<string, number> = {
		...featuresToRecord(f),
		alloc: input.alloc,
		comp: normalised.comp,
		capSec: composed.capSec,
		budgetTargetSec: normalised.target,
		budgetEffort: budget.effort,
		recognition: budget.recognition,
		complexity: budget.complexity,
		headMeanSec: input.rawMean,
		headSampleSec: normalised.headSampleSec,
		executionIncluded: input.includesExecution ? 1 : 0,
		opponentPressure: composed.opponentPressure,
		clockRace: race?.urgency ?? 0,
		opponentOnlyRace: race?.opponentOnly ? 1 : 0,
		loneKing: race && composed.loneKing ? 1 : 0,
		emergency: emergency ? 1 : 0,
		eps: input.eps,
		bodyMedianMs: normalised.median * 1000,
	};
	const plan: TimingPlan = {
		thinkMs,
		mode,
		preMoveHoverMs: mode === "premove" ? 0 : thinkMs - window.approachMs,
		dragDurationMs,
		deadlineMs: ctx.nowMs + thinkMs,
		rationale: input.rationale,
		features,
		orientationMs: window.orientationMs,
		window,
	};
	if (!race && motor.fakeout && motorScale === 1) plan.fakeout = motor.fakeout;
	if (f.is_promotion)
		plan.promotionPickerExpected = !(ctx.autoQueen && ctx.chosenMove.endsWith("q"));
	if (!race && motor.promoS > 0) plan.promotionDelayMs = motor.promoS * 1000 * motorScale;
	return plan;
}
