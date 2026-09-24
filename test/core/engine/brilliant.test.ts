import { describe, expect, it } from "bun:test";
import { BRILLIANT } from "@core/constants/review";
import {
	type BrilliantEvidence,
	classifyBrilliant,
	planBrilliant,
	type SacrificeOffer,
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
	it("does not call the queen countertrade in 16...Nxd4 an ignored-threat sacrifice", () => {
		// Omer-Sarikaya–zurdo1969, 180019136748: after Nxd4, Bxc7 permits Nxb5.
		const fen = "r3r1k1/ppq1bppp/2n2nb1/1Q1p4/3N1B2/1B5P/PPP1NPP1/R3R1K1 b - - 6 16";
		expect(staticExchange(fen, "c6d4")).toBe(0);
		expect(planBrilliant({ fen, uci: "c6d4" })).toMatchObject({
			offers: [],
			materialComplete: true,
		});
	});
	it("does not call a pawn lost after an even piece trade a piece sacrifice (33.Bb4)", () => {
		// zurdo1969–Streetmasters, 184035279236: the bishop steps to a pawn-defended square.
		// Nxb4 axb4 Qxb4 trades bishop for knight and then drops the a-pawn — a pawn, not a piece.
		const fen = "4r1k1/1p4p1/p1nR4/2B1r3/4pQpP/Pq2P1P1/1P3P2/3R2K1 w - - 3 33";
		expect(staticExchange(fen, "c5b4")).toBe(-1);
		expect(planBrilliant({ fen, uci: "c5b4" })).toMatchObject({
			offers: [],
			materialComplete: true,
		});
		// A rook on the same square is still given for a knight: the pawn only adds to the gift.
		const rook = "6k1/8/1qn5/8/5R2/P7/8/7K w - - 0 1";
		expect(planBrilliant({ fen: rook, uci: "f4b4" })?.offers).toEqual([
			{ capture: "c6b4", square: "b4", shape: "exchange-sacrifice", concession: 3 },
		]);
	});
	it("does not call a moved piece that cannot be taken a sacrifice, for a strong mover (17.Nxd4)", () => {
		// Sa-skia–zurdo1969, 184035634254: a knight for two pawns on d4, but leaving e2 unmasks
		// Re1 on the queen at e7 — cxd4 loses her to a capture that stood before the acceptance.
		const fen = "1r3rk1/p2bqppp/5n2/2p5/N2p4/1P3P2/P1P1NKPP/R2QR3 w - - 4 17";
		const offers: SacrificeOffer[] = [
			{
				capture: "c5d4",
				square: "d4",
				shape: "capture-sacrifice",
				concession: 1,
				standing: true,
			},
		];
		expect(planBrilliant({ fen, uci: "e2d4" })?.offers).toEqual(offers);
		const found = { playedPoints: 0.48, alternatives: [{ uci: "e2g3", points: 0.44 }] };
		expect(
			classifyBrilliant({ fen, uci: "e2d4", ...evidence({ ...found, moverRating: 2560 }) })
		).toEqual({ brilliant: false, reason: "illusion", offers });
		// Chess.com is more generous with newer players: the benchmark's 13.Nxc6 (808) is this idea.
		expect(
			classifyBrilliant({ fen, uci: "e2d4", ...evidence({ ...found, moverRating: 900 }) }).brilliant
		).toBe(true);
		// A deflection's regain exists only because the offer was accepted: still a sacrifice.
		const deflection = "3qk3/8/8/8/2B5/8/8/3QK3 w - - 0 1";
		expect(planBrilliant({ fen: deflection, uci: "c4f7" })?.offers).toEqual([
			{ capture: "e8f7", square: "f7", shape: "hanging-piece", concession: 3 },
		]);
	});
	it("requires safe off-square recovery, not just a high-value capture", () => {
		// h3 leaves Ne3 attacked, but dxe3 Rxa5 recovers a bishop for that knight.
		const safe = "7k/8/8/b7/3p4/4N3/7P/R5K1 w - - 0 1";
		expect(planBrilliant({ fen: safe, uci: "h2h3" })?.offers).toEqual([]);
		// With b6 guarding a5, Rxa5 bxa5 loses the rook: no proof of recovery.
		const defended = "7k/8/1p6/b7/3p4/4N3/7P/R5K1 w - - 0 1";
		expect(planBrilliant({ fen: defended, uci: "h2h3" })?.offers).toContainEqual({
			capture: "d4e3",
			square: "e3",
			shape: "ignored-threat",
			concession: 3,
		});
	});
	it("keeps a checking intermediate capture from erasing a genuine tactical sacrifice", () => {
		// Chessigma #39, 14.Ne5: Kxc7 Nxc6+ recovers a bishop for a moment, but the
		// knight on c6 is still attacked; SEE cannot account for the intervening check evasion.
		// The offer stays, flagged: only from `checkRecoveryMinRating` up does the check unmake it.
		const fen = "2kr1b1r/p1Np1ppp/1pb2n2/8/1nRP1B2/5N2/PP2B1PP/4K2R w K - 1 14";
		expect(planBrilliant({ fen, uci: "f3e5" })?.offers).toContainEqual({
			capture: "c8c7",
			square: "c7",
			shape: "ignored-threat",
			concession: 3,
			checkRecovered: true,
		});
	});
	it("unmakes a gift won back with check, from 1400 up", () => {
		// The owner's 28.Rc1 (2026-09-23, 184245091060): ...exf4 Rxc2+ wins a rook for the bishop.
		const rc1 = "2k5/p2rb2R/1p1p4/4pp2/1P3B2/P7/2r2PPP/R5K1 w - - 0 28";
		expect(planBrilliant({ fen: rc1, uci: "a1c1" })?.offers).toEqual([
			{
				capture: "e5f4",
				square: "f4",
				shape: "ignored-threat",
				concession: 3,
				checkRecovered: true,
			},
		]);
		// The owner's 22...Nf6 (2026-09-23, 184266449184): hxg5 Nxg4+ wins the queen.
		const nf6 = {
			fen: "3rr1k1/2pq1ppn/2n1b2p/1p1ppNb1/p3P1QP/P1PPB1N1/1PB2PPK/R3R3 b - - 0 22",
			uci: "h7f6",
			...evidence({
				playedPoints: 0.62,
				alternatives: [{ uci: "e6f5", points: 0.49 }],
				moverRating: 2647,
			}),
		};
		expect(classifyBrilliant(nf6).reason).toBe("illusion");
		// Chess.com is more generous below 1400: the benchmark's 14.Ne5 (954) is Kxc7 Nxc6+.
		expect(classifyBrilliant({ ...nf6, moverRating: 954 }).brilliant).toBe(true);
	});
	it("abstains when proving the off-square recovery exceeds the shared material budget", () => {
		const fen = "7k/8/8/b7/3p4/4N3/7P/R5K1 w - - 0 1";
		const verdict = classifyBrilliant(
			{
				fen,
				uci: "h2h3",
				...evidence({ alternatives: [{ uci: "e3c4", points: 0.5 }] }),
			},
			{ ...BRILLIANT, maxExchangeNodes: 1 }
		);
		expect(verdict.reason).toBe("insufficient-evidence");
	});
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
		// A slower mate is second best too, though mate in 6 scores as mate in 5 (the owner's 37.Qc8,
		// 2026-09-23): whatever the alternative gives away, as every winning move there left g5.
		const slower = input({
			playedPoints: 1,
			playedMate: 6,
			alternatives: [{ uci: "g5f3", points: 1, mate: 5 }],
		});
		expect(classifyBrilliant(slower).reason).toBe("not-near-best");
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

	it("2 — a piece the engine's line takes to win more at once is a combination, from 1400 up", () => {
		// The owner's 36.Bg5 (2026-09-23, 184245091060, 2647): Bxg5 Rxd7+ wins the exchange.
		const bg5 = {
			fen: "8/1k1rb2R/8/p4p1P/4p3/P2p4/5PP1/2BK4 w - - 2 36",
			uci: "c1g5",
			...evidence({
				playedPoints: 0.938,
				alternatives: [
					{ uci: "h5h6", points: 0.881 },
					{ uci: "h7f7", points: 0.881 },
				],
				playedPv: ["c1g5", "e7g5", "h7d7", "b7c6"],
				moverRating: 2647,
			}),
		};
		expect(classifyBrilliant(bg5).reason).toBe("illusion");
		// Chess.com is more generous below 1400 (the benchmark's Rxf6 at 1117 is this idea).
		expect(classifyBrilliant({ ...bg5, moverRating: 1100 }).brilliant).toBe(true);
		// A line that declines the piece proves nothing.
		expect(classifyBrilliant({ ...bg5, playedPv: ["c1g5", "e4e3"] }).brilliant).toBe(true);
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
		// Gate 3 now declines a slower mate first (`slowerMateNotBrilliant`); without it, gate 4 does.
		expect(
			classifyBrilliant(
				input({ playedPoints: 1, playedMate: 4, alternatives: [{ uci: "g5f3", points: 1, mate: 2 }] }),
				{ ...BRILLIANT, slowerMateNotBrilliant: 0 }
			).reason
		).toBe("trivial-win");
	});

	it("4 — a small gift is gratuitous once the plain move already wins at the mover's rating", () => {
		// The owner's 32...Nxb2 (2026-09-23, 184267516150, 2655): the plain Nc5 kept +7.00 (0.929 on
		// the reference curve, 0.979 at 2655); the knight for a pawn gained +0.39.
		const nxb2 = {
			fen: "2r3k1/6p1/p3p2p/4B3/npp5/8/1P3PPP/3R2K1 b - - 1 32",
			uci: "a4b2",
			...evidence({
				playedPoints: 0.938,
				ratedPlayedPoints: 0.983,
				alternatives: [
					{ uci: "a4c5", points: 0.929, ratedPoints: 0.979 },
					{ uci: "a6a5", points: 0.925, ratedPoints: 0.977 },
				],
				moverRating: 2655,
			}),
		};
		expect(classifyBrilliant(nxb2).reason).toBe("trivial-win");
		expect(classifyBrilliant(nxb2, { ...BRILLIANT, gratuitousRatedWinning: 0 }).brilliant).toBe(true);
		// A sacrifice worse than the plain move is not a victory lap (the benchmark's 21.Bf6, 2323).
		const worse = {
			...nxb2,
			...evidence({
				playedPoints: 0.9,
				ratedPlayedPoints: 0.96,
				alternatives: [{ uci: "a4c5", points: 0.929, ratedPoints: 0.979 }],
				moverRating: 2655,
			}),
		};
		expect(classifyBrilliant(worse).reason).not.toBe("trivial-win");
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
