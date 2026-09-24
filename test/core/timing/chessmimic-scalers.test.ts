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
	it("bandRange parses the `<lo>_<hi>` name; bandCentre is the band's population mean", () => {
		expect(bandRange("1500_1600")).toEqual([1500, 1600]);
		// Not the midpoint of the name: for a 100-wide band the two nearly coincide …
		expect(bandCentre("1200_1300")).toBeCloseTo(1251.858, 3);
		expect(Math.abs(bandCentre("1200_1300") - 1250)).toBeLessThan(5);
		// … and for the 1 300-wide top band they do not, which is the whole reason for the change:
		// the midpoint 2850 sent every 2200–2450 target to the band below. The fine-tuned top band's
		// population (chess.com movers rated 2100+, docs/models.md §9) has mean 2632.6.
		expect(bandCentre("2200_3500")).toBeCloseTo(2632.595, 3);
		// A band with no scalers falls back to the midpoint of its name.
		expect(bandCentre("900_1000", {})).toBe(950);
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
		const z = (band: string, rating: number): number =>
			standardiseInputs({ band, rating, playerClockS: 1, opponentClockS: 1, incrementS: 0 })
				.scaledRating;
		// A 100-Elo band's rating std is ≈ 27, so the clamp puts *any* target within 2.5 std of what
		// the band saw — that is the whole point of clamping rather than extrapolating.
		for (const band of CHESSMIMIC_BANDS)
			if (bandRange(band)[1] - bandRange(band)[0] === 100)
				for (const rating of [0, 1000, 1550, 3000]) expect(Math.abs(z(band, rating))).toBeLessThan(2.5);
		// `2200_3500` is the exception: one model for everything above 2200, 1 300 Elo wide. Upstream
		// fitted it on a population of 2357 ± 126.7, so a 3000 target was +5.07 std out; the
		// fine-tuned band (docs/models.md §9) was refitted on chess.com movers rated 2100+ with the
		// scaler 2632.6 ± 280.1, which puts 3000 at +1.31. Pinned so that a re-export which changed
		// the scaler would show up here.
		expect(z("0_1000", 400)).toBeCloseTo(
			(400 - CHESSMIMIC_SCALERS["0_1000"].rating.mean) / CHESSMIMIC_SCALERS["0_1000"].rating.std,
			10
		);
		expect(z("0_1000", -500)).toBe(z("0_1000", 0));
		expect(z("2200_3500", 0)).toBeCloseTo(-1.5447, 3);
		expect(z("2200_3500", 1550)).toBeCloseTo(-1.5447, 3);
		expect(z("2200_3500", 2400)).toBeCloseTo(-0.8305, 3);
		expect(z("2200_3500", 3000)).toBeCloseTo(1.3119, 3);
		expect(z("2200_3500", 9999)).toBeCloseTo(3.0973, 3);
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
