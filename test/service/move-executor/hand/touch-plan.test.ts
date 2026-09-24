import { describe, expect, it } from "bun:test";
import { ANTICIPATION, CLICK } from "@core/motor/constants";
import { pathMs } from "@core/motor/geometry";
import { perGameProfile, perMoveProfile, profileFor } from "@core/motor/motor-profile";
import type { ExecutionPlan } from "@core/motor/types";
import { createRng } from "@core/rng";
import { planTouch } from "@service/move-executor/hand/touch-plan";
import type { TimingPlan } from "@typedefs/timing";
import { centre, squareRect } from "../../../core/motor/fixtures";

const FROM = squareRect("b2");
const TO = squareRect("c3");

/** A median anticipated plan: `ANTICIPATION` reaction, grasp and a one-square carry. */
function timing(anticipated: boolean): TimingPlan {
	return {
		thinkMs: 580,
		mode: "instant",
		preMoveHoverMs: 220,
		dragDurationMs: 190,
		deadlineMs: 580,
		rationale: [],
		features: anticipated ? { anticipated: 1 } : {},
		orientationMs: 220,
		window: { orientationMs: 220, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 360 },
	};
}

function touches(anticipated: boolean) {
	return Array.from({ length: 300 }, (_, i) => {
		const rng = createRng(`touch-${i}`);
		const motor = perMoveProfile(
			perGameProfile(profileFor("balanced", "blitz", "recapture"), createRng(`game-${i % 10}`)),
			rng
		);
		const plan = { motor, motorSpeed: 1, expected: { premove: false } } as unknown as ExecutionPlan;
		return planTouch(plan, timing(anticipated), { from: FROM, to: TO }, centre(FROM), rng);
	});
}

describe("the prepared touch of an anticipated reply", () => {
	const prepared = touches(true);
	const ordinary = touches(false);

	it("pauses less before the grab, settles sooner and never hesitates mid-carry", () => {
		for (const t of prepared) {
			expect(t.preGrabMs).toBeGreaterThanOrEqual(ANTICIPATION.touch.preGrabPauseMs[0]);
			expect(t.preGrabMs).toBeLessThanOrEqual(ANTICIPATION.touch.preGrabPauseMs[1]);
			expect(t.settleMs).toBeLessThanOrEqual(ANTICIPATION.touch.releaseSettleMs[1]);
			expect(t.hesitate).toHaveLength(0);
		}
		expect(ordinary.some((t) => t.preGrabMs > ANTICIPATION.touch.preGrabPauseMs[1])).toBe(true);
		expect(Math.max(...ordinary.map((t) => t.preGrabMs))).toBeLessThanOrEqual(
			CLICK.preGrabPauseMs[1]
		);
	});

	it("fits the anticipated plan's approach budget from the hover point, and is still a real drag", () => {
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		const total = prepared.map((t) => t.approachMs + t.touchMs);
		expect(mean(total)).toBeLessThan(mean(ordinary.map((t) => t.approachMs + t.touchMs)));
		expect(mean(total)).toBeLessThanOrEqual(timing(true).window.approachMs + 20);
		for (const t of prepared) {
			expect(t.travel.length).toBeGreaterThan(3);
			expect(pathMs(t.travel)).toBeGreaterThanOrEqual(100);
		}
	});
});
