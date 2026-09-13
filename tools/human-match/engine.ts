/**
 * tools/human-match/engine.ts — the vendored Stockfish 18 smallnet as a referee under Bun.
 *
 * Boots `sf_18_smallnet` through the offscreen loader exactly as `test/integration/engine.test.ts`
 * does (the Emscripten glue takes its Node code path — pthreads on `node:worker_threads` — which
 * Bun supports), then answers one `go` at a time and returns the **last complete MultiPV cycle**
 * as `EvalLine[]` — the same collection rule the `stockfish18-*.json` fixtures were captured with.
 * Nothing here runs in the extension.
 */

import "./defines";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pvToSan } from "@core/chess/san";
import { ENGINE_DIR } from "@core/constants/engine-files";
import { parseBestmove, parseInfo } from "@core/engine/uci-parser";
import { __setLogSinkOutsideServiceWorker, printLog, setLogLevel, setLogSink } from "@core/logger";
import { compareLines } from "@core/strength/quality";
import { bootEngine, type StockfishFactory } from "@offscreen/stockfish-loader";
import type { EvalLine } from "@typedefs/engine";

export const ROOT = path.resolve(import.meta.dir, "../..");

// Route `log.*` from the loaders to this process's console (there is no service worker here).
__setLogSinkOutsideServiceWorker(true);
setLogSink(printLog);
setLogLevel("warn");

export interface SearchSpec {
	fen: string;
	movetimeMs: number;
	/** `go depth` cap; omitted = movetime alone. */
	depth?: number;
	multiPv: number;
	/** `go searchmoves …` — the frame then covers exactly these roots. */
	searchmoves?: readonly string[];
	/** `UCI_LimitStrength true` + `UCI_Elo`; omitted = full strength (the referee). */
	uciElo?: number;
}

export interface SearchFrame {
	/** Sorted by `compareLines`, `multipv` renumbered 1…K, `pvSan` filled from `fen`. */
	lines: EvalLine[];
	bestmove: string | null;
	/** Depth of the cycle the lines come from. */
	depth: number;
	/** Whether every requested root was reported at `depth`. */
	complete: boolean;
	elapsedMs: number;
}

export interface RefereeEngine {
	search(spec: SearchSpec): Promise<SearchFrame>;
	dispose(): void;
}

export interface RefereeOptions {
	threads?: number;
	hashMb?: number;
	/** Per-search wall-clock guard on top of the movetime (default 20 s). */
	timeoutMs?: number;
}

interface RawLine {
	multipv: number;
	depth: number;
	score: EvalLine["score"];
	pv: string[];
	wdl?: [number, number, number];
}

