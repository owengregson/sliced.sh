// Preparation consumes the original turn window; overruns never change its sampled target.
import { describe, expect, it } from "bun:test";
import { windowTotalMs } from "@core/timing/move-window";
import { accountPreparation } from "@service/game-session/recommendation";
import type { TimingMode, TimingPlan } from "@typedefs/timing";

const ARRIVED = 1_700_000_000_000;
function plan(thinkMs: number, mode: TimingMode): TimingPlan {
	const approachMs = Math.min(600, thinkMs);
	return {
		thinkMs,
		mode,
		deadlineMs: ARRIVED + thinkMs,
		preMoveHoverMs: thinkMs - approachMs,
		dragDurationMs: Math.min(300, approachMs),
		orientationMs: 0,
		features: {},
		rationale: [],
		window: {
			orientationMs: 0,
			scanMs: thinkMs - approachMs,
			previewMs: 0,
			decisionMs: 0,
			approachMs,
		},
	};
}

describe("preparation inside the original release window", () => {
	it("retains every sampled deadline, phase and duration across short, long and expired windows", () => {
		for (const mode of ["normal", "long", "instant", "premove"] as const)
			for (const thinkMs of [200, 400, 1000, 4000, 20000])
				for (const searchMs of [0, 150, 600, 1500, 4000]) {
					const p = plan(thinkMs, mode);
					const out = accountPreparation(p, ARRIVED + searchMs);
					expect(out.deadlineMs).toBe(p.deadlineMs);
					expect(out.thinkMs).toBe(p.thinkMs);
					expect(out.window).toEqual(p.window);
					expect(windowTotalMs(out.window)).toBe(out.thinkMs);
					expect(out.features.preparationMs).toBe(searchMs);
					expect(out.features.preparationOverrunMs).toBe(
						Math.max(0, searchMs + p.window.approachMs - thinkMs)
					);
				}
	});
	it("reports the shortfall without training a slow search as a longer human think", () => {
		const p = plan(400, "normal");
		const out = accountPreparation(p, ARRIVED + 900);
		expect(out.features.preparationOverrunMs).toBe(900);
		expect(out.rationale.join(" ")).toContain("release target short");
		expect(out.deadlineMs - out.thinkMs).toBe(ARRIVED);
		expect(p.features).toEqual({});
	});
});
