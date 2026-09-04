// test/core/motor/sampling.test.ts — Step 3 (Appendix G §7.2 sampling, §4 plausible start).
import { describe, expect, it } from "bun:test";
import { CLICK, SAMPLING } from "@core/motor/constants";
import { clickReleasePoint, inRect, plausibleStart, samplePointInRect } from "@core/motor/sampling";
import type { Rect } from "@core/motor/types";
import { createRng } from "@core/rng";
import { BOARD, centre, dist, inside, squareRect } from "./fixtures";

const RECT: Rect = { left: 200, top: 300, width: 80, height: 80 };

describe("samplePointInRect", () => {
	it("keeps 10 000 samples inside the inner fraction with the mean near the centre", () => {
		const rng = createRng("sample");
		const c = centre(RECT);
		const hw = (RECT.width * SAMPLING.press.innerFrac) / 2;
		let sx = 0;
		let sy = 0;
		for (let i = 0; i < 10_000; i++) {
			const p = samplePointInRect(RECT, SAMPLING.press.sigmaFrac, SAMPLING.press.innerFrac, rng);
			expect(Math.abs(p.x - c.x)).toBeLessThanOrEqual(hw);
			expect(Math.abs(p.y - c.y)).toBeLessThanOrEqual(hw);
			sx += p.x;
			sy += p.y;
		}
		expect(Math.abs(sx / 10_000 - c.x)).toBeLessThan(2);
		expect(Math.abs(sy / 10_000 - c.y)).toBeLessThan(2);
	});

	it("spreads samples (not always the centre) and honours the release fraction", () => {
		const rng = createRng("spread");
		const seen = new Set<string>();
		const hw = (RECT.width * SAMPLING.release.innerFrac) / 2;
		for (let i = 0; i < 500; i++) {
			const p = samplePointInRect(RECT, SAMPLING.release.sigmaFrac, SAMPLING.release.innerFrac, rng);
			seen.add(`${Math.round(p.x)},${Math.round(p.y)}`);
			expect(Math.abs(p.x - centre(RECT).x)).toBeLessThanOrEqual(hw);
		}
		expect(seen.size).toBeGreaterThan(100);
	});
});

describe("plausibleStart", () => {
	it("never lands inside the from-square and mostly stays around the board", () => {
		const rng = createRng("start");
		const from = squareRect("e2");
		let onBoard = 0;
		for (let i = 0; i < 2_000; i++) {
			const p = plausibleStart(BOARD, rng, from);
			expect(inside(p, from)).toBe(false);
			expect(Number.isInteger(p.x)).toBe(true);
			if (inside(p, BOARD)) onBoard++;
			expect(dist(p, centre(BOARD))).toBeLessThan(BOARD.width * 1.2);
		}
		expect(onBoard / 2_000).toBeGreaterThan(0.45);
		expect(onBoard / 2_000).toBeLessThan(0.75);
	});
	it("works without an avoid rect", () => {
		const p = plausibleStart(BOARD, createRng(1));
		expect(Number.isFinite(p.x)).toBe(true);
	});
});

describe("click helpers", () => {
	it("clickReleasePoint stays within the click drift", () => {
		const rng = createRng("click");
		for (let i = 0; i < 500; i++) {
			const p = { x: 300, y: 400 };
			const r = clickReleasePoint(p, rng);
			expect(dist(p, r)).toBeLessThanOrEqual(CLICK.releaseDriftPx * Math.SQRT2 + 1e-9);
			expect(Number.isInteger(r.x)).toBe(true);
		}
	});
	it("inRect honours padding", () => {
		expect(inRect({ x: 201, y: 301 }, RECT, 2)).toBe(false);
		expect(inRect({ x: 240, y: 340 }, RECT, 2)).toBe(true);
	});
});
