/**
 * Anonymized complete-game timing replay corpus with real Stockfish decision features.
 *
 *   bun tools/timing/build-pgn-corpus.ts <pgn> [output]
 *
 * The last eight 3+0 games of the owner's export (≥ 2400, ≥ 60 plies) are replayed in full and
 * every one of the owner's positions gets the pipeline's own shallow frame (`UciEngine`, smallnet
 * under Bun) — written to `test/fixtures/timing/pgn-replay.json` by default.
 */
import "../lib/defines";
import path from "node:path";
import { ENGINE_DIR } from "@core/constants/engine-files";
import type { EngineTransport } from "@core/engine/types";
import { UciEngine } from "@core/engine/uci-client";
import type StockfishWeb from "@lichess-org/stockfish-web";
import { bootEngine, type StockfishFactory } from "@offscreen/stockfish-loader";
import type { EvalLine } from "@typedefs/engine";
import { Chess } from "chess.js";
import { BUN_WASM_VALIDATE, bunEngineUrl } from "../../test/integration/engine-under-bun";
import { LineHub } from "../lib/engine/uci";
import { ROOT } from "../lib/paths";
import { type ParsedGame, parseGames } from "../lib/pgn/export";
import { splitAtEventTags } from "../lib/pgn/split";

const ACCOUNT = "gc_elif";

interface CorpusPly {
	uci: string;
	clockAfterS: number;
	lines?: EvalLine[];
}

interface CorpusGame {
	id: number;
	myColor: "w" | "b";
	baseSec: number;
	incSec: number;
	plies: CorpusPly[];
}

/** The last eight 3+0 games with the account at ≥ 2400 and ≥ 60 clocked plies. */
function selectGames(parsed: ParsedGame[]): Array<{ game: ParsedGame; index: number }> {
	return parsed
		.map((game, index) => ({ game, index }))
		.filter(({ game }) => {
			const color = game.headers.White === ACCOUNT ? "White" : "Black";
			return (
				Number(game.headers[`${color}Elo`]) >= 2400 &&
				game.headers.TimeControl === "180" &&
				game.clocksAfterPly.length >= 60
			);
		})
		.slice(-8);
}

/** The smallnet under Bun, as the `EngineTransport` the pipeline's `UciEngine` drives. */
async function bootTransport(): Promise<{ sf: StockfishWeb; transport: EngineTransport }> {
	const listeners = new LineHub();
	const sf = await bootEngine("smallnet", {
		crossOriginIsolated: true,
		wasmValidate: BUN_WASM_VALIDATE,
		getUrl: (file) => bunEngineUrl(ROOT, file),
		importModule: (url) => import(url) as Promise<{ default: StockfishFactory }>,
		nnueStore: {
			get: async (name) =>
				new Uint8Array(await Bun.file(path.join(ROOT, ENGINE_DIR, name)).arrayBuffer()),
		},
		listen: listeners.dispatch,
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
	return { sf, transport };
}

/** Every ply of one game; the account's own positions carry the engine's frame. */
async function annotateGame(
	engine: UciEngine,
	pgn: string,
	game: ParsedGame,
	index: number
): Promise<{ myColor: "w" | "b"; plies: CorpusPly[] }> {
	const board = new Chess();
	board.loadPgn(pgn);
	const history = board.history({ verbose: true });
	if (history.length !== game.clocksAfterPly.length)
		throw new Error(`Clock alignment failed game ${index}`);
	const myColor = game.headers.White === ACCOUNT ? "w" : "b";
	const plies: CorpusPly[] = [];
	for (const [ply, move] of history.entries()) {
		const record: CorpusPly = {
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
	return { myColor, plies };
}

async function main(argv: readonly string[]): Promise<void> {
	const input = argv[2];
	if (!input) throw new Error("Usage: bun tools/timing/build-pgn-corpus.ts <pgn> [output]");
	const source = await Bun.file(input).text();
	const chunks = splitAtEventTags(source);
	const selected = selectGames(parseGames(source));
	const { sf, transport } = await bootTransport();
	const engine = new UciEngine(transport);
	const games: CorpusGame[] = [];
	try {
		await engine.init();
		await engine.setOptions({ Threads: 1, Hash: 32, UCI_LimitStrength: false, UCI_ShowWDL: true });
		for (const { game, index } of selected) {
			const { myColor, plies } = await annotateGame(engine, chunks[index] ?? "", game, index);
			games.push({ id: games.length + 1, myColor, baseSec: 180, incSec: 0, plies });
			process.stdout.write(`Annotated game ${games.length}: ${plies.length} plies\n`);
		}
		const out = argv[3] ?? path.join(ROOT, "test/fixtures/timing/pgn-replay.json");
		await Bun.write(
			out,
			JSON.stringify(
				{
					provenance: {
						sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
						selection:
							"Last eight 3+0 games with gc_elif Elo >=2400 and >=60 plies; identifiers omitted.",
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
}

await main(process.argv);
