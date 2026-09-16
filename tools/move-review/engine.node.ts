/** Node/V8 worker for the exact shipped relaxed-SIMD full engine; JSON lines over stdin/stdout. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import { ENGINE_DIR, ENGINE_FILES } from "@core/constants/engine-files";
import { parseBestmove, parseInfo } from "@core/engine/uci-parser";
import { bootEngineDetailed } from "@offscreen/stockfish-loader";
import type { EvalLine } from "@typedefs/engine";
import { Chess } from "chess.js";
import type { SearchSpec } from "../human-match/engine";

const [root, threadsText, hashText] = process.argv.slice(2);
if (!root || process.versions.bun) throw new Error("Requires Node/V8 and a repository root");
const listeners = new Set<(line: string) => void>();
const errors: string[] = [];
let version = "";
const networks: Record<string, string> = {};
const boot = await bootEngineDetailed("full", {
	crossOriginIsolated: true,
	getUrl: (file) => path.join(root, file),
	nnueStore: {
		get: async (name) => {
			const file = path.join(root, ENGINE_DIR, name);
			const bytes = await readFile(file).catch(() => readFile(`${file}.gz`).then(gunzipSync));
			const sha = createHash("sha256").update(bytes).digest("hex");
			if (!name.includes(sha.slice(0, 12))) throw new Error(`NNUE checksum mismatch: ${name}`);
			networks[name] = sha;
			return bytes;
		},
	},
	listen: (line) => {
		if (line.startsWith("id name ")) version = line.slice(8);
		for (const listener of listeners) listener(line);
	},
	onError: (message) => errors.push(message),
});
const sf = boot.sf;
const command = (text: string, accept: (line: string) => boolean, timeout = 15_000) =>
	new Promise<string>((resolve, reject) => {
		const listener = (line: string) => {
			if (!accept(line)) return;
			clearTimeout(timer);
			listeners.delete(listener);
			resolve(line);
		};
		const timer = setTimeout(() => {
			listeners.delete(listener);
			reject(new Error(`Engine timeout: ${text}; ${errors.join("; ")}`));
		}, timeout);
		listeners.add(listener);
		sf.uci(text);
	});
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
await command("uci", (line) => line === "uciok");
sf.uci(`setoption name Threads value ${Number(threadsText)}`);
sf.uci(`setoption name Hash value ${Number(hashText)}`);
sf.uci("setoption name UCI_LimitStrength value false");
sf.uci("setoption name Skill Level value 20");
sf.uci("setoption name UCI_ShowWDL value true");
await command("isready", (line) => line === "readyok");
emit({
	provenance: {
		version,
		module: boot.module,
		networks,
		variant: "full",
		limitedStrength: false,
		wasmSha256: createHash("sha256")
			.update(await readFile(path.join(root, ENGINE_DIR, ENGINE_FILES.full.wasm)))
			.digest("hex"),
		runtime: process.version,
		threads: Number(threadsText),
		hashMb: Number(hashText),
	},
});
try {
	for await (const row of createInterface({ input: process.stdin })) {
		const spec = JSON.parse(row) as SearchSpec | { newGame: true };
		if ("newGame" in spec) {
			sf.uci("ucinewgame");
			await command("isready", (line) => line === "readyok");
			emit({ ready: true });
			continue;
		}
		const board = new Chess(spec.fen);
		for (const move of spec.moves ?? []) board.move(move);
		const expected = Math.min(spec.multiPv, spec.searchmoves?.length ?? board.moves().length);
		const cycles = new Map<number, Map<number, EvalLine>>();
		const collect = (line: string) => {
			const info = parseInfo(line);
			if (!info?.depth || !info.score || info.score.bound || !info.pv?.length) return;
			const rank = info.multipv ?? 1;
			const cycle = cycles.get(info.depth) ?? new Map<number, EvalLine>();
			cycles.set(info.depth, cycle);
			cycle.set(rank, {
				multipv: rank,
				depth: info.depth,
				score: info.score.type === "mate" ? { mate: info.score.value } : { cp: info.score.value },
				pvUci: info.pv,
				pvSan: [],
				...(info.wdl ? { wdl: info.wdl } : {}),
			});
		};
		sf.uci(`setoption name MultiPV value ${spec.multiPv}`);
		await command("isready", (line) => line === "readyok");
		sf.uci(`position fen ${spec.fen}${spec.moves?.length ? ` moves ${spec.moves.join(" ")}` : ""}`);
		listeners.add(collect);
		const started = performance.now();
		const best = await command(
			`go movetime ${spec.movetimeMs}${spec.depth ? ` depth ${spec.depth}` : ""}${spec.searchmoves?.length ? ` searchmoves ${spec.searchmoves.join(" ")}` : ""}`,
			(line) => line.startsWith("bestmove "),
			spec.movetimeMs + 30_000
		);
		listeners.delete(collect);
		const complete = [...cycles.entries()]
			.filter(([, cycle]) => cycle.size === expected)
			.sort(([a], [b]) => b - a)[0];
		emit({
			depth: complete?.[0] ?? 0,
			complete: !!complete,
			lines: [...(complete?.[1].values() ?? [])],
			bestmove: parseBestmove(best)?.bestmove ?? null,
			elapsedMs: performance.now() - started,
		});
	}
} finally {
	sf.uci("quit");
}
