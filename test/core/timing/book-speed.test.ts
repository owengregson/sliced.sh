import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { computeFeatures } from "@core/timing/features";
import { createMoveBudget } from "@core/timing/move-budget";
import { samplePersona } from "@core/timing/persona-latents";
import { ratingPace } from "@core/timing/rating-pace";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx, median, START_FEN } from "./helpers";

const opening = (targetElo: number, inBook: boolean, baseSec = 180) =>
	ctx({
		targetElo,
		inBook,
		fen: START_FEN,
		ply: 0,
		baseSec,
		myClockMs: baseSec * 1000,
		oppClockMs: baseSec * 1000,
	});

describe("rating-specific recognition", () => {
	it("interpolates without Elo-band cliffs across the full 400–3800 setting range", () => {
		let previous = ratingPace(400);
		for (let elo = 401; elo <= 3800; elo++) {
			const next = ratingPace(elo);
			for (const key of ["recognition", "selectivity", "discipline"] as const) {
				expect(next[key]).toBeGreaterThanOrEqual(previous[key]);
				expect(next[key] - previous[key]).toBeLessThan(0.002);
			}
			previous = next;
		}
		expect(ratingPace(2800).discipline).toBeGreaterThan(ratingPace(2500).discipline);
	});
	it("reserves progressively more of the opening allocation for later decisions as recognition improves", () => {
		const persona = samplePersona("recognition", "balanced", 1650);
		let previous = Infinity;
		for (const elo of [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3800]) {
			const f = computeFeatures(opening(elo, true));
			const b = createMoveBudget(f, persona);
			expect(b.effort).toBeLessThan(previous);
			expect(b.effort).toBeLessThan(createMoveBudget({ ...f, in_book: 0 }, persona).effort);
			previous = b.effort;
		}
	});
	it("a confirmed book hit is quicker at each time control, with a varied physical gesture", () => {
		for (const baseSec of [60, 180, 600, 1800]) {
			const plans = (inBook: boolean) =>
				Array.from({ length: 60 }, (_, i) => {
					const gameId = `opening-${i}`;
					const model = new TimingModel(
						new V1ParametricHead(),
						DEFAULT_SETTINGS.timing,
						createRng(gameId)
					);
					model.startGame({
						gameId,
						targetElo: 2400,
						profile: "balanced",
						baseSec,
						incSec: 0,
						site: "chesscom",
					});
					return model.planMove(opening(2400, inBook, baseSec)).thinkMs;
				});
			const book = plans(true);
			expect(median(book)).toBeLessThan(median(plans(false)));
			expect(Math.min(...book)).toBeGreaterThanOrEqual(210);
			expect(new Set(book.map(Math.round)).size).toBeGreaterThan(30);
		}
	});
});
