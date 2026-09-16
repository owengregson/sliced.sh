import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx, line, MODEL_TIMING } from "./helpers";

const PAWN_ON_KNIGHT = "r1bqkbnr/ppp2ppp/2np4/3Pp3/4P3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 4";

const meta: GameMeta = {
	targetElo: 1650,
	profile: "balanced",
	baseSec: 600,
	incSec: 0,
	site: "chesscom",
	gameId: "terms",
};

function plans(over: Partial<TimingContext>, n = 50): number[] {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const m = new TimingModel(new V1ParametricHead(), MODEL_TIMING, createRng(`t-${i}`));
		m.startGame({ ...meta, gameId: `t-${i}` });
		out.push(m.planMove(ctx(over)).thinkMs);
	}
	return out.sort((a, b) => a - b);
}
const median = (xs: number[]): number => xs[Math.floor(xs.length / 2)] ?? 0;

describe("the basically forced reply", () => {
	const threatened = (chosenMove: string) => ({
		fen: PAWN_ON_KNIGHT,
		myColor: "b" as const,
		ply: 7,
		moves: ["e2e4", "e7e5", "g1f3", "b8c6", "d2d4", "d7d6", "d4d5"],
		chosenMove,
		lines: [line(1, -20, "c6e7", "c2c4"), line(2, -60, "g8f6", "d5c6")],
		myClockMs: 540_000,
		oppClockMs: 540_000,
		baseSec: 600,
	});
	it("moving the attacked knight is planned much faster than a move that ignores the threat", () => {
		const answer = plans(threatened("c6e7"));
		const ignore = plans(threatened("g8f6"));
		expect(median(answer)).toBeLessThan(median(ignore) * 0.75);
		expect(answer[0] ?? 0).toBeGreaterThanOrEqual(210 - 1e-6);
	});
});

describe("opponent clock and own budget", () => {
	it("does not deliberately spend a clock lead to equalize the two clocks", () => {
		const level = median(plans({ myClockMs: 300000, oppClockMs: 300000, baseSec: 600 }));
		const ahead = median(plans({ myClockMs: 300000, oppClockMs: 200000, baseSec: 600 }));
		expect(ahead).toBeLessThanOrEqual(level + 1);
	});
	it("speeds up under opponent time pressure without requiring an own-clock emergency", () => {
		const level = median(plans({ myClockMs: 300000, oppClockMs: 300000, baseSec: 600 }));
		const pressure = median(plans({ myClockMs: 300000, oppClockMs: 5000, baseSec: 600 }));
		expect(pressure).toBeLessThan(level);
	});
});
