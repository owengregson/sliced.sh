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
 */

import "../human-match/defines";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, open, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { MAIA_INPUT, MAIA_MODEL_FILES } from "@core/constants/maia";
import { encodeMaiaInputs, type MaiaEncoded } from "@core/policy/maia-encoder";
import { decodeMaiaOutputs } from "@core/policy/maia-policy";
import { maiaModelBytes } from "../human-match/maia";

const ROOT = path.resolve(import.meta.dir, "../..");
const WORKER_SCRIPT = path.join(import.meta.dir, "maia_worker.py");
export const DEFAULT_PYTHON = path.join(ROOT, "tools/data/.venv/bin/python");
const CACHE_DIR = path.join(ROOT, "data/calibration/cache");
const TOKEN_FLOATS = MAIA_INPUT.squares * MAIA_INPUT.tokenDim;
const VALUE_LOGITS = 3;
/** File rounding / pruning (CLI output only). */
const STORE_DIGITS = 6;
const STORE_MIN_P = 1e-5;

export interface MaiaGridRequest {
	id: string;
	/** Oldest → newest, the last the position to move in. */
	historyFens: string[];
	oppoElo: number;
	selfElos: number[];
}

export interface MaiaGridPolicy {
	selfElo: number;
	/** Board-frame UCI, descending by p, exactly as `decodeMaiaOutputs` returns. */
	moves: Array<[string, number]>;
	wdl: [number, number, number];
}

export interface MaiaGridResult {
	id: string;
	policies: MaiaGridPolicy[];
}

export interface MaiaGridOptions {
	/** CPU-EP worker processes (default 3). */
	workers?: number;
	/** onnxruntime intra-op threads per CPU worker (default 2). */
	threads?: number;
	/** CoreML-EP (GPU, static batch) worker processes alongside the CPU ones (default 1). */
	coremlWorkers?: number;
	/** Queries per batch file / session run (default 32; the CoreML graph is built for it). */
	batch?: number;
	python?: string;
	/** Called after every finished batch with the queries done so far in this call. */
	onProgress?: (doneQueries: number, totalQueries: number) => void;
}

/** The joined 79M model under `data/calibration/cache/` (never under `assets/`), built once. */
export async function ensureJoinedModel(): Promise<string> {
	const spec = MAIA_MODEL_FILES["79m"];
	const target = path.join(CACHE_DIR, spec.file);
	const existing = await stat(target).catch(() => null);
	if (existing?.size === spec.bytes) return target;
	const bytes = await maiaModelBytes("79m");
	if (!bytes) throw new Error("maia-batch: the 79M model parts are not in the checkout");
	const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (bytes.byteLength !== spec.bytes || hash !== spec.sha256)
		throw new Error(`maia-batch: joined model does not match MAIA_MODEL_FILES (sha ${hash})`);
	mkdirSync(CACHE_DIR, { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	await writeFile(tmp, bytes);
	await rename(tmp, target);
	return target;
}

/** Line reader over a child's stdout: `next()` resolves with the next full line. */
function lineReader(stream: NodeJS.ReadableStream): { next(): Promise<string> } {
	const lines: string[] = [];
	const waiters: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = [];
	let buffer = "";
	let closed = false;
	stream.setEncoding?.("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			const waiter = waiters.shift();
			if (waiter) waiter.resolve(line);
			else lines.push(line);
			nl = buffer.indexOf("\n");
		}
	});
	stream.on("end", () => {
		closed = true;
		for (const w of waiters.splice(0)) w.reject(new Error("maia worker exited"));
	});
	return {
		next() {
			const line = lines.shift();
			if (line !== undefined) return Promise.resolve(line);
			if (closed) return Promise.reject(new Error("maia worker exited"));
			return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
		},
	};
}

interface Worker {
	run(inPath: string, outPath: string): Promise<void>;
	close(): Promise<void>;
}

