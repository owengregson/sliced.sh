import { describe, expect, it } from "bun:test";
import { windowTotalMs } from "@core/timing/move-window";
import { fitTiming, instantTiming } from "@service/move-executor";
import type { TimingPlan } from "@typedefs/timing";

const plan: TimingPlan = {
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

describe("execution budget fitting", () => {
	it("never inflates a short clock-race, lone-king or premove plan after setup latency", () => {
		for (const flags of [
			{ mode: "normal" as const, features: { clockRace: 1 } },
			{ mode: "normal" as const, features: { loneKing: 1 } },
			{ mode: "premove" as const, features: {} },
		]) {
			const urgent: TimingPlan = {
				...plan,
				...flags,
				thinkMs: 80,
				preMoveHoverMs: 0,
				dragDurationMs: 80,
				window: { orientationMs: 0, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 80 },
			};
			const fitted = fitTiming(urgent, 79);
			expect(fitted.thinkMs).toBe(79);
			expect(windowTotalMs(fitted.window)).toBe(79);
			expect(instantTiming(fitted).thinkMs).toBe(79);
			expect(fitTiming(urgent, 0).thinkMs).toBe(20);
			expect(fitTiming(urgent, -10).window.approachMs).toBe(20);
			const minimal = { ...urgent, thinkMs: 20, window: { ...urgent.window, approachMs: 20 } };
			expect(fitTiming(minimal, -10).thinkMs).toBe(20);
			expect(instantTiming(minimal).thinkMs).toBe(20);
			if (flags.mode === "premove") expect(instantTiming(fitted).mode).toBe("premove");
		}
	});
	it("charges setup delays to the original window and keeps every phase inside it", () => {
		for (const left of [1700, 700, 300]) {
			const fitted = fitTiming(plan, left);
			expect(fitted.thinkMs).toBe(left);
			expect(windowTotalMs(fitted.window)).toBeCloseTo(left, 8);
			expect(fitted.window.approachMs).toBeLessThanOrEqual(left);
			expect(fitted.dragDurationMs).toBeLessThanOrEqual(fitted.window.approachMs);
			expect(fitted.deadlineMs).toBe(plan.deadlineMs);
		}
	});
	it("manual execution drops the thinking window and preserves the complete gesture budget", () => {
		const instant = instantTiming(plan);
		expect(instant.preMoveHoverMs).toBe(0);
		expect(instant.thinkMs).toBe(plan.window.approachMs);
		expect(windowTotalMs(instant.window)).toBe(instant.thinkMs);
		expect(instant.window.scanMs + instant.window.previewMs + instant.window.decisionMs).toBe(0);
	});
});
