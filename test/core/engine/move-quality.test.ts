import { describe, expect, it } from "bun:test";
import { MOVE_QUALITY_ORDER } from "@core/constants/move-quality";
import { MOVE_CLASSIFICATION as C, EXPECTED_POINTS } from "@core/constants/review";
import {
	classifyMoveQuality,
	type MoveQualityInput,
	ordinaryMoveQuality,
	type ReviewFrame,
} from "@core/engine/move-quality";
import type { Eval, EvalLine } from "@typedefs/engine";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Centipawns worth `points` at `rating` — the inverse of `expectedPoints`. */
function cpFor(points: number, rating = EXPECTED_POINTS.referenceRating): number {
	const scale = Math.max(
		EXPECTED_POINTS.minSlopeScale,
		Math.min(
			EXPECTED_POINTS.maxSlopeScale,
			1 + (rating - EXPECTED_POINTS.referenceRating) / EXPECTED_POINTS.ratingScaleSpan
		)
	);
	return Math.log(points / (1 - points)) / (EXPECTED_POINTS.referenceSlope * scale);
}

function line(multipv: number, uci: string, score: Eval, depth = 18): EvalLine {
	return { multipv, score, depth, pvUci: [uci], pvSan: [] };
}

function frame(lines: EvalLine[], depth = 18): ReviewFrame {
	return { lines, depth };
}

function classify(input: Partial<MoveQualityInput> & Pick<MoveQualityInput, "uci" | "before">) {
	return classifyMoveQuality({ fen: START, ...input });
}

/** A frame for the position after 1.a3 in which the side to move (black) holds `score`. */
const afterScore = (score: Eval, depth = 18): ReviewFrame =>
	frame([line(1, "e7e5", score, depth)], depth);

describe("classifyMoveQuality — chess.com's expected-points bands", () => {
	it("maps the published loss bands, a boundary belonging to the more severe band", () => {
		expect(ordinaryMoveQuality(0, true)).toBe("best");
		expect(ordinaryMoveQuality(0.01, false)).toBe("excellent");
		expect(ordinaryMoveQuality(C.goodLoss, false)).toBe("good");
		expect(ordinaryMoveQuality(C.inaccuracyLoss, false)).toBe("inaccuracy");
		expect(ordinaryMoveQuality(C.mistakeLoss, false)).toBe("mistake");
		expect(ordinaryMoveQuality(C.blunderLoss, false)).toBe("blunder");
		expect(ordinaryMoveQuality(0.99, false)).toBe("blunder");
	});

	it("grades the played move against the best line by expected points lost", () => {
		const before = frame([line(1, "e2e4", { cp: 0 })]);
		const loses = (points: number) =>
			classify({ uci: "a2a3", before, after: afterScore({ cp: -Math.round(cpFor(points)) }) });
		expect(loses(0.49)?.quality).toBe("excellent");
		expect(loses(0.46)?.quality).toBe("good");
		expect(loses(0.42)?.quality).toBe("inaccuracy");
		expect(loses(0.35)?.quality).toBe("mistake");
		expect(loses(0.25)?.quality).toBe("mistake");
		expect(loses(0.19)?.quality).toBe("blunder");
		expect(loses(0.35)?.loss).toBeCloseTo(0.15, 2);
	});

	it("calls the engine's top move best, and any other move that loses nothing too", () => {
		const before = frame([line(1, "e2e4", { cp: 30 }), line(2, "d2d4", { cp: 30 })]);
		expect(classify({ uci: "e2e4", before })?.quality).toBe("best");
		expect(classify({ uci: "d2d4", before })?.quality).toBe("best");
		const behind = frame([line(1, "e2e4", { cp: 30 }), line(2, "d2d4", { cp: 25 })]);
		expect(classify({ uci: "d2d4", before: behind })?.quality).toBe("excellent");
	});

	it("measures in points, not centipawns: the same 200 cp matter less when already won", () => {
		const level = classify({
			uci: "a2a3",
			before: frame([line(1, "e2e4", { cp: 100 })]),
			after: afterScore({ cp: 100 }),
		});
		const won = classify({
			uci: "a2a3",
			before: frame([line(1, "e2e4", { cp: 1200 })]),
			after: afterScore({ cp: -1000 }),
		});
		expect(level?.quality).toBe("mistake");
		expect(won?.quality).toBe("excellent");
	});

	it("grades a stronger player more strictly for the same slip", () => {
		const input = {
			uci: "a2a3",
			before: frame([line(1, "e2e4", { cp: 0 })]),
			after: afterScore({ cp: 45 }),
		};
		const novice = classify({ ...input, moverRating: 700 });
		const expert = classify({ ...input, moverRating: 2500 });
		expect(expert?.loss ?? 0).toBeGreaterThan(novice?.loss ?? 1);
		expect(novice?.quality).toBe("good");
		expect(expert?.quality).toBe("inaccuracy");
	});
});

