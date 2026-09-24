/**
 * tools/calibration/maia-batch.ts — batched native Maia-3 79M inference for the calibration
 * harness. Numerically the shipped path (`test/integration/maia-onnx.test.ts`,
 * `tools/human-match/maia.ts`) with the model run by native onnxruntime instead of the wasm build:
 *
 *   `encodeMaiaInputs` (Bun, shipped) → binary batch file → `maia_worker.py` (onnxruntime CPU EP,
 *   one long-lived process per worker) → move logits gathered at the legal indices + 3 value
 *   logits → `decodeMaiaOutputs` (Bun, shipped) on a full-vocabulary logits array.
 *
 * `maia-parity.ts` is the proof that this equals `createMaiaRunner`. Nothing here ships.
 *
 * CLI:
 *   bun tools/calibration/maia-batch.ts --in requests.jsonl --out policies.jsonl
 *       [--workers N] [--threads T] [--coreml G] [--batch B]
 * Input lines are `MaiaGridRequest`s; output lines are `MaiaGridResult`s. Resumable: ids already
 * in `--out` are skipped (a torn last line is cut off first). In the **file** (not the API) every
 * probability and WDL value is rounded to 6 significant digits and moves with p < 1e-5 are
 * dropped, so a policy's stored mass can fall short of 1 by at most (legal moves) × 1e-5.
 *
 * The parts live in `maia-batch/`: the API types, the joined model, the worker process, the batch
 * file codec, the pool, and the stored form.
 */

import "../lib/defines";
import { createReadStream, mkdirSync } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { flagValue } from "../lib/cli";
import { createMaiaGridPool } from "./maia-batch/pool";
import { compactResult, doneIds } from "./maia-batch/store";
import type { MaiaGridOptions, MaiaGridRequest } from "./maia-batch/types";

export { ensureJoinedModel } from "./maia-batch/model";
export { createMaiaGridPool, type MaiaGridPool, maiaGrid } from "./maia-batch/pool";
export { compactResult } from "./maia-batch/store";
export type {
	MaiaGridOptions,
	MaiaGridPolicy,
	MaiaGridRequest,
	MaiaGridResult,
} from "./maia-batch/types";
export { DEFAULT_PYTHON } from "./maia-batch/worker";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const input = flagValue(args, "in");
	const output = flagValue(args, "out");
	if (!input || !output) {
		console.error(
			"usage: bun tools/calibration/maia-batch.ts --in requests.jsonl --out policies.jsonl [--workers N] [--threads T] [--coreml G] [--batch B]"
		);
		process.exit(2);
	}
	const options: MaiaGridOptions = {
		workers: Number(flagValue(args, "workers") ?? 3),
		threads: Number(flagValue(args, "threads") ?? 2),
		coremlWorkers: Number(flagValue(args, "coreml") ?? 1),
		batch: Number(flagValue(args, "batch") ?? 32),
	};
	const skip = await doneIds(output);
	mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
	await (await open(output, "a")).close();
	const pool = await createMaiaGridPool(options);
	const batch = options.batch ?? 32;
	// Queries per chunk: enough to keep every worker busy for several batches.
	const chunkQueries = pool.workers * batch * 4;
	const start = performance.now();
	let queriesDone = 0;
	let requestsDone = 0;
	let skipped = 0;
	let lastReport = 0;
	const report = (force = false): void => {
		const now = performance.now();
		if (!force && now - lastReport < 5_000) return;
		lastReport = now;
		const secs = (now - start) / 1000;
		console.error(
			`[maia-batch] ${requestsDone} requests (${skipped} skipped), ${queriesDone} queries, ${(queriesDone / Math.max(secs, 1e-9)).toFixed(1)} q/s, ${secs.toFixed(0)} s`
		);
	};
	const inFlight: Promise<void>[] = [];
	let chunk: MaiaGridRequest[] = [];
	let chunkSize = 0;
	let writeChain: Promise<void> = Promise.resolve();
	const flush = async (): Promise<void> => {
		if (chunk.length === 0) return;
		const reqs = chunk;
		chunk = [];
		chunkSize = 0;
		let seen = 0;
		const job = pool
			.run(reqs, (d) => {
				queriesDone += d - seen;
				seen = d;
				report();
			})
			.then((results) => {
				const text = results.map((r) => JSON.stringify(compactResult(r))).join("\n");
				writeChain = writeChain.then(() => appendFile(output, `${text}\n`));
				requestsDone += results.length;
				return writeChain;
			});
		inFlight.push(job);
		// Two chunks in flight: the pool stays fed while the next chunk is read and encoded.
		if (inFlight.length >= 2) await inFlight.shift();
	};
	const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.trim()) continue;
		const request = JSON.parse(line) as MaiaGridRequest;
		if (skip.has(request.id)) {
			skipped++;
			continue;
		}
		skip.add(request.id);
		chunk.push(request);
		chunkSize += request.selfElos.length;
		if (chunkSize >= chunkQueries) await flush();
	}
	await flush();
	await Promise.all(inFlight);
	await writeChain;
	await pool.close();
	report(true);
}

if (import.meta.main) await main();
