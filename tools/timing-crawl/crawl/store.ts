/**
 * tools/timing-crawl/crawl/store.ts — `games.jsonl` and `moves.jsonl`: replaying them into the
 * ledger on start (after trimming a torn last line and regenerating `moves.jsonl` lines missing
 * for stored games), and appending admitted games a month at a time so one append carries whole
 * lines.
 */

import { appendFileSync } from "node:fs";
import type { StoredGame } from "../../calibration/common";
import { readJsonlSync } from "../../lib/jsonl";
import {
	type Colour,
	type Ledger,
	movesRecord,
	qualifyStored,
	type TimingGame,
	timingGame,
} from "../policy";
import { dropTornTail } from "./files";

export class GameStore {
	readonly moveUuids = new Set<string>();
	private pendingGames: string[] = [];
	private pendingMoves: string[] = [];

	constructor(private readonly paths: { games: string; moves: string }) {}

	/** Book every stored game into `ledger`; returns how many `moves.jsonl` lines were regenerated. */
	replay(ledger: Ledger): number {
		dropTornTail(this.paths.games);
		dropTornTail(this.paths.moves);
		for (const m of readJsonlSync<{ uuid: string }>(this.paths.moves)) this.moveUuids.add(m.uuid);
		let regenerated = 0;
		for (const g of readJsonlSync<TimingGame>(this.paths.games)) {
			if (ledger.seen(g.uuid, g.url)) continue;
			ledger.record(g, { w: g.whiteKept, b: g.blackKept });
			if (!this.moveUuids.has(g.uuid)) {
				const prof = qualifyStored(g);
				if (prof) {
					appendFileSync(this.paths.moves, `${JSON.stringify(movesRecord(g, prof))}\n`);
					this.moveUuids.add(g.uuid);
					regenerated++;
				}
			}
		}
		return regenerated;
	}

	/** Buffer an admitted game (and its moves line) until the next `flush`. */
	store(g: StoredGame, prof: ReturnType<typeof qualifyStored>, kept: Record<Colour, boolean>): void {
		if (!prof) return;
		const tg = timingGame(g, prof.san.length, kept);
		this.pendingGames.push(`${JSON.stringify(tg)}\n`);
		this.pendingMoves.push(`${JSON.stringify(movesRecord(tg, prof))}\n`);
		this.moveUuids.add(g.uuid);
	}

	flush(): void {
		if (this.pendingGames.length === 0) return;
		appendFileSync(this.paths.games, this.pendingGames.join(""));
		appendFileSync(this.paths.moves, this.pendingMoves.join(""));
		this.pendingGames = [];
		this.pendingMoves = [];
	}
}
