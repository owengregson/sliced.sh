/**
 * tools/calibration/crawl-chesscom/sources.ts — what the crawl reads from chess.com: the seed
 * players (the live leaderboards and the titled lists, each title at a guessed rating until a real
 * game shows otherwise) and one player's visit (the latest one or two in-window monthly archives).
 */

import { MONTH_FIRST, MONTH_LAST, TIME_CLASSES, type TimeClass } from "../common";
import type { Crawl } from "./crawl";

const API = "https://api.chess.com/pub";
/** Seed titles and the rating each is assumed to hold until a real game shows otherwise. */
const TITLE_GUESS: Record<string, number> = {
	GM: 2650,
	IM: 2450,
	WGM: 2300,
	FM: 2350,
	WIM: 2200,
	CM: 2200,
	NM: 2200,
	WFM: 2050,
};
const LEADERBOARDS: Record<string, TimeClass> = {
	live_bullet: "bullet",
	live_blitz: "blitz",
	live_rapid: "rapid",
};
/** Fetch the second-latest in-window month when the latest gave fewer accepted games. */
const SECOND_MONTH_BELOW = 40;

/** Seed the frontier once: the leaderboards, then the titled lists at their guessed ratings. */
export async function seedFrontier(crawl: Crawl): Promise<void> {
	if (crawl.seeded) return;
	const boards = await crawl.http.get(`${API}/leaderboards`);
	if (boards === "budget") return;
	const lb = (boards ?? {}) as Record<string, Array<{ username?: string; score?: number }>>;
	for (const [board, tc] of Object.entries(LEADERBOARDS)) {
		for (const p of lb[board] ?? []) {
			if (p.username && p.score) crawl.notePlayer(p.username, tc, p.score);
		}
	}
	for (const [title, guess] of Object.entries(TITLE_GUESS)) {
		const res = await crawl.http.get(`${API}/titled/${title}`);
		if (res === "budget") return;
		for (const name of (res as { players?: string[] } | null)?.players ?? []) {
			for (const tc of TIME_CLASSES) crawl.notePlayer(name, tc, guess, true);
		}
	}
	crawl.seeded = true;
}

/** Visit one player: archive list, then the latest one or two in-window months. */
export async function visitPlayer(crawl: Crawl, name: string): Promise<"ok" | "budget"> {
	const archives = await crawl.http.get(`${API}/player/${encodeURIComponent(name)}/games/archives`);
	if (archives === "budget") return "budget";
	crawl.visited.add(name);
	const urls = ((archives as { archives?: string[] } | null)?.archives ?? [])
		.filter((u) => {
			const m = /\/games\/(\d{4}\/\d{2})$/.exec(u);
			return m?.[1] !== undefined && m[1] >= MONTH_FIRST && m[1] <= MONTH_LAST;
		})
		.sort()
		.reverse()
		.slice(0, 2);
	for (let i = 0; i < urls.length; i++) {
		const body = await crawl.http.get(urls[i] as string);
		if (body === "budget") return "budget";
		const accepted = crawl.processArchive(body);
		if (accepted >= SECOND_MONTH_BELOW) break;
	}
	return "ok";
}
