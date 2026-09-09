// test/core/timing/chessmimic-scalers.test.ts — Task 34: per-band scalers (scalers.pkl → scalers.json)
// and the standardisation the model inputs go through.
import { describe, expect, it } from "bun:test";
import { CHESSMIMIC_BANDS } from "@core/constants/models";
import {
	bandCentre,
	bandRange,
	CHESSMIMIC_SCALERS,
	standardiseInputs,
} from "@core/timing/chessmimic-scalers";
import scalers from "../../../assets/models/chessmimic/scalers.json";
import reference from "../../fixtures/chessmimic-reference.json";

describe("scalers.json", () => {
	it("carries mean/std for rating and the three log clocks of every registered band", () => {
		for (const band of CHESSMIMIC_BANDS) {
			const s = CHESSMIMIC_SCALERS[band];
			expect(s).toEqual(scalers[band]);
			for (const key of [
				"rating",
				"log_player_clock",
				"log_opponent_clock",
				"log_increment",
			] as const) {
				expect(Number.isFinite(s[key].mean)).toBe(true);
				expect(s[key].std).toBeGreaterThan(0);
			}
			// The rating scaler is fitted inside the band: its mean sits in the band's range.
			const [lo, hi] = bandRange(band);
			expect(s.rating.mean).toBeGreaterThan(lo);
			expect(s.rating.mean).toBeLessThan(hi);
			expect(s.rating.std).toBeLessThan(hi - lo);
		}
	});
	it("bandRange / bandCentre parse the `<lo>_<hi>` names", () => {
		expect(bandRange("1500_1600")).toEqual([1500, 1600]);
		expect(bandCentre("1200_1300")).toBe(1250);
	});
});

describe("standardiseInputs", () => {
	it("reproduces the fixture's scaled rating and clock features (rating clamped to the band)", () => {
		let clampedSeen = 0;
		for (const p of reference.positions) {
			const out = standardiseInputs({
				band: p.band,
				rating: p.rating,
				playerClockS: p.playerClockS,
				opponentClockS: p.opponentClockS,
				incrementS: p.incrementS,
			});
			expect(Math.abs(out.scaledRating - p.scaledRating)).toBeLessThan(1e-12);
			for (let i = 0; i < 3; i++)
				expect(Math.abs((out.clockFeatures[i] ?? Number.NaN) - (p.clockFeatures[i] ?? 0))).toBeLessThan(
					1e-12
				);
			const [lo, hi] = bandRange(p.band);
			if (p.rating < lo || p.rating > hi) clampedSeen++;
		}
		expect(clampedSeen).toBeGreaterThan(100);
	});
	it("clamps the rating to the band range so |z| stays inside what the band saw", () => {
		const hi = standardiseInputs({
			band: "1800_1900",
			rating: 2600,
			playerClockS: 100,
			opponentClockS: 100,
			incrementS: 0,
		});
		const edge = standardiseInputs({
			band: "1800_1900",
			rating: 1900,
			playerClockS: 100,
			opponentClockS: 100,
			incrementS: 0,
		});
		expect(hi.scaledRating).toBe(edge.scaledRating);
		const lo = standardiseInputs({
			band: "1200_1300",
			rating: 800,
			playerClockS: 100,
			opponentClockS: 100,
			incrementS: 0,
		});
		expect(lo.scaledRating).toBe(
			standardiseInputs({
				band: "1200_1300",
				rating: 1200,
				playerClockS: 100,
				opponentClockS: 100,
				incrementS: 0,
			}).scaledRating
		);
		for (const band of CHESSMIMIC_BANDS)
			for (const rating of [0, 1000, 1550, 3000]) {
				const z = standardiseInputs({
					band,
					rating,
					playerClockS: 1,
					opponentClockS: 1,
					incrementS: 0,
				}).scaledRating;
				expect(Math.abs(z)).toBeLessThan(2.5);
			}
	});
	it("uses log(clock + 1) with the band's own means and stds", () => {
		const s = CHESSMIMIC_SCALERS["1500_1600"];
		const out = standardiseInputs({
			band: "1500_1600",
			rating: 1550,
			playerClockS: 120,
			opponentClockS: 0,
			incrementS: 2,
		});
		expect(out.clockFeatures[0]).toBeCloseTo(
			(Math.log(121) - s.log_player_clock.mean) / s.log_player_clock.std,
			12
		);
		expect(out.clockFeatures[1]).toBeCloseTo(
			(0 - s.log_opponent_clock.mean) / s.log_opponent_clock.std,
			12
		);
		expect(out.clockFeatures[2]).toBeCloseTo(
			(Math.log(3) - s.log_increment.mean) / s.log_increment.std,
			12
		);
	});
	it("rejects a band that has no scalers", () => {
		expect(() =>
			standardiseInputs({
				band: "900_1000",
				rating: 950,
				playerClockS: 1,
				opponentClockS: 1,
				incrementS: 0,
			})
		).toThrow();
	});
});
