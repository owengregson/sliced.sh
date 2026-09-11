import { describe, expect, it } from "bun:test";
import { loadPosition } from "@core/chess/fen";
import { applyMoves, legalMoves } from "@core/chess/san";
import { CHESS_START_FEN } from "@core/constants/chess";
import { MOTOR_DEFAULTS, OPPONENT_EXPLORATION as O } from "@core/motor/constants";
import { opponentExplorationCandidates } from "@core/motor/opponent-candidates";
import { planOpponentExploration } from "@core/motor/opponent-exploration";
import { createRng } from "@core/rng";
import { geometry, inside, squareRect, totalMs } from "./fixtures";

const FEN = applyMoves(CHESS_START_FEN, ["e2e4"])!;
const CANDIDATES = opponentExplorationCandidates(FEN, "w");
const options = {
	geometry: geometry(),
	profile: MOTOR_DEFAULTS,
	cursor: { x: 700, y: 690 },
	...CANDIDATES,
};

describe("opponent exploration candidates", () => {
	it("considers legal opponent moves and own replies to actual legal branches", () => {
		const position = loadPosition(FEN)!;
		const opponentLegal = legalMoves(FEN);
		expect(CANDIDATES.ownCandidates.length).toBeGreaterThan(3);
		expect(CANDIDATES.opponentCandidates.length).toBeGreaterThan(3);
		for (const candidate of CANDIDATES.opponentCandidates) {
			expect(opponentLegal).toContain(candidate.uci);
			expect(position.get(candidate.from)?.color).toBe("b");
		}
		for (const candidate of CANDIDATES.ownCandidates) {
			expect(position.get(candidate.from)?.color).toBe("w");
			expect(
				CANDIDATES.opponentCandidates.some((reply) =>
					legalMoves(applyMoves(FEN, [reply.uci])!).includes(candidate.uci)
				)
			).toBe(true);
		}
	});

	it("prefers a valid live PV and rejects illegal or stale continuations", () => {
		const makeLine = (pvUci: string[]) => ({
			multipv: 1,
			score: { cp: 10 },
			depth: 12,
			pvUci,
			pvSan: [],
		});
		const candidates = opponentExplorationCandidates(FEN, "w", [
			makeLine(["c7c5", "g1f3"]),
			makeLine(["h7h4", "e1e5"]),
		]);
		expect(candidates.opponentCandidates.find((move) => move.uci === "c7c5")?.probability).toBe(4);
		expect(candidates.ownCandidates.find((move) => move.uci === "g1f3")?.probability).toBe(4);
		expect(candidates.opponentCandidates.some((move) => move.uci === "h7h4")).toBe(false);
		expect(candidates.ownCandidates.some((move) => move.uci === "e1e5")).toBe(false);
		expect(opponentExplorationCandidates(FEN, "b").ownCandidates).toEqual([]);
		expect(opponentExplorationCandidates("bad fen", "w").opponentCandidates).toEqual([]);
	});
});

describe("opponent exploration bouts", () => {
	it("keeps tactical bouts on our candidates and reduces activity further under low time", () => {
		let normalMovement = 0;
		let lowMovement = 0;
		for (let seed = 0; seed < 100; seed++) {
			const normal = planOpponentExploration(options, createRng(seed));
			normalMovement += normal.actions.reduce((sum, a) => sum + totalMs(a.path ?? []), 0);
			for (const policy of [{ ownOnly: true }, { lowTime: true }]) {
				const plan = planOpponentExploration({ ...options, policy }, createRng(seed));
				expect(plan.actions.every((a) => a.kind === "rest" || a.side === "own")).toBe(true);
				if ("lowTime" in policy) {
					expect(plan.durationMs).toBeGreaterThanOrEqual(O.lowTimeBoutMs[0]);
					expect(plan.durationMs).toBeLessThanOrEqual(O.lowTimeBoutMs[1]);
					lowMovement += plan.actions.reduce((sum, a) => sum + totalMs(a.path ?? []), 0);
				}
			}
		}
		expect(lowMovement).toBeLessThan(normalMovement / 2);
		const emptyOwn = planOpponentExploration(
			{ ...options, ownCandidates: [], policy: { ownOnly: true } },
			createRng(1)
		);
		expect(emptyOwn.actions.every((a) => a.kind === "rest")).toBe(true);
	});
	it("varies sustained candidate visits on both sides with real stationary pauses", () => {
		let active = 0;
		let movement = 0;
		let duration = 0;
		let own = 0;
		let opponent = 0;
		const lengths = new Set<number>();
		for (let seed = 0; seed < 200; seed++) {
			const plan = planOpponentExploration(options, createRng(seed));
			lengths.add(Math.round(plan.durationMs));
			expect(plan.durationMs).toBeGreaterThanOrEqual(O.boutMs[0]);
			expect(plan.durationMs).toBeLessThanOrEqual(O.boutMs[1]);
			expect(
				plan.actions.reduce((sum, action) => sum + action.dwellMs + totalMs(action.path ?? []), 0)
			).toBeCloseTo(plan.durationMs, 5);
			duration += plan.durationMs;
			let priorSquare: string | undefined;
			for (const action of plan.actions) {
				if (action.kind === "rest") {
					expect(action.path).toBeUndefined();
					continue;
				}
				const path = action.path!;
				expect(action.square).not.toBe(priorSquare);
				priorSquare = action.square;
				expect(inside(path.at(-1)!, squareRect(action.square!))).toBe(true);
				const candidates =
					action.side === "own" ? CANDIDATES.ownCandidates : CANDIDATES.opponentCandidates;
				expect(
					candidates.some(
						(candidate) => (action.kind === "hover" ? candidate.from : candidate.to) === action.square
					)
				).toBe(true);
				if (action.side === "own") own++;
				else opponent++;
				movement += totalMs(path);
				active += totalMs(path) + action.dwellMs;
			}
		}
		expect(lengths.size).toBeGreaterThan(150);
		expect(own).toBeGreaterThan(opponent * 0.6);
		expect(opponent).toBeGreaterThan(own * 0.6);
		expect(active / duration).toBeGreaterThan(0.5);
		expect(movement / duration).toBeGreaterThan(0.25);
		expect(active / duration).toBeLessThan(0.88);
	});

	it("never manufactures movement without candidates or valid geometry", () => {
		for (const overrides of [
			{ ownCandidates: [], opponentCandidates: [] },
			{ geometry: geometry(false, { left: 0, top: 0, width: 0, height: 0 }) },
		]) {
			const plan = planOpponentExploration({ ...options, ...overrides }, createRng(4));
			expect(plan.actions.every((action) => action.kind === "rest" && !action.path)).toBe(true);
			expect(plan.actions.reduce((sum, action) => sum + action.dwellMs, 0)).toBe(plan.durationMs);
		}
	});

	it("is reproducible and avoids restarting on the previous target", () => {
		const a = planOpponentExploration(options, createRng(7));
		expect(planOpponentExploration(options, createRng(7))).toEqual(a);
		const previousTarget = a.lastTarget!;
		const b = planOpponentExploration({ ...options, previousTarget }, createRng(17));
		expect(b.actions.find((action) => action.square)?.square).not.toBe(previousTarget);
	});
});
