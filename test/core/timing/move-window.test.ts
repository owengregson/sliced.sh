// test/core/timing/move-window.test.ts — §8.4b item 3 window allocation + §3a.6 motor split.
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { computeFeatures } from "@core/timing/features";
import { allocateWindow, motorModel, WINDOW_PHASE_ORDER } from "@core/timing/move-window";
import type { Persona } from "@core/timing/types";
import { ctx } from "./helpers";

const persona: Persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };

describe("motor model", () => {
	it("drag follows the Fitts-like law and promotion adds a delay unless auto-queen", () => {
		const f = computeFeatures(ctx());
		const rng = createRng("motor");
		for (let i = 0; i < 2000; i++) {
			const m = motorModel(f, { inputMethod: "drag", autoQueen: true }, persona, rng);
			expect(m.dragS).toBeGreaterThanOrEqual(0.08);
			expect(m.dragS).toBeLessThanOrEqual(0.6);
			expect(m.hoverS).toBeGreaterThan(0);
			expect(m.promoS).toBe(0);
			expect(m.totalS).toBeCloseTo(m.hoverS + m.dragS + m.promoS, 12);
		}
		const promo = computeFeatures(
			ctx({
				fen: "8/1P4k1/8/8/8/8/8/K7 w - - 0 1",
				chosenMove: "b7b8q",
				lines: [{ multipv: 1, score: { cp: 900 }, depth: 10, pvUci: ["b7b8q"], pvSan: [] }],
			})
		);
		expect(promo.is_promotion).toBe(1);
		const m = motorModel(promo, { inputMethod: "drag", autoQueen: false }, persona, rng);
		expect(m.promoS).toBeGreaterThanOrEqual(0.25);
		expect(m.promoS).toBeLessThanOrEqual(0.6);
	});
	it("motor_k scales hover and drag; click mode uses the two-click gap", () => {
		const f = computeFeatures(ctx());
		const a = motorModel(f, { inputMethod: "drag", autoQueen: true }, persona, createRng(1));
		const b = motorModel(
			f,
			{ inputMethod: "drag", autoQueen: true },
			{ ...persona, motor_k: 2 },
			createRng(1)
		);
		expect(b.hoverS).toBeCloseTo(2 * a.hoverS, 10);
		const c = motorModel(f, { inputMethod: "click", autoQueen: true }, persona, createRng(1));
		expect(c.dragS).toBeCloseTo(0.12 + 0.05 * Math.log2(1 + f.dist), 10);
	});
});

describe("window allocation", () => {
	it("approach is the last phase", () => {
		expect(WINDOW_PHASE_ORDER[WINDOW_PHASE_ORDER.length - 1]).toBe("approach");
		expect(WINDOW_PHASE_ORDER[0]).toBe("orientation");
		expect(WINDOW_PHASE_ORDER.indexOf("decision")).toBe(WINDOW_PHASE_ORDER.indexOf("approach") - 1);
	});
	it("sums exactly to thinkMs; decision pause 15–40 % of what remains after orientation + approach", () => {
		const rng = createRng("window");
		for (let i = 0; i < 2000; i++) {
			const mode = rng.next() < 0.5 ? "normal" : "long";
			const thinkMs = (mode === "long" ? 2000 : 1000) + rng.next() * 20_000;
			const w = allocateWindow(
				{ thinkMs, mode, orientationMs: 380, motorMs: 450, previewCount: mode === "long" ? 1 : 0 },
				rng
			);
			const sum = w.orientationMs + w.scanMs + w.previewMs + w.decisionMs + w.approachMs;
			expect(sum).toBeCloseTo(thinkMs, 6);
			for (const v of Object.values(w)) expect(v).toBeGreaterThanOrEqual(0);
			const rest = thinkMs - w.orientationMs - w.approachMs;
			expect(w.decisionMs / rest).toBeGreaterThanOrEqual(0.15 - 1e-9);
			expect(w.decisionMs / rest).toBeLessThanOrEqual(0.4 + 1e-9);
			expect(w.approachMs).toBeCloseTo(450, 6);
			expect(w.orientationMs).toBeCloseTo(380, 6);
			if (mode === "long") expect(w.previewMs).toBeGreaterThan(0);
			else expect(w.previewMs).toBe(0);
		}
	});
	it("premove and instant windows contain no scan, preview or decision pause", () => {
		const rng = createRng("w2");
		const p = allocateWindow(
			{ thinkMs: 60, mode: "premove", orientationMs: 380, motorMs: 400, previewCount: 0 },
			rng
		);
		expect(p).toEqual({ orientationMs: 0, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 60 });
		const i = allocateWindow(
			{ thinkMs: 500, mode: "instant", orientationMs: 380, motorMs: 400, previewCount: 0 },
			rng
		);
		expect(i.scanMs + i.previewMs + i.decisionMs).toBe(0);
		// 500 < 380 + 400: compressed proportionally, both above their floors.
		expect(i.orientationMs).toBeGreaterThanOrEqual(150);
		expect(i.approachMs).toBeGreaterThanOrEqual(60);
		expect(i.orientationMs + i.approachMs).toBeCloseTo(500, 9);
		const wide = allocateWindow(
			{ thinkMs: 900, mode: "instant", orientationMs: 380, motorMs: 400, previewCount: 0 },
			rng
		);
		expect(wide.approachMs).toBe(400);
		expect(wide.orientationMs).toBe(500);
	});
	it("a tight normal window compresses orientation and motor with the 150 / 60 ms floors", () => {
		const rng = createRng("w3");
		for (const thinkMs of [250, 300, 500, 700]) {
			const w = allocateWindow(
				{ thinkMs, mode: "normal", orientationMs: 380, motorMs: 400, previewCount: 0 },
				rng
			);
			expect(w.approachMs + w.decisionMs + w.orientationMs + w.scanMs + w.previewMs).toBeCloseTo(
				thinkMs,
				9
			);
			expect(w.orientationMs).toBeGreaterThanOrEqual(150);
			expect(w.approachMs).toBeGreaterThanOrEqual(60);
			expect(w.approachMs).toBeLessThanOrEqual(400);
			for (const v of Object.values(w)) expect(v).toBeGreaterThanOrEqual(0);
		}
		const tight = allocateWindow(
			{ thinkMs: 250, mode: "normal", orientationMs: 380, motorMs: 400, previewCount: 0 },
			rng
		);
		expect(tight.orientationMs).toBe(150);
		expect(tight.approachMs).toBe(100);
	});
});
