import { describe, expect, it } from "bun:test";
import { BRILLIANT } from "@core/constants/review";
import {
	type BrilliantEvidence,
	classifyBrilliant,
	planBrilliant,
	staticExchange,
} from "@core/engine/brilliant";

/** White knight g5, black pawn f7: Ng5–e6 leaves the knight to the pawn for nothing. */
const KNIGHT_OFFER = "4k3/5p2/8/6N1/8/8/8/4K3 w - - 0 1";

const evidence = (over: Partial<BrilliantEvidence> = {}): BrilliantEvidence => ({
	playedPoints: 0.7,
	loss: 0,
	alternatives: [{ uci: "g5f3", points: 0.5 }],
	moverRating: 1500,
	...over,
});

describe("planBrilliant — the offers", () => {
	it("finds a piece hung on purpose, and a safe alternative", () => {
		const plan = planBrilliant({ fen: KNIGHT_OFFER, uci: "g5e6" });
		expect(plan?.offers).toEqual([
			{ capture: "f7e6", square: "e6", shape: "hanging-piece", concession: 3 },
		]);
		expect(plan?.safeAlternative).toBe(true);
		expect(plan?.legalMoves).toBeGreaterThan(1);
	});

	it("nets the move's own capture and the recapture out of the concession", () => {
		// Bxf7+ Kxf7: a bishop for a pawn is a two-pawn concession, a sacrifice by capture.
		const fen = "4k3/5p2/8/2B5/8/8/8/4K3 w - - 0 1";
		expect(planBrilliant({ fen, uci: "c5f8" })?.offers).toEqual([
			{ capture: "e8f8", square: "f8", shape: "hanging-piece", concession: 3 },
		]);
		const bishopTakesPawn = "4k3/5p2/8/8/8/8/1B6/4K3 w - - 0 1";
		expect(planBrilliant({ fen: bishopTakesPawn, uci: "b2f6" })?.offers).toEqual([]);
		const capture = "4k3/5p2/8/8/2B5/8/8/4K3 w - - 0 1";
		expect(planBrilliant({ fen: capture, uci: "c4f7" })?.offers).toEqual([
			{ capture: "e8f7", square: "f7", shape: "capture-sacrifice", concession: 2 },
		]);
	});

	it("does not call a defended trade a sacrifice", () => {
		// Nd4–e6 is attacked by the f7 pawn but defended by the d5 pawn: pawn takes, pawn retakes,
		// the knight for a pawn is still a concession — while Nd4–b5 is simply safe.
		const defended = "4k3/5p2/8/3P4/3N4/8/8/4K3 w - - 0 1";
		expect(planBrilliant({ fen: defended, uci: "d4b5" })?.offers).toEqual([]);
		// Nc3–e4 into the f6 knight, with the d3 pawn guarding e4: knight for knight, an even trade.
		const even = "4k3/8/5n2/8/8/2NP4/8/4K3 w - - 0 1";
		expect(planBrilliant({ fen: even, uci: "c3e4" })?.offers).toEqual([]);
	});

	it("finds an ignored threat: a piece left attacked while another moves", () => {
		// The e3 knight is attacked by the d4 pawn before and after a2–a3.
		const fen = "4k3/8/8/8/3p4/4N3/P7/4K3 w - - 0 1";
		const plan = planBrilliant({ fen, uci: "a2a3" });
		expect(plan?.offers).toEqual([
			{ capture: "d4e3", square: "e3", shape: "ignored-threat", concession: 3 },
		]);
	});
	it("finds an indirect sacrifice revealed on a different square", () => {
		const fen = "7k/8/1b6/8/3P4/4N3/8/4K3 w - - 0 1";
		expect(planBrilliant({ fen, uci: "d4d5" })?.offers).toContainEqual({
			capture: "b6e3",
			square: "e3",
			shape: "indirect",
			concession: 3,
		});
	});

	it("finds an exchange sacrifice", () => {
		// Rd2–d5 puts the rook where the f6 knight takes it; the d1 rook retakes the knight.
		const fen = "4k3/8/5n2/8/8/8/3R4/3RK3 w - - 0 1";
		const offers = planBrilliant({ fen, uci: "d2d5" })?.offers ?? [];
		expect(offers).toContainEqual({
			capture: "f6d5",
			square: "d5",
			shape: "exchange-sacrifice",
			concession: 2,
		});
	});

	it("ignores pawn offers and illegal moves", () => {
		const pawn = "4k3/8/8/b7/8/8/1P6/4K3 w - - 0 1";
		expect(planBrilliant({ fen: pawn, uci: "b2b4" })?.offers).toEqual([]);
		expect(planBrilliant({ fen: KNIGHT_OFFER, uci: "g5g7" })).toBeNull();
		expect(BRILLIANT.minOfferedPiece).toBe(3);
	});
});

