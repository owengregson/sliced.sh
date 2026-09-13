import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { blunderProbability } from "@core/strength/blunder-model";
import { SELECTION_CONSTANTS as C } from "@core/strength/constants";
import { effectiveElo } from "@core/strength/elo-map";
import { selectMove } from "@core/strength/move-selector";
import { clockRacePolicy, opponentClockPressure } from "@core/timing/opponent-pressure";
import type { EvalLine } from "@typedefs/engine";
import corpus from "../../fixtures/strength/stockfish18-opponent-rush.json";
import { type CtxOverrides, ctx, flatPrior, line, START } from "./helpers";

const rush = {
	baseMs: 180000,
	incrementMs: 0,
	myClockMs: 90000,
	oppClockMs: 1000,
	selectionMode: "hybrid" as const,
	blunderScale: 0,
};

function sample(lines: EvalLine[], overrides: CtxOverrides, count = 500) {
	const context = ctx({ ...rush, ...overrides, rng: createRng("rush-policy") });
	const prior = flatPrior(lines);
	const bestCp = Math.max(...lines.map((line) => line.score.cp ?? -10000));
	let loss = 0;
	let rank = 0;
	let top1 = 0;
	let maxLoss = 0;
	const moves = new Set<string>();
	for (let i = 0; i < count; i++) {
		const chosen = selectMove(lines, context, prior);
		const score = lines.find((line) => line.pvUci[0] === chosen.uci)?.score.cp;
		const gap = bestCp - (score ?? bestCp);
		loss += gap;
		rank += chosen.rankInLines;
		top1 += Number(chosen.rankInLines === 1);
		maxLoss = Math.max(maxLoss, gap);
		moves.add(chosen.uci);
		expect(chosen.source).not.toBe("blunder");
	}
	return { loss: loss / count, rank: rank / count, top1: top1 / count, maxLoss, moves };
}

