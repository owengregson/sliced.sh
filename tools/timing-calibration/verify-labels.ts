/**
 * tools/timing-calibration/verify-labels.ts — check the fast Python corpus (`build_corpus.py`)
 * against the TypeScript reference (`build-corpus.ts`, which uses the shipped book and chess
 * modules) on a sample of games. Every label of every sampled ply must agree.
 *
 *     bun tools/timing-calibration/verify-labels.ts [--corpus FILE] [--games FILE] [--sample 300]
 */

import "../lib/defines";
import type { StoredGame } from "../calibration/common";
import { flagValue } from "../lib/cli";
import { corpusGame, loadBooks } from "./build-corpus";
import { type CorpusGame, PATHS, readJsonl } from "./common";
import { hash32 } from "./stats";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const corpusFile = flagValue(argv, "corpus", PATHS.corpus) ?? PATHS.corpus;
	const gamesFile = flagValue(argv, "games", PATHS.games) ?? PATHS.games;
	const sample = Number(flagValue(argv, "sample", "300"));
	const books = await loadBooks();
	const wanted = new Map<string, CorpusGame>();
	for await (const g of readJsonl<CorpusGame>(corpusFile)) {
		if (
			hash32(g.gameId) % 1000 < 1000 * Number(flagValue(argv, "rate", "0.05")) &&
			wanted.size < sample
		)
			wanted.set(g.gameId, g);
	}
	let games = 0;
	let plies = 0;
	const mismatches: string[] = [];
	for await (const s of readJsonl<StoredGame>(gamesFile)) {
		const py = wanted.get(s.uuid);
		if (!py) continue;
		wanted.delete(s.uuid);
		const ts = corpusGame(
			{
				uuid: s.uuid,
				tc: s.time_class,
				control: s.time_control,
				white: s.white,
				black: s.black,
				pgn: s.pgn,
			},
			books
		);
		games++;
		if (!ts) {
			mismatches.push(`${s.uuid}: TS produced no game`);
			continue;
		}
		if (ts.ucis.join(" ") !== py.ucis.join(" ")) mismatches.push(`${s.uuid}: moves differ`);
		const byPly = new Map(ts.plies.map((p) => [p.ply, p]));
		for (const p of py.plies) {
			const t = byPly.get(p.ply);
			plies++;
			if (!t) {
				mismatches.push(`${s.uuid}:${p.ply} missing in TS`);
				continue;
			}
			for (const [k, v] of Object.entries(p)) {
				const tv = (t as unknown as Record<string, unknown>)[k];
				const same = typeof v === "number" ? Math.abs(v - Number(tv)) < 1e-9 : v === tv;
				if (!same) mismatches.push(`${s.uuid}:${p.ply} ${k}: py=${v} ts=${String(tv)}`);
			}
		}
		if (wanted.size === 0) break;
	}
	console.log(`${games} games, ${plies} plies compared, ${mismatches.length} mismatches`);
	for (const m of mismatches.slice(0, 40)) console.log(`  ${m}`);
	if (mismatches.length > 0 || games === 0) process.exit(1);
}

await main();
