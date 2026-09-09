// test/integration/chessmimic-onnx.test.ts
/**
 * Real onnxruntime-web (the vendored `assets/vendor/onnxruntime/` files, wasm backend, one
 * thread — the pthread worker path does not run under Bun) driving the shipped ChessMimic
 * bands through `createTimingInference`, exactly as the offscreen document does. Every fifth
 * reference position (200 of 1 000, all three bands) must reproduce the torch fp32
 * probabilities within `fixtureProbTolerance`; the per-query latency is printed and its p50
 * must stay inside the 100 ms budget. Skipped, with the reason, when the runtime cannot start
 * in this Bun.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chessMimicBandFile, MODELS_DIR } from "@core/constants/models";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference, type TimingInference } from "@offscreen/timing-inference";
import reference from "../fixtures/chessmimic-reference.json";

const ROOT = path.resolve(import.meta.dir, "../..");
const CM = TIMING_CONSTANTS.chessmimic;
const STRIDE = 5;
/** 200 queries plus three cold session loads; generous so a slow machine reports rather than fails. */
const PARITY_TIMEOUT_MS = 600_000;

let skipReason: string | undefined;
let inference: TimingInference | undefined;
try {
	inference = createTimingInference({
		runtime: () =>
			createOrtRuntime({
				importModule: (url) => import(url),
				getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
				threads: 1,
			}),
		store: {
			get: async (name) =>
				new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, name)).arrayBuffer()),
		},
	});
	const probe = await inference.handle({
		kind: "timing",
		id: "probe",
		inputs: {
			band: "1500_1600",
			moveTokens: reference.positions[0]?.moveTokens ?? [],
			fenTokens: reference.positions[0]?.fenTokens ?? [],
			rating: 1550,
			playerClockS: 300,
			opponentClockS: 300,
			incrementS: 0,
		},
	});
	if (!probe.probs) skipReason = `onnxruntime-web could not start: ${probe.error}`;
} catch (error) {
	skipReason = `onnxruntime-web could not start: ${error instanceof Error ? error.message : String(error)}`;
}

function quantile(sorted: number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

describe("ChessMimic ONNX bands under onnxruntime-web", () => {
	it.skipIf(skipReason !== undefined)(
		`every ${STRIDE}th reference position matches torch fp32 within ${CM.fixtureProbTolerance}`,
		async () => {
			if (!inference) throw new Error(skipReason);
			const perBand = new Map<string, number[]>();
			let maxDiff = 0;
			let n = 0;
			for (let i = 0; i < reference.positions.length; i += STRIDE) {
				const p = reference.positions[i];
				if (!p) continue;
				const r = await inference.handle({
					kind: "timing",
					id: String(i),
					inputs: {
						band: p.band,
						moveTokens: p.moveTokens,
						fenTokens: p.fenTokens,
						rating: p.rating,
						playerClockS: p.playerClockS,
						opponentClockS: p.opponentClockS,
						incrementS: p.incrementS,
					},
				});
				expect(r.error).toBeUndefined();
				expect(r.band).toBe(p.band);
				if (!r.probs) throw new Error("no probabilities");
				expect(r.probs).toHaveLength(CM.nBuckets);
				let sum = 0;
				for (let b = 0; b < CM.nBuckets; b++) {
					const d = Math.abs((r.probs[b] ?? 0) - (p.probs[b] ?? 0));
					if (d > maxDiff) maxDiff = d;
					sum += r.probs[b] ?? 0;
				}
				expect(sum).toBeCloseTo(1, 4);
				perBand.set(p.band, [...(perBand.get(p.band) ?? []), r.ms ?? Number.NaN]);
				n++;
			}
			expect(n).toBe(reference.positions.length / STRIDE);
			expect(maxDiff).toBeLessThan(CM.fixtureProbTolerance);
			const all: number[] = [];
			for (const [band, times] of perBand) {
				const sorted = [...times].sort((a, b) => a - b);
				all.push(...sorted);
				console.log(
					`chessmimic-onnx ${band}: n=${sorted.length} p50=${quantile(sorted, 0.5).toFixed(1)} ms p95=${quantile(sorted, 0.95).toFixed(1)} ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms`
				);
			}
			all.sort((a, b) => a - b);
			console.log(
				`chessmimic-onnx all: max |Δprob|=${maxDiff.toExponential(2)} p50=${quantile(all, 0.5).toFixed(1)} ms p95=${quantile(all, 0.95).toFixed(1)} ms`
			);
			expect(quantile(all, 0.5)).toBeLessThanOrEqual(CM.inferenceBudgetMs);
		},
		PARITY_TIMEOUT_MS
	);
	it.skipIf(skipReason !== undefined)("the bundled band files are the registered ones", async () => {
		for (const band of CM.bands)
			expect(Bun.file(path.join(ROOT, MODELS_DIR, chessMimicBandFile(band))).size).toBeGreaterThan(0);
	});
	it.skipIf(skipReason === undefined)(`skipped: ${skipReason}`, () => {});
});
