// test/service/game-session/stats.test.ts — Task 30: the §13.6 session pair the strip reads.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { QUALITY_STATISTICS as Q, TIMING_STATISTICS } from "@core/constants/telemetry";
import { checkBand } from "@core/strength/bands";
import {
	normalizeQualityStats,
	type QualityContext,
	qualityCohortKey,
} from "@core/strength/session-quality";
import { EMPTY_STATS, foldGame, foldMove } from "@service/game-session/stats";
import type { SessionStats } from "@typedefs/game";
import { DEFAULT_SETTINGS } from "@typedefs/settings";

const TC = { baseMs: 180_000, incMs: 0 };
function context(gameId = "a", targetElo = 1650): QualityContext {
	return {
		gameId,
		targetElo,
		cohortKey: qualityCohortKey(targetElo, DEFAULT_SETTINGS.strength, TC),
	};
}
function move(
	stats: SessionStats,
	id: string,
	top1: boolean,
	cpLoss: number,
	elo = 1650
): SessionStats {
	return foldMove(stats, {
		thinkMs: 1000,
		scored: true,
		top1,
		cpLoss,
		qualityContext: context(id, elo),
	});
}
function game(
	stats: SessionStats,
	id: string,
	good: boolean,
	elo = 1650,
	count: number = Q.minGameMoves
): SessionStats {
	let current = stats;
	for (let i = 0; i < count; i++)
		current = move(current, id, good ? i % 2 === 0 : true, good && i % 2 ? 104 : 0, elo);
	return foldGame(current, id);
}

describe("comparable search quality", () => {
	it("starts a new full-turn average without weighting it by historical hand-only moves", () => {
		const legacy: SessionStats = {
			games: 14,
			moves: 405,
			avgThinkMs: 2100,
			finishedGameIds: ["old"],
		};
		let s = foldMove(legacy, { thinkMs: 4000, scored: false, top1: false, cpLoss: 0 });
		expect(s).toMatchObject({
			games: 14,
			moves: 406,
			avgThinkMs: 4000,
			timingSamples: 1,
			timingVersion: TIMING_STATISTICS.version,
			finishedGameIds: ["old"],
		});
		s = foldMove(JSON.parse(JSON.stringify(s)), {
			thinkMs: 2000,
			scored: false,
			top1: false,
			cpLoss: 0,
		});
		expect(s).toMatchObject({ moves: 407, avgThinkMs: 3000, timingSamples: 2 });
		// A queued premove lacks a turn-to-acceptance measurement. Activity still counts.
		s = foldMove(s, { scored: false, top1: false, cpLoss: 0 });
		expect(s).toMatchObject({ moves: 408, avgThinkMs: 3000, timingSamples: 2 });
		expect(legacy.avgThinkMs).toBe(2100);
	});

	it("keeps malformed and unavailable timing out of its independently counted average", () => {
		let s = { ...EMPTY_STATS };
		for (const thinkMs of [Number.NaN, Number.POSITIVE_INFINITY, -1])
			s = foldMove(s, { thinkMs, scored: false, top1: false, cpLoss: 0 });
		expect(s).toMatchObject({ moves: 3, timingSamples: 0, avgThinkMs: 0 });
		s = foldMove(
			{ ...s, timingSamples: Number.NaN, avgThinkMs: 1200 },
			{
				thinkMs: 5000,
				scored: false,
				top1: false,
				cpLoss: 0,
			}
		);
		expect(s).toMatchObject({ moves: 4, timingSamples: 1, avgThinkMs: 5000 });
	});

	it("averages activity over all moves, quality only over valid samples", () => {
		let s = move({ ...EMPTY_STATS }, "a", true, 0);
		s = foldMove(s, {
			thinkMs: 3000,
			scored: true,
			top1: false,
			cpLoss: 40,
			qualityContext: context(),
		});
		expect(s).toMatchObject({ moves: 2, scoredMoves: 2, avgThinkMs: 2000, top1Pct: 50, acpl: 20 });
		s = foldMove(s, {
			thinkMs: 100,
			scored: false,
			top1: false,
			cpLoss: 0,
			qualityContext: context(),
		});
		expect(s.moves).toBe(3);
		expect(s.avgThinkMs).toBeCloseTo(4100 / 3);
		expect(s.qualityCohorts?.[0]).toMatchObject({ scoredMoves: 2, top1Pct: 50, acpl: 20 });
		expect(s.qualityGames?.[0]).toMatchObject({ gameId: "a", scoredMoves: 2 });
	});

	it("rejects absent provenance, nonfinite and negative loss without losing activity", () => {
		let s: SessionStats = { ...EMPTY_STATS };
		for (const cpLoss of [Number.NaN, Number.POSITIVE_INFINITY, -30])
			s = move(s, "bad", true, cpLoss);
		s = foldMove(s, { thinkMs: 1000, scored: true, top1: true, cpLoss: 0 });
		s = foldMove(s, {
			thinkMs: 1000,
			scored: false,
			top1: false,
			cpLoss: 0,
			qualityContext: context(),
		});
		expect(s.moves).toBe(5);
		expect(s.scoredMoves).toBeUndefined();
		expect(s.qualityCohorts).toBeUndefined();
	});

	it("migrates legacy quality while preserving activity counts and receipts", () => {
		const legacy: SessionStats = {
			games: 6,
			moves: 150,
			avgThinkMs: 1200,
			top1Pct: 49,
			acpl: 24,
			scoredMoves: 140,
			outOfBandStreak: 5,
			finishedGameIds: ["old"],
		};
		const current = normalizeQualityStats(legacy);
		expect(current).toEqual({
			games: 6,
			moves: 150,
			avgThinkMs: 1200,
			finishedGameIds: ["old"],
			qualityVersion: Q.version,
		});
		expect(legacy.acpl).toBe(24);
		expect(move(current, "new", false, 80)).toMatchObject({
			games: 6,
			moves: 151,
			scoredMoves: 1,
			top1Pct: 0,
			acpl: 80,
		});
	});

	it("grades each game's own sample even when the cumulative mean remains outside", () => {
		let s = game({ ...EMPTY_STATS }, "bad", false, 1650, 100);
		expect(s.qualityCohorts?.[0]?.outOfBandStreak).toBe(1);
		s = game(s, "good-a", true);
		s = game(s, "good-b", true);
		expect(checkBand(1650, s).inBand).toBe(false);
		expect(s.qualityCohorts?.[0]).toMatchObject({ eligibleGames: 3, outOfBandStreak: 0 });
		expect(s.qualityGames).toEqual([]);
	});

	it("does not advance a warning for short or unscored games", () => {
		let s = game({ ...EMPTY_STATS }, "bad", false);
		s = game(s, "short", false, 1650, Q.minGameMoves - 1);
		s = foldGame(s, "unscored-a");
		s = foldGame(s, "unscored-b");
		expect(s.games).toBe(4);
		expect(s.qualityCohorts?.[0]).toMatchObject({ eligibleGames: 1, outOfBandStreak: 1 });
	});

	it("shares persona targets in one reference band, isolating other bands", () => {
		expect(context("a", 1650).cohortKey).toBe(context("b", 1673).cohortKey);
		let s = game({ ...EMPTY_STATS }, "a", false, 1650);
		s = game(s, "b", false, 1673);
		s = game(s, "c", false, 1679);
		expect(s.qualityCohorts).toHaveLength(1);
		expect(s.qualityCohorts?.[0]).toMatchObject({ eligibleGames: 3, outOfBandStreak: 3 });
		s = game(s, "other-band", false, 2050);
		expect(s.qualityCohorts).toHaveLength(2);
		expect(s.qualityCohorts?.find((c) => c.key === context().cohortKey)?.outOfBandStreak).toBe(3);
		expect(
			s.qualityCohorts?.find((c) => c.key === context("x", 2050).cohortKey)?.outOfBandStreak
		).toBe(1);
	});

	it("separates search settings and increment/no-increment populations", () => {
		const strength = DEFAULT_SETTINGS.strength;
		const original = qualityCohortKey(1650, strength, TC);
		for (const changed of [
			{ ...strength, selectionMode: "engine-elo" as const },
			{ ...strength, blunderScale: 2 },
			{ ...strength, useOpeningBook: !strength.useOpeningBook },
		])
			expect(qualityCohortKey(1650, changed, TC)).not.toBe(original);
		expect(qualityCohortKey(1650, strength, { ...TC, incMs: 2000 })).not.toBe(original);
		expect(qualityCohortKey(1650, strength, undefined)).not.toBe(original);
	});

	it("keeps simultaneous tabs' game samples separate", () => {
		let s: SessionStats = { ...EMPTY_STATS };
		for (let i = 0; i < Q.minGameMoves; i++) {
			s = move(s, "tab-a", true, 0);
			s = move(s, "tab-b", i % 2 === 0, i % 2 ? 104 : 0);
		}
		s = foldGame(s, "tab-a");
		expect(s.qualityCohorts?.[0]?.outOfBandStreak).toBe(1);
		expect(s.qualityGames?.[0]?.gameId).toBe("tab-b");
		s = foldGame(s, "tab-b");
		expect(s.qualityCohorts?.[0]?.outOfBandStreak).toBe(0);
	});
});

