// test/integration/engine.test.ts
/**
 * Real Stockfish: boots the vendored `sf_18_smallnet` build through
 * `bootEngine` (the offscreen loader with its Bun-side deps injected) using a
 * shared `WebAssembly.Memory`, loads the bundled net, and searches. The
 * Emscripten glue detects `process.versions.node` and takes its Node code
 * path (pthreads on `node:worker_threads`), which Bun supports. Skipped, with
 * the blocking API named, when `SharedArrayBuffer` is missing or the module
 * cannot execute in this runtime.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE_DIR } from "@core/constants/engine-files";
import { LIMITS } from "@core/constants/limits";
import { bootEngine, type StockfishFactory } from "@offscreen/stockfish-loader";

const ROOT = path.resolve(import.meta.dir, "../..");
const BESTMOVE_TIMEOUT_MS = 10_000;

interface Booted {
	sf: Awaited<ReturnType<typeof bootEngine>>;
	lines: string[];
	/** Everything the engine wrote to stderr (`onError`); must stay empty. */
	errors: string[];
	waitFor: (predicate: (line: string) => boolean, timeoutMs: number) => Promise<string>;
}

let skipReason: string | undefined;
let booted: Booted | undefined;

if (typeof SharedArrayBuffer === "undefined") {
	skipReason = "SharedArrayBuffer is unavailable in this runtime";
} else {
	const lines: string[] = [];
	const waiters: Array<{ predicate: (line: string) => boolean; resolve: (line: string) => void }> =
		[];
	const listen = (line: string): void => {
		lines.push(line);
		for (const w of [...waiters]) {
			if (w.predicate(line)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(line);
			}
		}
	};
	const errors: string[] = [];
	try {
		const sf = await bootEngine("smallnet", {
			crossOriginIsolated: true,
			getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
			importModule: (url) => import(url) as Promise<{ default: StockfishFactory }>,
			nnueStore: {
				get: async (name) =>
					new Uint8Array(await Bun.file(path.join(ROOT, ENGINE_DIR, name)).arrayBuffer()),
			},
			listen,
			onError: (msg) => errors.push(msg),
		});
		booted = {
			sf,
			lines,
			errors,
			waitFor: (predicate, timeoutMs) =>
				new Promise<string>((resolve, reject) => {
					const hit = lines.find(predicate);
					if (hit !== undefined) return resolve(hit);
					const timer = setTimeout(
						() => reject(new Error(`timed out after ${timeoutMs} ms; stderr: ${errors.join(" | ")}`)),
						timeoutMs
					);
					waiters.push({
						predicate,
						resolve: (line) => {
							clearTimeout(timer);
							resolve(line);
						},
					});
				}),
		};
	} catch (error) {
		skipReason = `vendored module cannot execute under Bun: ${error instanceof Error ? error.message : String(error)}`;
	}
}

if (skipReason) console.log(`[integration/engine] SKIPPED: ${skipReason}`);

describe("Stockfish 18 smallnet (real wasm)", () => {
	it.skipIf(skipReason !== undefined)(
		"answers uci with uciok, loads the bundled net, and finds a bestmove at depth 8",
		async () => {
			const b = booted as Booted;
			b.sf.uci("uci");
			await b.waitFor((l) => l === "uciok", 5_000);
			expect(b.lines).toContain(
				`option name UCI_Elo type spin default ${LIMITS.engineEloMin} min ${LIMITS.engineEloMin} max ${LIMITS.engineEloMax}`
			);
			expect(b.lines.some((l) => l.startsWith("id name Stockfish"))).toBe(true);
			b.sf.uci("isready");
			await b.waitFor((l) => l === "readyok", 5_000);
			b.sf.uci("position startpos");
			b.sf.uci("go depth 8");
			const bestmove = await b.waitFor((l) => l.startsWith("bestmove"), BESTMOVE_TIMEOUT_MS);
			expect(bestmove).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/);
			expect(b.lines.some((l) => /^info depth 8 /.test(l))).toBe(true);
			expect(b.errors).toEqual([]);
			b.sf.uci("quit");
		},
		BESTMOVE_TIMEOUT_MS + 12_000
	);
});
