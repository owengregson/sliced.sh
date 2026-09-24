import { describe, expect, it } from "bun:test";
import { EXECUTOR } from "@core/constants/cdp";
import type { ExecutionResult } from "@core/motor/types";
import { outcomeEvent } from "@service/move-executor/executor/events";
import { overridesPace, stamp, undispatched } from "@service/move-executor/executor/results";
import type { Recommendation } from "@typedefs/game";

const rec = {
	chosen: { san: "e4", uci: "e2e4" },
	plan: { mode: "normal", deadlineMs: 10_000, features: {} },
} as unknown as Recommendation;

describe("executor results", () => {
	it("publishes each outcome under its own event", () => {
		for (const o of ["executed", "dispatched", "aborted", "skipped", "failed"] as const)
			expect(outcomeEvent(o)).toBe(o);
	});

	it("reports an undispatched result with no attempts and a fallback end point", () => {
		const r = undispatched("skipped", EXECUTOR.reasons.positionChanged, null, 12);
		expect(r).toEqual({
			ok: false,
			outcome: "skipped",
			reason: EXECUTOR.reasons.positionChanged,
			tier: EXECUTOR.committedTier,
			attempts: 0,
			endPoint: { x: 0, y: 0 },
			elapsedMs: 12,
			timeline: [],
		});
		expect(stamp(rec, r, 99)).toMatchObject({ at: 99, san: "e4" });
	});

	it("overrides the pace for anything but the plan run as planned", () => {
		const ok = { attempts: 1, submittedAt: 10_000 } as ExecutionResult;
		expect(overridesPace(rec, "normal", ok, false)).toBe(false);
		expect(overridesPace(rec, "instant", ok, false)).toBe(true);
		expect(overridesPace(rec, "normal", { ...ok, attempts: 2 }, false)).toBe(true);
		expect(overridesPace(rec, "normal", ok, true)).toBe(true);
		const late = { ...ok, submittedAt: 10_000 + EXECUTOR.approachFitToleranceMs + 1 };
		expect(overridesPace(rec, "normal", late, false)).toBe(true);
		const overrun = {
			...rec,
			plan: { ...rec.plan, features: { preparationOverrunMs: 5 } },
		} as unknown as Recommendation;
		expect(overridesPace(overrun, "normal", ok, false)).toBe(true);
	});
});
