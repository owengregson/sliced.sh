// test/integration/maia-onnx.test.ts
/**
 * Real onnxruntime-web (the vendored `assets/vendor/onnxruntime/` files, wasm backend, one
 * thread — the pthread worker path does not run under Bun) driving the shipped Maia-3 models
 * through `encodeMaiaInputs` → `session.run` → `decodeMaiaOutputs`, the path the offscreen
 * document takes. Every fixture position must reproduce the torch fp32 argmax and top-5 set
 * (`test/fixtures/maia3/expected-<size>.json`), the top-5 probabilities within `PROB_TOLERANCE`,
 * and the value softmax within the same. Per-query latency is logged (p50/p95) per size.
 *
 * A size whose model file is missing from `assets/models/maia3/` is skipped with the reason;
 * the 79M model is stored split in the repository (`MAIA_MODEL_FILES["79m"].parts`) and joined
 * in memory here, as the build joins it. Since 2026-09-13 the 79M model is the only size in
 * `MAIA_SIZES`, so this is the one parity run; `expected-79m.json` is the fixture it reproduces.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	MAIA_DIR,
	MAIA_FILES,
	MAIA_INPUT,
	MAIA_MODEL_FILES,
	MAIA_SIZES,
	type MaiaSize,
} from "@core/constants/maia";
import {
	__setLogSinkOutsideServiceWorker,
	log,
	printLog,
	setLogLevel,
	setLogSink,
} from "@core/logger";
import { encodeMaiaInputs, maiaIndexToUci, maiaMoveIndex } from "@core/policy/maia-encoder";
import { decodeMaiaOutputs } from "@core/policy/maia-policy";
import { MaiaStore } from "@offscreen/maia-store";
import { createOrtRuntime, type OrtRuntime } from "@offscreen/ort-loader";

interface FixturePosition {
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	tokensSet: number[];
	legal: number[];
}
interface PositionsFixture {
	history: number;
	tokenDim: number;
	positions: FixturePosition[];
}
interface ExpectedFixture {
	size: MaiaSize;
	/** `top` is `[uci, p] × 5` in the **mirrored** frame (the frame the model scores in); `value` the 3 raw logits. */
	positions: Array<{ top: Array<[string, number]>; value: [number, number, number] }>;
}

const ROOT = path.resolve(import.meta.dir, "../..");
const PACKAGED_ROOT = process.env.SLICED_PACKAGED_ROOT;
const FIXTURES = path.join(ROOT, "test/fixtures/maia3");
/** fp16-weight export versus torch fp32: the feasibility study measured ≤ 6.1e-4 on the top moves. */
const PROB_TOLERANCE = 2e-3;
const TOP_N = 5;
/** 60 queries at ≈ 200–300 ms for 79M plus a cold session load; generous so a slow machine reports rather than fails. */
const PARITY_TIMEOUT_MS = 600_000;

const positions = (await Bun.file(
	path.join(FIXTURES, "positions.json")
).json()) as PositionsFixture;

// Route `log.*` to this process's console the way the service worker's bridge would.
__setLogSinkOutsideServiceWorker(true);
setLogSink(printLog);
setLogLevel("info");

let skipReason: string | undefined;
let runtime: OrtRuntime | undefined;
try {
	runtime = await createOrtRuntime({
		importModule: (url) => import(url),
		getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
		threads: 1,
	});
} catch (error) {
	if (PACKAGED_ROOT) throw error;
	skipReason = `onnxruntime-web could not start: ${error instanceof Error ? error.message : String(error)}`;
}

/** The model bytes as the build ships them: whole, or the repository's parts joined. */
async function modelBytes(size: MaiaSize): Promise<Uint8Array | null> {
	if (PACKAGED_ROOT)
		return new MaiaStore({
			getUrl: (file) => path.join(PACKAGED_ROOT, file),
			fetch: async (file) => new Response(Bun.file(file)),
		}).get(size);
	const spec = MAIA_MODEL_FILES[size];
	const base = path.join(ROOT, MAIA_DIR, spec.file);
	if (spec.parts <= 1) {
		const file = Bun.file(base);
		return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
	}
	const parts: ArrayBuffer[] = [];
	for (let i = 0; i < spec.parts; i++) {
		const file = Bun.file(`${base}${MAIA_FILES.partSuffix}${i}`);
		if (!(await file.exists())) return null;
		parts.push(await file.arrayBuffer());
	}
	const total = parts.reduce((n, b) => n + b.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(new Uint8Array(part), offset);
		offset += part.byteLength;
	}
	return joined;
}

async function expectedFor(size: MaiaSize): Promise<ExpectedFixture | null> {
	const file = Bun.file(path.join(FIXTURES, `expected-${size}.json`));
	return (await file.exists()) ? ((await file.json()) as ExpectedFixture) : null;
}

function softmax3(v: readonly [number, number, number]): [number, number, number] {
	const m = Math.max(v[0], v[1], v[2]);
	const e = [Math.exp(v[0] - m), Math.exp(v[1] - m), Math.exp(v[2] - m)];
	const z = (e[0] ?? 0) + (e[1] ?? 0) + (e[2] ?? 0);
	return [(e[0] ?? 0) / z, (e[1] ?? 0) / z, (e[2] ?? 0) / z];
}

