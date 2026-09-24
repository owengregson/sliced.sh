import { describe, expect, it } from "bun:test";
import { PREMOVE } from "@core/constants/books";
import {
	TIMING_CALIBRATION,
	TIMING_CALIBRATION_IDENTITY,
	TIMING_CALIBRATION_LIMITS,
	TIMING_CALIBRATION_SITUATIONS,
	type TimingCalibrationTable,
} from "@core/constants/timing-calibration";
import { createRng } from "@core/rng";
import {
	calibratedPremoveProbability,
	calibrationSituation,
	calibrationTimeClass,
	interpolateKnots,
	isObviousRecapture,
	obviousRecaptureAvailable,
	premovePropensity,
	thinkShift,
} from "@core/timing/calibration";
import { TimingModel } from "@core/timing/timing-model";
import type { DistributionHead, GameMeta } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { AFTER_EXD5, ctx, line, MODEL_TIMING } from "./helpers";

/** 1.e4 d5 — White to move; `e4d5` takes the pawn. */
const BEFORE_EXD5 = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function table(
	over: Partial<Record<string, readonly number[]>>,
	premove: number[] | null = null,
	budgetPower = 1
) {
	const zero = [0, 0];
	const cls = {
		knots: [1000, 2000],
		budgetPower,
		shift: {
			forced: over.forced ?? zero,
			book: over.book ?? zero,
			recapture: over.recapture ?? zero,
			check: over.check ?? zero,
			ordinary: over.ordinary ?? zero,
		},
		premove: { recapture: premove, other: null },
	};
	return { bullet: cls, blitz: cls, rapid: cls } as TimingCalibrationTable;
}

describe("the calibration table's reader", () => {
	it("interpolates linearly between knots and holds the edge values outside", () => {
		expect(interpolateKnots([1000, 2000], [0, 1], 1500)).toBeCloseTo(0.5, 9);
		expect(interpolateKnots([1000, 2000], [0, 1], 500)).toBe(0);
		expect(interpolateKnots([1000, 2000], [0, 1], 2600)).toBe(1);
		expect(interpolateKnots([], [], 1500)).toBe(0);
	});
	it("clamps a shift to the registry bounds", () => {
		const t = table({ book: [-9, 9] });
		expect(thinkShift("blitz", 1000, "book", t)).toBe(TIMING_CALIBRATION_LIMITS.shiftMin);
		expect(thinkShift("blitz", 2000, "book", t)).toBe(TIMING_CALIBRATION_LIMITS.shiftMax);
	});
	it("uses chess.com's time classes (blitz reaches 10 minutes of estimated duration)", () => {
		expect(calibrationTimeClass(60, 0)).toBe("bullet");
		expect(calibrationTimeClass(180, 2)).toBe("blitz");
		expect(calibrationTimeClass(300, 5)).toBe("blitz");
		expect(calibrationTimeClass(600, 5)).toBe("rapid");
		expect(calibrationTimeClass(600, 0)).toBe("rapid");
	});
	it("scales a calibrated premove probability by the persona around the population mean", () => {
		const t = table({}, [0.2, 0.6]);
		expect(calibratedPremoveProbability("blitz", 2000, "recapture", 0.5, t)).toBeCloseTo(0.6, 9);
		expect(calibratedPremoveProbability("blitz", 2000, "recapture", 0.75, t)).toBeCloseTo(0.9, 9);
		expect(calibratedPremoveProbability("blitz", 2000, "recapture", 1, t)).toBe(1);
		expect(calibratedPremoveProbability("blitz", 1500, "recapture", 0.25, t)).toBeCloseTo(0.2, 9);
		expect(calibratedPremoveProbability("blitz", 2000, "other", 0.5, t)).toBeNull();
		expect(premovePropensity("blitz", 2000, 0.5, t)).toEqual({
			trade: 0.6,
			tradeReplyMinProb: PREMOVE.tradeReplyMinProb,
		});
		expect(premovePropensity("blitz", 2000, 0.5, TIMING_CALIBRATION_IDENTITY)).toEqual({});
	});
	it("ships a table whose every array has one value per knot", () => {
		for (const cls of Object.values(TIMING_CALIBRATION)) {
			for (const s of TIMING_CALIBRATION_SITUATIONS)
				expect(cls.shift[s]).toHaveLength(cls.knots.length);
			for (const p of [cls.premove.recapture, cls.premove.other])
				if (p !== null) expect(p).toHaveLength(cls.knots.length);
			expect([...cls.knots].sort((a, b) => a - b)).toEqual([...cls.knots]);
		}
	});
});

