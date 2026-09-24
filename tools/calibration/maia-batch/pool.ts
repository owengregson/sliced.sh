/**
 * tools/calibration/maia-batch/pool.ts — the native Maia grid: requests encoded with the shipped
 * `encodeMaiaInputs`, split into batches over a pool of `maia_worker.py` processes, and each answer
 * decoded with the shipped `decodeMaiaOutputs` on a full-vocabulary logits array.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIA_INPUT } from "@core/constants/maia";
import { encodeMaiaInputs, type MaiaEncoded } from "@core/policy/maia-encoder";
import { decodeMaiaOutputs } from "@core/policy/maia-policy";
import { decodeResult, encodeBatch, type ResultSink } from "./codec";
import { ensureJoinedModel } from "./model";
import type {
	MaiaGridOptions,
	MaiaGridPolicy,
	MaiaGridRequest,
	MaiaGridResult,
	Query,
} from "./types";
import { DEFAULT_PYTHON, type NativeWorker, startWorker } from "./worker";

/** A persistent pool: several `run` calls may be in flight and share the workers. */
export interface MaiaGridPool {
	run(
		requests: readonly MaiaGridRequest[],
		onProgress?: MaiaGridOptions["onProgress"]
	): Promise<MaiaGridResult[]>;
	close(): Promise<void>;
	readonly workers: number;
}

export async function createMaiaGridPool(options: MaiaGridOptions = {}): Promise<MaiaGridPool> {
	const cpuCount = Math.max(0, options.workers ?? 3);
	const coremlCount = Math.max(0, options.coremlWorkers ?? 1);
	const workerCount = cpuCount + coremlCount;
	if (workerCount === 0) throw new Error("maia-batch: no workers requested");
	const threads = Math.max(1, options.threads ?? 2);
	const batch = Math.max(1, options.batch ?? 32);
	const python = options.python ?? process.env.SLICED_CALIBRATION_PYTHON ?? DEFAULT_PYTHON;
	if (!existsSync(python))
		throw new Error(
			`maia-batch: no python at ${python} (uv venv --python 3.12 tools/data/.venv && uv pip install --python tools/data/.venv onnxruntime numpy)`
		);
	const model = await ensureJoinedModel();
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "maia-batch-"));
	const workers = await Promise.all(
		Array.from({ length: workerCount }, (_, i) =>
			startWorker(model, python, threads, i < coremlCount ? "coreml" : "cpu", batch)
		)
	);
	const idle: NativeWorker[] = [...workers];
	const waiting: Array<(w: NativeWorker) => void> = [];
	const acquire = (): Promise<NativeWorker> => {
		const w = idle.pop();
		return w ? Promise.resolve(w) : new Promise((resolve) => waiting.push(resolve));
	};
	const release = (w: NativeWorker): void => {
		const next = waiting.shift();
		if (next) next(w);
		else idle.push(w);
	};
	let fileSeq = 0;

	async function runBatch(
		queries: readonly Query[],
		encoded: readonly MaiaEncoded[],
		oppo: readonly number[],
		sink: ResultSink
	): Promise<void> {
		const u8 = encodeBatch(queries, encoded, oppo);
		const seq = fileSeq++;
		const inPath = path.join(tmpDir, `b${seq}.in`);
		const outPath = path.join(tmpDir, `b${seq}.out`);
		await Bun.write(inPath, u8);
		const worker = await acquire();
		try {
			await worker.run(inPath, outPath);
		} finally {
			release(worker);
		}
		const out = new Uint8Array(await Bun.file(outPath).arrayBuffer());
		rmSync(inPath, { force: true });
		rmSync(outPath, { force: true });
		decodeResult(out, queries, encoded, sink);
	}

	// One full-vocabulary logits buffer reused for every decode: -Infinity outside the legal set.
	const fullLogits = new Float32Array(MAIA_INPUT.moveVocab).fill(Number.NEGATIVE_INFINITY);

	return {
		workers: workerCount,
		async run(requests, onProgress) {
			const encoded = requests.map((r) => encodeMaiaInputs(r.historyFens));
			const oppo = requests.map((r) => r.oppoElo);
			const results: MaiaGridResult[] = requests.map((r) => ({
				id: r.id,
				policies: new Array<MaiaGridPolicy>(r.selfElos.length),
			}));
			const queries: Query[] = [];
			requests.forEach((r, request) => {
				r.selfElos.forEach((selfElo, slot) => {
					queries.push({ request, slot, selfElo });
				});
			});
			const sink = (q: Query, legalLogits: Float32Array, value: Float32Array): void => {
				const e = encoded[q.request];
				const res = results[q.request];
				if (!e || !res) return;
				for (let i = 0; i < e.legal.length; i++)
					fullLogits[e.legal[i] ?? 0] = legalLogits[i] ?? Number.NEGATIVE_INFINITY;
				const decoded = decodeMaiaOutputs(fullLogits, value, e);
				for (let i = 0; i < e.legal.length; i++) fullLogits[e.legal[i] ?? 0] = Number.NEGATIVE_INFINITY;
				res.policies[q.slot] = { selfElo: q.selfElo, moves: decoded.moves, wdl: decoded.wdl };
			};
			let done = 0;
			const jobs: Promise<void>[] = [];
			for (let i = 0; i < queries.length; i += batch) {
				const slice = queries.slice(i, i + batch);
				jobs.push(
					runBatch(slice, encoded, oppo, sink).then(() => {
						done += slice.length;
						onProgress?.(done, queries.length);
					})
				);
			}
			await Promise.all(jobs);
			return results;
		},
		async close() {
			await Promise.all(workers.map((w) => w.close()));
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

/** One-shot: start a pool, answer `requests`, shut the pool down. */
export async function maiaGrid(
	requests: readonly MaiaGridRequest[],
	options: MaiaGridOptions = {}
): Promise<MaiaGridResult[]> {
	const pool = await createMaiaGridPool(options);
	try {
		return await pool.run(requests, options.onProgress);
	} finally {
		await pool.close();
	}
}
