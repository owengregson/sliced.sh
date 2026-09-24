// tools/calibration/calibration.test.ts — the calibration harness's pure pieces: the Maia grid
// interpolation, the referee judgement, the cluster-robust profile, the fit's smoothing and table
// writer, the estimator, and the request grid. No engine, no model, < 1 s.
import "../lib/defines";
import { describe, expect, it } from "bun:test";
import { MAIA } from "@core/constants/maia";
import type { EvalLine } from "@typedefs/engine";
import { type CellSurface, smoothClass, tableSource } from "./fit";
import type { FrameCacheRecord } from "./frames";
import {
	CLASSES,
	covariates,
	estimateRating,
	moveClass,
	pairedDifference,
	trainModel,
} from "./rating-model";
import { gridFor } from "./requests";
import { judgeFor, type MoveOutcome, PolicyGrid } from "./sim";
import { objective, type Profile, ProfileBuilder } from "./stats";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("PolicyGrid", () => {
	const grid = new PolicyGrid([
		{
			selfElo: 1000,
			moves: [
				["e2e4", 0.5],
				["d2d4", 0.5],
			],
		},
		{
			selfElo: 1200,
			moves: [
				["e2e4", 0.8],
				["d2d4", 0.2],
			],
		},
	]);
	it("answers a grid point exactly and clamps outside the grid", () => {
		expect(new Map(grid.at(1000).moves).get("e2e4")).toBeCloseTo(0.5, 12);
		expect(new Map(grid.at(600).moves).get("e2e4")).toBeCloseTo(0.5, 12);
		expect(new Map(grid.at(1500).moves).get("e2e4")).toBeCloseTo(0.8, 12);
	});
	it("interpolates log-probabilities linearly and renormalises", () => {
		const mid = new Map(grid.at(1100).moves);
		const a = Math.sqrt(0.5 * 0.8);
		const b = Math.sqrt(0.5 * 0.2);
		expect(mid.get("e2e4")).toBeCloseTo(a / (a + b), 12);
		expect((mid.get("e2e4") ?? 0) + (mid.get("d2d4") ?? 0)).toBeCloseTo(1, 12);
		expect(grid.at(1100).moves[0]?.[0]).toBe("e2e4");
	});
});

function line(uci: string, cp: number, multipv: number): EvalLine {
	return { multipv, depth: 12, score: { cp }, pvUci: [uci], pvSan: [] };
}

describe("judgeFor", () => {
	const frame = {
		id: "x",
		lines: [line("e2e4", 50, 1), line("d2d4", 20, 2), line("a2a3", -400, 3)],
		bestmove: "e2e4",
		extra: [],
		depth: 12,
		complete: true,
		byDepth: {},
		byDepthAt: {},
		humanLine: line("h2h4", -900, 1),
		ms: 1,
	} as FrameCacheRecord;
	const judge = judgeFor(frame);
	it("judges against the best line, the human line included", () => {
		expect(judge.bestUci).toBe("e2e4");
		expect(judge.outcome("e2e4")).toEqual({ winLoss: 0, cpLoss: 0, top1: 1 });
		expect(judge.outcome("d2d4")?.cpLoss).toBe(30);
		expect(judge.outcome("a2a3")?.winLoss).toBeGreaterThan(0.3);
		expect(judge.outcome("h2h4")?.cpLoss).toBe(950);
		expect(judge.outcome("g1f3")).toBeNull();
	});
});

const outcome = (winLoss: number): MoveOutcome => ({ winLoss, cpLoss: winLoss * 1000, top1: 0 });

describe("ProfileBuilder", () => {
	it("is the ratio estimate with a cluster-robust SE", () => {
		const b = new ProfileBuilder();
		b.add("g1", outcome(0.25));
		b.add("g1", outcome(0));
		b.add("g2", outcome(0));
		b.add("g2", outcome(0));
		const p = b.build();
		expect(p.blunder.mean).toBeCloseTo(0.25, 12);
		// y = (1, 0), n = (2, 2), r = 1/4: residuals 0.5 and −0.5; SE = √(2·0.5)/4.
		expect(p.blunder.se).toBeCloseTo(Math.sqrt(2 * 0.5) / 4, 12);
		expect(p.blunder.games).toBe(2);
	});
	it("the objective is Σ z² over the fitted metrics", () => {
		const a = new ProfileBuilder();
		const c = new ProfileBuilder();
		for (let i = 0; i < 40; i++) {
			a.add(`g${i % 8}`, outcome(i % 5 === 0 ? 0.3 : 0.01));
			c.add(`g${i % 8}`, outcome(i % 5 === 0 ? 0.3 : 0.01));
		}
		expect(objective(a.build(), c.build())).toBeCloseTo(0, 12);
	});
});

