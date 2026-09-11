import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { clockRacePolicy, opponentClockPressure } from "@core/timing/opponent-pressure";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingContext } from "@core/timing/types";
import { ctx } from "./helpers";

const clocks = { ownClockMs: 120_000, opponentClockMs: 3000, baseMs: 180_000, incrementMs: 0 };

function plan(
	opponentClockMs: number,
	incSec = 0,
	overrides: Partial<TimingContext> = {},
	seed = "opponent-pressure"
) {
	const model = new TimingModel(
		{
			id: "chessmimic",
			median: () => 10,
			sample: () => ({ tSec: 10, mode: "normal", why: [] }),
		},
		DEFAULT_SETTINGS.timing,
		createRng(seed)
	);
	model.startGame({
		gameId: "clock-layer",
		site: "chesscom",
		baseSec: 180,
		incSec,
		targetElo: 1650,
		profile: "balanced",
	});
	return model.planMove(ctx({ oppClockMs: opponentClockMs, incSec, ...overrides }));
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
		const urgent = plan(15_000);
		expect(urgent.thinkMs).toBeLessThan(neutral.thinkMs);
		expect(urgent.window.approachMs).toBe(neutral.window.approachMs);
		expect(urgent.dragDurationMs).toBe(neutral.dragDurationMs);
		expect(urgent.thinkMs).toBeLessThanOrEqual((urgent.features.capSec ?? 0) * 1000);
		expect(urgent.features.opponentPressure).toBeGreaterThan(0);
		expect(plan(15_000, 3).thinkMs).toBeGreaterThan(urgent.thinkMs);
	});
});

describe("clock-race execution policy", () => {
	it("skips timing inference latency when the post-layer already requires immediate execution", async () => {
		let prepares = 0;
		const model = new TimingModel(
			{
				id: "chessmimic",
				median: () => 10,
				sample: () => ({ tSec: 10, mode: "normal", why: [] }),
				prepare: async () => {
					prepares++;
				},
			},
			DEFAULT_SETTINGS.timing,
			createRng("prepare-race")
		);
		await model.prepare(ctx({ oppClockMs: 2000 }));
		expect(prepares).toBe(0);
		await model.prepare(ctx());
		expect(prepares).toBe(1);
	});
	it("starts below ten seconds and leaves invalid or untimed contexts unchanged", () => {
		for (const patch of [
			{ opponentClockMs: 10_000 },
			{ opponentClockMs: 60_000 },
			{ opponentClockMs: 0 },
			{ ownClockMs: 0 },
			{ baseMs: 0 },
			{ opponentClockMs: Number.NaN },
			{ incrementMs: -1 },
		])
			expect(clockRacePolicy({ ...clocks, ...patch })).toBeNull();
		expect(clockRacePolicy({ ...clocks, opponentClockMs: 9999 })?.maxMoveMs).toBeLessThan(300);
	});
	it("tightens search and execution as either player runs low; increments reduce opponent urgency", () => {
		const early = clockRacePolicy({ ...clocks, opponentClockMs: 9000 })!;
		const late = clockRacePolicy({ ...clocks, opponentClockMs: 1000 })!;
		const own = clockRacePolicy({ ...clocks, ownClockMs: 1000, opponentClockMs: 60_000 })!;
		expect(late.maxSearchMs).toBeLessThan(early.maxSearchMs);
		expect(late.maxMoveMs).toBeLessThan(early.maxMoveMs);
		expect(late.maxSearchMs).toBeLessThan(50);
		expect(own.maxMoveMs).toBeLessThan(160);
		expect(clockRacePolicy({ ...clocks, incrementMs: 5000 })!.opponentUrgency).toBeLessThan(
			late.opponentUrgency
		);
	});
	it("allows a sub-100ms hand budget without an orientation, preview, or promotion pause", () => {
		const windows = Array.from({ length: 40 }, (_, i) => plan(1000, 0, {}, `race-${i}`));
		expect(Math.min(...windows.map((p) => p.thinkMs))).toBeLessThan(100);
		expect(new Set(windows.map((p) => Math.round(p.thinkMs))).size).toBeGreaterThan(20);
		for (const p of windows) {
			expect(p.thinkMs).toBeLessThan(160);
			expect(p.window.approachMs).toBe(p.thinkMs);
			expect(p.preMoveHoverMs).toBe(0);
			expect(p.orientationMs).toBe(0);
			expect(p.fakeout).toBeUndefined();
			expect(p.promotionDelayMs).toBeUndefined();
			expect(p.features.clockRace).toBeGreaterThan(0.9);
		}
	});
	it("gives a timed lone king the fast path even with ample clocks", () => {
		const king = {
			fen: "7k/8/8/8/8/8/4q3/K7 w - - 0 40",
			chosenMove: "a1b1",
			lines: [],
		};
		const fast = plan(60_000, 0, king);
		expect(fast.thinkMs).toBeLessThanOrEqual(130);
		expect(fast.features.loneKing).toBe(1);
		expect(fast.features.clockRace).toBe(1);
		expect(plan(0, 0, { ...king, myClockMs: 0, baseSec: 0 }).features.clockRace).toBe(0);
	});
	it("does not let the race window consume most of the last fraction of a second", () => {
		const policy = clockRacePolicy({ ...clocks, ownClockMs: 200 })!;
		expect(policy.maxMoveMs).toBeLessThanOrEqual(50);
		expect(policy.minMoveMs).toBeLessThanOrEqual(policy.maxMoveMs);
		expect(policy.maxSearchMs).toBeLessThanOrEqual(50);
	});
});