async function startWorker(
	model: string,
	python: string,
	threads: number,
	provider: string,
	maxBatch: number
): Promise<Worker> {
	const child = spawn(
		python,
		[
			WORKER_SCRIPT,
			"--model",
			model,
			"--threads",
			String(threads),
			"--provider",
			provider,
			"--max-batch",
			String(maxBatch),
		],
		{
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, OMP_NUM_THREADS: String(threads) },
		}
	);
	const stdin = child.stdin;
	const stdout = child.stdout;
	if (!stdin || !stdout) throw new Error("maia-batch: worker pipes missing");
	const reader = lineReader(stdout);
	const ready = await reader.next();
	if (!ready.startsWith("ready")) throw new Error(`maia-batch: worker said "${ready}"`);
	if (provider === "coreml" && !ready.includes("CoreML"))
		throw new Error(`maia-batch: CoreML EP unavailable (worker said "${ready}")`);
	let chain: Promise<void> = Promise.resolve();
	return {
		run(inPath, outPath) {
			const job = chain.then(async () => {
				stdin.write(`${inPath} ${outPath}\n`);
				const reply = await reader.next();
				if (reply !== "ok") throw new Error(`maia-batch: worker ${reply}`);
			});
			chain = job.catch(() => undefined);
			return job;
		},
		async close() {
			stdin.end();
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) resolve();
				else child.once("exit", () => resolve());
			});
		},
	};
}

interface Query {
	request: number;
	slot: number;
	selfElo: number;
}

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
	const idle: Worker[] = [...workers];
	const waiting: Array<(w: Worker) => void> = [];
	const acquire = (): Promise<Worker> => {
		const w = idle.pop();
		return w ? Promise.resolve(w) : new Promise((resolve) => waiting.push(resolve));
	};
	const release = (w: Worker): void => {
		const next = waiting.shift();
		if (next) next(w);
		else idle.push(w);
	};
	let fileSeq = 0;

	async function runBatch(
		queries: readonly Query[],
		encoded: readonly MaiaEncoded[],
		oppo: readonly number[],
		sink: (q: Query, legalLogits: Float32Array, value: Float32Array) => void
	): Promise<void> {
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

// ---------------------------------------------------------------------------------------------
// CLI

const round = (x: number): number => Number(x.toPrecision(STORE_DIGITS));

/** The stored form: 6 significant digits, moves under `STORE_MIN_P` dropped. */
export function compactResult(result: MaiaGridResult): MaiaGridResult {
	return {
		id: result.id,
		policies: result.policies.map((p) => ({
			selfElo: p.selfElo,
			moves: p.moves.filter(([, x]) => x >= STORE_MIN_P).map(([u, x]) => [u, round(x)]),
			wdl: [round(p.wdl[0]), round(p.wdl[1]), round(p.wdl[2])],
		})),
	};
}

function argValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

/** Ids already in `out`; a torn (newline-less) tail is truncated so appends stay valid JSONL. */
async function doneIds(out: string): Promise<Set<string>> {
	const ids = new Set<string>();
	if (!existsSync(out)) return ids;
	const text = await readFile(out, "utf8");
	const end = text.lastIndexOf("\n") + 1;
	if (end < text.length) await truncate(out, Buffer.byteLength(text.slice(0, end)));
	for (const line of text.slice(0, end).split("\n")) {
		if (!line) continue;
		const id = (JSON.parse(line) as { id?: unknown }).id;
		if (typeof id === "string") ids.add(id);
	}
	return ids;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const input = argValue(args, "--in");
	const output = argValue(args, "--out");
	if (!input || !output) {
		console.error(
			"usage: bun tools/calibration/maia-batch.ts --in requests.jsonl --out policies.jsonl [--workers N] [--threads T] [--coreml G] [--batch B]"
		);
		process.exit(2);
	}
	const options: MaiaGridOptions = {
		workers: Number(argValue(args, "--workers") ?? 3),
		threads: Number(argValue(args, "--threads") ?? 2),
		coremlWorkers: Number(argValue(args, "--coreml") ?? 1),
		batch: Number(argValue(args, "--batch") ?? 32),
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
