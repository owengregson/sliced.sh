// test/core/policy/maia-policy.test.ts
/**
 * Decoding Maia-3's raw outputs (masked softmax over the legal indices, un-mirroring, the value
 * head) and tempering the distribution into draw weights.
 */

import { describe, expect, it } from "bun:test";
import { MAIA_INPUT } from "@core/constants/maia";
import { maiaMoveIndex } from "@core/policy/maia-encoder";
import {
	decodeMaiaOutputs,
	klDivergence,
	policyEntropy,
	temperedWeights,
} from "@core/policy/maia-policy";

function logits(entries: ReadonlyArray<readonly [number, number]>, fill = 50): Float32Array {
	// every index not named carries a huge logit, so a leak past the mask would show
	const out = new Float32Array(MAIA_INPUT.moveVocab).fill(fill);
	for (const [index, value] of entries) out[index] = value;
	return out;
}

function sumOf(values: Iterable<number>): number {
	let s = 0;
	for (const v of values) s += v;
	return s;
}

describe("decodeMaiaOutputs", () => {
	const e2e4 = maiaMoveIndex("e2e4", false);
	const d2d4 = maiaMoveIndex("d2d4", false);
	const g1f3 = maiaMoveIndex("g1f3", false);
	const legal = Int32Array.from([e2e4, d2d4, g1f3].sort((a, b) => a - b));

	it("is a softmax over the legal indices only, sorted descending, summing to 1", () => {
		const move = logits([
			[e2e4, 2],
			[d2d4, 1],
			[g1f3, 0],
		]);
		const { moves, wdl } = decodeMaiaOutputs(move, [0, 0, 0], { legal, mirrored: false });
		expect(moves.map(([uci]) => uci)).toEqual(["e2e4", "d2d4", "g1f3"]);
		const z = Math.exp(2) + Math.exp(1) + 1;
		expect(moves[0]?.[1]).toBeCloseTo(Math.exp(2) / z, 12);
		expect(moves[1]?.[1]).toBeCloseTo(Math.exp(1) / z, 12);
		expect(moves[2]?.[1]).toBeCloseTo(1 / z, 12);
		expect(sumOf(moves.map(([, p]) => p))).toBeCloseTo(1, 12);
		expect(wdl).toEqual([1 / 3, 1 / 3, 1 / 3]);
	});
	it("is invariant to a shift of the logits and stable for large ones", () => {
		const a = decodeMaiaOutputs(
			logits([
				[e2e4, 1000],
				[d2d4, 999],
				[g1f3, -1000],
			]),
			[100, 0, -100],
			{ legal, mirrored: false }
		);
		const b = decodeMaiaOutputs(
			logits([
				[e2e4, 1],
				[d2d4, 0],
				[g1f3, -1999],
			]),
			[200, 100, 0],
			{ legal, mirrored: false }
		);
		expect(a.moves).toEqual(b.moves);
		expect(a.wdl).toEqual(b.wdl);
		for (const p of a.moves.map(([, p]) => p)) expect(Number.isFinite(p)).toBe(true);
		expect(a.wdl[0]).toBeCloseTo(1, 12);
	});
	it("un-mirrors the moves when black is to move", () => {
		// e7e5 / d7d5 / g8f6 in the board frame are e2e4 / d2d4 / g1f3 mirrored
		const { moves } = decodeMaiaOutputs(
			logits([
				[e2e4, 0],
				[d2d4, 3],
				[g1f3, 1],
			]),
			[0, 0, 0],
			{ legal, mirrored: true }
		);
		expect(moves.map(([uci]) => uci)).toEqual(["d7d5", "g8f6", "e7e5"]);
		const promo = Int32Array.from([maiaMoveIndex("b2b1q", true), maiaMoveIndex("b2a1n", true)]);
		const decoded = decodeMaiaOutputs(logits([]), [0, 0, 0], { legal: promo, mirrored: true });
		expect(decoded.moves.map(([uci]) => uci).sort()).toEqual(["b2a1n", "b2b1q"]);
		expect(decoded.moves[0]?.[1]).toBeCloseTo(0.5, 12);
	});
	it("softmaxes the value logits to (loss, draw, win)", () => {
		const { wdl } = decodeMaiaOutputs(logits([]), [-0.152368, -1.663091, 1.716946], {
			legal,
			mirrored: false,
		});
		const z = Math.exp(-0.152368) + Math.exp(-1.663091) + Math.exp(1.716946);
		expect(wdl[0]).toBeCloseTo(Math.exp(-0.152368) / z, 10);
		expect(wdl[1]).toBeCloseTo(Math.exp(-1.663091) / z, 10);
		expect(wdl[2]).toBeCloseTo(Math.exp(1.716946) / z, 10);
		expect(sumOf(wdl)).toBeCloseTo(1, 12);
	});
	it("a single legal move gets everything; no legal moves gives nothing", () => {
		const one = decodeMaiaOutputs(logits([]), [0, 0, 0], {
			legal: Int32Array.from([e2e4]),
			mirrored: false,
		});
		expect(one.moves).toEqual([["e2e4", 1]]);
		const none = decodeMaiaOutputs(logits([]), [0, 0, 0], {
			legal: new Int32Array(0),
			mirrored: false,
		});
		expect(none.moves).toEqual([]);
	});
});

