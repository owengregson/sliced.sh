// test/core/strength/max-strength-selection.test.ts — max-strength mode plays the engine's
// strongest searched line (owner, 2026-09-15: "just play the absolute best possible move in every
// situation"): the repetition preference that can drop it is off, legality is checked, and a 3799
// target keeps the guarded high-Elo path. The board-proven draw veto (a line whose PV reaches
// stalemate, a dead position or an actual threefold while its score claims a win) stays on at 3800
// — `conversion.test.ts` pins it — because only a stale score can put such a line on top.
import { describe, expect, it } from "bun:test";
import type { PositionHistory } from "@core/chess/history";
import { applyMoves } from "@core/chess/san";
import { LIMITS } from "@core/constants/limits";
import { createRng } from "@core/rng";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { repetitionRisk } from "@core/strength/repetition";
import { ctx, line, START } from "./helpers";

const MAX = LIMITS.eloMax;
const BELOW = LIMITS.eloMax - 1;

/** Three near-equal openings: the jittered, sampled policies would spread over them. */
const OPENINGS = [
	line(START, "e2e4", { cp: 32 }, 1),
	line(START, "d2d4", { cp: 30 }, 2),
	line(START, "g1f3", { cp: 28 }, 3),
];

// A king shuffle whose next move returns to the start position once (a twofold, no draw yet).
const SHUFFLE_START = "6k1/8/8/8/8/8/PPPP4/6K1 b - - 0 1";
const history: PositionHistory = { fen: SHUFFLE_START, moves: ["g8h8", "g1h1", "h8g8"] };
const shuffleFen = applyMoves(history.fen, history.moves) ?? "";

describe("selectMove at max strength", () => {
	it("plays the engine's top line in every selection mode, at every accuracy offset, pressure and seed", () => {
		for (const selectionMode of ["engine-elo", "hybrid", "persona-sampling"] as const)
			for (const blunderScale of [LIMITS.blunderScaleMin, 1, LIMITS.blunderScaleMax])
				for (let seed = 0; seed < 25; seed++) {
					const chosen = selectMove(
						OPENINGS,
						ctx({
							targetElo: MAX,
							selectionMode,
							blunderScale,
							form: -1,
							myClockMs: 2_000,
							oppClockMs: 1_000,
							baseMs: 60_000,
							rng: createRng(`max:${seed}`),
						})
					);
					expect(chosen.uci).toBe("e2e4");
					expect(chosen.source).toBe("engine-elo");
					expect(chosen.rankInLines).toBe(1);
					expect(chosen.rationale.join(" ")).toContain("max strength: the engine's best move");
				}
	});

	it("trusts the engine's history-aware score over the repetition preference that 3799 applies", () => {
		expect(repetitionRisk(history, "h1g1")).toBe(1);
		const lines = [
			line(shuffleFen, "h1g1", { cp: 800 }, 1),
			line(shuffleFen, "a2a3", { cp: 775 }, 2),
		];
		const below = selectMove(lines, ctx({ fen: shuffleFen, history, targetElo: BELOW }));
		expect(below.uci).toBe("a2a3");
		expect(below.rationale.join(" ")).toContain("repetition");
		expect(below.rationale.join(" ")).toContain(
			"full-strength engine: strongest guarded continuation"
		);
		const max = selectMove(lines, ctx({ fen: shuffleFen, history, targetElo: MAX }));
		expect(max.uci).toBe("h1g1");
		expect(max.rankInLines).toBe(1);
		expect(max.rationale.join(" ")).not.toContain("repetition");
		expect(max.rationale.join(" ")).toContain("max strength: the engine's best move");
	});

	it("orders by the searched score: neither the report order nor a weaker bestmove overrides it", () => {
		const shuffled = [OPENINGS[2]!, OPENINGS[0]!, OPENINGS[1]!];
		expect(selectMove(shuffled, ctx({ targetElo: MAX })).uci).toBe("e2e4");
		for (const engineBestmove of ["d2d4", "a2a3", "e2e5", "0000"])
			expect(selectMove(OPENINGS, ctx({ targetElo: MAX, engineBestmove })).uci).toBe("e2e4");
	});

	it("checks legality: an illegal top line is skipped, no legal line throws", () => {
		const illegalTop = [line(START, "e2e5", { cp: 90 }, 1), OPENINGS[1]!];
		expect(selectMove(illegalTop, ctx({ targetElo: MAX })).uci).toBe("d2d4");
		expect(() => selectMove([line(START, "e2e5", { cp: 90 }, 1)], ctx({ targetElo: MAX }))).toThrow(
			RangeError
		);
	});

	it("plays a losing top line too, and advances the per-game state", () => {
		const state = createSelectionState();
		const lost = [line(START, "e2e4", { cp: -400 }, 1), line(START, "d2d4", { cp: -900 }, 2)];
		expect(selectMove(lost, ctx({ targetElo: MAX, state })).uci).toBe("e2e4");
		expect(selectMove(OPENINGS, ctx({ targetElo: MAX, state })).uci).toBe("e2e4");
		expect(state.top1Streak).toBe(2);
		expect(state.previousOwnMoves).toEqual(["e2e4", "e2e4"]);
	});
});
