/**
 * tools/timing-crawl/crawl/visit.ts — one visit: a player's archive list, then a random selection
 * of in-window months (all of them for scarce bands). In each month the player's own sides are
 * rationed (`monthQuota`) and the opponents' sides are kept whenever they are eligible, up to the
 * visit's harvest per cell spread over its months, so no cell is filled by the opponents of a
 * handful of players. Every opponent seen is filed as a candidate.
 */

import { TIME_CLASSES, type TimeClass } from "../../calibration/common";
import {
	archiveMonth,
	bandFor,
	type Colour,
	cellOf,
	maxMonthsFor,
	monthQuota,
	parseCell,
	prefilter,
	qualifyArchive,
	type RawGame,
	shuffle,
} from "../policy";
import { API } from "./http";
import type { Crawl } from "./state";

/** One month of a visited player; returns kept sides gained per cell. */
export function processMonth(
	c: Crawl,
	body: unknown,
	player: string,
	monthsLeft: number,
	harvested: Map<string, number>
): Map<string, number> {
	const gains = new Map<string, number>();
	/** Opponent sides still allowed this month per cell (the visit's harvest spread over its months). */
	const oppLeft = new Map<string, number>();
	const oppAllowed = (cell: string): number => {
		let n = oppLeft.get(cell);
		if (n === undefined) {
			n = monthQuota(c.args.harvest - (harvested.get(cell) ?? 0), monthsLeft);
			oppLeft.set(cell, n);
		}
		return n;
	};
	const raw = ((body as { games?: RawGame[] } | null)?.games ?? []).filter(prefilter);
	const quota: Record<TimeClass, number> = { bullet: 0, blitz: 0, rapid: 0 };
	for (const tc of TIME_CLASSES) quota[tc] = monthQuota(c.ledger.room(player, tc), monthsLeft);
	const taken: Record<TimeClass, number> = { bullet: 0, blitz: 0, rapid: 0 };
	for (const g of raw) {
		for (const s of [g.white, g.black]) {
			if (s?.username && Number(s.rating) > 0)
				c.frontier.note(s.username, g.time_class, Number(s.rating));
		}
	}
	for (const g of shuffle(raw, c.random)) {
		if (c.ledger.seen(g.uuid, g.url)) continue;
		const tc = g.time_class;
		const want: Record<Colour, boolean> = { w: false, b: false };
		let own: Colour | null = null;
		for (const colour of ["w", "b"] as const) {
			const s = colour === "w" ? g.white : g.black;
			const name = s?.username?.toLowerCase();
			const rating = Number(s?.rating);
			if (!name || !(rating > 0)) continue;
			const ok = c.ledger.eligible(name, tc, rating);
			if (name === player) {
				own = colour;
				want[colour] = ok && taken[tc] < quota[tc];
			} else {
				const band = bandFor(rating);
				want[colour] = ok && band !== null && oppAllowed(cellOf(tc, band)) > 0;
			}
		}
		if (!want.w && !want.b) continue;
		const q = qualifyArchive(g);
		if (!q) continue;
		const kept = c.ledger.admit(q.game, want);
		if (!kept) continue;
		if (own && kept[own]) taken[tc]++;
		c.store.store(q.game, q.prof, kept);
		for (const colour of ["w", "b"] as const) {
			if (!kept[colour]) continue;
			const band = bandFor((colour === "w" ? q.game.white : q.game.black).rating);
			if (band === null) continue;
			const cell = cellOf(tc, band);
			gains.set(cell, (gains.get(cell) ?? 0) + 1);
			if (colour !== own) {
				oppLeft.set(cell, (oppLeft.get(cell) ?? 0) - 1);
				harvested.set(cell, (harvested.get(cell) ?? 0) + 1);
			}
		}
	}
	c.store.flush();
	return gains;
}

/** Visit a player picked for `cell`; returns kept sides gained per cell. */
export async function visit(
	c: Crawl,
	name: string,
	cell: string
): Promise<{ gains: Map<string, number>; months: number }> {
	const gains = new Map<string, number>();
	const list = (await c.http.get(`${API}/player/${encodeURIComponent(name)}/games/archives`)) as {
		archives?: string[];
	} | null;
	c.frontier.visited.add(name);
	const months = shuffle(
		(list?.archives ?? []).filter((u) => archiveMonth(u) !== null),
		c.random
	);
	const planned = Math.min(
		months.length,
		maxMonthsFor(parseCell(cell).band, c.args.scarceFrom, c.args.fewMonths)
	);
	let fetched = 0;
	const harvested = new Map<string, number>();
	for (let i = 0; i < planned; i++) {
		if (TIME_CLASSES.every((tc) => c.ledger.room(name, tc) <= 0)) break;
		const body = await c.http.get(months[i] as string);
		fetched++;
		for (const [cl, n] of processMonth(c, body, name, planned - i, harvested)) {
			gains.set(cl, (gains.get(cl) ?? 0) + n);
		}
	}
	return { gains, months: fetched };
}
