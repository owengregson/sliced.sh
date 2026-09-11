import { describe, expect, it } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENGINE_DIR, ENGINE_FILES, ENGINE_NNUE_SOURCES } from "@core/constants/engine-files";
import { LIMITS } from "@core/constants/limits";
import { NnueStore } from "@offscreen/nnue-store";
import {
	type BootedEngine,
	bootEngineDetailed,
	type StockfishFactory,
} from "@offscreen/stockfish-loader";
import { writeBundledNnue } from "../../scripts/nnue-assets";

const ROOT = path.resolve(import.meta.dir, "../..");

describe("Stockfish 18 full (real packaged NNUE and wasm)", () => {
	it.skipIf(typeof SharedArrayBuffer === "undefined")(
		"boots and searches using installed raw networks with no cache or download relay",
		async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "sliced-full-engine-"));
			let engine: BootedEngine | undefined;
			const errors: string[] = [];
			const lines: string[] = [];
			const reads: string[] = [];
			const requests: string[] = [];
			const waiters: Array<{ match: (line: string) => boolean; accept: (line: string) => void }> = [];
			try {
				const installed = path.join(dir, ENGINE_DIR);
				await writeBundledNnue(
					path.join(ROOT, ENGINE_DIR),
					installed,
					ENGINE_NNUE_SOURCES.filter((spec) => spec.name !== ENGINE_FILES.smallnet.nnue)
				);
				for (const name of [ENGINE_FILES.full.js, ENGINE_FILES.full.wasm])
					await copyFile(path.join(ROOT, ENGINE_DIR, name), path.join(installed, name));
				expect((await readdir(installed)).some((name) => name.endsWith(".gz"))).toBe(false);
				const getUrl = (file: string) => pathToFileURL(path.join(dir, file)).href;
				const store = new NnueStore({
					getUrl,
					fetch: async (url) => {
						reads.push(url);
						const file = Bun.file(fileURLToPath(url));
						return { ok: await file.exists(), arrayBuffer: () => file.arrayBuffer() };
					},
					post: (message) => {
						requests.push(message.kind);
						throw new Error("Packaged NNUE must not require the download relay");
					},
					opfs: null,
					indexedDb: null,
				});
				engine = await bootEngineDetailed("full", {
					crossOriginIsolated: true,
					getUrl,
					importModule: (url) => import(url) as Promise<{ default: StockfishFactory }>,
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
				expect(lines).toContain(
					`option name UCI_Elo type spin default ${LIMITS.engineEloMin} min ${LIMITS.engineEloMin} max ${LIMITS.engineEloMax}`
				);
				sf.uci("setoption name UCI_LimitStrength value false");
				await command("isready", (line) => line === "readyok");
				sf.uci("position startpos");
				const best = await command("go depth 8", (line) => line.startsWith("bestmove "));
				expect(best).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/);
				expect(lines.some((line) => /^info depth 8 /.test(line))).toBe(true);
				expect(engine.nnue).toEqual([...ENGINE_FILES.full.nnue]);
				expect(reads).toEqual(ENGINE_FILES.full.nnue.map((name) => getUrl(ENGINE_DIR + name)));
				expect(requests).toEqual([]);
				expect(errors).toEqual([]);
			} finally {
				engine?.sf.uci("quit");
				await rm(dir, { recursive: true, force: true });
			}
		},
		25_000
	);
});