describe("persistent bounded receipts", () => {
	it("does not advance or clear a warning from malformed stored quality", () => {
		let stats = game({ ...EMPTY_STATS }, "bad-a", false);
		stats = game(stats, "bad-b", false);
		stats.qualityGames = [
			{ ...context("malformed"), scoredMoves: 20, top1Pct: 500, acpl: -1, lossM2: 0 },
		];
		const after = foldGame(stats, "malformed");
		expect(after.qualityCohorts?.[0]).toMatchObject({ eligibleGames: 2, outOfBandStreak: 2 });
		expect(after.games).toBe(3);
	});
	it("does not regrade a completed game after serialization", () => {
		const first = game({ ...EMPTY_STATS }, "finished-a", false);
		const restored = JSON.parse(JSON.stringify(first)) as SessionStats;
		expect(foldGame(restored, "finished-a")).toEqual(first);
		expect(foldGame(restored, "finished-b")).toMatchObject({
			games: 2,
			finishedGameIds: ["finished-a", "finished-b"],
		});
		expect(foldGame(restored, "finished-b").qualityCohorts?.[0]?.outOfBandStreak).toBe(1);
	});

	it("bounds receipt, cohort and pending game storage", () => {
		let s: SessionStats = { ...EMPTY_STATS };
		for (let i = 0; i < LIMITS.finishedGameHistorySize + 2; i++) s = foldGame(s, `finished-${i}`);
		expect(s.finishedGameIds).toHaveLength(LIMITS.finishedGameHistorySize);
		expect(s.finishedGameIds?.[0]).toBe("finished-2");
		for (let i = 0; i < Q.maxCohorts + 2; i++) {
			const ctx = context(`pending-${i}`);
			ctx.cohortKey = qualityCohortKey(1650, DEFAULT_SETTINGS.strength, { ...TC, incMs: i * 1000 });
			s = foldMove(s, { thinkMs: 1, scored: true, top1: true, cpLoss: 0, qualityContext: ctx });
		}
		expect(s.qualityCohorts).toHaveLength(Q.maxCohorts);
		expect(s.qualityGames).toHaveLength(Q.maxPendingGames);
	});
});