describe("fit smoothing", () => {
	const profile = {} as Profile;
	/** A cell whose objective is a bowl centred on (Δ*, T*). */
	const bowl = (bucket: number, dStar: number, tStar: number): CellSurface => ({
		tc: "blitz",
		bucket,
		rows: 1,
		games: 50,
		chains: 1,
		human: profile,
		seconds: 0,
		points: [-200, -100, 0, 100, 200, 300].flatMap((offset) =>
			[0.6, 0.8, 1].map((temperature) => ({
				offset,
				temperature,
				objective: ((offset - dStar) / 100) ** 2 + ((temperature - tStar) / 0.2) ** 2,
				bot: profile,
				z: {},
			}))
		),
	});
	it("keeps clean minima, makes the conditioning monotone and drops thin cells", () => {
		const cells = [bowl(1000, 100, 0.8), bowl(1200, 100, 0.8), bowl(1400, -300, 0.8)];
		const picks = smoothClass(cells, 1);
		// A heavier smoothness weight pulls the outlying cell towards its neighbours' offset.
		const pulled = smoothClass(cells, 50);
		expect(pulled[2]?.point.offset ?? 0).toBeGreaterThan(picks[2]?.point.offset ?? 0);
		expect(picks.map((p) => p.temperature)).toEqual([0.8, 0.8, 0.8]);
		for (let i = 1; i < picks.length; i++)
			expect(picks[i]?.conditioning ?? 0).toBeGreaterThanOrEqual(picks[i - 1]?.conditioning ?? 0);
		expect(picks[0]?.conditioning).toBe(1100);
		// every pick is an evaluated point
		for (const p of picks) expect(p.conditioning).toBe(p.bucket + p.point.offset);
		const thin = { ...bowl(1600, 0, 1), games: 3 };
		expect(smoothClass([bowl(1000, 100, 0.8), thin], 1).map((p) => p.bucket)).toEqual([1000]);
		const source = tableSource(picks);
		expect(source).toContain("export const MAIA_CALIBRATION: MaiaCalibrationTable = {");
		expect(source).toContain("\t\t[1000, 1100, 0.8],");
		expect(source).toContain("\tbullet: [[1500, 1500, 1]],");
	});
	it("prefers the advertised point among equivalent ones", () => {
		const flat: CellSurface = { ...bowl(1500, 0, 1), points: [] };
		flat.points = [
			{ offset: -400, temperature: 0.6, objective: 1, bot: profile, z: {} },
			{ offset: 0, temperature: 1, objective: 1, bot: profile, z: {} },
		];
		expect(smoothClass([flat])[0]?.point.offset).toBe(0);
	});
});

describe("rating model", () => {
	it("recovers a rating from move classes whose odds move with the rating", () => {
		const shape = { nearBest: 2, secondLoss: 0.05, decided: 0.2 };
		const moves: Array<{ x: number[]; y: number; rating: number }> = [];
		let seed = 7;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (let i = 0; i < 6000; i++) {
			const rating = 800 + (i % 21) * 100;
			// Weaker players land in worse classes more often.
			const p = 0.2 + (0.6 * (rating - 800)) / 2000;
			const y = rand() < p ? 0 : 1 + Math.floor(rand() * (CLASSES - 1));
			moves.push({ x: covariates(shape, 1), y, rating });
		}
		const model = trainModel(moves, 800);
		expect(model.beta).toBeLessThan(0);
		const strong = estimateRating(
			model,
			moves.filter((m) => m.rating === 2600).map((m) => ({ ...m, cluster: `${m.rating}` }))
		);
		const weak = estimateRating(
			model,
			moves.filter((m) => m.rating === 1000).map((m) => ({ ...m, cluster: `${m.rating}` }))
		);
		expect(strong.rating).toBeGreaterThan(weak.rating + 800);
		expect(moveClass({ winLoss: 0, cpLoss: 0, top1: 1 })).toBe(0);
		expect(moveClass({ winLoss: 0.25, cpLoss: 300, top1: 0 })).toBe(CLASSES - 2);
		expect(moveClass({ winLoss: 0.5, cpLoss: 900, top1: 0 })).toBe(CLASSES - 1);
	});
	it("a paired difference of identical sets is zero with zero SE", () => {
		const shape = { nearBest: 1, secondLoss: 0.2, decided: 0 };
		const moves = Array.from({ length: 400 }, (_, i) => ({
			x: covariates(shape, 0.5),
			y: i % 3,
			rating: 1000 + (i % 4) * 400,
		}));
		const model = trainModel(moves, 300);
		const set = moves.map((m, i) => ({ ...m, cluster: `g${i % 20}` }));
		const d = pairedDifference(estimateRating(model, set), estimateRating(model, set));
		expect(d.diff).toBe(0);
		expect(d.se).toBe(0);
	});
});

describe("gridFor", () => {
	it("covers the bucket's sweep at the step, clamped to the conditioning range", () => {
		const g = gridFor(1600);
		expect(g[0]).toBe(700);
		expect(g[g.length - 1]).toBe(2600);
		expect(g.every((e, i) => i === 0 || e - (g[i - 1] ?? 0) === 100)).toBe(true);
		const top = gridFor(2800);
		expect(top[top.length - 1]).toBe(MAIA.conditioningEloMax);
		expect(gridFor(600)[0]).toBe(MAIA.context.eloFloor);
		expect(gridFor(2800, undefined, "bullet")[0]).toBe(1500);
		expect(gridFor(2800, undefined, "blitz")[0]).toBe(1900);
	});
});