function quantile(sorted: number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

/** The fixture's moves are in the mirrored frame; `decodeMaiaOutputs` answers in the board frame. */
function toBoardFrame(mirroredUci: string, mirrored: boolean): string {
	return maiaIndexToUci(maiaMoveIndex(mirroredUci, false), mirrored);
}

const present = new Map<MaiaSize, Uint8Array>();
const missing: string[] = [];
if (skipReason === undefined)
	for (const size of MAIA_SIZES) {
		const bytes = await modelBytes(size);
		if (bytes) present.set(size, bytes);
		else missing.push(`${size}: ${MAIA_DIR}${MAIA_MODEL_FILES[size].file} is not in the checkout`);
	}

describe("Maia-3 ONNX models under onnxruntime-web", () => {
	it("the fixture has the registry's shape", () => {
		expect(positions.history).toBe(MAIA_INPUT.history);
		expect(positions.tokenDim).toBe(MAIA_INPUT.tokenDim);
		expect(positions.positions.length).toBeGreaterThan(0);
	});
	for (const size of MAIA_SIZES) {
		const bytes = present.get(size);
		const reason =
			skipReason ?? (bytes ? undefined : `skipped: ${missing.find((m) => m.startsWith(size))}`);
		it.skipIf(reason !== undefined)(
			`${size}: every fixture position reproduces torch fp32 (argmax, top-${TOP_N} set, |Δp| ≤ ${PROB_TOLERANCE})`,
			async () => {
				if (!runtime || !bytes) throw new Error(reason);
				const expected = await expectedFor(size);
				if (!expected) throw new Error(`test/fixtures/maia3/expected-${size}.json is missing`);
				expect(expected.size).toBe(size);
				expect(expected.positions.length).toBe(positions.positions.length);
				expect(bytes.byteLength).toBe(MAIA_MODEL_FILES[size].bytes);

				const t0 = performance.now();
				const session = await runtime.createSession(bytes);
				const loadMs = performance.now() - t0;
				try {
					const times: number[] = [];
					let argmaxAgree = 0;
					let topSetAgree = 0;
					let maxDeltaP = 0;
					let maxDeltaValue = 0;
					for (const [i, p] of positions.positions.entries()) {
						const want = expected.positions[i];
						if (!want) throw new Error(`no expectation for position ${i}`);
						const encoded = encodeMaiaInputs(p.historyFens);
						const feeds = {
							[MAIA_INPUT.inputs.tokens]: runtime.tensor("float32", encoded.tokens, [
								1,
								MAIA_INPUT.squares,
								MAIA_INPUT.tokenDim,
							]),
							[MAIA_INPUT.inputs.selfElo]: runtime.tensor("float32", Float32Array.of(p.selfElo), [1]),
							[MAIA_INPUT.inputs.oppoElo]: runtime.tensor("float32", Float32Array.of(p.oppoElo), [1]),
						};
						const start = performance.now();
						const out = await session.run(feeds);
						times.push(performance.now() - start);
						const moveLogits = out[MAIA_INPUT.outputs.move]?.data;
						const valueLogits = out[MAIA_INPUT.outputs.value]?.data;
						if (!moveLogits || !valueLogits) throw new Error(`position ${i}: missing outputs`);
						expect(moveLogits.length).toBe(MAIA_INPUT.moveVocab);
						expect(valueLogits.length).toBe(3);
						const decoded = decodeMaiaOutputs(moveLogits, valueLogits, encoded);

						expect(decoded.moves.length).toBe(p.legal.length);
						let sum = 0;
						for (const [, prob] of decoded.moves) sum += prob;
						expect(sum).toBeCloseTo(1, 5);

						const wantTop = want.top.map(
							([uci, prob]) => [toBoardFrame(uci, encoded.mirrored), prob] as const
						);
						const gotTop = decoded.moves.slice(0, TOP_N);
						if (gotTop[0]?.[0] === wantTop[0]?.[0]) argmaxAgree++;
						const gotSet = new Set(gotTop.map(([uci]) => uci));
						if (wantTop.every(([uci]) => gotSet.has(uci)) && gotSet.size === wantTop.length)
							topSetAgree++;
						const byUci = new Map(decoded.moves);
						for (const [uci, prob] of wantTop) {
							const d = Math.abs((byUci.get(uci) ?? 0) - prob);
							if (d > maxDeltaP) maxDeltaP = d;
						}
						const wantWdl = softmax3(want.value);
						for (let k = 0; k < 3; k++) {
							const d = Math.abs((decoded.wdl[k] ?? 0) - (wantWdl[k] ?? 0));
							if (d > maxDeltaValue) maxDeltaValue = d;
						}
					}
					const n = positions.positions.length;
					const sorted = [...times].sort((a, b) => a - b);
					log.info(
						`maia-onnx ${size}: argmax ${argmaxAgree}/${n} top-${TOP_N} set ${topSetAgree}/${n} max|Δp|=${maxDeltaP.toExponential(2)} max|Δwdl|=${maxDeltaValue.toExponential(2)} load=${loadMs.toFixed(0)} ms p50=${quantile(sorted, 0.5).toFixed(1)} ms p95=${quantile(sorted, 0.95).toFixed(1)} ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms`
					);
					expect(argmaxAgree).toBe(n);
					expect(topSetAgree).toBe(n);
					expect(maxDeltaP).toBeLessThanOrEqual(PROB_TOLERANCE);
					expect(maxDeltaValue).toBeLessThanOrEqual(PROB_TOLERANCE);
				} finally {
					await session.release();
				}
			},
			PARITY_TIMEOUT_MS
		);
	}
	it.skipIf(skipReason === undefined)(`skipped: ${skipReason}`, () => {});
});
