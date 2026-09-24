// test/core/strength/maia-calibration.test.ts — the Maia strength calibration (2026-09-23): the
// chess.com time class, the knot lookup, `temperPolicy`, and the selector reading the table
// (conditioning through `maiaSelfElo`, temperature over the whole answer).
import { describe, expect, it } from "bun:test";
import {
	MAIA_CALIBRATION,
	MAIA_CALIBRATION_TIME_CLASSES,
	type MaiaCalibrationTable,
} from "@core/constants/maia-calibration";
import { temperPolicy } from "@core/policy/maia-policy";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { maiaCalibrationFor, maiaCalibrationTimeClass } from "@core/strength/maia-calibration";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { maiaCalibrationPoint, maiaSelfElo } from "@core/strength/selection-elo";
import type { EvalLine } from "@typedefs/engine";
import { ctx, flatPrior, line, START } from "./helpers";

const TABLE: MaiaCalibrationTable = {
	bullet: [
		[1000, 1300, 1.1],
		[2000, 2100, 0.9],
	],
	blitz: [
		[1000, 1200, 1],
		[2000, 2400, 0.8],
		[2800, 3200, 0.6],
	],
	rapid: [],
};

describe("maiaCalibrationTimeClass — chess.com's classes on base + 40·inc", () => {
	it("splits at 180 s and 600 s", () => {
		expect(maiaCalibrationTimeClass(60_000, 0)).toBe("bullet");
		expect(maiaCalibrationTimeClass(120_000, 1_000)).toBe("bullet"); // 160 s
		expect(maiaCalibrationTimeClass(180_000, 0)).toBe("blitz");
		expect(maiaCalibrationTimeClass(120_000, 2_000)).toBe("blitz"); // 200 s
		expect(maiaCalibrationTimeClass(300_000, 5_000)).toBe("blitz"); // 500 s
		expect(maiaCalibrationTimeClass(600_000, 0)).toBe("rapid");
		expect(maiaCalibrationTimeClass(900_000, 10_000)).toBe("rapid");
	});
	it("an unknown clock falls back to blitz", () => {
		expect(maiaCalibrationTimeClass(undefined, undefined)).toBe("blitz");
		expect(maiaCalibrationTimeClass(0, 0)).toBe("blitz");
		expect(maiaCalibrationTimeClass(Number.NaN, undefined)).toBe("blitz");
	});
});

describe("maiaCalibrationFor — the knots", () => {
	it("interpolates linearly between knots", () => {
		const mid = maiaCalibrationFor(1500, "blitz", TABLE);
		expect(mid.conditioningElo).toBeCloseTo(1800, 9);
		expect(mid.temperature).toBeCloseTo(0.9, 9);
		const upper = maiaCalibrationFor(2400, "blitz", TABLE);
		expect(upper.conditioningElo).toBeCloseTo(2800, 9);
		expect(upper.temperature).toBeCloseTo(0.7, 9);
	});
	it("keeps the edge offset (slope 1) and the edge temperature outside the knots", () => {
		expect(maiaCalibrationFor(600, "blitz", TABLE)).toEqual({ conditioningElo: 800, temperature: 1 });
		expect(maiaCalibrationFor(3000, "blitz", TABLE)).toEqual({
			conditioningElo: 3400,
			temperature: 0.6,
		});
	});
	it("is the identity for a class with no knots", () => {
		expect(maiaCalibrationFor(1700, "rapid", TABLE)).toEqual({
			conditioningElo: 1700,
			temperature: 1,
		});
	});
	it("the shipped table is well-formed: ascending targets, positive temperatures", () => {
		for (const tc of MAIA_CALIBRATION_TIME_CLASSES) {
			const knots = MAIA_CALIBRATION[tc];
			expect(knots.length).toBeGreaterThan(0);
			for (let i = 0; i < knots.length; i++) {
				const k = knots[i];
				expect(k?.[2]).toBeGreaterThan(0);
				if (i > 0) expect(k?.[0]).toBeGreaterThan(knots[i - 1]?.[0] ?? Number.NEGATIVE_INFINITY);
			}
		}
	});
});

