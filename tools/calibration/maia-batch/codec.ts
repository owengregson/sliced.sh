/**
 * tools/calibration/maia-batch/codec.ts — the batch and result files `maia_worker.py` reads and
 * writes (little-endian; the layout is documented there): `"MBQ1"` with each referenced position's
 * tokens and legal indices once plus one (position, self, oppo) row per query, and `"MBR1"` with
 * each query's legal move logits and 3 value logits.
 */

import { MAIA_INPUT } from "@core/constants/maia";
import type { MaiaEncoded } from "@core/policy/maia-encoder";
import type { Query } from "./types";

const TOKEN_FLOATS = MAIA_INPUT.squares * MAIA_INPUT.tokenDim;
const VALUE_LOGITS = 3;

/** One query's answer: its position's legal move logits and the 3 value logits. */
export type ResultSink = (q: Query, legalLogits: Float32Array, value: Float32Array) => void;

/** The batch file for `queries` (positions in first-use order). */
export function encodeBatch(
	queries: readonly Query[],
	encoded: readonly MaiaEncoded[],
	oppo: readonly number[]
): Uint8Array {
	// Positions this batch references, in first-use order.
	const posOf = new Map<number, number>();
	const positions: number[] = [];
	for (const q of queries)
		if (!posOf.has(q.request)) {
			posOf.set(q.request, positions.length);
			positions.push(q.request);
		}
	let legalTotal = 0;
	for (const r of positions) legalTotal += encoded[r]?.legal.length ?? 0;
	const p = positions.length;
	const n = queries.length;
	const bytes = 16 + 4 * (p * TOKEN_FLOATS + (p + 1) + legalTotal + 3 * n);
	const buf = new ArrayBuffer(bytes);
	const u8 = new Uint8Array(buf);
	u8.set([0x4d, 0x42, 0x51, 0x31]); // "MBQ1"
	const view = new DataView(buf);
	view.setUint32(4, p, true);
	view.setUint32(8, n, true);
	view.setUint32(12, legalTotal, true);
	let off = 16;
	const tokens = new Float32Array(buf, off, p * TOKEN_FLOATS);
	positions.forEach((r, i) => {
		const e = encoded[r];
		if (e) tokens.set(e.tokens, i * TOKEN_FLOATS);
	});
	off += 4 * p * TOKEN_FLOATS;
	const offsets = new Int32Array(buf, off, p + 1);
	off += 4 * (p + 1);
	const legal = new Int32Array(buf, off, legalTotal);
	off += 4 * legalTotal;
	let cursor = 0;
	positions.forEach((r, i) => {
		offsets[i] = cursor;
		const l = encoded[r]?.legal;
		if (l) {
			legal.set(l, cursor);
			cursor += l.length;
		}
	});
	offsets[p] = cursor;
	const qPos = new Int32Array(buf, off, n);
	off += 4 * n;
	const qSelf = new Float32Array(buf, off, n);
	off += 4 * n;
	const qOppo = new Float32Array(buf, off, n);
	queries.forEach((q, i) => {
		qPos[i] = posOf.get(q.request) ?? 0;
		qSelf[i] = q.selfElo;
		qOppo[i] = oppo[q.request] ?? 0;
	});
	return u8;
}

/** Hand every query's slice of a result file to `sink`; throws on a malformed or short file. */
export function decodeResult(
	out: Uint8Array,
	queries: readonly Query[],
	encoded: readonly MaiaEncoded[],
	sink: ResultSink
): void {
	const n = queries.length;
	const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
	if (String.fromCharCode(...out.subarray(0, 4)) !== "MBR1" || outView.getUint32(4, true) !== n)
		throw new Error("maia-batch: malformed worker result");
	const total = outView.getUint32(8, true);
	const data = new Float32Array(
		out.buffer.slice(out.byteOffset + 12, out.byteOffset + 12 + 4 * total)
	);
	let at = 0;
	for (const q of queries) {
		const count = encoded[q.request]?.legal.length ?? 0;
		sink(q, data.subarray(at, at + count), data.subarray(at + count, at + count + VALUE_LOGITS));
		at += count + VALUE_LOGITS;
	}
	if (at !== total) throw new Error("maia-batch: result length mismatch");
}
