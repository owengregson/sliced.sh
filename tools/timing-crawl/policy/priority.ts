/**
 * tools/timing-crawl/policy/priority.ts — what the crawl works on next: the cell order, how many
 * months a visit fetches and how a player's own sides are rationed over them, when a cell is
 * parked, and the seeded randomness behind the picks.
 */

import { ALL_CELLS } from "./cells";

/**
 * Cells in the order the crawl should work on them: open cells (below `cellCap`) that are not
 * parked, by fill / target ascending (the most under-filled first), ties by a random key.
 */
export function rankCells(
	fills: ReadonlyMap<string, number>,
	target: number,
	cellCap: number,
	parked: ReadonlySet<string>,
	random: () => number
): string[] {
	return ALL_CELLS.filter((c) => (fills.get(c) ?? 0) < cellCap && !parked.has(c))
		.map((c) => ({ c, r: (fills.get(c) ?? 0) / target, k: random() }))
		.sort((a, b) => a.r - b.r || a.k - b.k)
		.map((x) => x.c);
}

/** Months of a visited player to fetch at most: scarce (high) bands get the whole window. */
export function maxMonthsFor(band: number, scarceFrom = 2000, few = 3): number {
	return band >= scarceFrom ? 12 : few;
}

/** Own sides to take from the next month so the rest of the room spreads over the remaining months. */
export function monthQuota(room: number, monthsLeft: number): number {
	if (room <= 0) return 0;
	return Math.ceil(room / Math.max(1, monthsLeft));
}

/** Deterministic PRNG (mulberry32). */
export { mulberry32 as rng } from "../../lib/random";

export function shuffle<T>(xs: T[], random: () => number): T[] {
	for (let i = xs.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const t = xs[i] as T;
		xs[i] = xs[j] as T;
		xs[j] = t;
	}
	return xs;
}

export interface VisitYield {
	/** Kept sides the visit added to the cell it was made for. */
	gain: number;
	/** Network requests it cost (cache hits are free). */
	requests: number;
}

/**
 * Park a cell for the rest of the run once its last `window` focused visits added fewer than
 * `minYield` kept sides per network request between them (a scarce population, or one already
 * harvested). A cache-only window never parks.
 */
export function shouldPark(
	recent: readonly VisitYield[],
	window: number,
	minYield: number
): boolean {
	if (recent.length < window) return false;
	let gain = 0;
	let requests = 0;
	for (const v of recent.slice(-window)) {
		gain += v.gain;
		requests += v.requests;
	}
	return requests > 0 && gain < minYield * requests;
}
