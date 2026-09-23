import { describe, expect, it } from "bun:test";
import type { ExecutionPlan, LinePreviewPlan } from "@core/motor/types";
import { planMoveWindow } from "@service/move-executor/hand/move-window";
import type { PromotionBudget } from "@service/move-executor/hand/touch-plan";
import type { TimingPlan } from "@typedefs/timing";

const timing: TimingPlan = {
	thinkMs: 10_000,
	deadlineMs: 20_000,
	mode: "normal",
	preMoveHoverMs: 9200,
	dragDurationMs: 380,
	orientationMs: 400,
	window: { orientationMs: 400, scanMs: 5000, previewMs: 400, decisionMs: 3400, approachMs: 800 },
	features: {},
	rationale: [],
};
const preview: LinePreviewPlan = {
	seed: "s",
	lines: [],
	restBeforeApproachMs: 100,
	reserveMs: 1500,
};
const plan = (over: Partial<ExecutionPlan> = {}): ExecutionPlan =>
	({ expected: { uci: "e2e4", premove: false }, ...over }) as ExecutionPlan;
const promotion: PromotionBudget = {
	lookMs: 300,
	travelMs: 200,
	prePressMs: 100,
	holdMs: 50,
	totalMs: 650,
};

describe("planMoveWindow", () => {
	it("anchors the release on the earlier of the deadline and t0 + thinkMs", () => {
		const w = planMoveWindow(plan(), timing, 12_000, null);
		expect(w.releaseAt).toBe(20_000);
		expect(w.pawnReleaseAt).toBe(20_000);
		expect(w.reservedApproachAt).toBe(19_200);
		expect(w.exploreUntil).toBe(19_200);
		expect(w.exploreMs).toBe(9200);
		expect(w.touchTiming).toBe(timing);
		expect(planMoveWindow(plan(), timing, 5000, null).releaseAt).toBe(15_000);
	});

	it("reserves the promotion picker off the approach budget, never on auto-queen", () => {
		const w = planMoveWindow(plan({ promotion: "n" }), timing, 10_000, promotion);
		expect(w.pawnReleaseAt).toBe(20_000 - 650);
		expect(w.touchTiming.window.approachMs).toBe(150);
		expect(w.reservedApproachAt).toBe(20_000 - 650 - 150);
		const queen = planMoveWindow(
			plan({ promotion: "q" }),
			{ ...timing, promotionPickerExpected: false },
			10_000,
			promotion
		);
		expect(queen.autoQueen).toBe(true);
		expect(queen.pawnReleaseAt).toBe(20_000);
	});

	it("takes a line preview's reserve off exploration, and never draws one on an instant plan", () => {
		const w = planMoveWindow(plan({ linePreview: preview }), timing, 10_000, null);
		expect(w.linePreview).toBe(preview);
		expect(w.exploreMs).toBe(9200 - 1500);
		expect(w.exploreUntil).toBe(19_200 - 1500);
		const instant = planMoveWindow(
			plan({ linePreview: preview }),
			{ ...timing, mode: "instant" },
			10_000,
			null
		);
		expect(instant.linePreview).toBeNull();
		const urgent = planMoveWindow(
			plan({ linePreview: preview }),
			{ ...timing, features: { clockRace: 1 } },
			10_000,
			null
		);
		expect(urgent.linePreview).toBeNull();
	});
});
