/**
 * tools/calibration/crawl-chesscom.ts — targeted crawl of chess.com rated games for the Maia
 * strength calibration (data acquisition stage; `build-corpus.ts` turns the result into rows).
 *
 *     bun tools/calibration/crawl-chesscom.ts                       # crawl until full or 6000 requests
 *     bun tools/calibration/crawl-chesscom.ts --max-requests 500    # a chunk; rerun to resume
 *     bun tools/calibration/crawl-chesscom.ts --rule-only           # re-derive time-class-rule.json
 *
 * Options: --max-requests N (network requests this run, default 6000), --target N (samples per
 * cell, default 110), --per-player N (samples per player per cell, default 2), --stall N (visits
 * to a cell without a new sample before it is set aside, default 40), --seed N (RNG seed).
 *
 * Cells are time class (bullet / blitz / rapid) × rating bucket (600, 800, …, 3000; a side counts
 * for the nearest centre within ± 100). A sample is a (game, side) pair; it counts only toward its
 * own time class. The crawl is serial (chess.com rate-limits parallel clients), caches every
 * response body under `data/calibration/http-cache/` (gzipped, keyed by sha1 of the URL) so a
 * rerun never refetches, and keeps its frontier in `crawl-state.json`, so it is resumable.
 *
 * Player choice: every player seen (seeds from the titled lists and leaderboards, then every
 * opponent in every fetched game) is filed under the cell of each last-seen rating; the next
 * visit is a random unvisited player from the least-filled cell that still has one. Following
 * low-rated opponents of low-rated players is how the crawl reaches 600–1000.
 *
 * Outputs (all under `data/calibration/`, git-ignored): `games.jsonl` (accepted games that
 * yielded a sample, deduped by uuid), `samples.jsonl` ({uuid, side, tc, bucket, player}),
 * `time-class-rule.json` (time_control → time_class counts over every fetched live game, and
 * the check of `timeClassFor` against chess.com's own label).
 *
 * The parts live in `crawl-chesscom/`: the arguments, the cached HTTP client, the archive filter,
 * the crawl state and policy, the chess.com sources, and the time-class rule.
 */

import { mkdirSync } from "node:fs";
import { PATHS } from "./common";
import { parseArgs } from "./crawl-chesscom/args";
import { Crawl } from "./crawl-chesscom/crawl";
import { Http } from "./crawl-chesscom/http";
import { seedFrontier, visitPlayer } from "./crawl-chesscom/sources";
import { writeRule } from "./crawl-chesscom/time-class-rule";

export { acceptGame } from "./crawl-chesscom/archive";
export { deriveTimeClassRule } from "./crawl-chesscom/time-class-rule";

const PROGRESS_EVERY = 50;

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(PATHS.cache, { recursive: true });
	if (args.ruleOnly) {
		writeRule();
		return;
	}
	const http = new Http(args.maxRequests);
	const crawl = new Crawl(args, http);
	crawl.load();
	let stopping = false;
	process.on("SIGINT", () => {
		stopping = true;
	});
	await seedFrontier(crawl);
	let lastReport = 0;
	let visits = 0;
	let reason = "frontier exhausted";
	while (!stopping) {
		if (crawl.allFull()) {
			reason = "every cell full";
			break;
		}
		if (http.exhausted) {
			reason = "request budget spent";
			break;
		}
		const pick = crawl.next();
		if (!pick) break;
		const before = crawl.fill.get(pick.cell) ?? 0;
		const res = await visitPlayer(crawl, pick.name);
		if (res === "budget") {
			reason = "request budget spent";
			break;
		}
		visits++;
		if ((crawl.fill.get(pick.cell) ?? 0) === before) {
			crawl.stall.set(pick.cell, (crawl.stall.get(pick.cell) ?? 0) + 1);
		}
		if (http.requests - lastReport >= PROGRESS_EVERY) {
			lastReport = http.requests;
			crawl.save();
			console.log(
				`\n[${http.requests} requests this run, ${visits} visits, ${crawl.players.size} players known]`
			);
			console.log(crawl.table());
		}
	}
	if (stopping) reason = "interrupted";
	crawl.save();
	console.log(`\nstopped: ${reason}`);
	console.log(
		`requests this run ${http.requests}, total ${crawl.requestsBefore + http.requests}, visits ${visits}, samples ${crawl.sampleKeys.size}, games ${crawl.gameUuids.size}`
	);
	console.log(crawl.table());
	const short = [...crawl.fill.entries()].filter(([, n]) => n < args.target);
	if (short.length > 0) {
		console.log(`under-filled cells: ${short.map(([k, n]) => `${k}=${n}`).join(", ")}`);
	}
	writeRule();
}

if (import.meta.main) {
	await main();
}
