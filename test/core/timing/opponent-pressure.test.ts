import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { opponentClockPressure } from "@core/timing/opponent-pressure";
import { TimingModel } from "@core/timing/timing-model";
import { ctx } from "./helpers";

const clocks = { ownClockMs: 120_000, opponentClockMs: 3000, baseMs: 180_000, incrementMs: 0 };

function plan(opponentClockMs: number, incSec = 0) {
	const model = new TimingModel(
		{
			id: "chessmimic",
			median: () => 10,
			sample: () => ({ tSec: 10, mode: "normal", why: [] }),
		},
		DEFAULT_SETTINGS.timing,
		createRng("opponent-pressure")
	);
	model.startGame({
		gameId: "clock-layer",
		site: "chesscom",
		baseSec: 180,
		incSec,
		targetElo: 1650,
		profile: "balanced",
	});
	return model.planMove(ctx({ oppClockMs: opponentClockMs, incSec }));
}

describe("opponent clock policy", () => {
	it("is neutral with ample, unknown, invalid, or untimed clocks", () => {
		for (const patch of [
			{ opponentClockMs: 60_000 },
			{ opponentClockMs: 0 },
			{ ownClockMs: 0 },
			{ baseMs: 0 },
			{ opponentClockMs: Number.NaN },
			{ incrementMs: -1 },
		])
			expect(opponentClockPressure({ ...clocks, ...patch })).toBe(0);
	});
	it("strengthens as the opponent runs out of time and accounts for increment and our clock", () => {
		const urgent = opponentClockPressure(clocks);
		expect(urgent).toBeGreaterThan(0.8);
		expect(urgent).toBeLessThanOrEqual(1);
		expect(opponentClockPressure({ ...clocks, opponentClockMs: 15_000 })).toBeLessThan(urgent);
		expect(opponentClockPressure({ ...clocks, incrementMs: 3000 })).toBeLessThan(urgent);
		expect(opponentClockPressure({ ...clocks, ownClockMs: 1000 })).toBeLessThan(urgent);
		expect(opponentClockPressure({ ...clocks, incrementMs: 10_000 })).toBe(0);
	});
	it("shortens model output without exceeding the existing deadline or compressing the gesture", () => {
		const neutral = plan(60_000);
		const urgent = plan(3000);
		expect(urgent.thinkMs).toBeLessThan(neutral.thinkMs * 0.7);
		expect(urgent.window.approachMs).toBe(neutral.window.approachMs);
		expect(urgent.dragDurationMs).toBe(neutral.dragDurationMs);
		expect(urgent.thinkMs).toBeLessThanOrEqual((urgent.features.capSec ?? 0) * 1000);
		expect(urgent.features.opponentPressure).toBeGreaterThan(0.8);
		expect(plan(3000, 3).thinkMs).toBeGreaterThan(urgent.thinkMs);
	});
});