describe("classifyMoveQuality — what it needs", () => {
	it("rejects incomplete frames and a shallower played line mixed into the frame", () => {
		const before = frame([line(1, "e2e4", { cp: 30 }), line(2, "a2a3", { cp: 20 }, 8)]);
		expect(classify({ uci: "e2e4", before: { ...before, complete: false } })).toBeNull();
		expect(classify({ uci: "a2a3", before })).toBeNull();
	});
	it("rejects an illegal after-position root instead of grading its score", () => {
		expect(
			classify({
				uci: "a2a3",
				before: frame([line(1, "e2e4", { cp: 30 })]),
				after: frame([line(1, "e2e4", { cp: -30 })]),
			})
		).toBeNull();
	});
	it("requires tactical depth and comparable evidence for brilliant", () => {
		const fen = "4k3/5p2/8/6N1/8/8/8/4K3 w - - 0 1";
		const shallow = frame([line(1, "g5e6", { cp: 300 }, 12), line(2, "g5f3", { cp: 40 }, 12)], 12);
		const verdict = classifyMoveQuality({ fen, uci: "g5e6", before: shallow });
		expect(verdict?.quality).toBe("best");
		expect(verdict?.brilliant?.reason).toBe("insufficient-evidence");
		const noAlternatives = frame([line(1, "g5e6", { cp: 300 })]);
		expect(classifyMoveQuality({ fen, uci: "g5e6", before: noAlternatives })?.brilliant?.reason).toBe(
			"insufficient-evidence"
		);
	});
	it("scores a move outside the before lines from the position it made", () => {
		const before = frame([line(1, "e2e4", { cp: 30 })]);
		expect(classify({ uci: "a2a3", before })).toBeNull();
		expect(
			classify({ uci: "a2a3", before, after: afterScore({ cp: 0 }, C.minDepth - 1) })
		).toBeNull();
		expect(classify({ uci: "a2a3", before, after: afterScore({ cp: 0 }) })?.depth).toBe(18);
	});

	it("abstains on illegal moves, empty or shallow frames and bound-only lines", () => {
		expect(classify({ uci: "e2e5", before: frame([line(1, "e2e4", { cp: 30 })]) })).toBeNull();
		expect(classify({ uci: "e2e4", before: frame([]) })).toBeNull();
		expect(
			classify({ uci: "e2e4", before: frame([line(1, "e2e4", { cp: 30 }, C.minDepth - 1)]) })
		).toBeNull();
		const bounded: EvalLine = { ...line(1, "e2e4", { cp: 900 }), bound: "lower" };
		expect(classify({ uci: "e2e4", before: frame([bounded]) })).toBeNull();
	});

	it("only ever answers a category from the ladder", () => {
		const verdict = classify({ uci: "e2e4", before: frame([line(1, "e2e4", { cp: 30 })]) });
		expect(MOVE_QUALITY_ORDER).toContain(verdict?.quality ?? ("none" as never));
	});
});

describe("classifyMoveQuality — forced", () => {
	// Black's king on a8: b7 and a7 are covered, b8 is the only legal move.
	const ONLY_MOVE = "k7/2R5/1K6/8/8/8/8/8 b - - 0 1";

	it("rates the only legal move forced, before anything else and without frames", () => {
		expect(classifyMoveQuality({ fen: ONLY_MOVE, uci: "a8b8", before: frame([]) })).toMatchObject({
			quality: "forced",
			depth: 0,
			brilliant: null,
		});
		const scored = frame([line(1, "a8b8", { mate: -3 })]);
		expect(classifyMoveQuality({ fen: ONLY_MOVE, uci: "a8b8", before: scored })?.quality).toBe(
			"forced"
		);
	});

	it("never rates a move forced when there was a choice", () => {
		const before = frame([line(1, "e2e4", { cp: 30 })]);
		expect(classify({ uci: "e2e4", before })?.quality).toBe("best");
	});
});

