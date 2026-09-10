// test/core/strength/premove.test.ts
import { describe, expect, it } from "bun:test";
import { PREMOVE } from "@core/constants/books";
import { createRng, type Rng } from "@core/rng";
import {
	isQueueableReason,
	type PremoveContext,
	type PremoveDeps,
	type PremoveReason,
	premoveCandidate,
	premoveProbability,
	replyProbability,
} from "@core/strength/premove";
import type { EvalLine } from "@typedefs/engine";

function line(uci: string, cp: number, multipv: number, pv: string[] = []): EvalLine {
	return { multipv, score: { cp }, depth: 12, pvUci: [uci, ...pv], pvSan: [] };
}

/** Rngs whose probability gate always / never passes. */
const alwaysRng: Rng = { ...createRng(1), chance: () => true };
const neverRng: Rng = { ...createRng(1), chance: () => false };

// 1. e4 e5 2. Nf3 Nc6 3. -- Nf6, white to move: m = Nxe5, predictable reply r = Nxe5.
const FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 4";
const OPPONENT_LINES = [line("c6e5", 0, 1), line("d7d6", -150, 2), line("a7a6", -300, 3)];

interface Analysis {
	calls: Array<{ fen: string; moves: string[]; movetimeMs: number; multiPv: number }>;
	deps: PremoveDeps;
}

/** `analyseAfter` fake: `opponent` answers the 1-move query, `reply` the 2-move query. */
function analysis(opponent: EvalLine[], reply: EvalLine[]): Analysis {
	const calls: Analysis["calls"] = [];
	return {
		calls,
		deps: {
			analyseAfter: async (fen, moves, opts) => {
				calls.push({ fen, moves: [...moves], movetimeMs: opts.movetimeMs, multiPv: opts.multiPv });
				return moves.length === 1 ? opponent : reply;
			},
		},
	};
}

function ctx(overrides: Partial<PremoveContext> = {}): PremoveContext {
	return {
		fen: FEN,
		move: "f3e5",
		targetElo: 2000,
		timeControl: { baseMs: 180_000, incMs: 0 },
		ponder: "c6e5",
		rng: alwaysRng,
		...overrides,
	};
}

describe("premoveProbability", () => {
	it("is 0.35 + 0.5·clamp((E − 1200)/1200, 0, 1), times the optional π_p", () => {
		expect(premoveProbability(1200)).toBeCloseTo(0.35);
		expect(premoveProbability(1800)).toBeCloseTo(0.6);
		expect(premoveProbability(2400)).toBeCloseTo(0.85);
		expect(premoveProbability(3000)).toBeCloseTo(0.85);
		expect(premoveProbability(2400, 0.5)).toBeCloseTo(0.425);
		expect(premoveProbability(1000)).toBe(0);
	});
});

describe("replyProbability", () => {
	it("is a softmax over the opponent's lines with τ = 0.06 in win-fraction units", () => {
		expect(replyProbability("c6e5", OPPONENT_LINES)).toBeGreaterThan(0.6);
		expect(replyProbability("d7d6", OPPONENT_LINES)).toBeLessThan(0.4);
		expect(replyProbability("h7h6", OPPONENT_LINES)).toBe(0);
		expect(replyProbability("c6e5", [line("c6e5", 0, 1), line("d7d6", -5, 2)])).toBeLessThan(0.6);
		expect(replyProbability("c6e5", [line("c6e5", 0, 1)])).toBe(1);
		expect(replyProbability("c6e5", [])).toBe(0);
	});
});

