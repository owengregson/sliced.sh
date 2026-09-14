import { describe, expect, it } from "bun:test";
import { MOVE_QUALITY_ORDER, MOVE_QUALITY as Q } from "@core/constants/move-quality";
import { classifyMoveQuality } from "@core/engine/move-quality";
import { cpEffective, winProb } from "@core/strength/elo-map";
import type { Eval, EvalLine } from "@typedefs/engine";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** Past `bookMaxPly`, so the opening-book approximation never fires unless a test asks for it. */
const LATE_PLY = Q.bookMaxPly + 4;

function line(multipv: number, uci: string, score: Eval, depth = 20): EvalLine {
	return { multipv, score, depth, pvUci: [uci], pvSan: [] };
}

/** The played move is not in the lines; it is scored by the position after it instead. */
function verdict(
	lines: EvalLine[],
	uci: string,
	playedScore?: Eval,
	extra: { ply?: number; inBook?: boolean; fen?: string } = {}
) {
	return classifyMoveQuality({
		fen: extra.fen ?? START,
		uci,
		ply: extra.ply ?? LATE_PLY,
		lines,
		...(playedScore ? { playedScore } : {}),
		...(extra.inBook === undefined ? {} : { inBook: extra.inBook }),
	});
}

describe("classifyMoveQuality — the bands", () => {
	it("calls a move that throws a big advantage away a blunder", () => {
		const v = verdict([line(1, "e2e4", { cp: 400 })], "a2a3", { cp: 0 });
		expect(v?.quality).toBe("blunder");
		expect(v?.lossWp).toBeGreaterThanOrEqual(Q.blunderLoss);
		expect(v?.cpLoss).toBe(400);
	});

	it("separates mistake, inaccuracy, good and excellent by win-probability loss", () => {
		expect(verdict([line(1, "e2e4", { cp: 250 })], "a2a3", { cp: 0 })?.quality).toBe("mistake");
		expect(verdict([line(1, "e2e4", { cp: 100 })], "a2a3", { cp: 0 })?.quality).toBe("inaccuracy");
		expect(verdict([line(1, "e2e4", { cp: 60 })], "a2a3", { cp: 0 })?.quality).toBe("good");
		expect(verdict([line(1, "e2e4", { cp: 20 })], "a2a3", { cp: 0 })?.quality).toBe("excellent");
	});

	it("measures the loss in win probability, not in centipawns", () => {
		// The same 200 cp given up is a mistake around level and barely anything when already won.
		const level = verdict([line(1, "e2e4", { cp: 100 })], "a2a3", { cp: -100 });
		const won = verdict([line(1, "e2e4", { cp: 800 })], "a2a3", { cp: 600 });
		expect(level?.cpLoss).toBe(200);
		expect(won?.cpLoss).toBe(200);
		expect(level?.quality).toBe("mistake");
		expect(won?.quality).toBe("good");
	});

	it("calls the engine's first choice best, ties included", () => {
		const lines = [line(1, "e2e4", { cp: 30 }), line(2, "d2d4", { cp: 24 })];
		expect(verdict(lines, "e2e4")?.quality).toBe("best");
		// Within `bestTieCp` of the top: the MultiPV order is not a judgement.
		expect(verdict(lines, "d2d4")?.quality).toBe("best");
		expect(verdict(lines, "d2d4")?.top).toBe(true);
		// Outside it, it is merely excellent.
		const wider = [line(1, "e2e4", { cp: 30 }), line(2, "d2d4", { cp: 12 })];
		expect(verdict(wider, "d2d4")?.quality).toBe("excellent");
	});
});

