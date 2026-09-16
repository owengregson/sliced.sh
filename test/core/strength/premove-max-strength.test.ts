// test/core/strength/premove-max-strength.test.ts — max-strength mode premoves only what the board
// proves (owner, 2026-09-15: "the absolute best possible move in every situation"): the only legal
// move, or a recapture every reply leaves safe. A 3799 target keeps today's premoves.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { createRng, type Rng } from "@core/rng";
import { type PremoveContext, type PremoveDeps, premoveCandidate } from "@core/strength/premove";
import type { EvalLine } from "@typedefs/engine";

function line(uci: string, cp: number, multipv: number): EvalLine {
	return { multipv, score: { cp }, depth: 12, pvUci: [uci], pvSan: [] };
}

const alwaysRng: Rng = { ...createRng(1), chance: () => true };

/** `analyseAfter` fake: `opponent` answers the 1-move query, `reply` the 2-move query. */
function deps(opponent: EvalLine[], reply: EvalLine[]): PremoveDeps {
	return { analyseAfter: async (_fen, moves) => (moves.length === 1 ? opponent : reply) };
}

// 1. e4 e5 2. Nf3 Nc6 3. -- Nf6, white to move: m = Nxe5, predictable reply r = Nxe5.
const FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 4";
const OPPONENT_LINES = [line("c6e5", 0, 1), line("d7d6", -150, 2), line("a7a6", -300, 3)];

function ctx(targetElo: number, overrides: Partial<PremoveContext> = {}): PremoveContext {
	return {
		fen: FEN,
		move: "f3e5",
		targetElo,
		timeControl: { baseMs: 180_000, incMs: 0 },
		ponder: "c6e5",
		rng: alwaysRng,
		...overrides,
	};
}

describe("premoveCandidate at max strength", () => {
	it("never arms a clear-best quiet move read off a short search (`loss2nd`); 3799 still does", async () => {
		const reply = [line("d2d4", 0, 1), line("d2d3", -400, 2)];
		const below = await premoveCandidate(ctx(LIMITS.eloMax - 1), deps(OPPONENT_LINES, reply));
		expect(below?.reason).toBe("loss2nd");
		expect(await premoveCandidate(ctx(LIMITS.eloMax), deps(OPPONENT_LINES, reply))).toBeNull();
	});

	it("still arms a recapture every legal reply leaves a safe exchange", async () => {
		// Bxc3 trades a bishop for a knight; bxc3 takes back the bishop.
		const fen = "4k3/8/8/8/1b6/2N5/1P6/4K3 w - - 0 1";
		const opp = [line("b4c3", 0, 1), line("b4a5", -200, 2), line("e8f8", -300, 3)];
		const res = await premoveCandidate(
			ctx(LIMITS.eloMax, { fen, move: "e1f1", ponder: undefined }),
			deps(opp, [line("b2c3", 200, 1)])
		);
		expect(res?.premove).toBe("b2c3");
		expect(res?.reason).toBe("recapture");
	});

	it("still arms the only legal move", async () => {
		// White Kh1 boxed by g2/h2, Rc2; black Ra8. m = Rc3, r = Ra1+, q = Rc1 (the only legal move).
		const fen = "r6k/8/8/8/8/8/2R3PP/7K w - - 0 1";
		const opp = [line("a8a1", 0, 1), line("h8g8", -500, 2)];
		const res = await premoveCandidate(
			ctx(LIMITS.eloMax, { fen, move: "c2c3", ponder: "a8a1" }),
			deps(opp, [line("c3c1", 0, 1)])
		);
		expect(res?.premove).toBe("c3c1");
		expect(res?.reason).toBe("only-move");
	});
});