describe("classifyMoveQuality — mate", () => {
	it("rates the checkmate itself mate, one move from mate", () => {
		// Fool's mate: 1.f3 e5 2.g4 Qh4#.
		const fen = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
		const verdict = classifyMoveQuality({
			fen,
			uci: "d8h4",
			before: frame([line(1, "d8h4", { mate: 1 })]),
		});
		expect(verdict).toMatchObject({ quality: "mate", mateIn: 1 });
	});

	it("rates every move that keeps a forced mate, counting the move itself", () => {
		const before = frame([line(1, "e2e4", { mate: 3 }), line(2, "d2d4", { cp: 50 })]);
		expect(classify({ uci: "e2e4", before })).toMatchObject({ quality: "mate", mateIn: 3 });
		// Scored from the position it made: black is mated in 2 more of white's moves.
		expect(classify({ uci: "a2a3", before, after: afterScore({ mate: -2 }) })).toMatchObject({
			quality: "mate",
			mateIn: 3,
		});
	});

	it("rates only the mating sequence's own moves mate: a slower mate is graded on the ladder", () => {
		// Owner, 2026-09-19: a forced mate that is on the board but not being played is not Mate.
		const before = frame([line(1, "e2e4", { mate: 2 }), line(2, "d2d4", { mate: 5 })]);
		expect(classify({ uci: "e2e4", before })).toMatchObject({ quality: "mate", mateIn: 2 });
		// Still a forced mate, and the distance is still reported — but not the sequence's move.
		const slower = classify({ uci: "d2d4", before });
		expect(slower?.mateIn).toBe(5);
		expect(slower?.quality).not.toBe("mate");
		// The same for a move outside the lines, scored from the position it made.
		const unlisted = classify({ uci: "a2a3", before, after: afterScore({ mate: -4 }) });
		expect(unlisted?.mateIn).toBe(5);
		expect(unlisted?.quality).not.toBe("mate");
	});

	it("rates the move that starts a forced mate the review had not seen yet", () => {
		const before = frame([line(1, "e2e4", { cp: 900 }), line(2, "d2d4", { cp: 850 })]);
		expect(classify({ uci: "a2a3", before, after: afterScore({ mate: -3 }) })).toMatchObject({
			quality: "mate",
			mateIn: 4,
		});
	});

	it("does not rate the defender's moves, or a move that lets the mate go, mate", () => {
		const before = frame([line(1, "e2e4", { mate: -4 })]);
		expect(classify({ uci: "e2e4", before })?.quality).not.toBe("mate");
		const letsGo = classify({
			uci: "a2a3",
			before: frame([line(1, "e2e4", { mate: 2 })]),
			after: afterScore({ cp: 0 }),
		});
		expect(letsGo?.mateIn).toBeNull();
		expect(letsGo?.quality).toBe("blunder");
	});
});

describe("classifyMoveQuality — book", () => {
	it("recognises theory, unless it throws real points away", () => {
		const before = frame([line(1, "e2e4", { cp: 30 }), line(2, "d2d4", { cp: 25 })]);
		expect(classify({ uci: "d2d4", before, inBook: true })?.quality).toBe("book");
		const trap = classify({ uci: "a2a3", before, after: afterScore({ cp: 400 }), inBook: true });
		expect(trap?.quality).toBe("blunder");
	});
});

