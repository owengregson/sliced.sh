/**
 * tools/timing-calibration/frames.ts — engine lines for every ply of the replayed games.
 *
 *     bun tools/timing-calibration/frames.ts [--shard k/n] [--depth 8] [--multipv 4]
 *
 * The timing features read the MultiPV lines of the position (reasonable choices, decisiveness,
 * the chosen move's rank and gap, the eval swing), the ponder's expected reply is the best line
 * of the opponent's previous position, and the premove predictions are softmaxes over that
 * position's lines. So every ply of a selected game is searched, both sides: the vendored
 * Stockfish 19 small net (plain-SIMD under Bun), `go depth 8` MultiPV 4, one transposition table
 * per game (`position … moves …`, so repetitions are seen). Depth 8 is about `HUMAN_DEPTH` at
 * 2000–2400 and is what 2 workers can afford; the browser's own searches are deeper, which moves
 * the features little (they read ≥ 40 cp gaps).
 *
 * Output `frames.<k>.jsonl` (resumable: games already present are skipped): per game
 * `{ gameId, depth, plies: [[best-line pv0, pv1] …, lines: [[uci, cp|null, mate|null]…]] }`.
 */

import "../lib/defines";
import { existsSync } from "node:fs";
import path from "node:path";
import type { EvalLine } from "@typedefs/engine";
import { flagValue } from "../lib/cli";
import { createRefereeEngine } from "../lib/engine/referee";
import { type CorpusGame, DATA_DIR, JsonlWriter, PATHS, readJsonl } from "./common";
import { SELECT_PATH, type Selection } from "./select";

/** One ply's lines, compact: `[uci, cp, mate, pv1]` (pv1 = the reply in the line, or ""). */
export type CompactLine = [string, number | null, number | null, string];

export interface GameFrames {
	gameId: string;
	depth: number;
	/** Per ply (index = ply), the lines of the position before that ply. */
	plies: CompactLine[][];
}

export function toEvalLines(lines: readonly CompactLine[], depth: number): EvalLine[] {
	return lines.map(([uci, cp, mate, pv1], i) => {
		const score: EvalLine["score"] = mate !== null ? { mate } : { cp: cp ?? 0 };
		return {
			multipv: i + 1,
			depth,
			score,
			pvUci: pv1 ? [uci, pv1] : [uci],
			pvSan: [],
		};
	});
}

export function framesPath(k: number): string {
	return path.join(DATA_DIR, `frames.${k}.jsonl`);
}

export async function loadFrames(): Promise<Map<string, GameFrames>> {
	const out = new Map<string, GameFrames>();
	for (let k = 0; k < 16; k++) {
		const file = framesPath(k);
		if (!existsSync(file)) continue;
		for await (const f of readJsonl<GameFrames>(file, true)) out.set(f.gameId, f);
	}
	return out;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const [k, n] = (flagValue(argv, "shard", "0/1") ?? "0/1").split("/").map(Number) as [
		number,
		number,
	];
	const depth = Number(flagValue(argv, "depth", "8"));
	const multiPv = Number(flagValue(argv, "multipv", "4"));
	const selection = (await Bun.file(SELECT_PATH).json()) as Selection;
	// Games any shard already searched (an earlier selection) are not searched again.
	const elsewhere = new Set((await loadFrames()).keys());
	const wanted = new Set(
		selection.games.filter((g) => !elsewhere.has(g)).filter((_, i) => i % n === k)
	);
	// `--slot s` names the output file (frames.<s>.jsonl): a later pass writes new slots.
	const out = framesPath(Number(flagValue(argv, "slot", String(k))));
	const done = new Set<string>();
	const previous: string[] = [];
	if (existsSync(out)) {
		for await (const f of readJsonl<GameFrames>(out, true)) {
			done.add(f.gameId);
			previous.push(JSON.stringify(f));
		}
	}
	// Rewrite what exists (a crash mid-line leaves at most one torn record, which the reader skips).
	const writer = new JsonlWriter(out);
	for (const line of previous) writer.write(JSON.parse(line));
	const engine = await createRefereeEngine({ newGameEachSearch: false, hashMb: 16 });
	let games = 0;
	const t0 = performance.now();
	for await (const g of readJsonl<CorpusGame>(PATHS.selectGames)) {
		if (!wanted.has(g.gameId) || done.has(g.gameId)) continue;
		engine.newGame();
		const plies: CompactLine[][] = [];
		for (let ply = 0; ply < g.ucis.length; ply++) {
			const frame = await engine.search({
				fen: g.fens[0] as string,
				moves: g.ucis.slice(0, ply),
				movetimeMs: 5000,
				depth,
				multiPv,
			});
			plies.push(
				frame.lines.map((l) => [
					l.pvUci[0] ?? "",
					l.score.cp ?? null,
					l.score.mate ?? null,
					l.pvUci[1] ?? "",
				])
			);
		}
		writer.write({ gameId: g.gameId, depth, plies } satisfies GameFrames);
		games++;
		if (games % 25 === 0) {
			const rate = games / ((performance.now() - t0) / 1000);
			console.log(`shard ${k}: ${games + done.size}/${wanted.size} games, ${rate.toFixed(2)} games/s`);
		}
	}
	await writer.close();
	engine.dispose();
	console.log(`shard ${k}: done, ${games} new games`);
	process.exit(0);
}

if (import.meta.main) await main();