describe("temperPolicy", () => {
	const P: PolicyResult = {
		moves: [
			["e2e4", 0.6],
			["d2d4", 0.3],
			["g1f3", 0.1],
		],
		wdl: [0.3, 0.4, 0.3],
		size: "79m",
	};
	it("returns the policy itself at T = 1 and for a non-positive T", () => {
		expect(temperPolicy(P, 1)).toBe(P);
		expect(temperPolicy(P, 0)).toBe(P);
		expect(temperPolicy(P, Number.NaN)).toBe(P);
	});
	it("is p^(1/T) renormalised over every move, sorted, the rest of the answer kept", () => {
		const cool = temperPolicy(P, 0.5);
		const sum = 0.36 + 0.09 + 0.01;
		expect(cool.moves.map(([u]) => u)).toEqual(["e2e4", "d2d4", "g1f3"]);
		expect(cool.moves[0]?.[1]).toBeCloseTo(0.36 / sum, 12);
		expect(cool.moves[2]?.[1]).toBeCloseTo(0.01 / sum, 12);
		expect(cool.wdl).toEqual(P.wdl);
		expect(P.moves[0]?.[1]).toBe(0.6); // the input is not mutated
		const hot = temperPolicy(P, 2);
		expect(hot.moves[2]?.[1]).toBeGreaterThan(0.1);
	});
});

describe("maiaSelfElo — conditioning through the calibration", () => {
	const base = { form: 0, blunderScale: 1, pressureReduction: 0 };
	it("conditions at the calibrated rating of the game's time class", () => {
		const blitz = { ...base, targetElo: 1500, baseMs: 180_000, incrementMs: 0, calibration: TABLE };
		expect(maiaSelfElo(blitz)).toBe(1800);
		expect(maiaSelfElo({ ...blitz, baseMs: 60_000 })).toBe(1700); // bullet: 1300→2100 at 1500
	});
	it("the context terms and form move the calibrated rating, not the raw target", () => {
		const input = {
			...base,
			targetElo: 2000,
			baseMs: 180_000,
			calibration: TABLE,
			contextEloPenalty: 100,
			pressureReduction: 50,
		};
		expect(maiaSelfElo(input)).toBe(2250);
		expect(maiaSelfElo({ ...input, form: 1 })).toBe(2400);
	});
	it("the mistakes slider moves along the calibrated curve", () => {
		// slider 2 = 250 below the target: 1750 on the curve → 2100.
		const input = { ...base, targetElo: 2000, blunderScale: 2, baseMs: 180_000, calibration: TABLE };
		expect(maiaSelfElo(input)).toBe(2100);
		expect(maiaCalibrationPoint(input).temperature).toBeCloseTo(0.85, 9);
	});
});

describe("selectMove — the calibrated temperature reshapes the draw", () => {
	const LINES: EvalLine[] = [
		line(START, "e2e4", { cp: 30 }, 1),
		line(START, "d2d4", { cp: 25 }, 2),
		line(START, "g1f3", { cp: 20 }, 3),
		line(START, "c2c4", { cp: 15 }, 4),
	];
	const MAIA: PolicyResult = {
		moves: [
			["e2e4", 0.4],
			["d2d4", 0.3],
			["g1f3", 0.2],
			["c2c4", 0.1],
		],
		wdl: [0.3, 0.4, 0.3],
		size: "79m",
	};
	const share = (table: MaiaCalibrationTable, n: number): number => {
		const rng = createRng("calibrated-T");
		let top = 0;
		for (let i = 0; i < n; i++) {
			const c = ctx({
				targetElo: 1500,
				maia: MAIA,
				maiaCalibration: table,
				rng,
				state: createSelectionState(),
			});
			if (selectMove(LINES, c, flatPrior(LINES)).uci === "e2e4") top++;
		}
		return top / n;
	};
	it("a cooler table plays the favourite more often, and says so in the rationale", () => {
		const cool: MaiaCalibrationTable = {
			bullet: [[1500, 1500, 0.4]],
			blitz: [[1500, 1500, 0.4]],
			rapid: [[1500, 1500, 0.4]],
		};
		const identity: MaiaCalibrationTable = {
			bullet: [[1500, 1500, 1]],
			blitz: [[1500, 1500, 1]],
			rapid: [[1500, 1500, 1]],
		};
		const coolShare = share(cool, 600);
		const rawShare = share(identity, 600);
		// p^(1/T) renormalised: 0.4 raw; 0.4^2.5 / Σ p^2.5 ≈ 0.590 at T = 0.4.
		const expectedCool = 0.4 ** 2.5 / (0.4 ** 2.5 + 0.3 ** 2.5 + 0.2 ** 2.5 + 0.1 ** 2.5);
		expect(Math.abs(rawShare - 0.4)).toBeLessThan(0.05);
		expect(Math.abs(coolShare - expectedCool)).toBeLessThan(0.05);
		const rationale = selectMove(
			LINES,
			ctx({ targetElo: 1500, maia: MAIA, maiaCalibration: cool }),
			flatPrior(LINES)
		).rationale;
		expect(
			rationale.some((r) => r.startsWith("maia calibration: blitz conditioning 1500 temperature 0.4"))
		).toBe(true);
	});
});