describe("staticExchange", () => {
	it("is the material a capture nets on its square", () => {
		// Nxe5 wins a free pawn; Qxd5 into a defended pawn loses the queen for it.
		expect(staticExchange("4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5")).toBe(1);
		expect(staticExchange("4k3/2p5/3p4/8/8/8/8/3QK3 w - - 0 1", "d1d6")).toBe(-8);
		expect(staticExchange(KNIGHT_OFFER, "e1e9")).toBeNull();
	});
});

describe("sacrifice correctness regressions", () => {
	it("does not count a pinned pawn's pseudo-legal capture", () => {
		const fen = "4k3/4p3/8/7N/8/8/8/4R1K1 w - - 0 1";
		// Nf6 is attacked geometrically by e7, but exf6 exposes its own king to Re1.
		expect(planBrilliant({ fen, uci: "h5f6" })?.offers).toEqual([]);
	});
	it("does not count a king capture onto a defended square", () => {
		const fen = "4k3/8/7N/8/8/8/8/5RK1 w - - 0 1";
		expect(planBrilliant({ fen, uci: "h6f7" })?.offers).toEqual([]);
	});
	it("does not turn an exhausted material search into a safe sacrifice", () => {
		const verdict = classifyBrilliant(
			{ fen: KNIGHT_OFFER, uci: "g5e6", ...evidence() },
			{ ...BRILLIANT, maxExchangeNodes: 0 }
		);
		expect(verdict.reason).toBe("insufficient-evidence");
	});
	it("requires a legal scored alternative and finite probabilities", () => {
		for (const patch of [
			{ alternatives: [] },
			{ alternatives: [{ uci: "g5g7", points: 0.5 }] },
			{ loss: Number.NaN },
			{ playedPoints: Number.NaN },
			{ ratedLoss: Number.NaN },
			{ alternatives: [{ uci: "g5f3", points: Number.NaN }] },
		])
			expect(classifyBrilliant({ fen: KNIGHT_OFFER, uci: "g5e6", ...evidence(patch) }).reason).toBe(
				"insufficient-evidence"
			);
	});
	it("does not award an unavoidable material concession", () => {
		// The bishop is pinned to the king and lost after every legal king move.
		const fen = "4r2k/8/8/8/8/3p4/4B3/4K3 w - - 0 1";
		const plan = planBrilliant({ fen, uci: "e1d1" });
		expect(plan?.offers.length).toBeGreaterThan(0);
		expect(plan?.safeAlternative).toBe(false);
	});
});

