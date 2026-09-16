import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { computeFeatures } from "@core/timing/features";
import { createMoveBudget } from "@core/timing/move-budget";
import { samplePersona } from "@core/timing/persona-latents";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx, MODEL_TIMING } from "./helpers";

const ENDING = "8/4k3/5pp1/7p/7P/5PP1/4K3/8 w - - 0 60";
const RATINGS = [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3800];

describe("rating and clock allocation", () => {
	it("allocates selectively: familiarity buys time for a difficult decision at every rating", () => {
		for (const targetElo of RATINGS) {
			const p = samplePersona("selection", "balanced", targetElo);
			const f = computeFeatures(ctx({ targetElo }));
			const routine = createMoveBudget({ ...f, n_reasonable: 1, ln_n_reasonable: 0 }, p);
			const difficult = createMoveBudget(
				{ ...f, n_reasonable: 6, ln_n_reasonable: Math.log(6), swing_bad: 1.5 },
				p
			);
			const memorized = createMoveBudget({ ...f, in_book: 1 }, p);
			expect(difficult.targetSec).toBeGreaterThan(routine.targetSec);
			expect(memorized.targetSec).toBeLessThan(difficult.targetSec);
			expect(difficult.capSec).toBeGreaterThan(routine.capSec);
		}
	});
	it("an engine-only forced tactic is not treated as a reflex, and missing PVs are not a single known choice", () => {
		const p = samplePersona("forced", "balanced", 2400);
		const f = computeFeatures(ctx({ targetElo: 2400 }));
		const tactic = createMoveBudget(
			{ ...f, is_forced: 1, is_recapture: 0, n_reasonable: 1, ln_n_reasonable: 0 },
			p
		);
		expect(tactic.recognition).toBe(0);
		expect(tactic.complexity).toBeGreaterThan(0.6);
		expect(
			createMoveBudget({ ...f, analysis_lines: 0, n_reasonable: 1, ln_n_reasonable: 0 }, p).complexity
		).toBeGreaterThan(0);
	});
	it("a continuous late-game horizon leaves usable time through 110 moves in 3+0 and longer controls", () => {
		for (const targetElo of RATINGS)
			for (const [baseSec, incSec] of [
				[180, 0],
				[300, 0],
				[180, 2],
				[600, 5],
				[1800, 0],
			] as const) {
				const gameId = `long-${targetElo}-${baseSec}-${incSec}`;
				const model = new TimingModel(new V1ParametricHead(), MODEL_TIMING, createRng(gameId));
				model.startGame({ gameId, targetElo, profile: "balanced", baseSec, incSec, site: "chesscom" });
				let clock = baseSec * 1000;
				for (let move = 0; move < 110; move++) {
					const context = ctx({
						targetElo,
						baseSec,
						incSec,
						myClockMs: clock,
						oppClockMs: baseSec * 1000,
						ply: move * 2,
						inBook: move < 5,
						...(move >= 30 ? { fen: ENDING, chosenMove: "e2d2", lines: [] } : {}),
					});
					const plan = model.planMove(context);
					expect(Number.isFinite(plan.thinkMs)).toBe(true);
					expect(plan.thinkMs).toBeGreaterThan(0);
					expect(plan.thinkMs).toBeLessThan(clock);
					clock = clock - plan.thinkMs + incSec * 1000;
				}
				expect(clock).toBeGreaterThan(0);
			}
	}, 60000);
});