describe("situations", () => {
	it("takes the most specific situation first", () => {
		const base = { isOnlyLegal: false, inBook: false, obviousRecapture: false, inCheck: false };
		expect(calibrationSituation({ ...base, isOnlyLegal: true, inBook: true })).toBe("forced");
		expect(calibrationSituation({ ...base, inBook: true, obviousRecapture: true })).toBe("book");
		expect(calibrationSituation({ ...base, obviousRecapture: true, inCheck: true })).toBe(
			"recapture"
		);
		expect(calibrationSituation({ ...base, inCheck: true })).toBe("check");
		expect(calibrationSituation(base)).toBe("ordinary");
	});
	it("recognises an obvious, material-restoring recapture of a capture", () => {
		expect(isObviousRecapture(BEFORE_EXD5, "e4d5", AFTER_EXD5, "d8d5")).toBe(true);
		expect(obviousRecaptureAvailable(BEFORE_EXD5, "e4d5", AFTER_EXD5)).toBe(true);
		// Not a recapture, or no prior position to compare with.
		expect(isObviousRecapture(BEFORE_EXD5, "e4d5", AFTER_EXD5, "g8f6")).toBe(false);
		expect(isObviousRecapture(null, "e4d5", AFTER_EXD5, "d8d5")).toBe(false);
	});
	it("does not call it a recapture when the opponent's move was not a capture", () => {
		const prior = "rnbqkbnr/pppp1ppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 2";
		const fen = "rnbqkbnr/pppp1ppp/8/4p3/6N1/8/PPPPPPPP/RNBQKB1R b KQkq - 2 2";
		// Nf3-g4 lands on g4; nothing was taken, so taking it is not "restoring" anything.
		expect(isObviousRecapture(prior, "f3g4", fen, "d8g5")).toBe(false);
		expect(obviousRecaptureAvailable(prior, "f3g4", fen)).toBe(false);
	});
	it("does not call a losing recapture obvious (queen takes a defended pawn back)", () => {
		// 1.e4 d5 2.exd5 with a white knight on c3 defending d5 is not modelled here; instead a
		// pawn takes a pawn that a rook recaptures into a defended square: balance drops.
		const prior = "4k3/8/8/3p4/4P3/8/8/3RK3 w - - 0 1";
		const fen = "4k3/8/8/3P4/8/8/8/3RK3 b - - 0 1";
		expect(isObviousRecapture(prior, "e4d5", fen, "e8d7")).toBe(false);
	});
});

const meta: GameMeta = {
	targetElo: 2600,
	profile: "balanced",
	baseSec: 180,
	incSec: 0,
	site: "chesscom",
	gameId: "calib",
};

function plan(t: TimingCalibrationTable, over: Parameters<typeof ctx>[0] = {}, seed = "c") {
	const m = new TimingModel(new V1ParametricHead(), MODEL_TIMING, createRng(seed), {
		calibration: t,
	});
	m.startGame({ ...meta, gameId: seed });
	return m.planMove(ctx({ targetElo: 2600, ...over }));
}

