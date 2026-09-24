/**
 * tools/timing/distribution-report/human-clocks.ts — matched human think times from PGN exports:
 * the owner's opponents only, each game once, the first two moves excluded, grouped by rating
 * band × time control × clock-fraction band.
 */

import { parseGames, parseTimeControl } from "../../lib/pgn/export";
import { thinksOf } from "../../lib/pgn/thinks";
import { thinkStats } from "./think-stats";

const ACCOUNT = "gc_elif";

function fractionBand(fraction: number): string {
	return fraction > 0.85
		? "1-.85"
		: fraction > 0.55
			? ".85-.55"
			: fraction > 0.25
				? ".55-.25"
				: ".25-0";
}

export async function humanClockGroups(files: readonly string[]) {
	const humans = new Map<string, { games: Set<string>; times: number[] }>();
	const seen = new Set<string>();
	for (const filename of files) {
		for (const game of parseGames(await Bun.file(filename).text())) {
			const key = game.headers.Link ?? JSON.stringify(game);
			if (seen.has(key)) continue;
			seen.add(key);
			const tc = parseTimeControl(game.headers.TimeControl ?? "");
			if (!tc) continue;
			const ours =
				game.headers.White?.toLowerCase() === ACCOUNT
					? 0
					: game.headers.Black?.toLowerCase() === ACCOUNT
						? 1
						: null;
			if (ours === null) continue;
			const side = ours === 0 ? 1 : 0;
			const elo = Number(game.headers[side === 0 ? "WhiteElo" : "BlackElo"]);
			for (const think of thinksOf(game, side, tc.baseSec, tc.incSec)) {
				if (think.moveNo <= 2) continue;
				const band = fractionBand(think.fraction);
				const group = `${Math.floor(elo / 400) * 400}-${Math.floor(elo / 400) * 400 + 399}|${tc.baseSec}+${tc.incSec}|${band}`;
				const row = humans.get(group) ?? { games: new Set<string>(), times: [] };
				row.games.add(key);
				row.times.push(think.thinkS);
				humans.set(group, row);
			}
		}
	}
	return [...humans].map(([group, row]) => ({
		group,
		games: row.games.size,
		...thinkStats(row.times),
	}));
}
