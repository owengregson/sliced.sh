/**
 * tools/timing-crawl/crawl/frontier.ts — the players the crawl may visit next: every opponent seen
 * is filed as a candidate under the cell of the rating it had in that game (while that cell is
 * open and the player has room), in a reservoir-capped list per cell; a visit pops a random one.
 */

import type { TimeClass } from "../../calibration/common";
import { ALL_CELLS, bandFor, cellOf, type Ledger, parseCell } from "../policy";

export class Frontier {
	readonly visited = new Set<string>();
	readonly candidates = new Map<string, string[]>();
	readonly inCell = new Map<string, Set<string>>();

	constructor(
		private readonly ledger: Ledger,
		private readonly limits: { candCap: number; cellCap: number },
		private readonly random: () => number
	) {
		for (const c of ALL_CELLS) {
			this.candidates.set(c, []);
			this.inCell.set(c, new Set());
		}
	}

	/** File a candidate under a cell (reservoir-capped). */
	file(cell: string, name: string): void {
		const set = this.inCell.get(cell);
		const list = this.candidates.get(cell);
		if (!set || !list || set.has(name) || this.visited.has(name)) return;
		if (list.length < this.limits.candCap) {
			list.push(name);
			set.add(name);
			return;
		}
		const i = Math.floor(this.random() * list.length);
		set.delete(list[i] as string);
		list[i] = name;
		set.add(name);
	}

	/** File a player seen with this rating in this time class, when that could yield a side. */
	note(username: string, tc: TimeClass, rating: number): void {
		const name = username.toLowerCase();
		if (this.visited.has(name)) return;
		const band = bandFor(rating);
		if (band === null) return;
		const cell = cellOf(tc, band);
		if (this.ledger.fill(cell) >= this.limits.cellCap || this.ledger.room(name, tc) <= 0) return;
		this.file(cell, name);
	}

	/** Pop a random candidate for a cell, validated; null when the cell has none. */
	pop(cell: string): string | null {
		const list = this.candidates.get(cell);
		const set = this.inCell.get(cell);
		if (!list || !set) return null;
		const { tc } = parseCell(cell);
		while (list.length > 0) {
			const i = Math.floor(this.random() * list.length);
			const name = list[i] as string;
			list[i] = list[list.length - 1] as string;
			list.pop();
			set.delete(name);
			if (this.visited.has(name) || this.ledger.room(name, tc) <= 0) continue;
			return name;
		}
		return null;
	}

	size(cell: string): number {
		return this.candidates.get(cell)?.length ?? 0;
	}
}
