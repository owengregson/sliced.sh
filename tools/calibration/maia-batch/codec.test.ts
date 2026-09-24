// tools/calibration/maia-batch/codec.test.ts — the batch file layout maia_worker.py reads, and the
// result file split back into per-query slices. No model, no python.
import "../../lib/defines";
import { describe, expect, it } from "bun:test";
import { MAIA_INPUT } from "@core/constants/maia";
import { encodeMaiaInputs } from "@core/policy/maia-encoder";
import { decodeResult, encodeBatch } from "./codec";
import type { Query } from "./types";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const encoded = [encodeMaiaInputs([START]), encodeMaiaInputs([START, AFTER_E4])];
const tokenFloats = MAIA_INPUT.squares * MAIA_INPUT.tokenDim;

describe("maia-batch codec", () => {
	// Request 1 first, then request 0: positions are listed in first-use order.
	const queries: Query[] = [
		{ request: 1, slot: 0, selfElo: 1500 },
		{ request: 0, slot: 0, selfElo: 1100 },
		{ request: 1, slot: 1, selfElo: 1700 },
	];

	it("lists each referenced position once, then one row per query", () => {
		const bytes = encodeBatch(queries, encoded, [1400, 1600]);
		const view = new DataView(bytes.buffer);
		expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("MBQ1");
		const legal = (encoded[0]?.legal.length ?? 0) + (encoded[1]?.legal.length ?? 0);
		expect([view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)]).toEqual([
			2,
			3,
			legal,
		]);
		const at = 16 + 4 * (2 * tokenFloats + 3 + legal);
		expect(Array.from(new Int32Array(bytes.buffer, at, 3))).toEqual([0, 1, 0]);
		expect(Array.from(new Float32Array(bytes.buffer, at + 12, 3))).toEqual([1500, 1100, 1700]);
		expect(Array.from(new Float32Array(bytes.buffer, at + 24, 3))).toEqual([1600, 1400, 1600]);
		expect(bytes.byteLength).toBe(at + 36);
	});

	it("hands every query its legal logits and value logits, and rejects a short file", () => {
		const counts = queries.map((q) => encoded[q.request]?.legal.length ?? 0);
		const total = counts.reduce((s, c) => s + c + 3, 0);
		const out = new Uint8Array(12 + 4 * total);
		out.set([0x4d, 0x42, 0x52, 0x31]);
		const view = new DataView(out.buffer);
		view.setUint32(4, queries.length, true);
		view.setUint32(8, total, true);
		const data = new Float32Array(out.buffer, 12, total);
		for (let i = 0; i < total; i++) data[i] = i;
		const seen: Array<[number, number, number]> = [];
		decodeResult(out, queries, encoded, (q, logits, value) => {
			seen.push([q.selfElo, logits.length, value[0] ?? -1]);
		});
		expect(seen).toEqual([
			[1500, counts[0] ?? 0, counts[0] ?? 0],
			[1100, counts[1] ?? 0, (counts[0] ?? 0) + 3 + (counts[1] ?? 0)],
			[1700, counts[2] ?? 0, total - 3],
		]);
		view.setUint32(8, total - 1, true);
		expect(() => decodeResult(out, queries, encoded, () => {})).toThrow("length mismatch");
		out[3] = 0x30;
		expect(() => decodeResult(out, queries, encoded, () => {})).toThrow("malformed");
	});
});
