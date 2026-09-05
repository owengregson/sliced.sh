// test/core/timing/v1-head.test.ts — Step 3: seeded distribution tests for the v1 head.
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { budgetController } from "@core/timing/budget";
import { computeFeatures } from "@core/timing/features";
import { applyPressureAndCaps, jitteredCap } from "@core/timing/pressure";
import { freshState } from "@core/timing/timing-model";
import type { Persona } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { AFTER_EXD5, ctx, line, median, pearson } from "./helpers";

const persona: Persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };
const N = 20_000;

describe("v1 parametric head", () => {
	it("generic middlegame at 3+0 with 120 s: median 2–4 s, P(>15 s) 1–6 %, P(instant) 5–20 %", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(ctx());
		const alloc = budgetController(f, persona);
		const rng = createRng("step3");
		const ts: number[] = [];
		let instant = 0;
		let premove = 0;
		for (let i = 0; i < N; i++) {
			const s = head.sample(f, persona, freshState("g"), rng, alloc);
			const t = applyPressureAndCaps(s.tSec, f, rng).tSec;
			ts.push(t);
			if (s.mode === "instant") instant++;
			if (s.mode === "premove") premove++;
		}
		const med = median(ts);
		expect(med).toBeGreaterThan(2);
		expect(med).toBeLessThan(4);
		const tail = ts.filter((t) => t > 15).length / N;
		expect(tail).toBeGreaterThan(0.01);
		expect(tail).toBeLessThan(0.06);
		expect(instant / N).toBeGreaterThan(0.05);
		expect(instant / N).toBeLessThan(0.2);
		expect(premove).toBe(0); // not eligible in this position
	});
	it("forced recapture with ponder_hit in blitz: P(premove ∪ instant) > 0.5", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(
			ctx({
				fen: AFTER_EXD5,
				myColor: "b",
				ply: 3,
				moves: ["e2e4", "d7d5", "e4d5"],
				expectedOppReply: "e4d5",
				chosenMove: "d8d5",
				lines: [line(1, -10, "d8d5"), line(2, -200, "g8f6"), line(3, -250, "c7c6")],
			})
		);
		expect(f.tc).toBe("blitz");
		expect(f.ponder_hit).toBe(1);
		expect(f.is_recapture).toBe(1);
		const rng = createRng("recap");
		let fast = 0;
		for (let i = 0; i < N; i++) {
			const s = head.sample(f, persona, freshState("g"), rng, 3);
			if (s.mode === "premove" || s.mode === "instant") fast++;
		}
		expect(fast / N).toBeGreaterThan(0.5);
	});
	it("with 8 s left every sample is ≤ 0.15·clock", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(ctx({ myClockMs: 8_000, oppClockMs: 30_000, ply: 60 }));
		const alloc = budgetController(f, persona);
		const rng = createRng("pressure");
		for (let i = 0; i < N; i++) {
			const s = head.sample(f, persona, freshState("g"), rng, alloc);
			const { tSec, comp } = applyPressureAndCaps(s.tSec, f, rng);
			expect(tSec).toBeLessThanOrEqual(0.15 * 8 + 1e-9);
			expect(comp).toBeLessThan(1);
		}
	});
	it("AR(1): lag-1 correlation of successive residuals ≈ φ", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(ctx());
		const state = freshState("g");
		const rng = createRng("ar1");
		const eps: number[] = [];
		for (let i = 0; i < N; i++) {
			const s = head.sample(f, persona, state, rng, 3);
			if (s.mode === "normal" || s.mode === "long") eps.push(state.eps);
		}
		const r = pearson(eps.slice(0, -1), eps.slice(1));
		expect(Math.abs(r - 0.35)).toBeLessThan(0.05);
	});
	it("untimed games bypass compression and caps", () => {
		const f = computeFeatures(ctx({ baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 }));
		const r = applyPressureAndCaps(400, f, createRng(1));
		expect(r.tSec).toBe(400);
		expect(r.comp).toBe(1);
		expect(r.capSec).toBe(Number.POSITIVE_INFINITY);
	});
	it("increment games rarely panic: comp ≥ 0.6 above 5 s", () => {
		const f = computeFeatures(ctx({ baseSec: 180, incSec: 2, myClockMs: 9_000 }));
		expect(applyPressureAndCaps(10, f, createRng(1)).comp).toBeGreaterThanOrEqual(0.6);
		const cap = applyPressureAndCaps(10, f, createRng(1)).capSec;
		expect(cap).toBeCloseTo(4.5, 10); // 0.5·C (no 0.15 rule with inc ≥ 2)
	});
	it("median() is the body median without residual or mirroring", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(ctx());
		const m = head.median(f, persona, freshState("g"), 3);
		expect(m).toBeGreaterThan(2);
		expect(m).toBeLessThan(4.5);
		expect(head.median(f, { ...persona, s_game: Math.log(2) }, freshState("g"), 3)).toBeCloseTo(
			2 * m,
			8
		);
	});
	it("knobs: sigmaScale widens, piOffset raises premove rate, lambdaScale raises long thinks", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(ctx());
		const rec = computeFeatures(
			ctx({
				fen: AFTER_EXD5,
				myColor: "b",
				ply: 3,
				moves: ["e2e4", "d7d5", "e4d5"],
				chosenMove: "d8d5",
				lines: [line(1, -10, "d8d5"), line(2, -60, "g8f6")],
			})
		);
		const run = (
			knobs: Partial<{ sigmaScale: number; piOffset: number; lambdaScale: number }>,
			ff = f
		) => {
			const rng = createRng("knobs");
			let long = 0;
			let pre = 0;
			const logs: number[] = [];
			for (let i = 0; i < 5000; i++) {
				const st = freshState("g");
				st.knobs = { sigmaScale: 1, piOffset: 0, lambdaScale: 1, ...knobs };
				const s = head.sample(ff, persona, st, rng, 3);
				if (s.mode === "long") long++;
				if (s.mode === "premove") pre++;
				if (s.mode === "normal") logs.push(Math.log(s.tSec));
			}
			const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
			const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length);
			return { long, pre, sd };
		};
		expect(run({ sigmaScale: 2 }).sd).toBeGreaterThan(run({}).sd * 1.5);
		expect(run({ piOffset: -3 }, rec).pre).toBeLessThan(run({}, rec).pre * 0.5);
		expect(run({ lambdaScale: 3 }).long).toBeGreaterThan(run({}).long * 2);
	});
});