export async function createRefereeEngine(options: RefereeOptions = {}): Promise<RefereeEngine> {
	if (typeof SharedArrayBuffer === "undefined")
		throw new Error("SharedArrayBuffer is unavailable in this runtime");
	const listeners = new Set<(line: string) => void>();
	const errors: string[] = [];
	const sf = await bootEngine("smallnet", {
		crossOriginIsolated: true,
		getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
		importModule: (url) => import(url) as Promise<{ default: StockfishFactory }>,
		nnueStore: {
			get: async (name) =>
				new Uint8Array(await Bun.file(path.join(ROOT, ENGINE_DIR, name)).arrayBuffer()),
		},
		listen: (line) => {
			for (const l of [...listeners]) l(line);
		},
		onError: (msg) => errors.push(msg),
	});

	const waitFor = (predicate: (line: string) => boolean, timeoutMs: number): Promise<string> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.delete(listener);
				reject(new Error(`engine timed out after ${timeoutMs} ms; stderr: ${errors.join(" | ")}`));
			}, timeoutMs);
			const listener = (line: string): void => {
				if (!predicate(line)) return;
				clearTimeout(timer);
				listeners.delete(listener);
				resolve(line);
			};
			listeners.add(listener);
		});

	const send = (command: string): void => sf.uci(command);
	send("uci");
	await waitFor((l) => l === "uciok", 10_000);
	send(`setoption name Threads value ${options.threads ?? 1}`);
	send(`setoption name Hash value ${options.hashMb ?? 32}`);
	send("setoption name UCI_ShowWDL value true");
	send("isready");
	await waitFor((l) => l === "readyok", 10_000);

	let chain: Promise<unknown> = Promise.resolve();
	let lastElo: number | undefined | "unset" = "unset";

	const runSearch = async (spec: SearchSpec): Promise<SearchFrame> => {
		if (spec.uciElo !== lastElo) {
			if (spec.uciElo === undefined) send("setoption name UCI_LimitStrength value false");
			else {
				send("setoption name UCI_LimitStrength value true");
				send(`setoption name UCI_Elo value ${spec.uciElo}`);
			}
			lastElo = spec.uciElo;
		}
		send(`setoption name MultiPV value ${spec.multiPv}`);
		send("ucinewgame");
		send("isready");
		await waitFor((l) => l === "readyok", 10_000);
		send(`position fen ${spec.fen}`);

		const byDepth = new Map<number, Map<number, RawLine>>();
		const collect = (line: string): void => {
			if (!line.startsWith("info")) return;
			const info = parseInfo(line);
			if (!info || info.string !== undefined || info.depth === undefined) return;
			if (info.multipv === undefined || info.score === undefined || !info.pv?.length) return;
			if (info.score.bound !== undefined) return;
			let cycle = byDepth.get(info.depth);
			if (!cycle) {
				cycle = new Map();
				byDepth.set(info.depth, cycle);
			}
			const raw: RawLine = {
				multipv: info.multipv,
				depth: info.depth,
				score: info.score.type === "mate" ? { mate: info.score.value } : { cp: info.score.value },
				pv: info.pv,
			};
			if (info.wdl) raw.wdl = info.wdl;
			cycle.set(info.multipv, raw);
		};
		listeners.add(collect);
		const parts = [`go movetime ${spec.movetimeMs}`];
		if (spec.depth !== undefined) parts.push(`depth ${spec.depth}`);
		if (spec.searchmoves?.length) parts.push(`searchmoves ${spec.searchmoves.join(" ")}`);
		const started = performance.now();
		send(parts.join(" "));
		let bestLine: string;
		try {
			bestLine = await waitFor(
				(l) => l.startsWith("bestmove"),
				spec.movetimeMs + (options.timeoutMs ?? 20_000)
			);
		} finally {
			listeners.delete(collect);
		}
		const elapsedMs = performance.now() - started;
		const expected = spec.searchmoves?.length
			? Math.min(spec.multiPv, spec.searchmoves.length)
			: spec.multiPv;
		// The deepest cycle that reported every root, else the deepest one at all.
		let chosenDepth = -1;
		let complete = false;
		for (const [depth, cycle] of byDepth) {
			const full = cycle.size >= expected;
			if (full && (!complete || depth > chosenDepth)) {
				chosenDepth = depth;
				complete = true;
			} else if (!complete && depth > chosenDepth) chosenDepth = depth;
		}
		const cycle = byDepth.get(chosenDepth) ?? new Map<number, RawLine>();
		const lines: EvalLine[] = [...cycle.values()]
			.map((raw) => {
				const line: EvalLine = {
					multipv: raw.multipv,
					depth: raw.depth,
					score: raw.score,
					pvUci: raw.pv,
					pvSan: pvToSan(spec.fen, raw.pv),
				};
				if (raw.wdl) line.wdl = raw.wdl;
				return line;
			})
			.sort((a, b) => compareLines(a, b) || a.multipv - b.multipv)
			.map((line, i) => ({ ...line, multipv: i + 1 }));
		const bestmove = parseBestmove(bestLine)?.bestmove ?? null;
		return { lines, bestmove, depth: Math.max(0, chosenDepth), complete, elapsedMs };
	};

	return {
		search(spec) {
			const next = chain.then(() => runSearch(spec));
			chain = next.catch(() => undefined);
			return next;
		},
		dispose() {
			try {
				send("quit");
			} catch {
				/* already gone */
			}
		},
	};
}
