/** Anonymized complete-game timing replay corpus with real Stockfish decision features. */
import "../human-match/defines";
import path from "node:path";
import { ENGINE_DIR } from "@core/constants/engine-files";
import type { EngineTransport } from "@core/engine/types";
import { UciEngine } from "@core/engine/uci-client";
import { bootEngine, type StockfishFactory } from "@offscreen/stockfish-loader";
import type { EvalLine } from "@typedefs/engine";
import { Chess } from "chess.js";
import { BUN_WASM_VALIDATE, bunEngineUrl } from "../../test/integration/engine-under-bun";
import { parseGames } from "../pgn-clock-reference";

const root = path.resolve(import.meta.dir, "../..");
const input = process.argv[2];
if (!input) throw new Error("Usage: bun tools/timing/build-pgn-corpus.ts <pgn> [output]");
const source = await Bun.file(input).text();
const chunks = source
	.replace(/\r\n?/g, "\n")
	.split(/(?=^\[Event )/m)
	.filter((s) => s.trim());
const parsed = parseGames(source);
const selected = parsed
	.map((game, index) => ({ game, index }))
	.filter(({ game }) => {
		const color = game.headers.White === "gc_elif" ? "White" : "Black";
		return (
			Number(game.headers[`${color}Elo`]) >= 2400 &&
			game.headers.TimeControl === "180" &&
			game.clocksAfterPly.length >= 60
		);
	})
	.slice(-8);
const listeners = new Set<(line: string) => void>();
const sf = await bootEngine("smallnet", {
	crossOriginIsolated: true,
	wasmValidate: BUN_WASM_VALIDATE,
	getUrl: (file) => bunEngineUrl(root, file),
	importModule: (url) => import(url) as Promise<{ default: StockfishFactory }>,
	nnueStore: {
		get: async (name) =>
			new Uint8Array(await Bun.file(path.join(root, ENGINE_DIR, name)).arrayBuffer()),
	},
	listen: (line) => {
		for (const listener of listeners) listener(line);
	},
	onError: (message) => {
		throw new Error(message);
	},
});
const transport: EngineTransport = {
	send: (line) => sf.uci(line),
	onLine: (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	onStatus: () => () => {},
	restart: async () => {
		throw new Error("Unexpected restart");
	},
};
const engine = new UciEngine(transport);
const games: Array<{
	id: number;
	myColor: "w" | "b";
	baseSec: number;
	incSec: number;
	plies: Array<{ uci: string; clockAfterS: number; lines?: EvalLine[] }>;
}> = [];
try {
	await engine.init();
	await engine.setOptions({ Threads: 1, Hash: 32, UCI_LimitStrength: false, UCI_ShowWDL: true });
	for (const { game, index } of selected) {
		const board = new Chess();
		board.loadPgn(chunks[index] ?? "");
		const history = board.history({ verbose: true });
		if (history.length !== game.clocksAfterPly.length)
			throw new Error(`Clock alignment failed game ${index}`);
		const myColor = game.headers.White === "gc_elif" ? "w" : "b";
		const plies: Array<{ uci: string; clockAfterS: number; lines?: EvalLine[] }> = [];
		for (const [ply, move] of history.entries()) {
			const record: (typeof plies)[number] = {
				uci: `${move.from}${move.to}${move.promotion ?? ""}`,
				clockAfterS: game.clocksAfterPly[ply] ?? 0,
			};
			if (move.color === myColor) {
				const count = new Chess(move.before).moves().length;
				const result = await engine.analyse({
					id: `${index}-${ply}`,
					fen: history[0]?.before ?? move.before,
					moves: plies.map((entry) => entry.uci),
					multiPv: Math.min(6, count),
					limit: { depth: 10, movetimeMs: 80 },
					priority: "move",
				}).result;
				if (!result.final.complete || !result.final.lines.length)
					throw new Error(`Missing coherent frame ${index}:${ply}`);
				record.lines = result.final.lines.map(({ multipv, score, depth, pvUci }) => ({
					multipv,
					score,
					depth,
					pvUci: pvUci.slice(0, 2),
					pvSan: [],
				}));
			}
			plies.push(record);
		}
		games.push({ id: games.length + 1, myColor, baseSec: 180, incSec: 0, plies });
		process.stdout.write(`Annotated game ${games.length}: ${plies.length} plies\n`);
	}
	const out = process.argv[3] ?? path.join(root, "test/fixtures/timing/pgn-replay.json");
	await Bun.write(
		out,
		JSON.stringify(
			{
				provenance: {
					sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
					selection: "Last eight 3+0 games with gc_elif Elo >=2400 and >=60 plies; identifiers omitted.",
					engine:
						"Stockfish18 smallnet, full strength, MultiPV<=6, depth10/movetime80ms, one thread, full legal history, last coherent frame",
					generator: "tools/timing/build-pgn-corpus.ts",
					note:
						"Retrospective sample, not an independent human timing calibration; clock annotations aligned against full legal history.",
				},
				games,
			},
			null,
			2
		) + "\n"
	);
	process.stdout.write(`Wrote ${out}\n`);
} finally {
	engine.dispose();
	sf.uci("quit");
}