describe("jittered caps", () => {
	it("passes unbound values through and lands binding caps in cap·U(0.75, 1)", () => {
		const rng = createRng("jitter");
		expect(jitteredCap(0.5, 1, rng)).toBe(0.5);
		expect(jitteredCap(5, Number.POSITIVE_INFINITY, rng)).toBe(5);
		const hits = new Set<number>();
		for (let i = 0; i < 2000; i++) {
			const v = jitteredCap(3, 1.2, rng);
			expect(v).toBeGreaterThanOrEqual(0.9);
			expect(v).toBeLessThanOrEqual(1.2);
			hits.add(v);
		}
		expect(hits.size).toBeGreaterThan(1900);
	});
	it("the long-think cap never produces an exact-cap mass point", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(ctx({ myClockMs: 40_000, oppClockMs: 40_000 }));
		const rng = createRng("longcap");
		let long = 0;
		let atCap = 0;
		for (let i = 0; i < N; i++) {
			const s = head.sample(f, persona, freshState("g"), rng, 3);
			if (s.mode !== "long") continue;
			long++;
			expect(s.tSec).toBeLessThanOrEqual(10);
			if (Math.abs(s.tSec - 10) < 0.001) atCap++;
		}
		expect(long).toBeGreaterThan(100);
		expect(atCap).toBe(0);
	});
});