describe("classifyMoveQuality — the overrides", () => {
	it("calls giving up a won game a miss rather than a mistake", () => {
		const v = verdict([line(1, "e2e4", { mate: 3 })], "a2a3", { cp: 300 });
		expect(v?.quality).toBe("miss");
		expect(winProb(cpEffective({ mate: 3 }))).toBeGreaterThanOrEqual(Q.missWinBefore);
	});

	it("never lets a miss outrank a blunder", () => {
		// Mate was there and the move loses outright: the worse verdict wins.
		const v = verdict([line(1, "e2e4", { mate: 3 })], "a2a3", { mate: -2 });
		expect(v?.quality).toBe("blunder");
	});

	it("keeps calling a still-winning move excellent when the win survives", () => {
		const v = verdict([line(1, "e2e4", { mate: 3 })], "a2a3", { cp: 1200 });
		expect(v?.quality).toBe("excellent");
	});

	it("calls the top move book while the opening lasts, and takes the caller's word for it", () => {
		const lines = [line(1, "e2e4", { cp: 30 }), line(2, "d2d4", { cp: 28 })];
		expect(verdict(lines, "e2e4", undefined, { ply: 2 })?.quality).toBe("book");
		expect(verdict(lines, "e2e4", undefined, { ply: LATE_PLY })?.quality).toBe("best");
		// An explicit statement wins over the ply approximation, in both directions.
		expect(verdict(lines, "e2e4", undefined, { ply: 2, inBook: false })?.quality).toBe("best");
		expect(verdict([line(1, "e2e4", { cp: 60 })], "a2a3", { cp: 0 }, { inBook: true })?.quality).toBe(
			"book"
		);
	});

	it("does not call a losing move book", () => {
		expect(
			verdict([line(1, "e2e4", { cp: 400 })], "a2a3", { cp: 0 }, { ply: 2, inBook: true })?.quality
		).toBe("blunder");
	});

	it("calls the only move that held great", () => {
		const lines = [line(1, "e2e4", { cp: 250 }), line(2, "d2d4", { cp: 0 })];
		expect(verdict(lines, "e2e4")?.quality).toBe("great");
		// With no runner-up there is no claim to make.
		expect(verdict([line(1, "e2e4", { cp: 250 })], "e2e4")?.quality).toBe("best");
		// A narrow gap is an ordinary best move.
		const narrow = [line(1, "e2e4", { cp: 40 }), line(2, "d2d4", { cp: 20 })];
		expect(verdict(narrow, "e2e4")?.quality).toBe("best");
	});

	it("calls a sound piece sacrifice that is also the best move brilliant", () => {
		// Ng5–e6 puts the knight where the f7 pawn takes it for nothing.
		const fen = "4k3/5p2/8/6N1/8/8/8/4K3 w - - 0 1";
		const lines = [line(1, "g5e6", { cp: 300 }), line(2, "g5f3", { cp: 40 })];
		expect(verdict(lines, "g5e6", undefined, { fen })?.quality).toBe("brilliant");
		// The same sacrifice when it is not the best move is judged on its loss alone.
		const losing = [line(1, "g5f3", { cp: 400 }), line(2, "g5e6", { cp: 0 })];
		expect(verdict(losing, "g5e6", undefined, { fen })?.quality).toBe("blunder");
	});

	it("does not call a quiet best move brilliant", () => {
		const lines = [line(1, "g5f3", { cp: 300 }), line(2, "g5e6", { cp: 40 })];
		expect(
			verdict(lines, "g5f3", undefined, { fen: "4k3/5p2/8/6N1/8/8/8/4K3 w - - 0 1" })?.quality
		).toBe("great");
	});

	it("does not call a pawn offer brilliant", () => {
		// b2–b4 hangs a pawn to the a5 bishop; below `brilliantMinPieceValue`.
		const fen = "4k3/8/8/b7/8/8/1P6/4K3 w - - 0 1";
		const lines = [line(1, "b2b4", { cp: 300 }), line(2, "b2b3", { cp: 40 })];
		expect(verdict(lines, "b2b4", undefined, { fen })?.quality).toBe("great");
	});
});

describe("classifyMoveQuality — when it refuses to answer", () => {
	it("says nothing without a line, without a score for the played move, or too shallow", () => {
		expect(verdict([], "e2e4", { cp: 0 })).toBeNull();
		expect(verdict([line(1, "e2e4", { cp: 30 })], "a2a3")).toBeNull();
		expect(verdict([line(1, "e2e4", { cp: 30 }, Q.minDepth - 1)], "e2e4")).toBeNull();
	});

	it("ignores fail-high/low reports rather than scoring against them", () => {
		const bounded: EvalLine = { ...line(1, "e2e4", { cp: 900 }), bound: "lower" };
		expect(verdict([bounded], "e2e4", { cp: 0 })).toBeNull();
		expect(verdict([bounded, line(2, "d2d4", { cp: 30 })], "d2d4")?.quality).toBe("best");
	});

	it("only ever answers a category from the ladder", () => {
		const answers = [
			verdict([line(1, "e2e4", { cp: 400 })], "a2a3", { cp: 0 }),
			verdict([line(1, "e2e4", { cp: 30 })], "e2e4"),
			verdict([line(1, "e2e4", { mate: 3 })], "a2a3", { cp: 300 }),
		];
		for (const answer of answers) {
			expect(answer).not.toBeNull();
			expect(MOVE_QUALITY_ORDER).toContain(answer!.quality);
			expect(answer?.depth).toBe(20);
		}
	});
});
