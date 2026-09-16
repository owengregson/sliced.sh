import { describe, expect, it } from "bun:test";
import type { ChessMimicBand } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { remainingMoveWindow, windowTotalMs } from "@core/timing/move-window";
import { freshState, TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx, MODEL_TIMING } from "./helpers";

function makeHead(mass: Array<[number, number]>, band: ChessMimicBand = "2200_3500") {
	const probs = Array<number>(30).fill(0);
	for (const [bucket, weight] of mass) probs[bucket] = weight;
	return new ChessMimicHead({
		infer: async () => ({ probs, band }),
		fallback: new V1ParametricHead(),
	});
}
function model(head: ChessMimicHead, seed: string, speed = 1) {
	const result = new TimingModel(head, { ...MODEL_TIMING, moveTimeScale: speed }, createRng(seed));
	result.startGame({
		gameId: seed,
		targetElo: 2400,
		profile: "balanced",
		baseSec: 180,
		incSec: 0,
		site: "chesscom",
	});
	return result;
}

describe("learned times are complete turn windows", () => {
	it.each([
		{ move: "e7e8q", autoQueen: true, picker: false },
		{ move: "e7e8q", autoQueen: false, picker: true },
		{ move: "e7e8n", autoQueen: true, picker: true },
	])(
		"carries the picker requirement into execution for $move, autoQueen=$autoQueen",
		async ({ move, autoQueen, picker }) => {
			const head = makeHead([[4, 1]]);
			const timing = model(head, `promotion-${move}-${autoQueen}`);
			const context = ctx({
				fen: "6k1/4P3/8/8/8/8/8/6K1 w - - 0 40",
				chosenMove: move,
				lines: [],
				autoQueen,
			});
			await timing.prepare(context);
			const plan = timing.planMove(context);
			expect(plan.promotionPickerExpected).toBe(picker);
			if (picker) expect(plan.promotionDelayMs).toBeGreaterThan(0);
			else expect(plan.promotionDelayMs).toBeUndefined();
			expect(plan.deadlineMs).toBe(context.nowMs + plan.thinkMs);
		}
	);
	it("preserves a continuous subsecond bucket through orientation and execution", async () => {
		const head = makeHead([[0, 1]]);
		const timing = model(head, "total-fast");
		const context = ctx({ targetElo: 2400 });
		await timing.prepare(context);
		const times: number[] = [];
		for (let i = 0; i < 1000; i++) {
			const plan = timing.planMove(context);
			times.push(plan.thinkMs);
			expect(plan.thinkMs).toBeGreaterThanOrEqual(210);
			expect(plan.thinkMs).toBeLessThan(1000);
			expect(plan.thinkMs).toBeCloseTo((plan.features.headSampleSec ?? 0) * 1000, 6);
			expect(plan.orientationMs).toBeGreaterThanOrEqual(150);
			expect(plan.window.approachMs).toBeGreaterThanOrEqual(60);
			expect(windowTotalMs(plan.window)).toBeCloseTo(plan.thinkMs, 6);
			expect(plan.deadlineMs).toBeCloseTo(context.nowMs + plan.thinkMs, 6);
		}
		expect(times.filter((ms) => ms < 500).length / times.length).toBeGreaterThan(0.3);
		expect(times.filter((ms) => ms > 800).length / times.length).toBeGreaterThan(0.2);
	});
	it("a speed change scales feasible duration without creating a floor spike", async () => {
		for (const bucket of [0, 1]) {
			const head = makeHead([[bucket, 1]]);
			const timing = model(head, `fast-setting-${bucket}`, 0.15);
			await timing.prepare(ctx());
			const values = Array.from({ length: 500 }, () => timing.planMove(ctx()).thinkMs);
			expect(new Set(values).size).toBe(500);
			expect(values.filter((v) => v === 250 || v === 210).length).toBe(0);
		}
	});
	it("keeps an affordable long tail after mean budgeting instead of clipping every draw to routine allocation", async () => {
		const head = makeHead([
			[1, 0.9],
			[20, 0.1],
		]);
		const timing = model(head, "tail-room");
		const context = ctx({ targetElo: 2400, myClockMs: 72_000, oppClockMs: 72_000 });
		await timing.prepare(context);
		const plans = Array.from({ length: 1200 }, () => timing.planMove(context));
		expect(plans.filter((p) => p.thinkMs > 10_000).length).toBeGreaterThan(35);
		for (const plan of plans) expect(plan.thinkMs).toBeLessThanOrEqual(18_000);
	});
	it("a subphysical recognition allocation produces varied feasible replies, never a repeated floor", async () => {
		const head = makeHead([[3, 1]]);
		const timing = model(head, "physical-budget", 0.01);
		const context = ctx({ myClockMs: 24_000, oppClockMs: 24_000, inBook: true });
		await timing.prepare(context);
		const plans = Array.from({ length: 100 }, () => timing.planMove(context));
		expect(plans.every((p) => p.mode === "instant")).toBe(true);
		expect(new Set(plans.map((p) => p.thinkMs)).size).toBe(100);
		for (const plan of plans) {
			expect(plan.thinkMs).toBeGreaterThanOrEqual(210);
			expect(plan.thinkMs).toBeLessThan(420);
		}
	});
	it("the head mean describes the actual fast bucket, including wide novice schemas", async () => {
		for (const band of ["0_1000", "2200_3500"] as const) {
			const head = makeHead(
				[
					[0, 0.4],
					[3, 0.6],
				],
				band
			);
			const context = ctx();
			await head.prepare(context);
			const state = freshState("mean");
			state.fen = context.fen;
			state.knobs.sigmaScale = 0;
			const persona = {
				s_game: Math.log(2),
				iota: 0.5,
				pi_p: 0,
				tau: 0.65,
				rho_mirror: 0,
				motor_k: 1,
			};
			const f = computeFeatures(context);
			const rng = createRng(`fast-mean-${band}`);
			const sampled = Array.from(
				{ length: 24_000 },
				() => head.sample(f, persona, state, rng, 3).tSec
			);
			const mean = sampled.reduce((a, b) => a + b, 0) / sampled.length;
			expect(Math.abs(mean - head.mean(f, persona, state, 3))).toBeLessThan(0.08);
		}
	});
});

describe("one deadline includes preparation and mandatory hand work", () => {
	const plan = {
		thinkMs: 800,
		deadlineMs: 1800,
		window: { orientationMs: 200, scanMs: 200, previewMs: 0, decisionMs: 100, approachMs: 300 },
	};
	it("reserves execution and optional-action cleanup without extending the sampled duration", () => {
		expect(remainingMoveWindow(plan, 1400, 350)).toEqual({
			elapsedMs: 400,
			remainingMs: 400,
			executionReserveMs: 350,
			executeByMs: 1450,
			optionalMs: 50,
			overrunMs: 0,
		});
		expect(plan.thinkMs).toBe(800);
	});
	it("preserves 80 ms remaining without adding a new floor or hiding physical overrun", () => {
		const room = remainingMoveWindow(plan, 1720, 200);
		expect(room.remainingMs).toBe(80);
		expect(room.optionalMs).toBe(0);
		expect(room.overrunMs).toBe(120);
		expect(room.executeByMs).toBe(1600);
		expect(remainingMoveWindow(plan, 1850, 200).overrunMs).toBe(250);
	});
});
