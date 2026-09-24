/**
 * tools/timing-crawl/crawl.ts — snowball crawl of chess.com live games with a clock on every move,
 * for the think-time model. The pure rules (filters, bands, caps, priorities) live in
 * `policy.ts`, which documents the definitions `games.jsonl` is written under.
 *
 *     bun tools/timing-crawl/crawl.ts --data <dir> --calib <dir>        # run / resume
 *     nohup bun tools/timing-crawl/crawl.ts --data D --calib C >> D/crawl.log 2>&1 &
 *
 * Options: --target N (kept sides per cell counted as "met", 4000), --cell-cap N (no side is kept
 * in a cell once it holds N, 8000), --goal-games N (250000), --per-player N (150),
 * --per-player-tc N (30), --stall N and --min-yield Y (a cell is parked for this run once its
 * last N focused visits added fewer than Y kept sides per network request; 20, 0.5),
 * --few-months N (months per visit below --scarce-from, 3), --scarce-from R (2000:
 * players picked for a band ≥ R get every in-window month), --cand-cap N (candidates kept per
 * cell, 5000), --harvest N (opponent sides kept per cell per visit, spread over its months,
 * 250 — so no cell is filled by the opponents of a handful of players), --max-requests N, --report-every S (180), --seed N.
 *
 * Network: strictly serial, `sliced-calibration-research/1.0`, exponential backoff on 429 / 5xx /
 * network errors (honouring Retry-After). Every response body is cached gzipped under
 * `<data>/http-cache/` keyed by sha1(url) (the calibration crawl's format); `<calib>/http-cache/`
 * is read as a first-level cache and never written. A 404/410 is cached as a null body.
 *
 * Resumability (kill -9 safe): `games.jsonl` (append-only, one full line per write) is the truth
 * for fills and caps and is replayed on start after dropping a torn last line; `moves.jsonl`
 * lines missing for stored games are regenerated; the frontier (visited players, candidates per
 * cell) is snapshotted atomically to `state.json`. A lost snapshot costs only cache hits.
 *
 * Outputs under `<data>`: `games.jsonl` (TimingGame per line), `moves.jsonl` (MovesRecord per
 * line), `summary.json`, `STATUS.md`, `state.json`, `http-cache/`.
 *
 * Player choice: every opponent seen in a fetched month (and the titled lists, the leaderboards,
 * the calibration corpus' players) is filed as a candidate under the cell of the rating it had
 * in that game, while that cell is open and the player has room. The next visit takes a random
 * candidate from the most under-filled open cell (fill / target). A visit fetches the player's
 * archive list and then a random selection of in-window months (all of them for scarce bands),
 * rationing the player's own sides per month; opponents' sides in those months are kept whenever
 * they are eligible.
 *
 * Parts (`crawl/`): `args.ts` (the command line), `http.ts` (the cached, serial client), `files.ts`
 * (atomic snapshots, torn-tail trim), `store.ts` (`games.jsonl` / `moves.jsonl`), `frontier.ts`
 * (candidates per cell), `state.ts` (the run's shared state), `persist.ts` (`state.json`),
 * `seed.ts` (leaderboards, titled players, the calibration corpus), `visit.ts` (one player's
 * months), `loop.ts` (the crawl loop), `report.ts` (`summary.json`, `STATUS.md`). The pure rules
 * are `policy.ts`.
 */

import { mkdirSync } from "node:fs";
import { parseArgs } from "./crawl/args";
import { log } from "./crawl/log";
import { runCrawl } from "./crawl/loop";
import { loadCrawl, saveCrawl } from "./crawl/persist";
import { RateMeter, writeReport } from "./crawl/report";
import { ingestCalibration, seedFrontier } from "./crawl/seed";
import { Crawl } from "./crawl/state";

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.data, { recursive: true });
	const crawl = new Crawl(args);
	const rate = new RateMeter();
	loadCrawl(crawl);
	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	await seedFrontier(crawl);
	ingestCalibration(crawl);
	writeReport(crawl, rate, "running");
	const reason = await runCrawl(crawl, rate, () => stopping);
	saveCrawl(crawl);
	writeReport(crawl, rate, `stopped: ${reason}`);
	log(`stopped: ${reason}; games ${crawl.ledger.games}, sides ${crawl.ledger.sides}`);
}

if (import.meta.main) {
	await main();
}
