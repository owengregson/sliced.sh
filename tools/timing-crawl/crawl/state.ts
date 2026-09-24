/**
 * tools/timing-crawl/crawl/state.ts — one crawl run's shared state: the ledger, the frontier, the
 * store, the HTTP client, the seeded randomness, the per-cell stall windows and parked cells, and
 * the counters carried across runs in `state.json` (`persist.ts`). The collaborators (`seed.ts`,
 * `visit.ts`, `loop.ts`, `report.ts`) read and update it live.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { ALL_CELLS, type Caps, Ledger, rng, type VisitYield } from "../policy";
import type { Args } from "./args";
import { Frontier } from "./frontier";
import { Http } from "./http";
import { GameStore } from "./store";

export class Crawl {
	readonly ledger: Ledger;
	readonly stall = new Map<string, VisitYield[]>();
	readonly parked = new Set<string>();
	readonly random: () => number;
	readonly paths;
	readonly http: Http;
	readonly frontier: Frontier;
	readonly store: GameStore;
	seeded = false;
	ingested = false;
	requestsBefore = 0;
	visitsBefore = 0;
	visits = 0;
	startedAt = Date.now();

	constructor(readonly args: Args) {
		const caps: Caps = {
			perPlayer: args.perPlayer,
			perPlayerTc: args.perPlayerTc,
			cellCap: args.cellCap,
		};
		this.ledger = new Ledger(caps);
		this.random = rng(args.seed ^ (Date.now() & 0xffff));
		this.paths = {
			games: path.join(args.data, "games.jsonl"),
			moves: path.join(args.data, "moves.jsonl"),
			state: path.join(args.data, "state.json"),
			summary: path.join(args.data, "summary.json"),
			status: path.join(args.data, "STATUS.md"),
			cache: path.join(args.data, "http-cache"),
		};
		mkdirSync(this.paths.cache, { recursive: true });
		this.http = new Http(this.paths.cache, path.join(args.calib, "http-cache"), args.maxRequests);
		this.frontier = new Frontier(this.ledger, args, this.random);
		this.store = new GameStore(this.paths);
		for (const c of ALL_CELLS) this.stall.set(c, []);
	}

	/** Cells still below target that the crawl can still work on. */
	openShort(): string[] {
		return ALL_CELLS.filter(
			(c) => this.ledger.fill(c) < this.args.target && !this.parked.has(c) && this.frontier.size(c) > 0
		);
	}
}