describe("classifyMoveQuality — great", () => {
	it("rates the best move great when every alternative gives the game away", () => {
		const before = frame([line(1, "e2e4", { cp: 250 }), line(2, "d2d4", { cp: 0 })]);
		expect(classify({ uci: "e2e4", before })?.quality).toBe("great");
	});

	it("needs a runner-up, a real gap and a position that was not already won", () => {
		expect(classify({ uci: "e2e4", before: frame([line(1, "e2e4", { cp: 250 })]) })?.quality).toBe(
			"best"
		);
		const narrow = frame([line(1, "e2e4", { cp: 40 }), line(2, "d2d4", { cp: 20 })]);
		expect(classify({ uci: "e2e4", before: narrow })?.quality).toBe("best");
		const wonAnyway = frame([line(1, "e2e4", { cp: 1200 }), line(2, "d2d4", { cp: 500 })]);
		expect(classify({ uci: "e2e4", before: wonAnyway })?.quality).toBe("best");
		const stillLost = frame([line(1, "e2e4", { cp: -150 }), line(2, "d2d4", { cp: -600 })]);
		expect(classify({ uci: "e2e4", before: stillLost })?.quality).toBe("best");
	});

	it("is more generous for newer players", () => {
		const gap = cpFor(0.5 + 0.12);
		const before = frame([line(1, "e2e4", { cp: Math.round(gap) }), line(2, "d2d4", { cp: 0 })]);
		expect(classify({ uci: "e2e4", before, moverRating: 600 })?.quality).toBe("great");
		expect(classify({ uci: "e2e4", before, moverRating: 2400 })?.quality).toBe("best");
	});

	it("never calls taking material for free great", () => {
		// Nxe5 grabs a loose pawn; the gap to anything else is the pawn. (The a2 pawn keeps the
		// capture from ending the game in insufficient material.)
		const fen = "4k3/8/8/4p3/8/5N2/P7/4K3 w - - 0 1";
		const before = frame([line(1, "f3e5", { cp: 250 }), line(2, "f3d4", { cp: 0 })]);
		expect(classifyMoveQuality({ fen, uci: "f3e5", before })?.quality).toBe("best");
	});
});

describe("classifyMoveQuality — miss", () => {
	// Black's last move (from `previous`, black to move, black +0.00) handed white a winning game.
	const previous = frame([line(1, "e7e5", { cp: 0 })]);
	const winning = frame([line(1, "e2e4", { cp: 600 }), line(2, "d2d4", { cp: 550 })]);

	it("rates giving the opportunity back a miss", () => {
		const verdict = classify({
			uci: "a2a3",
			before: winning,
			after: afterScore({ cp: -20 }),
			previous,
		});
		expect(verdict?.quality).toBe("miss");
	});

	it("needs the opponent's mistake, and a move that does not keep the win", () => {
		expect(classify({ uci: "a2a3", before: winning, after: afterScore({ cp: -20 }) })?.quality).toBe(
			"blunder"
		);
		const alreadyWinning = frame([line(1, "e7e5", { cp: -500 })]);
		expect(
			classify({
				uci: "a2a3",
				before: winning,
				after: afterScore({ cp: -20 }),
				previous: alreadyWinning,
			})?.quality
		).toBe("blunder");
		expect(
			classify({ uci: "a2a3", before: winning, after: afterScore({ cp: -500 }), previous })?.quality
		).not.toBe("miss");
	});

	it("grades a move that also falls far below the earlier position on its loss", () => {
		const verdict = classify({
			uci: "a2a3",
			before: winning,
			after: afterScore({ cp: 600 }),
			previous,
		});
		expect(verdict?.quality).toBe("blunder");
	});
});

describe("classifyMoveQuality — brilliant", () => {
	const fen = "4k3/5p2/8/6N1/8/8/8/4K3 w - - 0 1";

	it("rates a sound piece sacrifice that is the best move brilliant", () => {
		const before = frame([line(1, "g5e6", { cp: 300 }), line(2, "g5f3", { cp: 40 })]);
		const verdict = classifyMoveQuality({ fen, uci: "g5e6", before });
		expect(verdict?.quality).toBe("brilliant");
		expect(verdict?.brilliant?.reason).toBe("sound-sacrifice");
	});

	it("grades the same sacrifice on its loss when it is not good", () => {
		const before = frame([line(1, "g5f3", { cp: 400 }), line(2, "g5e6", { cp: 0 })]);
		const verdict = classifyMoveQuality({ fen, uci: "g5e6", before });
		expect(verdict?.quality).toBe("blunder");
		expect(verdict?.brilliant?.brilliant).toBe(false);
	});

	it("keeps the brilliant gates' answer under a mate rating", () => {
		const before = frame([line(1, "g5e6", { mate: 5 }), line(2, "g5f3", { cp: 40 })]);
		const verdict = classifyMoveQuality({ fen, uci: "g5e6", before });
		expect(verdict?.quality).toBe("mate");
		expect(verdict?.brilliant?.brilliant).toBe(true);
	});
});
