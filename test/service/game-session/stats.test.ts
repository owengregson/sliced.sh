// test/service/game-session/stats.test.ts — Task 30: the §13.6 session pair the strip reads.
import { describe, expect, it } from "bun:test";
import { AGREEMENT_BANDS } from "@core/strength/constants";
import { EMPTY_STATS, foldGame, foldMove } from "@service/game-session/stats";
import type { SessionStats } from "@typedefs/game";

describe("session stats", () => {
	it("keeps running means over moves", () => {
		let s: SessionStats = { ...EMPTY_STATS };
		s = foldMove(s, { thinkMs: 1000, top1: true, cpLoss: 0 });
		expect(s).toMatchObject({ moves: 1, avgThinkMs: 1000, top1Pct: 100, acpl: 0 });
		s = foldMove(s, { thinkMs: 3000, top1: false, cpLoss: 40 });
		expect(s).toMatchObject({ moves: 2, avgThinkMs: 2000, top1Pct: 50, acpl: 20 });
		s = foldMove(s, { thinkMs: 2000, top1: false, cpLoss: 20 });
		expect(s.moves).toBe(3);
		expect(s.avgThinkMs).toBeCloseTo(2000, 6);
		expect(s.top1Pct).toBeCloseTo(100 / 3, 6);
		expect(s.acpl).toBeCloseTo(20, 6);
	});

	it("negative cp loss never lowers ACPL", () => {
		const s = foldMove({ ...EMPTY_STATS }, { thinkMs: 1, top1: true, cpLoss: -30 });
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
