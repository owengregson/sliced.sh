/**
 * tools/lib/engine/referee.ts — the vendored Stockfish 19 as a referee under Bun.
 *
 * Boots `sf_19_smallnet` through the offscreen loader exactly as `test/integration/engine.test.ts`
 * does (the Emscripten glue takes its Node code path — pthreads on `node:worker_threads` — which
 * Bun supports), then answers one `go` at a time and returns the **last complete MultiPV cycle**
 * as `EvalLine[]` — the same collection rule the `stockfish18-*.json` fixtures were captured with.
 * Nothing here runs in the extension.
 */

import "../defines";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pvToSan } from "@core/chess/san";
import { ENGINE_DIR, ENGINE_FILES } from "@core/constants/engine-files";
import { parseBestmove, parseInfo } from "@core/engine/uci-parser";
import { __setLogSinkOutsideServiceWorker, printLog, setLogLevel, setLogSink } from "@core/logger";
import { compareLines } from "@core/strength/quality";
import { bootEngine, type StockfishFactory } from "@offscreen/stockfish-loader";
import type { EvalLine } from "@typedefs/engine";
import { ROOT } from "../paths";
import type { RefereeEngine, RefereeOptions, SearchFrame, SearchSpec } from "./types";
import { evalScoreOf, goCommand, LineHub, positionCommand } from "./uci";

// Route `log.*` from the loaders to this process's console (there is no service worker here).
__setLogSinkOutsideServiceWorker(true);
setLogSink(printLog);
setLogLevel("warn");

interface RawLine {
	multipv: number;
	depth: number;
	score: EvalLine["score"];
	pv: string[];
	wdl?: [number, number, number];
}

/**
 * The loader's `getUrl` for a variant. `full` maps the registry's relaxed-SIMD module names onto
 * the npm package's plain-SIMD `sf_19` program, which Bun's JavaScriptCore accepts.
 */
function engineUrl(variant: RefereeOptions["variant"]): (p: string) => string {
	const plainFull: Readonly<Record<string, string>> = {
		[ENGINE_FILES.full.js]: "sf_19.js",
		[ENGINE_FILES.full.wasm]: "sf_19.wasm",
		// The plain glue asks locateFile for its own name, not the registry's relaxed-SIMD name.
		"sf_19.wasm": "sf_19.wasm",
	};
	return (p) => {
		const plain = variant === "full" ? plainFull[path.basename(p)] : undefined;
		return plain === undefined
			? pathToFileURL(path.join(ROOT, p)).href
			: pathToFileURL(path.join(ROOT, "node_modules", "@lichess-org", "stockfish-web", plain)).href;
	};
}

/** A network from the checkout; the big net is committed gzipped and expanded here. */
async function readNetwork(name: string): Promise<Uint8Array> {
	const raw = Bun.file(path.join(ROOT, ENGINE_DIR, name));
	if (await raw.exists()) return new Uint8Array(await raw.arrayBuffer());
	// The big net is committed gzipped (`ENGINE_NNUE_SOURCES`); the build expands it.
	const packed = await Bun.file(path.join(ROOT, ENGINE_DIR, `${name}.gz`)).arrayBuffer();
	return Bun.gunzipSync(new Uint8Array(packed));
}

/**
 * The cycle a search answers with: the deepest one that reported every root, else the deepest
 * one at all (`complete` false).
 */
function chooseCycle(
	byDepth: ReadonlyMap<number, Map<number, RawLine>>,
	expected: number
): { depth: number; complete: boolean } {
	let chosenDepth = -1;
	let complete = false;
	for (const [depth, cycle] of byDepth) {
		const full = cycle.size >= expected;
		if (full && (!complete || depth > chosenDepth)) {
			chosenDepth = depth;
			complete = true;
		} else if (!complete && depth > chosenDepth) chosenDepth = depth;
	}
	return { depth: chosenDepth, complete };
}

export async function createRefereeEngine(options: RefereeOptions = {}): Promise<RefereeEngine> {
	if (typeof SharedArrayBuffer === "undefined")
		throw new Error("SharedArrayBuffer is unavailable in this runtime");
	const listeners = new LineHub();
	const errors: string[] = [];
	const variant = options.variant ?? "smallnet";
	const sf = await bootEngine(variant, {
		crossOriginIsolated: true,
		getUrl: engineUrl(variant),
		...(variant === "full" ? { wasmValidate: () => true } : {}),
		importModule: (url) => import(url) as Promise<{ default: StockfishFactory }>,
		nnueStore: { get: readNetwork },
		listen: listeners.dispatch,
		onError: (msg) => errors.push(msg),
	});

	const waitFor = (predicate: (line: string) => boolean, timeoutMs: number): Promise<string> =>
		listeners.waitFor(
			predicate,
			timeoutMs,
			() => new Error(`engine timed out after ${timeoutMs} ms; stderr: ${errors.join(" | ")}`)
		);

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
		if (options.newGameEachSearch !== false) send("ucinewgame");
		send("isready");
		await waitFor((l) => l === "readyok", 10_000);
		send(positionCommand(spec.fen, spec.moves));

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
				score: evalScoreOf(info.score),
				pv: info.pv,
			};
			if (info.wdl) raw.wdl = info.wdl;
			cycle.set(info.multipv, raw);
		};
		listeners.add(collect);
		const started = performance.now();
		send(goCommand(spec));
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
		const { depth: chosenDepth, complete } = chooseCycle(byDepth, expected);
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
		newGame() {
			chain = chain.then(async () => {
				send("ucinewgame");
				send("isready");
				await waitFor((l) => l === "readyok", 10_000);
			});
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
