/**
 * tools/timing-crawl/crawl/loop.ts — the crawl loop: pick a random candidate from the most
 * under-filled open cell (`rankCells`; past the target only while the game goal is unmet), visit
 * it, park the cell when its recent focused visits stall, and snapshot / report on their cadences.
 * A transient HTTP failure requeues the player and pauses. Returns why the loop stopped.
 */

import { rankCells, shouldPark } from "../policy";
import { TransientError } from "./http";
import { log } from "./log";
import { saveCrawl } from "./persist";
import { type RateMeter, writeReport } from "./report";
import type { Crawl } from "./state";
import { visit } from "./visit";

export async function runCrawl(
	crawl: Crawl,
	rate: RateMeter,
	stopping: () => boolean
): Promise<string> {
	const args = crawl.args;
	let lastReport = Date.now();
	let lastSave = Date.now();
	let reason = "interrupted";
	while (!stopping()) {
		if (crawl.http.exhausted) {
			reason = "request budget spent";
			break;
		}
		const L = crawl.ledger;
		if (L.games >= args.goalGames && crawl.openShort().length === 0) {
			reason = "game goal reached and every reachable cell at target";
			break;
		}
		let pick: { name: string; cell: string } | null = null;
		for (const cell of rankCells(L.cellFill, args.target, args.cellCap, crawl.parked, crawl.random)) {
			// Beyond the target, keep working only while the game goal is unmet.
			if (L.fill(cell) >= args.target && L.games >= args.goalGames) continue;
			const name = crawl.frontier.pop(cell);
			if (name) {
				pick = { name, cell };
				break;
			}
		}
		if (!pick) {
			reason = "frontier exhausted";
			break;
		}
		const req0 = crawl.http.net;
		try {
			const { gains, months } = await visit(crawl, pick.name, pick.cell);
			crawl.visits++;
			const focus = gains.get(pick.cell) ?? 0;
			const recent = crawl.stall.get(pick.cell) ?? [];
			recent.push({ gain: focus, requests: crawl.http.net - req0 });
			if (recent.length > args.stall) recent.shift();
			crawl.stall.set(pick.cell, recent);
			if (shouldPark(recent, args.stall, args.minYield)) {
				crawl.parked.add(pick.cell);
				log(
					`parked ${pick.cell}: last ${recent.length} focused visits yielded < ${args.minYield} side/request (fill ${L.fill(pick.cell)})`
				);
			}
			let total = 0;
			for (const n of gains.values()) total += n;
			log(
				`visit ${pick.name} for ${pick.cell} (${L.fill(pick.cell)}): ${months} months, +${total} sides (+${focus} focus), ${crawl.http.net - req0} req · games ${L.games}`
			);
		} catch (err) {
			if (err instanceof TransientError) {
				log(`${err.message}; requeueing ${pick.name} and pausing 5 min`);
				crawl.frontier.file(pick.cell, pick.name);
				crawl.frontier.visited.delete(pick.name);
				await Bun.sleep(300_000);
				continue;
			}
			throw err;
		}
		// Month archives parse to tens of MB; return the garbage now so the footprint stays flat.
		Bun.gc(true);
		const now = Date.now();
		if (now - lastSave > 60_000) {
			saveCrawl(crawl);
			lastSave = now;
		}
		if (now - lastReport > args.reportEvery * 1000) {
			writeReport(crawl, rate, "running");
			lastReport = now;
		}
	}
	return reason;
}