describe("temperedWeights", () => {
	const moves: ReadonlyArray<readonly [string, number]> = [
		["e2e4", 0.6],
		["d2d4", 0.3],
		["g1f3", 0.09],
		["a2a3", 0.01],
	];
	it("T = 1 with no floor is the identity, in the input order", () => {
		const w = temperedWeights(moves, 1, 0);
		expect([...w.keys()]).toEqual(["e2e4", "d2d4", "g1f3", "a2a3"]);
		for (const [uci, p] of moves) expect(w.get(uci)).toBeCloseTo(p, 12);
		expect(sumOf(w.values())).toBeCloseTo(1, 12);
	});
	it("T < 1 sharpens, T > 1 flattens, and the weights always sum to 1", () => {
		const cool = temperedWeights(moves, 0.5, 0);
		const warm = temperedWeights(moves, 2, 0);
		expect(cool.get("e2e4") ?? 0).toBeGreaterThan(0.6);
		expect(warm.get("e2e4") ?? 0).toBeLessThan(0.6);
		expect(cool.get("e2e4")).toBeCloseTo(0.36 / (0.36 + 0.09 + 0.0081 + 0.0001), 12);
		expect(sumOf(cool.values())).toBeCloseTo(1, 12);
		expect(sumOf(warm.values())).toBeCloseTo(1, 12);
		// the ordering by weight is preserved at every temperature
		for (const w of [cool, warm]) {
			const values = [...w.values()];
			for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThan(values[i - 1] ?? 0);
		}
	});
	it("T ≤ 0 is argmax: weight 1 on the top move, whatever the input order", () => {
		const shuffled: ReadonlyArray<readonly [string, number]> = [
			["a2a3", 0.01],
			["d2d4", 0.3],
			["e2e4", 0.6],
			["g1f3", 0.09],
		];
		expect([...temperedWeights(shuffled, 0, 0)]).toEqual([["e2e4", 1]]);
		expect([...temperedWeights(shuffled, -1, 0)]).toEqual([["e2e4", 1]]);
		expect([...temperedWeights(shuffled, Number.NaN, 0)]).toEqual([["e2e4", 1]]);
	});
	it("drops moves under minProb before tempering and renormalises", () => {
		const w = temperedWeights(moves, 1, 0.05);
		expect([...w.keys()]).toEqual(["e2e4", "d2d4", "g1f3"]);
		expect(w.get("e2e4")).toBeCloseTo(0.6 / 0.99, 12);
		expect(sumOf(w.values())).toBeCloseTo(1, 12);
		// a move exactly at the floor stays
		expect([...temperedWeights(moves, 1, 0.09).keys()]).toEqual(["e2e4", "d2d4", "g1f3"]);
		// argmax respects the floor too (the floor never changes the argmax, but nothing else leaks)
		expect([...temperedWeights(moves, 0, 0.05)]).toEqual([["e2e4", 1]]);
	});
	it("keeps everything when the floor would drop every move; empty in, empty out", () => {
		const w = temperedWeights(moves, 1, 0.99);
		expect([...w.keys()]).toEqual(["e2e4", "d2d4", "g1f3", "a2a3"]);
		expect(sumOf(w.values())).toBeCloseTo(1, 12);
		expect(temperedWeights([], 1, 0).size).toBe(0);
		expect(temperedWeights([], 0, 0.5).size).toBe(0);
		const zeros = temperedWeights(
			[
				["e2e4", 0],
				["d2d4", 0],
			],
			1,
			0
		);
		expect(zeros.get("e2e4")).toBeCloseTo(0.5, 12);
		expect(zeros.get("d2d4")).toBeCloseTo(0.5, 12);
	});
});