describe("premoveCandidate", () => {
	it("returns { reply, premove } for a predictable reply and a clear-only move (loss_2nd ≥ 0.25)", async () => {
		const a = analysis(OPPONENT_LINES, [line("d2d4", 0, 1), line("d2d3", -400, 2)]);
		const res = await premoveCandidate(ctx(), a.deps);
		expect(res).toEqual({
			reply: "c6e5",
			premove: "d2d4",
			from: "d2",
			to: "d4",
			reason: "loss2nd",
			replyProbability: replyProbability("c6e5", OPPONENT_LINES),
		});
		// The opponent search (movetime 150, MultiPV 3) supplies p(r); then the reply analysis
		// (movetime 120, MultiPV 2) after `m r`.
		expect(a.calls).toEqual([
			{
				fen: FEN,
				moves: ["f3e5"],
				movetimeMs: PREMOVE.ponderMovetimeMs,
				multiPv: PREMOVE.ponderMultiPv,
			},
			{
				fen: FEN,
				moves: ["f3e5", "c6e5"],
				movetimeMs: PREMOVE.replyMovetimeMs,
				multiPv: PREMOVE.replyMultiPv,
			},
		]);
	});

	it("premoves a recapture on the square just captured on", async () => {
		// 1. e4 e5 2. Nc3 d5, white to move: m = exd5, r = Qxd5, q = Nxd5 recaptures on d5.
		const fen = "rnbqkbnr/ppp2ppp/8/3pp3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3";
		const opp = [line("d8d5", -30, 1), line("g8f6", -200, 2), line("c7c6", -300, 3)];
		const a = analysis(opp, [line("c3d5", 200, 1), line("d2d4", 150, 2)]);
		const res = await premoveCandidate(ctx({ fen, move: "e4d5", ponder: undefined }), a.deps);
		expect(res?.reply).toBe("d8d5");
		expect(res?.premove).toBe("c3d5");
		expect(res?.reason).toBe("recapture");
		// Without a ponder move the opponent search (150 ms, MultiPV 3) runs first.
		expect(a.calls.map((c) => c.moves)).toEqual([["e4d5"], ["e4d5", "d8d5"]]);
		expect(a.calls[0]?.movetimeMs).toBe(PREMOVE.ponderMovetimeMs);
		expect(a.calls[0]?.multiPv).toBe(PREMOVE.ponderMultiPv);
	});

	it("does not call a capture on the reply's square a recapture when the reply was quiet", async () => {
		// 1. e4 e5 2. Nf3 Nc6 3. Bb5 (m); predictable quiet reply 3... a6 (r); 4. Bxa6?? lands on a6
		// (the reply's destination) but nothing was captured there, and its loss_2nd is small.
		const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
		const opp = [line("a7a6", 0, 1), line("g8f6", -300, 2)];
		const a = analysis(opp, [line("b5a6", 0, 1), line("b5a4", -10, 2)]);
		expect(await premoveCandidate(ctx({ fen, move: "f1b5", ponder: "a7a6" }), a.deps)).toBeNull();
	});

	it("premoves the only legal move", async () => {
		// White Kh1 boxed by g2/h2, Rc2; black Ra8. m = Rc3, r = Ra1+, q = Rc1 (the only legal move).
		const fen = "r6k/8/8/8/8/8/2R3PP/7K w - - 0 1";
		const opp = [line("a8a1", 0, 1), line("h8g8", -500, 2)];
		const a = analysis(opp, [line("c3c1", 0, 1)]);
		const res = await premoveCandidate(ctx({ fen, move: "c2c3", ponder: "a8a1" }), a.deps);
		expect(res?.reply).toBe("a8a1");
		expect(res?.premove).toBe("c3c1");
		expect(res?.reason).toBe("only-move");
	});

	it("never premoves a king move, even when it is the only legal move", async () => {
		// m = g3, r = Ra1+, and 2. Kg2 is the only legal move — but a king move.
		const fen = "r5k1/8/8/8/8/8/5PPP/6K1 w - - 0 1";
		const opp = [line("a8a1", 0, 1), line("g8f8", -300, 2)];
		const a = analysis(opp, [line("g1g2", 0, 1)]);
		expect(await premoveCandidate(ctx({ fen, move: "g2g3", ponder: "a8a1" }), a.deps)).toBeNull();
	});

	it("never premoves castling (a king move) even as a clear-only move", async () => {
		const fen = "r3k2r/pppq1ppp/2n2n2/3pp3/3PP3/2N2N2/PPPQ1PPP/R3K2R w KQkq - 0 8";
		const opp = [line("e8c8", 0, 1), line("a7a6", -400, 2)];
		const a = analysis(opp, [line("e1g1", 0, 1), line("a2a3", -400, 2)]);
		expect(await premoveCandidate(ctx({ fen, move: "d4e5", ponder: "e8c8" }), a.deps)).toBeNull();
	});

	it("does not premove when the reply is not predictable (p(r) < 0.6)", async () => {
		const a = analysis([line("c6e5", 0, 1), line("d7d6", -5, 2), line("a7a6", -8, 3)], []);
		expect(await premoveCandidate(ctx({ ponder: undefined }), a.deps)).toBeNull();
		expect(a.calls.length).toBe(1); // the reply analysis never runs
	});

	it("does not premove a merely-good move (loss_2nd < 0.25, no recapture, not the only move)", async () => {
		const a = analysis(OPPONENT_LINES, [line("d2d4", 30, 1), line("d2d3", 10, 2)]);
		expect(await premoveCandidate(ctx(), a.deps)).toBeNull();
	});

	it("is gated by bullet/blitz, E ≥ 1200 and the probability roll (× π_p)", async () => {
		const a = analysis(OPPONENT_LINES, [line("d2d4", 0, 1), line("d2d3", -400, 2)]);
		const rapid = { baseMs: 600_000, incMs: 0 };
		expect(await premoveCandidate(ctx({ timeControl: rapid }), a.deps)).toBeNull();
		expect(await premoveCandidate(ctx({ timeControl: undefined }), a.deps)).toBeNull();
		expect(await premoveCandidate(ctx({ targetElo: 1100 }), a.deps)).toBeNull();
		expect(await premoveCandidate(ctx({ rng: neverRng }), a.deps)).toBeNull();
		expect(await premoveCandidate(ctx({ piP: 0 }), a.deps)).toBeNull();
		expect(a.calls.length).toBe(0);
		const bullet = { baseMs: 60_000, incMs: 0 };
		expect(await premoveCandidate(ctx({ timeControl: bullet }), a.deps)).not.toBeNull();
	});

	it("returns null for an illegal move or ponder, or an empty analysis", async () => {
		const a = analysis(OPPONENT_LINES, []);
		expect(await premoveCandidate(ctx({ ponder: "a7a4" }), a.deps)).toBeNull();
		expect(await premoveCandidate(ctx({ move: "e2e4" }), a.deps)).toBeNull();
		expect(a.calls.length).toBe(0);
		expect(await premoveCandidate(ctx(), a.deps)).toBeNull();
		// The ponder move is used as `r` even when the search's top line differs.
		const b = analysis([line("d7d6", 0, 1), line("c6e5", -2, 2)], []);
		expect(await premoveCandidate(ctx({ ponder: "c6e5" }), b.deps)).toBeNull();
		expect(b.calls.length).toBe(1);
	});
});

describe("isQueueableReason (Fix F)", () => {
	// The central safety decision of the queued-premove path: only a reason an unexpected reply
	// makes *illegal* may be entered on the site before that reply is known.
	it("queues a recapture — the opponent not capturing there leaves our own piece on the square", () => {
		expect(isQueueableReason("recapture")).toBe(true);
	});

	it("queues the only legal move", () => {
		expect(isQueueableReason("only-move")).toBe(true);
	});

	it("never queues a clear-only quiet move: `loss2nd` stays legal after any reply", () => {
		expect(isQueueableReason("loss2nd")).toBe(false);
	});

	it("is exactly `PREMOVE.queueReasons` — every reason the policy can produce is classified", () => {
		const all: PremoveReason[] = ["recapture", "only-move", "loss2nd"];
		expect(all.filter(isQueueableReason)).toEqual([...PREMOVE.queueReasons]);
	});
});
