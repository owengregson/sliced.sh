/**
 * tools/timing-crawl/crawl/persist.ts — resuming (kill -9 safe): `games.jsonl` is the truth for
 * fills and caps and is replayed first; the frontier (visited players, candidates per cell) and
 * the counters come from the atomic `state.json` snapshot. A lost snapshot costs only cache hits.
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./files";
import { log } from "./log";
import type { Crawl } from "./state";

interface Persisted {
	visited: string[];
	candidates: Record<string, string[]>;
	seeded: boolean;
	ingested: boolean;
	requests: number;
	visits: number;
	startedAt: number;
}

export function loadCrawl(c: Crawl): void {
	const regenerated = c.store.replay(c.ledger);
	if (existsSync(c.paths.state)) {
		const s = JSON.parse(readFileSync(c.paths.state, "utf8")) as Persisted;
		for (const v of s.visited) c.frontier.visited.add(v);
		for (const [cell, names] of Object.entries(s.candidates)) {
			for (const n of names) c.frontier.file(cell, n);
		}
		c.seeded = s.seeded;
		c.ingested = s.ingested;
		c.requestsBefore = s.requests;
		c.visitsBefore = s.visits;
		c.startedAt = s.startedAt;
	}
	log(
		`loaded ${c.ledger.games} games, ${c.ledger.sides} kept sides, ${c.frontier.visited.size} visited` +
			(regenerated ? `, regenerated ${regenerated} moves lines` : "")
	);
}

export function saveCrawl(c: Crawl): void {
	const s: Persisted = {
		visited: [...c.frontier.visited],
		candidates: Object.fromEntries(c.frontier.candidates),
		seeded: c.seeded,
		ingested: c.ingested,
		requests: c.requestsBefore + c.http.net,
		visits: c.visitsBefore + c.visits,
		startedAt: c.startedAt,
	};
	atomicWrite(c.paths.state, JSON.stringify(s));
}
