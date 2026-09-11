import { expect, it } from "bun:test";
import { checkBand } from "@core/strength/bands";
import { checkQualityBand } from "@core/strength/quality-band";
import { EMPTY_STATS, foldMove } from "@service/game-session/stats";
import type { SessionQualitySample } from "@typedefs/game";

function sample(n: number, top: number): SessionQualitySample {
	// A 50% top-1 distribution with loss0 on top moves and104 on alternatives has mean52.
	const mean = (104 * (n - top)) / n;
	return {
		scoredMoves: n,
		top1Pct: (100 * top) / n,
		acpl: mean,
		lossM2: top * mean ** 2 + (n - top) * (104 - mean) ** 2,
	};
}

it("quantifies small-sample false warnings and applies an uncertainty guard", () => {
	let combinations = 1;
	let pointOutside = 0;
	let intervalOutside = 0;
	for (let top = 0; top <= 20; top++) {
		if (top > 0) combinations *= (21 - top) / top;
		const probability = combinations / 2 ** 20;
		const observed = sample(20, top);
		if (!checkBand(1650, observed).inBand) pointOutside += probability;
		if (checkQualityBand(1650, observed).state === "outside") intervalOutside += probability;
	}
	expect(pointOutside).toBeCloseTo(0.823802947998, 10);
	expect(pointOutside ** 3).toBeCloseTo(0.559074939239, 10);
	expect(intervalOutside).toBeCloseTo(0.041389465332, 10);
	expect(checkQualityBand(1650, sample(20, 10)).state).toBe("uncertain");
});

it("uses Wilson rather than a zero-width agreement interval for all-top moves", () => {
	const check = checkQualityBand(1650, { scoredMoves: 20, top1Pct: 100, acpl: 0, lossM2: 0 });
	expect(check.top1Interval?.[0]).toBeCloseTo(83.8875, 3);
	expect(check.top1Interval?.[1]).toBeCloseTo(100, 8);
	expect(check.state).toBe("outside");
});

it("distinguishes a noisy loss point from stable evidence outside the reference", () => {
	const point = { scoredMoves: 20, top1Pct: 50, acpl: 22, lossM2: 100_000 };
	expect(checkQualityBand(1650, point).state).toBe("uncertain");
	expect(checkQualityBand(1650, { ...point, lossM2: 0 }).state).toBe("outside");
	expect(
		checkQualityBand(1650, { scoredMoves: 10_000, top1Pct: 50, acpl: 52, lossM2: 2704 * 10_000 })
			.state
	).toBe("inside");
});

it("requires enough samples and variance provenance", () => {
	expect(checkQualityBand(1650, sample(19, 19)).state).toBe("insufficient");
	expect(checkQualityBand(1650, { scoredMoves: 20, top1Pct: 100, acpl: 0 }).state).toBe(
		"insufficient"
	);
	expect(checkQualityBand(1650, { ...sample(20, 10), lossM2: Number.NaN }).state).toBe(
		"insufficient"
	);
	for (const invalid of [
		{ scoredMoves: Number.POSITIVE_INFINITY },
		{ scoredMoves: 20.5 },
		{ top1Pct: -1 },
		{ top1Pct: 101 },
		{ acpl: -1 },
		{ lossM2: -1 },
	])
		expect(checkQualityBand(1650, { ...sample(20, 10), ...invalid }).state).toBe("insufficient");
});

it("accumulates loss variance online without changing the sample mean", () => {
	let stats = { ...EMPTY_STATS };
	for (const cpLoss of [0, 40, 80])
		stats = foldMove(stats, {
			thinkMs: 1,
			scored: true,
			top1: cpLoss === 0,
			cpLoss,
			qualityContext: { gameId: "g", targetElo: 1650, cohortKey: "c" },
		});
	expect(stats.acpl).toBe(40);
	expect(stats.lossM2).toBe(3200);
	expect(stats.qualityGames?.[0]?.lossM2).toBe(3200);
	expect(stats.qualityCohorts?.[0]?.lossM2).toBe(3200);
});