describe("classifyBrilliant — the gates", () => {
	const input = (over: Partial<BrilliantEvidence> = {}) => ({
		fen: KNIGHT_OFFER,
		uci: "g5e6",
		...evidence(over),
	});

	it("badges a sound sacrifice that is the best move", () => {
		expect(classifyBrilliant(input())).toMatchObject({ brilliant: true, reason: "sound-sacrifice" });
	});

	it("1 — declines book moves and moves without a real choice", () => {
		expect(classifyBrilliant({ ...input(), inBook: true }).reason).toBe("book");
		// Black to move in check with only one legal reply.
		const forced = "k7/1R6/1K6/8/8/8/8/8 b - - 0 1";
		expect(classifyBrilliant({ fen: forced, uci: "a8a8", ...evidence() }).reason).toBe("illegal");
	});

	it("2 — declines a move that offers nothing", () => {
		expect(classifyBrilliant({ ...input(), uci: "g5f3" }).reason).toBe("not-sacrifice");
	});

	it("3 — declines an unsound or clearly inferior sacrifice", () => {
		expect(classifyBrilliant(input({ playedPoints: 0.3 })).reason).toBe("unsound");
		expect(classifyBrilliant(input({ playedMate: -2, playedPoints: 0 })).reason).toBe("unsound");
		// At 1500 the near-best allowance is 0.095.
		expect(classifyBrilliant(input({ loss: 0.13 })).reason).toBe("not-near-best");
		// A mate elsewhere makes a non-mating sacrifice second best, however good it is.
		expect(
			classifyBrilliant(input({ alternatives: [{ uci: "g5f3", points: 1, mate: 3 }] })).reason
		).toBe("not-near-best");
	});
	it("judges soundness at the mover's rating while retaining the reference comparison scale", () => {
		expect(
			classifyBrilliant(input({ playedPoints: 0.44, ratedPlayedPoints: 0.46, moverRating: 900 }))
				.brilliant
		).toBe(true);
		expect(
			classifyBrilliant(input({ playedPoints: 0.46, ratedPlayedPoints: 0.44, moverRating: 2400 }))
				.reason
		).toBe("unsound");
	});
	it("SF19: a substantial but nontrivial advantage does not make every two-pawn sacrifice gratuitous", () => {
		const fen = "4k3/5p2/8/8/2B5/8/8/4K3 w - - 0 1";
		const input = {
			fen,
			uci: "c4f7",
			...evidence({ playedPoints: 0.92, alternatives: [{ uci: "c4d3", points: 0.915 }] }),
		};
		expect(classifyBrilliant(input).brilliant).toBe(true);
		expect(classifyBrilliant(input, { ...BRILLIANT, gratuitousWinning: 0.9 }).reason).toBe(
			"trivial-win"
		);
	});

	it("3 — is more generous about near-best for newer players", () => {
		// Allowed 0.12 at 600 and 0.07 at 2400.
		const slightlyWorse = input({ loss: 0.09 });
		expect(classifyBrilliant({ ...slightlyWorse, moverRating: 600 }).brilliant).toBe(true);
		expect(classifyBrilliant({ ...slightlyWorse, moverRating: 2400 }).reason).toBe("not-near-best");
	});

	it("badges a continuation of a sacrifice again only when it is itself decisive", () => {
		// Played 0.95 against 0.5 elsewhere: the only winning move, like Qf2 … Rxh3+.
		const decisive = input({
			recentSacrifice: true,
			playedPoints: 0.95,
			alternatives: [{ uci: "g5f3", points: 0.5 }],
		});
		expect(classifyBrilliant(decisive)).toMatchObject({ brilliant: true, reason: "sound-sacrifice" });
	});

	it("badges the fastest mate even when other moves mate too, also as a continuation", () => {
		// 32.Rxf7+ Kh8 33.Rh7+: mate in 3, while Qxg6 mates in 4 (chess.com badges both rook moves).
		const fastest = input({
			recentSacrifice: true,
			playedPoints: 1,
			playedMate: 3,
			alternatives: [{ uci: "g5f3", points: 1, mate: 4 }],
		});
		expect(classifyBrilliant(fastest)).toMatchObject({ brilliant: true, reason: "sound-sacrifice" });
		// An equally fast mate elsewhere is no longer decisive for a continuation.
		const tied = input({
			recentSacrifice: true,
			playedPoints: 1,
			playedMate: 3,
			alternatives: [{ uci: "g5f3", points: 1, mate: 3 }],
		});
		expect(classifyBrilliant(tied).reason).toBe("continuation");
	});

	it("keeps a fastest-mate continuation that only leaves an attacked piece a continuation", () => {
		// 25…Qf3+ leaves the h4 knight to Kxh4 inside the Bxg2 attack: an ignored threat, not a new gift.
		const ignoredThreat = "4k3/8/8/8/3p4/4N3/P7/4K3 w - - 0 1";
		const verdict = classifyBrilliant({
			fen: ignoredThreat,
			uci: "a2a3",
			...evidence({
				recentSacrifice: true,
				playedPoints: 1,
				playedMate: 3,
				alternatives: [{ uci: "e3c4", points: 1, mate: 4 }],
			}),
		});
		expect(verdict.reason).toBe("continuation");
	});

	it("judges near-best at the mover's rating when that switch is on", () => {
		// 18…Bg4 (2132): 0.098 behind on the reference curve, 0.068 at the mover's rating.
		const loose = { ...BRILLIANT, maxLossNovice: 0.12, maxLossExpert: 0.07 };
		const bg4 = input({ loss: 0.098, ratedLoss: 0.068, moverRating: 2132 });
		expect(classifyBrilliant(bg4, loose).brilliant).toBe(true);
		expect(classifyBrilliant(bg4, { ...loose, nearBestRatedLoss: 0 }).reason).toBe("not-near-best");
	});

	it("does not badge a routine continuation of the same sacrificial attack", () => {
		const verdict = classifyBrilliant(input({ recentSacrifice: true }));
		expect(verdict).toMatchObject({ brilliant: false, reason: "continuation" });
		// Every other gate still has its say first.
		expect(classifyBrilliant(input({ recentSacrifice: true, playedPoints: 0.3 })).reason).toBe(
			"unsound"
		);
	});

	it("4 — declines a gratuitous sacrifice that gains nothing on a clearly winning plain move", () => {
		// 20.Rxd4 at +8.7 when the plain Nxd4 kept +8.5.
		const gratuitous = input({ playedPoints: 0.96, alternatives: [{ uci: "g5f3", points: 0.958 }] });
		// The knight offer concedes 3: a real gift, still brilliant under the default cap of 2 …
		expect(classifyBrilliant(gratuitous).brilliant).toBe(true);
		// … and gratuitous once the cap admits a gift that size (20.Rxd4 conceded only 1).
		expect(classifyBrilliant(gratuitous, { ...BRILLIANT, gratuitousMaxConcession: 3 }).reason).toBe(
			"trivial-win"
		);
		// A real gain in a winning position is still a fight.
		const gains = input({ playedPoints: 0.99, alternatives: [{ uci: "g5f3", points: 0.92 }] });
		expect(classifyBrilliant(gains).brilliant).toBe(true);
	});

	it("4 — declines a victory lap: the alternative already won", () => {
		expect(
			classifyBrilliant(input({ playedPoints: 1, alternatives: [{ uci: "g5f3", points: 0.98 }] }))
				.reason
		).toBe("trivial-win");
		expect(
			classifyBrilliant(
				input({ playedPoints: 1, playedMate: 4, alternatives: [{ uci: "g5f3", points: 1, mate: 2 }] })
			).reason
		).toBe("trivial-win");
	});

	it("4 — a victory lap needs a plain alternative, not the same sacrifice again", () => {
		// The owner's 30.Rdxh5+ (2026-09-16, chess.com Brilliant, rated only `best`): both rooks take
		// the h5 knight, so the runner-up Rhxh5+ is the identical sacrifice at 0.980 expected points.
		// The only alternative that wins *without* giving material away is f4–f5, at 0.638.
		const fen = "r6r/p5pk/5pp1/1qpR3n/5P1R/1P5P/P5PK/3Q4 w - - 0 30";
		const rdxh5 = {
			fen,
			uci: "d5h5",
			...evidence({
				playedPoints: 0.991,
				alternatives: [{ uci: "h4h5", points: 0.98 }],
				moverRating: 2144,
			}),
		};
		expect(classifyBrilliant(rdxh5)).toMatchObject({ brilliant: true, reason: "sound-sacrifice" });
		// Off, a sacrificial runner-up counts as a win the player already had.
		expect(
			classifyBrilliant(rdxh5, { ...BRILLIANT, sacrificialAlternativeNotTrivial: 0 }).reason
		).toBe("trivial-win");
		// A genuinely plain alternative that already wins is still a victory lap.
		expect(
			classifyBrilliant({ ...rdxh5, alternatives: [{ uci: "f4f5", points: 0.98 }] }).reason
		).toBe("trivial-win");
	});
});
