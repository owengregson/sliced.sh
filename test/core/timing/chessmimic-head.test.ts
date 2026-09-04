// test/core/timing/chessmimic-head.test.ts — Step 3a: the ChessMimic head scaffold.
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import {
	BAND_SCALERS,
	bucketIndexOf,
	bucketMask,
	buildInputs,
	CHESSMIMIC_BANDS,
	ChessMimicHead,
	CLASS_TOKEN,
	CLOCK_BUCKET_BOUNDARIES,
	encodeRecentMoves,
	FEN_CHARACTERS,
	INPUT_VOCAB_SIZE,
	MOVE_TO_ACTION,
	MOVE_VOCABULARY,
	PAD_TOKEN,
	sampleBucket,
	sampleWithinBucket,
	selectBand,
	tokenizeFen,
} from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { freshState } from "@core/timing/timing-model";
import type { DistributionHead, Persona } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import fixture from "../../fixtures/chessmimic-tokeniser-sample.json";
import { AFTER_EXD5, ctx, line } from "./helpers";

const persona: Persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };

function probsAt(indices: number[], weights?: number[]): number[] {
	const p = new Array<number>(30).fill(0);
	indices.forEach((i, k) => {
		p[i] = weights?.[k] ?? 1 / indices.length;
	});
	return p;
}

describe("tokeniser", () => {
	it("matches the hand-derived fixture (characters, special tokens, positions)", () => {
		expect([...FEN_CHARACTERS] as string[]).toEqual(fixture.characters);
		expect(CLASS_TOKEN).toBe(fixture.classToken);
		expect(PAD_TOKEN).toBe(fixture.padToken);
		expect(INPUT_VOCAB_SIZE).toBe(fixture.inputVocabSize);
		for (const pos of fixture.positions) {
			const t = tokenizeFen(pos.fen);
			expect(t.length).toBe(78);
			expect(t).toEqual(pos.tokens);
		}
	});
	it("builds the 1 968-entry UCI vocabulary in the searchless_chess order", () => {
		expect(MOVE_VOCABULARY.length).toBe(fixture.vocabSize);
		expect(new Set(MOVE_VOCABULARY).size).toBe(1968);
		expect(MOVE_VOCABULARY.slice(0, 12)).toEqual(fixture.vocabFirst);
		expect(MOVE_VOCABULARY.slice(-8)).toEqual(fixture.vocabLast);
		for (const [uci, action] of Object.entries(fixture.vocabSamples))
			expect(MOVE_TO_ACTION.get(uci)).toBe(action);
	});
	it("encodes the last 12 moves left-padded", () => {
		for (const r of fixture.recentMoves) expect(encodeRecentMoves(r.moves)).toEqual(r.tokens);
	});
	it("buildInputs yields the 92-token layout and the virtual clock for clockless games", () => {
		const timed = buildInputs(ctx({ moves: ["e2e4", "e7e5"] }));
		expect(timed.moveTokens.length).toBe(12);
		expect(timed.fenTokens.length).toBe(78);
		expect(timed.sequenceLength).toBe(92);
		expect(timed.playerClockS).toBe(120);
		expect(timed.opponentClockS).toBe(120);
		expect(timed.incrementS).toBe(0);
		expect(timed.band).toBe("1500_1600");
		const s = BAND_SCALERS["1500_1600"];
		expect(timed.scaledRating).toBeCloseTo((1650 - s.rating.mean) / s.rating.std, 10);
		expect(timed.clockFeatures[0]).toBeCloseTo(
			(Math.log(121) - s.log_player_clock.mean) / s.log_player_clock.std,
			10
		);
		const untimed = buildInputs(ctx({ baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 }));
		expect(untimed.playerClockS).toBe(300);
		expect(untimed.opponentClockS).toBe(300);
		expect(untimed.incrementS).toBe(0);
	});
	it("selects the nearest shipped band from the target Elo", () => {
		expect(CHESSMIMIC_BANDS).toEqual(["1200_1300", "1500_1600", "1800_1900"]);
		expect(selectBand(900)).toBe("1200_1300");
		expect(selectBand(1260)).toBe("1200_1300");
		expect(selectBand(1550)).toBe("1500_1600");
		expect(selectBand(1690)).toBe("1500_1600");
		expect(selectBand(1720)).toBe("1800_1900");
		expect(selectBand(2600)).toBe("1800_1900");
	});
});