describe("opponent-only rush selection", () => {
	it("meaningfully broadens real short-search choices at both club and high target ratings", () => {
		for (const targetElo of [1650, 2800]) {
			const position = corpus.positions.find((p) => p.E === targetElo && p.name === "kiwipete")!;
			const lines: EvalLine[] = position.lines.map((line) => ({
				...line,
				wdl: [line.wdl[0]!, line.wdl[1]!, line.wdl[2]!],
			}));
			expect(position.complete).toBe(true);
			expect(position.budget.movetimeMs).toBeLessThanOrEqual(100);
			expect(lines.length).toBeGreaterThanOrEqual(12);
			const result = sample(
				lines,
				{
					fen: position.fen,
					targetElo,
					engineBestmove: position.bestmove,
				},
				120
			);
			expect(result.moves.size).toBeGreaterThan(2);
			expect(result.rank).toBeGreaterThan(1.5);
			expect(result.top1).toBeLessThan(0.8);
			expect(result.loss).toBeGreaterThan(20);
			if (targetElo === 2800)
				expect(result.maxLoss).toBeLessThanOrEqual(C.opponentPressure.raceExpandedLossCp);
			else {
				const ordinary = sample(
					lines,
					{
						fen: position.fen,
						targetElo,
						engineBestmove: position.bestmove,
						oppClockMs: 90000,
					},
					120
				);
				expect(result.loss).toBeGreaterThan(ordinary.loss * 1.2);
			}
		}
	});

	it("retains rating sensitivity while lowering ordinary precision instead of forcing errors", () => {
		const lines = [
			line(START, "e2e4", { cp: 50 }, 1),
			line(START, "d2d4", { cp: 20 }, 2),
			line(START, "g1f3", { cp: -40 }, 3),
			line(START, "b1c3", { cp: -90 }, 4),
			line(START, "f2f3", { cp: -250 }, 5),
			line(START, "a2a3", { cp: -400 }, 6),
		];
		const club = sample(lines, { targetElo: 1650, engineBestmove: "e2e4" });
		const ordinary = sample(lines, { targetElo: 1650, engineBestmove: "e2e4", oppClockMs: 90000 });
		const high = sample(lines, { targetElo: 2800, engineBestmove: "e2e4" });
		expect(club.loss).toBeGreaterThan(ordinary.loss * 1.2);
		expect(club.loss).toBeGreaterThan(high.loss);
		expect(high.loss).toBeGreaterThan(15);
		expect(high.maxLoss).toBeLessThanOrEqual(C.opponentPressure.raceExpandedLossCp);
	});

	it("retains the existing explicit-error probability despite the larger ordinary penalty", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 20 }, 2)];
		const probabilities: number[] = [];
		const state = ctx().state;
		const chosen = selectMove(
			lines,
			ctx({
				...rush,
				targetElo: 1650,
				blunderScale: 1,
				state,
				rng: {
					...createRng("probability"),
					normal: () => 0,
					chance: (p) => {
						probabilities.push(p);
						return false;
					},
				},
			})
		);
		const clocks = {
			ownClockMs: rush.myClockMs,
			opponentClockMs: rush.oppClockMs,
			baseMs: rush.baseMs,
			incrementMs: 0,
		};
		const pressure = Math.max(
			opponentClockPressure(clocks),
			clockRacePolicy(clocks)!.opponentUrgency
		);
		const baselineE = effectiveElo(1650 - C.opponentPressure.eloReduction * pressure, 0);
		expect(probabilities).toEqual([
			blunderProbability(baselineE, {
				myClockMs: rush.myClockMs,
				baseMs: rush.baseMs,
				cpStd: 15,
				blunderScale: 1,
				state,
			}),
		]);
		expect(chosen.rationale.join(" ")).toContain("existing error rate retained");
	});

	it("broadens winning endgame choices while retaining the win and excluding large concessions", () => {
		const fen = "8/8/4k3/8/8/8/4P3/R3K3 w - - 0 40";
		const lines = [
			line(fen, "a1a8", { cp: 600 }, 1),
			line(fen, "e2e4", { cp: 580 }, 2),
			line(fen, "e1d2", { cp: 480 }, 3),
			line(fen, "a1a7", { cp: 350 }, 4),
			line(fen, "e2e3", { cp: 100 }, 5),
		];
		const result = sample(lines, {
			fen,
			targetElo: 2800,
			phase: "endgame",
			ply: 78,
			engineBestmove: "a1a8",
		});
		expect(result.moves.has("e1d2")).toBe(true);
		expect(result.moves.has("a1a7")).toBe(false);
		expect(result.moves.has("e2e3")).toBe(false);
		expect(result.loss).toBeGreaterThan(25);
		expect(result.maxLoss).toBeLessThanOrEqual(C.opponentPressure.raceExpandedLossCp);
	});

	it("keeps rush samples out of normal target warnings while retaining honest scored loss", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 20 }, 2)];
		const chosen = selectMove(lines, ctx({ ...rush, targetElo: 2800 }));
		expect(chosen.quality?.eligible).toBe(false);
		expect(chosen.quality?.reason).toBe("opponent-rush");
		expect(chosen.cpLoss).toBe(chosen.uci === "e2e4" ? 0 : 30);
		const ordinary = selectMove(lines, ctx({ ...rush, targetElo: 2800, oppClockMs: 90000 }));
		expect(ordinary.quality?.eligible).toBe(true);
		const shallow = selectMove(
			lines.map((line) => ({ ...line, depth: 3 })),
			ctx({ ...rush, targetElo: 2800 })
		);
		expect(shallow.quality?.reason).toBe("shallow");
	});

	it("does not impose the opponent-only policy during our emergency, a lone king, or a large increment", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 20 }, 2)];
		for (const override of [{ myClockMs: 1000 }, { incrementMs: 10000 }, { oppClockMs: 15000 }]) {
			const chosen = selectMove(lines, ctx({ ...rush, ...override, targetElo: 2800 }));
			expect(chosen.rationale.join(" ")).not.toContain("opponent-only rush");
		}
		const fen = "7k/8/8/8/8/8/8/KR6 b - - 0 1";
		const king = selectMove(
			[line(fen, "h8g8", { cp: -500 }, 1), line(fen, "h8g7", { cp: -530 }, 2)],
			ctx({ ...rush, fen, targetElo: 2800 })
		);
		expect(king.rationale.join(" ")).not.toContain("opponent-only rush");
	});

	it("never weakens the forced-loss guard just because the pace-adjusted rating crosses1000", () => {
		const lines = [line(START, "e2e4", { cp: -200 }, 1), line(START, "d2d4", { mate: -5 }, 2)];
		for (let seed = 0; seed < 20; seed++) {
			const chosen = selectMove(
				lines,
				ctx({ ...rush, targetElo: 1200, blunderScale: 100, rng: createRng(seed) })
			);
			expect(chosen.uci).toBe("e2e4");
		}
	});
});
