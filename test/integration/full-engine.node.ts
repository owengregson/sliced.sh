import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NnueStore } from "@offscreen/nnue-store";
import { type BootedEngine, bootEngineDetailed } from "@offscreen/stockfish-loader";

export interface FullEngineReport {
	runtime: string;
	module: string;
	nnue: string[];
	lines: string[];
	reads: string[];
	requests: string[];
	errors: string[];
	best: string;
}

const [installedRoot, reportFile] = process.argv.slice(2);
if (!installedRoot || !reportFile) throw new Error("Expected installed asset root and report file");
if (process.versions.bun) throw new Error("The full-engine fixture requires Node/V8, not Bun");

const errors: string[] = [];
const lines: string[] = [];
const reads: string[] = [];
const requests: string[] = [];
const waiters: Array<{ match: (line: string) => boolean; accept: (line: string) => void }> = [];
const getUrl = (file: string) => {
	const absolutePath = path.join(installedRoot, file);
	// Node's Worker constructor requires a filesystem path for a string entrypoint.
	return /\.(js|wasm)$/.test(file) ? absolutePath : pathToFileURL(absolutePath).href;
};
const store = new NnueStore({
	getUrl,
	fetch: async (url) => {
		reads.push(url);
		const data = await readFile(fileURLToPath(url));
		return {
			ok: true,
			arrayBuffer: async () =>
				data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
		};
	},
	post: (message) => {
		requests.push(message.kind);
		throw new Error("Packaged NNUE must not require the download relay");
	},
	opfs: null,
	indexedDb: null,
});

let engine: BootedEngine | undefined;
try {
	engine = await bootEngineDetailed("full", {
		crossOriginIsolated: typeof SharedArrayBuffer !== "undefined",
		getUrl,
		nnueStore: store,
		listen: (line) => {
			lines.push(line);
			for (const waiter of [...waiters]) {
				if (!waiter.match(line)) continue;
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.accept(line);
			}
		},
		onError: (error) => errors.push(error),
	});
	const sf = engine.sf;
	const command = (text: string, match: (line: string) => boolean) =>
		new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`No response: ${text}`)), 10_000);
			waiters.push({
				match,
				accept: (line) => {
					clearTimeout(timer);
					resolve(line);
				},
			});
			sf.uci(text);
		});
	await command("uci", (line) => line === "uciok");
	sf.uci("setoption name UCI_LimitStrength value false");
	await command("isready", (line) => line === "readyok");
	sf.uci("position startpos");
	const best = await command("go depth 8", (line) => line.startsWith("bestmove "));
	const report: FullEngineReport = {
		runtime: "node",
		module: engine.module,
		nnue: engine.nnue,
		lines,
		reads,
		requests,
		errors,
		best,
	};
	await writeFile(reportFile, JSON.stringify(report));
} finally {
	engine?.sf.uci("quit");
}
