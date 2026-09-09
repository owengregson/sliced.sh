// test/service/game-session/stats.test.ts — Task 30: the §13.6 session pair the strip reads.
import { describe, expect, it } from "bun:test";
import { AGREEMENT_BANDS } from "@core/strength/constants";
import { EMPTY_STATS, foldGame, foldMove } from "@service/game-session/stats";
import type { SessionStats } from "@typedefs/game";

describe("session stats", () => {
	it("keeps running means over moves", () => {
		let s: SessionStats = { ...EMPTY_STATS };
		s = foldMove(s, { thinkMs: 1000, scored: true, top1: true, cpLoss: 0 });
		expect(s).toMatchObject({ moves: 1, scoredMoves: 1, avgThinkMs: 1000, top1Pct: 100, acpl: 0 });
		s = foldMove(s, { thinkMs: 3000, scored: true, top1: false, cpLoss: 40 });
		expect(s).toMatchObject({ moves: 2, scoredMoves: 2, avgThinkMs: 2000, top1Pct: 50, acpl: 20 });
		s = foldMove(s, { thinkMs: 2000, scored: true, top1: false, cpLoss: 20 });
		expect(s.moves).toBe(3);
		expect(s.avgThinkMs).toBeCloseTo(2000, 6);
		expect(s.top1Pct).toBeCloseTo(100 / 3, 6);
		expect(s.acpl).toBeCloseTo(20, 6);
	});

	it("an unscored move (premove, unranked book move) counts as a move but not in the quality pair", () => {
		let s: SessionStats = { ...EMPTY_STATS };
		s = foldMove(s, { thinkMs: 4000, scored: true, top1: true, cpLoss: 10 });
		expect(s).toMatchObject({ moves: 1, scoredMoves: 1, top1Pct: 100, acpl: 10 });
		// A premove: `rankInLines: 0`, `cpLoss: 0` — folding it would read as a zero-loss non-top-1.
		s = foldMove(s, { thinkMs: 100, scored: false, top1: false, cpLoss: 0 });
		expect(s.moves).toBe(2);
		expect(s.scoredMoves).toBe(1);
		expect(s.top1Pct).toBe(100);
		expect(s.acpl).toBe(10);
		// … and `avgThinkMs` still covers every move played.
		expect(s.avgThinkMs).toBeCloseTo(2050, 6);
		// The next scored move divides by 2, not by 3.
		s = foldMove(s, { thinkMs: 2000, scored: true, top1: false, cpLoss: 30 });
		expect(s.scoredMoves).toBe(2);
		expect(s.top1Pct).toBe(50);
		expect(s.acpl).toBe(20);
	});

	it("a session of nothing but unscored moves reports no quality pair at all", () => {
		let s: SessionStats = { ...EMPTY_STATS };
		for (let i = 0; i < 5; i++)
			s = foldMove(s, { thinkMs: 90, scored: false, top1: false, cpLoss: 0 });
		expect(s.moves).toBe(5);
		expect(s.scoredMoves).toBeUndefined();
		expect(s.top1Pct).toBeUndefined();
		expect(s.acpl).toBeUndefined();
		// `checkBand` counts an absent pair as in band, so no spurious out-of-band warning.
		expect(foldGame(s, 1600).outOfBandStreak).toBe(0);
	});

	it("negative cp loss never lowers ACPL", () => {
		const s = foldMove({ ...EMPTY_STATS }, { thinkMs: 1, scored: true, top1: true, cpLoss: -30 });
		expect(s.acpl).toBe(0);
	});

	it("counts games and the consecutive out-of-band streak against the target's band", () => {
		const band = AGREEMENT_BANDS.find((b) => b.elo === 1600);
		expect(band).toBeDefined();
		const inBand: SessionStats = {
			...EMPTY_STATS,
			moves: 10,
			top1Pct: (band?.top1[0] ?? 0) + 1,
			acpl: (band?.acpl[0] ?? 0) + 1,
		};
		const good = foldGame(inBand, 1600);
		expect(good.games).toBe(1);
		expect(good.outOfBandStreak).toBe(0);

		const outOfBand: SessionStats = { ...inBand, top1Pct: 95, acpl: 2 };
		let s = foldGame(outOfBand, 1600);
		expect(s.outOfBandStreak).toBe(1);
		s = foldGame({ ...s, top1Pct: 95, acpl: 2 }, 1600);
		s = foldGame({ ...s, top1Pct: 95, acpl: 2 }, 1600);
		expect(s.games).toBe(3);
		expect(s.outOfBandStreak).toBe(3);
		// back in band resets the streak
		s = foldGame({ ...s, top1Pct: (band?.top1[0] ?? 0) + 1, acpl: (band?.acpl[0] ?? 0) + 1 }, 1600);
		expect(s.outOfBandStreak).toBe(0);
	});

	it("a session with no moves counts as in band", () => {
		expect(foldGame({ ...EMPTY_STATS }, 1600).outOfBandStreak).toBe(0);
	});
});
