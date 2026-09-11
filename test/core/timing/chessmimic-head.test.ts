// test/core/timing/chessmimic-head.test.ts — Step 3a / Task 34: the ChessMimic head (inputs,
// band selection, decoding on top of the offscreen inference port, v1 fallback).
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import {
	buildInputs,
	CHESSMIMIC_BANDS,
	ChessMimicHead,
	fastShareCap,
	type InferResult,
	selectBand,
} from "@core/timing/chessmimic-head";
import { encodeRecentMoves, tokenizeFen } from "@core/timing/chessmimic-tokeniser";
import { computeFeatures } from "@core/timing/features";
import { freshState } from "@core/timing/timing-model";
import type { DistributionHead, Persona } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { AFTER_EXD5, ctx, line } from "./helpers";

const persona: Persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };

function probsAt(indices: number[], weights?: number[]): number[] {
	const p = new Array<number>(30).fill(0);
	indices.forEach((i, k) => {
		p[i] = weights?.[k] ?? 1 / indices.length;
	});
	return p;
}

describe("inputs and bands", () => {
	it("buildInputs yields the raw port payload: tokens, rating, clocks (virtual clock when untimed)", () => {
		const timed = buildInputs(ctx({ moves: ["e2e4", "e7e5"] }));
		expect(timed.moveTokens).toEqual(encodeRecentMoves(["e2e4", "e7e5"]));
		expect(timed.fenTokens).toEqual(tokenizeFen(ctx().fen));
		expect(timed.moveTokens.length + 2 + timed.fenTokens.length).toBe(92);
		expect(timed.rating).toBe(1650);
		expect(timed.playerClockS).toBe(120);
		expect(timed.opponentClockS).toBe(120);
		expect(timed.incrementS).toBe(0);
		expect(timed.band).toBe("1500_1600");
		const untimed = buildInputs(ctx({ baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 }));
		expect(untimed.playerClockS).toBe(300);
		expect(untimed.opponentClockS).toBe(300);
		expect(untimed.incrementS).toBe(0);
		const negative = buildInputs(ctx({ myClockMs: -500 }));
		expect(negative.playerClockS).toBe(0);
	});
	it("selects the nearest registered band from the target Elo", () => {
		expect(CHESSMIMIC_BANDS).toEqual(["1200_1300", "1500_1600", "1800_1900"]);
		expect(selectBand(900)).toBe("1200_1300");
		expect(selectBand(1260)).toBe("1200_1300");
		expect(selectBand(1550)).toBe("1500_1600");
		expect(selectBand(1690)).toBe("1500_1600");
		expect(selectBand(1720)).toBe("1800_1900");
		expect(selectBand(2600)).toBe("1800_1900");
	});
});