describe("the calibration stage of planMove", () => {
	it("leaves every plan unchanged under the identity table", () => {
		for (let i = 0; i < 20; i++) {
			const a = plan(TIMING_CALIBRATION_IDENTITY, {}, `id-${i}`);
			const b = plan(table({}), {}, `id-${i}`);
			expect(b.thinkMs).toBe(a.thinkMs);
			expect(b.features.calibrationShift).toBe(0);
		}
	});
	it("shortens the situation's think by the table's shift, never below the physical gesture", () => {
		const half = table({ ordinary: [Math.log(0.5), Math.log(0.5)] });
		let shorter = 0;
		for (let i = 0; i < 40; i++) {
			const a = plan(TIMING_CALIBRATION_IDENTITY, {}, `s-${i}`);
			const b = plan(half, {}, `s-${i}`);
			expect(b.features.calibrationSituation).toBe(TIMING_CALIBRATION_SITUATIONS.indexOf("ordinary"));
			expect(b.features.calibrationShift).toBeCloseTo(Math.log(0.5), 9);
			expect(b.thinkMs).toBeLessThanOrEqual(a.thinkMs + 1e-6);
			expect(b.thinkMs).toBeGreaterThanOrEqual(b.window.approachMs);
			if (b.thinkMs < a.thinkMs * 0.8) shorter++;
		}
		expect(shorter).toBeGreaterThan(30);
	});
	it("records a book move's situation", () => {
		const p = plan(table({}), { inBook: true, ply: 10 }, "book");
		expect(p.features.calibrationSituation).toBe(TIMING_CALIBRATION_SITUATIONS.indexOf("book"));
	});
	it("shifts only the situation the table names", () => {
		const onlyRecapture = table({ recapture: [Math.log(0.5), Math.log(0.5)] });
		for (let i = 0; i < 10; i++) {
			const a = plan(TIMING_CALIBRATION_IDENTITY, {}, `o-${i}`);
			const b = plan(onlyRecapture, {}, `o-${i}`);
			expect(b.thinkMs).toBe(a.thinkMs);
		}
	});
	it("classifies an obvious recapture from the prior position", () => {
		const recap = {
			fen: AFTER_EXD5,
			myColor: "b" as const,
			ply: 3,
			moves: ["e2e4", "d7d5", "e4d5"],
			chosenMove: "d8d5",
			priorFen: BEFORE_EXD5,
			lines: [line(1, -10, "d8d5", "b1c3"), line(2, -320, "g8f6", "d5c6")],
		};
		const p = plan(TIMING_CALIBRATION_IDENTITY, recap, "r");
		expect(p.features.calibrationSituation).toBe(TIMING_CALIBRATION_SITUATIONS.indexOf("recapture"));
		const noPrior = plan(TIMING_CALIBRATION_IDENTITY, { ...recap, priorFen: null }, "r");
		expect(noPrior.features.calibrationSituation).toBe(
			TIMING_CALIBRATION_SITUATIONS.indexOf("ordinary")
		);
	});
	it("budgetPower 0 plans the learned sample instead of the budget-compressed one", () => {
		// A learned head whose samples (8 s, clock-conditioned) exceed the move budget's target.
		const head: DistributionHead = {
			id: "chessmimic",
			sample: () => ({ tSec: 8, mode: "normal", includesExecution: true, why: [] }),
			median: () => 8,
			mean: () => 8,
		};
		const run = (t: TimingCalibrationTable) => {
			const m = new TimingModel(head, MODEL_TIMING, createRng("power"), { calibration: t });
			m.startGame({ ...meta, gameId: "power" });
			return m.planMove(ctx({ targetElo: 2600 }));
		};
		const a = run(TIMING_CALIBRATION_IDENTITY);
		const b = run(table({}, null, 0));
		expect(a.features.comp ?? 1).toBeLessThan(0.9);
		expect(a.thinkMs).toBeLessThan(6000);
		expect(b.thinkMs).toBeCloseTo(8000, -1);
	});
	it("fades a positive shift out as the own clock runs down", () => {
		const longer = table({ ordinary: [1, 1] });
		const L = TIMING_CALIBRATION_LIMITS;
		const at = (fraction: number) => {
			const clock = { myClockMs: fraction * 180_000, oppClockMs: 120_000 };
			return plan(longer, clock, "fade").features.calibrationShift ?? Number.NaN;
		};
		expect(at(0.9)).toBeCloseTo(1, 9);
		// The helper's clock is 3+0: chess.com blitz.
		expect(at(L.shiftClockZero.blitz / 2)).toBe(0);
		const mid = (L.shiftClockZero.blitz + L.shiftClockFull.blitz) / 2;
		expect(at(mid)).toBeCloseTo(0.5, 6);
		// A negative shift (a faster reply) is never faded.
		const faster = table({ ordinary: [-0.5, -0.5] });
		expect(
			plan(faster, { myClockMs: 5_000, oppClockMs: 120_000 }, "fade").features.calibrationShift
		).toBeCloseTo(-0.5, 9);
	});
});
