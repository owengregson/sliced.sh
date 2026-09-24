import { describe, expect, it } from "bun:test";
import {
	anticipatedExecution,
	anticipateReply,
	anticipationEngageProb,
	planAnticipationHover,
	withinHover,
} from "@core/motor/anticipation";
import { ANTICIPATION, MOTOR_DEFAULTS } from "@core/motor/constants";
import { opponentExplorationCandidates } from "@core/motor/opponent-candidates";
import { createRng } from "@core/rng";
import { centre, geometry, inside, squareRect } from "./fixtures";

/** White: Ke1, Nc3, b2. Black to move: Ke8, Bb4. We are white; they take on c3, we recapture. */
const FEN = "4k3/8/8/8/1b6/2N5/1P6/5K2 b - - 1 1";
const line = (pvUci: string[], multipv: number) => ({
	multipv,
	score: { cp: 10 },
	depth: 12,
	pvUci,
	pvSan: [],
});

function quantile(values: number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

describe("anticipateReply", () => {
	it("reads the ponder's top line, and calls an answer on their destination a recapture", () => {
		const c = opponentExplorationCandidates(FEN, "w", [line(["b4c3", "b2c3"], 1)]);
		expect(anticipateReply(c)).toMatchObject({
			kind: "recapture",
			opponent: { from: "b4", to: "c3" },
			reply: { from: "b2", to: "c3" },
		});
	});

	it("is a ponder anticipation when our answer goes elsewhere, and null without our answer", () => {
		const other = opponentExplorationCandidates(FEN, "w", [line(["b4c3", "f1e2"], 1)]);
		expect(anticipateReply(other)?.kind).toBe("ponder");
		expect(anticipateReply(opponentExplorationCandidates(FEN, "w", [line(["b4c3"], 1)]))).toBeNull();
		expect(anticipateReply(opponentExplorationCandidates(FEN, "w"))).toBeNull();
	});
});

describe("anticipationEngageProb", () => {
	it("pre-positions a recapture more than a ponder answer, and a fast clock more than a slow one", () => {
		for (const tc of ["bullet", "blitz", "rapid", "classical", "untimed"] as const)
			expect(anticipationEngageProb("recapture", tc)).toBeGreaterThan(
				anticipationEngageProb("ponder", tc)
			);
		expect(anticipationEngageProb("recapture", "bullet")).toBeGreaterThan(
			anticipationEngageProb("recapture", "rapid")
		);
		expect(anticipationEngageProb("recapture", "blitz")).toBeLessThan(1);
	});
});

describe("anticipatedExecution", () => {
	const samples = Array.from({ length: 2000 }, (_, i) =>
		anticipatedExecution(1, 1, createRng(`anticipated-${i}`))
	);
	const totals = samples.map((s) => s.totalS * 1000);

	it("never goes below the human floor, and its parts sum to the total", () => {
		expect(Math.min(...totals)).toBeGreaterThanOrEqual(ANTICIPATION.floorMs - 1e-9);
		for (const s of samples) {
			expect(s.orientationMs).toBeGreaterThanOrEqual(ANTICIPATION.reaction.minMs);
			expect(s.dragS).toBeGreaterThanOrEqual(ANTICIPATION.drag.minS);
			expect(s.orientationMs / 1000 + s.hoverS + s.dragS).toBeCloseTo(s.totalS, 9);
		}
	});

	it("puts a one-square recapture's median in the fast human band, jittered, never a constant", () => {
		const p50 = quantile(totals, 0.5);
		expect(p50).toBeGreaterThan(450);
		expect(p50).toBeLessThan(600);
		expect(quantile(totals, 0.9) - quantile(totals, 0.1)).toBeGreaterThan(100);
		expect(new Set(totals.map((t) => Math.round(t))).size).toBeGreaterThan(200);
	});

	it("carries a longer move for longer, and a slower hand is slower", () => {
		const far = Array.from({ length: 500 }, (_, i) =>
			anticipatedExecution(6, 1, createRng(`anticipated-${i}`))
		);
		const slow = Array.from({ length: 500 }, (_, i) =>
			anticipatedExecution(1, 1.3, createRng(`anticipated-${i}`))
		);
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		expect(mean(far.map((s) => s.dragS))).toBeGreaterThan(mean(samples.map((s) => s.dragS)));
		expect(mean(slow.map((s) => s.totalS))).toBeGreaterThan(mean(samples.map((s) => s.totalS)));
	});
});

describe("planAnticipationHover", () => {
	const g = geometry();
	it("travels to the answering piece's square and rests there, without a button or a teleport", () => {
		for (let i = 0; i < 100; i++) {
			const plan = planAnticipationHover(
				{ geometry: g, profile: MOTOR_DEFAULTS, cursor: { x: 700, y: 690 } },
				"b2",
				createRng(`hover-${i}`)
			);
			expect(plan.spell).toBe("anticipate");
			expect(plan.lastTarget).toBe("b2");
			const moves = plan.actions.filter((a) => a.path && a.path.length > 0);
			expect(moves.length).toBeGreaterThan(0);
			const end = moves.at(-1)?.path?.at(-1);
			expect(end && withinHover(end, squareRect("b2"))).toBe(true);
			const dwell = plan.actions.reduce(
				(sum, a) => sum + a.dwellMs + (a.path ?? []).reduce((s, p) => s + p.dtMs, 0),
				0
			);
			expect(dwell).toBeCloseTo(plan.durationMs, 6);
			expect(plan.durationMs).toBeGreaterThanOrEqual(ANTICIPATION.dwellMs[0]);
			expect(plan.durationMs).toBeLessThanOrEqual(ANTICIPATION.dwellMs[1]);
		}
	});

	it("only rests (tremor at most) when the hand is already over the square", () => {
		const rect = squareRect("b2");
		const plan = planAnticipationHover(
			{ geometry: g, profile: MOTOR_DEFAULTS, cursor: centre(rect) },
			"b2",
			createRng("hover-already")
		);
		for (const action of plan.actions) {
			expect(action.kind === "rest" || action.kind === "drift").toBe(true);
			for (const p of action.path ?? []) expect(inside(p, rect)).toBe(true);
		}
	});
});
