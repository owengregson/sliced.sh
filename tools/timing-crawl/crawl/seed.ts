/**
 * tools/timing-crawl/crawl/seed.ts — the frontier's first candidates, each taken once per crawl:
 * the live leaderboards and the titled-player lists (filed at a title's typical rating), and the
 * calibration corpus' qualifying games (stored, and their players filed).
 */

import path from "node:path";
import { type StoredGame, TIME_CLASSES, type TimeClass } from "../../calibration/common";
import { readJsonlSync } from "../../lib/jsonl";
import { qualifyStored } from "../policy";
import { API } from "./http";
import { log } from "./log";
import { saveCrawl } from "./persist";
import type { Crawl } from "./state";

const TITLES: Record<string, number> = {
	GM: 2600,
	IM: 2400,
	WGM: 2300,
	FM: 2300,
	WIM: 2200,
	CM: 2200,
	NM: 2200,
	WFM: 2000,
	WCM: 1900,
	WNM: 1900,
};
const LEADERBOARDS: Record<string, TimeClass> = {
	live_bullet: "bullet",
	live_blitz: "blitz",
	live_rapid: "rapid",
};

export async function seedFrontier(c: Crawl): Promise<void> {
	if (c.seeded) return;
	const lb = ((await c.http.get(`${API}/leaderboards`)) ?? {}) as Record<
		string,
		Array<{ username?: string; score?: number }>
	>;
	for (const [board, tc] of Object.entries(LEADERBOARDS)) {
		for (const p of lb[board] ?? [])
			if (p.username && p.score) c.frontier.note(p.username, tc, p.score);
	}
	for (const [title, guess] of Object.entries(TITLES)) {
		const res = (await c.http.get(`${API}/titled/${title}`)) as { players?: string[] } | null;
		const names = res?.players ?? [];
		for (const n of names) for (const tc of TIME_CLASSES) c.frontier.note(n, tc, guess);
		log(`seed ${title}: ${names.length} players`);
	}
	c.seeded = true;
	saveCrawl(c);
}

/** Take the calibration corpus' qualifying games and file its players. */
export function ingestCalibration(c: Crawl): void {
	if (c.ingested) return;
	const file = path.join(c.args.calib, "games.jsonl");
	let n = 0;
	let kept = 0;
	for (const g of readJsonlSync<StoredGame>(file)) {
		n++;
		c.frontier.note(g.white.username, g.time_class, g.white.rating);
		c.frontier.note(g.black.username, g.time_class, g.black.rating);
		if (c.ledger.seen(g.uuid, g.url)) continue;
		const prof = qualifyStored(g);
		if (!prof) continue;
		const k = c.ledger.admit(g, { w: true, b: true });
		if (!k) continue;
		c.store.store(g, prof, k);
		kept++;
	}
	c.store.flush();
	c.ingested = true;
	saveCrawl(c);
	log(`ingested ${kept} of ${n} calibration games`);
}
