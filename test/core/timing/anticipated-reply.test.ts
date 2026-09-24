import { describe, expect, it } from "bun:test";
import { ANTICIPATION } from "@core/motor/constants/anticipation";
import { createRng } from "@core/rng";
import { windowTotalMs } from "@core/timing/move-window";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { AFTER_EXD5, ctx, line, MODEL_TIMING } from "./helpers";

const meta: GameMeta = {
	targetElo: 2700,
	profile: "balanced",
	baseSec: 180,
	incSec: 0,
	site: "chesscom",
	gameId: "anticipate",
};

/** Black to move after 1.e4 d5 2.exd5: Qxd5 recaptures from d8. */
function recapture(over: Partial<TimingContext> = {}): TimingContext {
	return ctx({
		fen: AFTER_EXD5,
		myColor: "b",
		ply: 3,
		moves: ["e2e4", "d7d5", "e4d5"],
		chosenMove: "d8d5",
		lines: [line(1, -10, "d8d5", "b1c3"), line(2, -320, "g8f6", "d5c6")],
		myClockMs: 170_000,
		oppClockMs: 170_000,
		targetElo: 2700,
		...over,
	});
}

function plan(c: TimingContext, seed: string) {
	const m = new TimingModel(new V1ParametricHead(), MODEL_TIMING, createRng(seed));
	m.startGame({ ...meta, gameId: seed });
	return m.planMove(c);
}

describe("an anticipated reply (the hand rested on the answering piece)", () => {
	it("plans a prepared touch: instant, anticipated, above the human floor", () => {
		let anticipated = 0;
		for (let i = 0; i < 40; i++) {
			const p = plan(recapture({ hoverSquare: "d8" }), `a-${i}`);
			if (p.features.anticipated !== 1) continue;
			anticipated++;
			expect(p.mode).toBe("instant");
			expect(p.thinkMs).toBeGreaterThanOrEqual(ANTICIPATION.floorMs - 1e-6);
			expect(windowTotalMs(p.window)).toBeCloseTo(p.thinkMs, 6);
			expect(p.dragDurationMs).toBeGreaterThan(0);
			expect(p.fakeout).toBeUndefined();
		}
		expect(anticipated).toBeGreaterThan(20);
	});
	it("is not anticipated when the hand rested elsewhere or nowhere", () => {
		for (let i = 0; i < 20; i++) {
			expect(plan(recapture({ hoverSquare: "g8" }), `n-${i}`).features.anticipated).toBe(0);
			expect(plan(recapture({ hoverSquare: null }), `n-${i}`).features.anticipated).toBe(0);
			expect(plan(recapture(), `n-${i}`).features.anticipated).toBe(0);
		}
	});
	it("leaves an un-anticipated plan's random stream untouched", () => {
		for (let i = 0; i < 20; i++) {
			const a = plan(recapture(), `s-${i}`);
			const b = plan(recapture({ hoverSquare: "g8" }), `s-${i}`);
			expect(b.thinkMs).toBe(a.thinkMs);
		}
	});
	it("needs the pondered reply or a recapture: a quiet move from the hovered square is not anticipated", () => {
		const quiet = ctx({ targetElo: 2700, hoverSquare: "d2", chosenMove: "d2d4" });
		for (let i = 0; i < 10; i++) expect(plan(quiet, `q-${i}`).features.anticipated).toBe(0);
	});
});