describe("policyEntropy (H5)", () => {
	it("is 0 for a forced move or an empty list and 1 for a uniform distribution", () => {
		expect(policyEntropy([])).toBe(0);
		expect(policyEntropy([["e2e4", 1]])).toBe(0);
		expect(
			policyEntropy([
				["e2e4", 1],
				["d2d4", 0],
			])
		).toBe(0);
		const n = 7;
		const uniform: Array<[string, number]> = Array.from({ length: n }, (_, i) => [`m${i}`, 1 / n]);
		expect(policyEntropy(uniform)).toBeCloseTo(1, 12);
	});
	it("is −Σ p log p / log(#moves), renormalising a partial list first", () => {
		const moves: Array<[string, number]> = [
			["e2e4", 0.5],
			["d2d4", 0.3],
			["g1f3", 0.2],
		];
		const h = -(0.5 * Math.log(0.5) + 0.3 * Math.log(0.3) + 0.2 * Math.log(0.2)) / Math.log(3);
		expect(policyEntropy(moves)).toBeCloseTo(h, 12);
		const scaled = moves.map(([u, p]) => [u, p * 0.4] as [string, number]);
		expect(policyEntropy(scaled)).toBeCloseTo(h, 12);
		// more concentrated → lower
		expect(
			policyEntropy([
				["e2e4", 0.9],
				["d2d4", 0.05],
				["g1f3", 0.05],
			])
		).toBeLessThan(h);
	});
});

describe("klDivergence (§3.2 meters)", () => {
	const p = new Map([
		["e2e4", 0.5],
		["d2d4", 0.3],
		["g1f3", 0.15],
		["c2c4", 0.05],
	]);
	it("is 0 when q is p renormalised over q's keys — the railed-set identity", () => {
		expect(klDivergence(p, p)).toBeCloseTo(0, 12);
		const subset = new Map([
			["e2e4", 0.5 / 0.8],
			["d2d4", 0.3 / 0.8],
		]);
		expect(klDivergence(subset, p)).toBeCloseTo(0, 12);
		// unnormalised q is normalised first
		expect(
			klDivergence(
				new Map([
					["e2e4", 5],
					["d2d4", 3],
				]),
				p
			)
		).toBeCloseTo(0, 12);
	});
	it("is Σ q log(q/p̃) otherwise, and infinite when q lands where p has nothing", () => {
		const q = new Map([
			["e2e4", 0.3],
			["d2d4", 0.7],
		]);
		const expected = 0.3 * Math.log(0.3 / (0.5 / 0.8)) + 0.7 * Math.log(0.7 / (0.3 / 0.8));
		expect(klDivergence(q, p)).toBeCloseTo(expected, 12);
		expect(klDivergence(new Map([["h2h4", 1]]), p)).toBe(Number.POSITIVE_INFINITY);
		expect(klDivergence(new Map(), p)).toBe(0);
	});
});