describe("decoding", () => {
	it("bucket boundaries and the player_clock + increment validity mask", () => {
		expect(CLOCK_BUCKET_BOUNDARIES.length).toBe(31);
		expect(bucketIndexOf(0.5)).toBe(0);
		expect(bucketIndexOf(26.9)).toBe(26);
		expect(bucketIndexOf(27)).toBe(27);
		expect(bucketIndexOf(39)).toBe(28);
		expect(bucketIndexOf(1000)).toBe(29);
		const m = bucketMask(5, 0);
		expect(m.slice(0, 6).every(Boolean)).toBe(true);
		expect(m.slice(6).some(Boolean)).toBe(false);
		expect(bucketMask(0, 0)).toEqual([true, ...new Array<boolean>(29).fill(false)]);
		expect(bucketMask(3, 2)[5]).toBe(true);
		expect(bucketMask(3, 2)[6]).toBe(false);
		expect(bucketMask(1000, 0).every(Boolean)).toBe(true);
	});
	it("never samples a masked bucket and honours the temperature", () => {
		const rng = createRng("mask");
		const probs = probsAt([0, 2, 10, 29], [0.1, 0.2, 0.3, 0.4]);
		const mask = bucketMask(4, 0);
		for (let i = 0; i < 2000; i++) {
			const b = sampleBucket(probs, mask, 1, rng);
			expect(b === 0 || b === 2).toBe(true);
		}
		let hi = 0;
		for (let i = 0; i < 4000; i++)
			if (sampleBucket(probs, bucketMask(1000, 0), 0.2, rng) === 29) hi++;
		expect(hi / 4000).toBeGreaterThan(0.6);
	});
	it("draws a continuous value inside the bucket", () => {
		const rng = createRng("within");
		for (let b = 0; b < 30; b++) {
			for (let i = 0; i < 50; i++) {
				const t = sampleWithinBucket(b, rng);
				expect(t).toBeGreaterThanOrEqual(CLOCK_BUCKET_BOUNDARIES[b] ?? 0);
				const hi = CLOCK_BUCKET_BOUNDARIES[b + 1] ?? Number.POSITIVE_INFINITY;
				expect(t).toBeLessThan(hi === Number.POSITIVE_INFINITY ? 200 : hi);
			}
		}
	});
});

describe("ChessMimicHead", () => {
	const fallback: DistributionHead = new V1ParametricHead();
	function head(probs: number[] | null, delayMs = 0, budgetMs = 100): ChessMimicHead {
		return new ChessMimicHead({
			infer: () =>
				new Promise((resolve) => {
					setTimeout(() => resolve(probs), delayMs);
				}),
			fallback,
			budgetMs,
		});
	}

	it("decodes bucket then within-bucket and applies the clock mask", async () => {
		const h = head(probsAt([2, 20, 29], [0.2, 0.3, 0.5]));
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
			expect(s.why.join(" ")).toContain("chessmimic");
		}
	});
	it("bucket 0 maps to premove/instant only when eligible", async () => {
		const h = head(probsAt([0]));
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
	it("re-samples from buckets ≥ 1 when bucket 0 is not eligible and others are available", async () => {
		const h = head(probsAt([0, 3], [0.9, 0.1]));
		const c = ctx();
		await h.prepare(c);
		const f = computeFeatures(c);
		const st = freshState("g");
		st.fen = c.fen;
		const rng = createRng("b0b");
		for (let i = 0; i < 200; i++) {
			const s = h.sample(f, persona, st, rng, 1);
			expect(s.mode === "normal" || s.mode === "long").toBe(true);
			expect(s.why.join(" ")).toContain("bucket 3");
		}
	});
	it("labels the top buckets long and adds s_game + AR(1) on top", async () => {
		const h = head(probsAt([29]));
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
	it("falls back to v1 on timeout or null, and reports the fallback", async () => {
		const slow = head(probsAt([5]), 400, 50);
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
		// A position that was never prepared also falls back.
		const fresh = head(probsAt([5]));
		expect(
			fresh.sample(f, persona, st, createRng(1), 3).why.some((w) => w.includes("fallback"))
		).toBe(true);
	});
	it("median comes from the cached distribution", async () => {
		const h = head(probsAt([4, 5, 6], [0.3, 0.4, 0.3]));
		const c = ctx();
		await h.prepare(c);
		const f = computeFeatures(c);
		expect(h.median(f, persona, 3)).toBeCloseTo(5.5, 10);
		expect(h.median(f, { ...persona, s_game: Math.log(2) }, 3)).toBeCloseTo(11, 10);
	});
});
