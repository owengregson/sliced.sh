import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { AFTER_EXD5, ctx, line, MODEL_TIMING } from "./helpers";

const meta: GameMeta = {
	targetElo: 1650,
	profile: "balanced",
	baseSec: 600,
	incSec: 0,
	site: "chesscom",
	gameId: "quick",
};

/** Black to move after 1.e4 d5 2.exd5: Qxd5 is the one recapture, everything else drops a pawn. */
const recapture = (second: number) =>
	ctx({
		fen: AFTER_EXD5,
		myColor: "b",
		ply: 3,
		moves: ["e2e4", "d7d5", "e4d5"],
		chosenMove: "d8d5",
		lines: [line(1, -10, "d8d5", "b1c3"), line(2, second, "g8f6", "d5c6")],
		myClockMs: 540_000,
		oppClockMs: 540_000,
		baseSec: 600,
	});

function plans(second: number, n = 60): number[] {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const m = new TimingModel(new V1ParametricHead(), MODEL_TIMING, createRng(`q-${i}`));
		m.startGame({ ...meta, gameId: `q-${i}` });
		out.push(m.planMove(recapture(second)).thinkMs);
	}
	return out.sort((a, b) => a - b);
}

describe("the obvious reply", () => {
	it("caps the one recapture to a short varied window, never below the physical gesture", () => {
		const quick = plans(-320);
		const maxMs = 2200;
		// Every plan inside the window, allowing for the sampled gesture when it is the longer.
		expect(quick[quick.length - 1] ?? 0).toBeLessThanOrEqual(maxMs + 1_500);
		expect(quick.filter((t) => t <= maxMs + 1e-6).length / quick.length).toBeGreaterThan(0.8);
		// Varied, not a mass point.
		expect(new Set(quick.map((t) => Math.round(t / 50))).size).toBeGreaterThan(10);
	});
	it("leaves a genuine choice between two close recaptures to the head", () => {
		const quick = plans(-320);
		const choice = plans(-25);
		const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? 0;
		expect(median(choice)).toBeGreaterThan(median(quick));
	});
});
