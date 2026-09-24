/**
 * Planning the committed touch (§9.3 / §8.4b): the approach, press point, grab, travel, drop and
 * settle of one move, fitted to the plan's `window.approachMs` and `dragDurationMs`, and the
 * promotion picker's reserve. Pure over the injected `Rng` — every draw happens here, in order, so
 * the planning functions are called exactly where the hand used to sample inline.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import {
	ANTICIPATION,
	CLICK,
	FAST_TOUCH,
	PATH,
	PROMOTION_LOOK_DELAY_MS,
	PROMOTION_PICKER_TRAVEL_SQUARES,
	SAMPLING,
} from "@core/motor/constants";
import { lastPoint, pathMs, sampleRange } from "@core/motor/geometry";
import { fastPath, fittsMs, generatePath, grabWobble } from "@core/motor/path-generator";
import { samplePointInRect } from "@core/motor/sampling";
import type { ExecutionPlan, MotorProfile, PathPoint, Pt, Rect } from "@core/motor/types";
import type { Rng } from "@core/rng";
import type { TimingPlan } from "@typedefs/timing";
import type { Rects } from "./geometry";
import { anticipatedTouch, fastTouch } from "./timing";

export interface DragTouch {
	approach: PathPoint[];
	pressAt: Pt;
	preGrabMs: number;
	grabDelayMs: number;
	wobble: PathPoint[];
	travel: PathPoint[];
	drop: Pt;
	hesitate: PathPoint[];
	settleMs: number;
}

/** The committed touch: a drag, always, plus the budgets it was fitted to. */
export type Touch = DragTouch & { approachMs: number; touchMs: number };

export interface PromotionBudget {
	lookMs: number;
	travelMs: number;
	prePressMs: number;
	holdMs: number;
	totalMs: number;
}

/** Uniformly re-time a path to `targetMs`, never faster than the profile's speed cap. */
export function rescalePath(
	path: PathPoint[],
	targetMs: number,
	m: MotorProfile,
	from: Pt
): PathPoint[] {
	const total = pathMs(path);
	if (total <= 0 || path.length === 0) return path;
	const k = Math.min(
		EXECUTOR.travelScaleClamp[1],
		Math.max(EXECUTOR.travelScaleClamp[0], targetMs / total)
	);
	let prev = from;
	return path.map((p) => {
		const step = Math.hypot(p.x - prev.x, p.y - prev.y);
		prev = p;
		const capMs = (step / m.peakSpeedCapPxPerS) * 1000;
		return { x: p.x, y: p.y, dtMs: Math.max(p.dtMs * k, capMs) };
	});
}

/**
 * Fit the approach into what is left of `window.approachMs` after the touch
 * itself (§8.4b item 3), exactly the way the drag leg is fitted to
 * `dragDurationMs`: `rescalePath` re-times the path uniformly, clamped to
 * `EXECUTOR.travelScaleClamp` and never faster than the profile's peak-speed
 * cap. Where the cap makes the budget unreachable the move still overruns —
 * the hand is never made to teleport — and that is logged.
 */
function fitApproach(
	approach: PathPoint[],
	touchMs: number,
	timing: TimingPlan,
	m: MotorProfile,
	cursor: Pt
): { path: PathPoint[]; ms: number } {
	const natural = pathMs(approach);
	const budget = timing.window.approachMs - touchMs;
	if (!(budget > 0)) {
		// No room at all: run the approach as fast as the profile allows and accept the overrun.
		const path = rescalePath(approach, 0, m, cursor);
		const ms = pathMs(path);
		log.debug("hand: approach budget exhausted by the touch", {
			approachMs: timing.window.approachMs,
			touchMs,
			naturalMs: natural,
			fittedMs: ms,
		});
		return { path, ms };
	}
	const path = rescalePath(approach, budget, m, cursor);
	const ms = pathMs(path);
	if (ms > budget + EXECUTOR.approachFitToleranceMs)
		log.debug("hand: approach cannot be compressed to its budget (speed cap)", {
			budgetMs: budget,
			naturalMs: natural,
			fittedMs: ms,
		});
	return { path, ms };
}

/** The urgent touch: straight fast paths split by leg length, no grab, wobble or settle. */
function planFastTouch(timing: TimingPlan, rects: Rects, cursor: Pt, press: Pt, rng: Rng): Touch {
	const drop = samplePointInRect(
		rects.to,
		SAMPLING.release.sigmaFrac,
		SAMPLING.release.innerFrac,
		rng
	);
	const available = timing.window.approachMs > 0 ? timing.window.approachMs : FAST_TOUCH.minBudgetMs;
	// Comfortable own clock: spend the sampled reply window on motion, rather than
	// waiting before an identical 300 ms gesture. Our clock emergencies keep their cap.
	const budget = Math.max(
		FAST_TOUCH.gestureFloorMs,
		(timing.features.opponentOnlyRace ?? 0) > 0
			? available
			: Math.min(FAST_TOUCH.maxBudgetMs, available)
	);
	const approachDistance = Math.hypot(press.x - cursor.x, press.y - cursor.y);
	const dragDistance = Math.hypot(drop.x - press.x, drop.y - press.y);
	const fraction = Math.max(
		FAST_TOUCH.minLegFrac,
		Math.min(FAST_TOUCH.maxLegFrac, approachDistance / (approachDistance + dragDistance || 1))
	);
	const approach = fastPath(cursor, press, budget * fraction);
	const pressAt = lastPoint(approach, press);
	const travel = fastPath(pressAt, drop, budget * (1 - fraction));
	return {
		approach,
		pressAt,
		preGrabMs: 0,
		grabDelayMs: 0,
		wobble: [],
		travel,
		drop,
		hesitate: [],
		settleMs: 0,
		approachMs: pathMs(approach),
		touchMs: pathMs(travel),
	};
}