describe("ChessMimicHead", () => {
	const fallback: DistributionHead = new V1ParametricHead();
	function result(probs: number[], band = "1500_1600"): InferResult {
		return { probs, band, ms: 30 };
	}
	function head(res: InferResult | null, delayMs = 0, budgetMs = 100): ChessMimicHead {
		return new ChessMimicHead({
			infer: () =>
				new Promise((resolve) => {
					setTimeout(() => resolve(res), delayMs);
				}),
			fallback,
			budgetMs,
		});
	}

	it("decodes bucket then within-bucket and applies the clock mask", async () => {
		const h = head(result(probsAt([2, 20, 29], [0.2, 0.3, 0.5])));
		const c = ctx({ myClockMs: 8_000, ply: 60 });
		await h.prepare(c);
		const f = computeFeatures(c);
		const st = freshState("g");
		st.fen = c.fen;
		const rng = createRng("cm");
		for (let i = 0; i < 500; i++) {
			const s = h.sample(f, persona, st, rng, 1);
			expect(s.mode).not.toBe("premove");
			// bucket 2 → [2, 3) s before the persona/AR shift; masked buckets 20 and 29 never appear.
			expect(s.why.join(" ")).toContain("bucket 2");
			expect(s.why.join(" ")).toContain("chessmimic band=1500_1600");
		}
	});
	it("decodes with the band that answered when the host substituted one", async () => {
		const h = head(result(probsAt([29]), "1800_1900"));
		const c = ctx();
		await h.prepare(c);
		const st = freshState("g");
		st.fen = c.fen;
		const s = h.sample(computeFeatures(c), persona, st, createRng("sub"), 1);
		expect(s.why[0]).toContain("band=1800_1900");
		expect(s.tSec).toBeGreaterThanOrEqual(40 * Math.exp(st.eps) - 1e-9);
	});
	it("bucket 0 maps to premove/instant only when eligible", async () => {
		const h = head(result(probsAt([0])));
		const eligible = ctx({
			fen: AFTER_EXD5,
			myColor: "b",
			ply: 3,
			moves: ["e2e4", "d7d5", "e4d5"],
			expectedOppReply: "e4d5",
			chosenMove: "d8d5",
			lines: [line(1, -10, "d8d5"), line(2, -60, "g8f6")],
		});
		await h.prepare(eligible);
		const fe = computeFeatures(eligible);
		const st = freshState("g");
		st.fen = eligible.fen;
		const rng = createRng("b0");
		const modes = new Set<string>();
		for (let i = 0; i < 200; i++) modes.add(h.sample(fe, persona, st, rng, 1).mode);
		expect([...modes].every((m) => m === "premove" || m === "instant")).toBe(true);
		expect(modes.has("premove")).toBe(true);
		const notEligible = ctx();
		await h.prepare(notEligible);
		const fn = computeFeatures(notEligible);
		expect(fn.premove_eligible).toBe(0);
		st.fen = notEligible.fen;
		const s = h.sample(fn, persona, st, rng, 1);
		expect(s.mode).toBe("instant");
		expect(s.tSec).toBeLessThan(1);
	});
	it("bucket 0 is a fast move, not a premove-only move: it answers instant with no premove available", async () => {
		// Until 2026-09-10 this case asserted the opposite — that a bucket-0 draw was discarded and
		// re-drawn from buckets ≥ 1 whenever `premove_eligible` was 0. The measured consequence on the
		// real ONNX bands: the model puts ≈ 21 % of its mass on bucket 0 (≈ 0.5 s) at a full 3+0 clock,
		// and every one of those draws was redistributed into the *slower* buckets, so the shipped head
		// produced 0 instant-mode plans in 2000 against 222 for the v1 fallback. The owner asked about
		// exactly this on 2026-09-09 — "the bot never is able to come up with the move nearly instantly
		// (when in many situations a player would have the move instantly ready), is it that we
		// actually dont have the move or we're artificially causing this problem?" — and the answer was
		// that we were causing it. Premove eligibility is about whether a move can be entered *before*
		// the opponent replies (§7.4); it says nothing about whether a human can play it quickly.
		const h = head(result(probsAt([0, 3], [0.9, 0.1])));
		const c = ctx();
		await h.prepare(c);
		const f = computeFeatures(c);
		expect(f.premove_eligible).toBe(0);
		const st = freshState("g");
		st.fen = c.fen;
		const rng = createRng("b0b");
		const N = 400;
		let instant = 0;
		for (let i = 0; i < N; i++) {
			const s = h.sample(f, persona, st, rng, 1);
			if (s.mode === "instant") {
				instant++;
				// a fast move is fast: under the bucket's own 1 s upper edge, before the hand is added
				expect(s.tSec).toBeLessThan(1);
				expect(s.why.join(" ")).toContain("bucket 0");
			} else {
				expect(s.mode === "normal" || s.mode === "long").toBe(true);
				expect(s.why.join(" ")).toContain("bucket 3");
			}
		}
		// The model's bucket-0 mass reaches the plan instead of being redistributed wholesale, and how
		// much of it gets through is `fastShareCap` — `min(share, cap)`, via the feed-forward thinning
		// that holds the rate at the budget from the first move rather than only asymptotically
		// (round 6; the budget's own behaviour is pinned in chessmimic-instant-cap.test.ts).
		//
		// The load-bearing assertion is that it is the budget and **not zero**. Zero is what the branch
		// this case replaced produced, at every speed and every clock.
		const cap = fastShareCap(f, "1500_1600");
		expect(cap).toBeGreaterThan(0);
		expect(cap).toBeLessThan(0.9); // the fixture's own mass, so the budget is what binds here
		expect(instant / N).toBeGreaterThan(cap * 0.7);
		expect(instant / N).toBeLessThanOrEqual(cap * 1.2);
		expect(instant).toBeLessThan(N);
	});
	it("labels the top buckets long and adds s_game + AR(1) on top", async () => {
		const h = head(result(probsAt([29])));
		const c = ctx();
		await h.prepare(c);
		const f = computeFeatures(c);
		const st = freshState("g");
		st.fen = c.fen;
		const rng = createRng("long");
		const s = h.sample(f, { ...persona, s_game: Math.log(3) }, st, rng, 1);
		expect(s.mode).toBe("long");
		expect(s.tSec).toBeGreaterThanOrEqual(40 * 3 * Math.exp(st.eps) - 1e-6);
		expect(st.eps).not.toBe(0);
	});
	it("falls back to v1 on timeout, null or a malformed reply, and reports the fallback", async () => {
		const slow = head(result(probsAt([5])), 400, 50);
		const c = ctx();
		const t0 = Date.now();
		await slow.prepare(c);
		expect(Date.now() - t0).toBeLessThan(300);
		const f = computeFeatures(c);
		const st = freshState("g");
		st.fen = c.fen;
		const s = slow.sample(f, persona, st, createRng(1), 3);
		expect(s.why.some((w) => w.includes("fallback"))).toBe(true);
		const nul = head(null);
		await nul.prepare(c);
		expect(nul.sample(f, persona, st, createRng(1), 3).why.some((w) => w.includes("fallback"))).toBe(
			true
		);
		const bad = head({ probs: [0.5, 0.5], band: "1500_1600" });
		await bad.prepare(c);
		expect(bad.sample(f, persona, st, createRng(1), 3).why[0]).toContain("bad shape");
		const unknownBand = head({ probs: probsAt([3]), band: "900_1000" });
		await unknownBand.prepare(c);
		expect(unknownBand.sample(f, persona, st, createRng(1), 3).why[0]).toContain("fallback");
		// A position that was never prepared also falls back.
		const fresh = head(result(probsAt([5])));
		expect(
			fresh.sample(f, persona, st, createRng(1), 3).why.some((w) => w.includes("fallback"))
		).toBe(true);
	});
	it("median comes from the cached distribution", async () => {
		const h = head(result(probsAt([4, 5, 6], [0.3, 0.4, 0.3])));
		const c = ctx();
		await h.prepare(c);
		const f = computeFeatures(c);
		const st = freshState("g");
		st.fen = c.fen;
		expect(h.median(f, persona, st, 3)).toBeCloseTo(5.5, 10);
		expect(h.median(f, { ...persona, s_game: Math.log(2) }, st, 3)).toBeCloseTo(11, 10);
		// Another position (or a reset head) falls back to the v1 median.
		const other = freshState("g");
		other.fen = "8/8/4k3/8/8/2K5/8/8 b - - 0 1";
		expect(h.median(f, persona, other, 3)).toBe(fallback.median(f, persona, other, 3));
		h.reset();
		expect(h.median(f, persona, st, 3)).toBe(fallback.median(f, persona, st, 3));
		expect(h.sample(f, persona, st, createRng(1), 3).why[0]).toContain("fallback");
	});
	it("a stale inference result never overwrites a newer prepare", async () => {
		const slow: { resolve?: (v: InferResult) => void } = {};
		const h = new ChessMimicHead({
			infer: (inputs) =>
				inputs.playerClockS === 120
					? new Promise((resolve) => {
							slow.resolve = resolve;
						})
					: Promise.resolve(result(probsAt([7]))),
			fallback,
			budgetMs: 50,
		});
		const first = h.prepare(ctx({ myClockMs: 120_000 }));
		const second = h.prepare(ctx({ myClockMs: 60_000 }));
		await second;
		slow.resolve?.(result(probsAt([3])));
		await first;
		const st = freshState("g");
		st.fen = ctx().fen;
		const s = h.sample(computeFeatures(ctx({ myClockMs: 60_000 })), persona, st, createRng(1), 3);
		expect(s.why[0]).toContain("bucket 7");
	});
});
