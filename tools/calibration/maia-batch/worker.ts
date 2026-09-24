/**
 * tools/calibration/maia-batch/worker.ts — one long-lived `maia_worker.py` process (onnxruntime,
 * CPU or CoreML EP): started with the joined model, then asked to run one batch file at a time over
 * its stdin / stdout line protocol.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT } from "../../lib/paths";

const WORKER_SCRIPT = path.join(import.meta.dir, "..", "maia_worker.py");
export const DEFAULT_PYTHON = path.join(ROOT, "tools/data/.venv/bin/python");

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

export interface NativeWorker {
	run(inPath: string, outPath: string): Promise<void>;
	close(): Promise<void>;
}

export async function startWorker(
	model: string,
	python: string,
	threads: number,
	provider: string,
	maxBatch: number
): Promise<NativeWorker> {
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