export function planTouch(
	plan: ExecutionPlan,
	timing: TimingPlan,
	rects: Rects,
	cursor: Pt,
	rng: Rng
): Touch {
	const m = plan.motor;
	const press = samplePointInRect(
		rects.from,
		SAMPLING.press.sigmaFrac,
		SAMPLING.press.innerFrac,
		rng
	);
	// Premove timing describes reaction/queue latency, not a license to compress pointer travel.
	// Entry and reactive fallback both use the normal generated approach and held drag below.
	if (fastTouch(timing) && timing.mode !== "premove" && !plan.expected.premove)
		return planFastTouch(timing, rects, cursor, press, rng);
	const speed = plan.motorSpeed ?? 1;
	const motorTiming = {
		...timing,
		dragDurationMs: timing.dragDurationMs / speed,
		window: { ...timing.window, approachMs: timing.window.approachMs / speed },
	};
	// An anticipated reply: the hand was already resting on the piece and the answer was
	// prepared, so its pauses are shorter and it never hesitates mid-carry. The draws stay in the
	// same order so a plan's stream is the same shape either way.
	const prepared = anticipatedTouch(timing);
	const P = ANTICIPATION.touch;
	const approachRaw = generatePath(cursor, press, rects.from, m, rng);
	const pressAt = lastPoint(approachRaw, press);
	const preGrabMs = sampleRange(prepared ? P.preGrabPauseMs : CLICK.preGrabPauseMs, rng);
	const grabDelayMs = sampleRange(m.grabDelayMs, rng) * (prepared ? P.grabDelayScale : 1);
	const wobble = grabWobble(pressAt, m, rng);
	const wobbleEnd = lastPoint(wobble, pressAt);
	const drop = samplePointInRect(
		rects.to,
		SAMPLING.release.sigmaFrac,
		SAMPLING.release.innerFrac,
		rng
	);
	const raw = generatePath(wobbleEnd, drop, rects.to, m, rng);
	// The anticipated plan's carry (`dragDurationMs`) includes its settle; the drag leg is the rest.
	const carryMs = prepared
		? motorTiming.dragDurationMs - (P.releaseSettleMs[0] + P.releaseSettleMs[1]) / 2
		: motorTiming.dragDurationMs;
	const travel = rescalePath(raw, Math.max(EXECUTOR.minTravelMs, carryMs), m, wobbleEnd);
	const travelEnd = lastPoint(travel, drop);
	const hesitate =
		rng.chance(m.hesitationProb) && !prepared
			? grabWobble(travelEnd, m, rng).map((p) => ({
					...p,
					dtMs: sampleRange(PATH.hesitationWobbleDtMs, rng),
				}))
			: [];
	const settleMs = sampleRange(prepared ? P.releaseSettleMs : m.releaseSettleMs, rng);
	const touchMs =
		preGrabMs + grabDelayMs + pathMs(wobble) + pathMs(travel) + pathMs(hesitate) + settleMs;
	const fitted = fitApproach(approachRaw, touchMs, motorTiming, m, cursor);
	return {
		approach: fitted.path,
		pressAt,
		preGrabMs,
		grabDelayMs,
		wobble,
		travel,
		drop,
		hesitate,
		settleMs,
		approachMs: fitted.ms,
		touchMs,
	};
}

/** Reserve the picker before scheduling the pawn drop; sample its pauses only once. */
export function planPromotion(
	timing: TimingPlan,
	m: MotorProfile,
	to: Rect,
	premove: boolean,
	rng: Rng
): PromotionBudget {
	const urgent = fastTouch(timing);
	const lookMs = urgent
		? 0
		: (timing.promotionDelayMs ??
			sampleRange(m.lookDelayMs[1] > 0 ? m.lookDelayMs : PROMOTION_LOOK_DELAY_MS, rng));
	const travelMs =
		urgent && timing.mode !== "premove" && !premove
			? sampleRange(FAST_TOUCH.promotionTravelMs, rng)
			: fittsMs(
					Math.max(to.width, to.height) * PROMOTION_PICKER_TRAVEL_SQUARES,
					Math.min(to.width, to.height),
					m,
					rng
				);
	const prePressMs = urgent ? 0 : sampleRange(CLICK.prePressPauseMs, rng);
	const holdMs = urgent ? 0 : sampleRange(m.pressHoldMs, rng);
	return { lookMs, travelMs, prePressMs, holdMs, totalMs: lookMs + travelMs + prePressMs + holdMs };
}
