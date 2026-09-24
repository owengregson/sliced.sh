/**
 * tools/timing-crawl/crawl/report.ts — `summary.json` (every count, per cell and split, the config)
 * and `STATUS.md` (the human-readable fill table), both replaced atomically, plus the games/hour
 * rate over the last hour.
 */

import { TIME_CLASSES } from "../../calibration/common";
import { ALL_CELLS, BANDS, cellOf, MONTH_FIRST, MONTH_LAST } from "../policy";
import { atomicWrite } from "./files";
import type { Crawl } from "./state";

/** Games per hour over the last hour of samples (0 until a minute has passed). */
export class RateMeter {
	private readonly history: Array<{ t: number; games: number }> = [];

	sample(games: number): number {
		const now = Date.now();
		this.history.push({ t: now, games });
		while (this.history.length > 2 && (this.history[0]?.t ?? now) < now - 3_600_000)
			this.history.shift();
		const first = this.history[0];
		if (!first || now - first.t < 60_000) return 0;
		return ((games - first.games) * 3_600_000) / (now - first.t);
	}
}

type CellCounts = Record<string, Record<string, { sides: number; fit: number; holdout: number }>>;

function crawlSummary(c: Crawl, state: string, rate: number) {
	const L = c.ledger;
	const requests = c.requestsBefore + c.http.net;
	const cells: CellCounts = {};
	for (const tc of TIME_CLASSES) {
		cells[tc] = {};
		for (const b of BANDS) {
			const cell = cellOf(tc, b);
			(cells[tc] as Record<string, unknown>)[String(b)] = {
				sides: L.fill(cell),
				fit: L.cellSplit.get(`${cell}:fit`) ?? 0,
				holdout: L.cellSplit.get(`${cell}:holdout`) ?? 0,
			};
		}
	}
	const rapid = [...L.rapidControls.entries()].sort((a, b) => b[1] - a[1]);
	const short = ALL_CELLS.filter((cell) => L.fill(cell) < c.args.target).map((cell) => ({
		cell,
		sides: L.fill(cell),
		candidates: c.frontier.size(cell),
		parked: c.parked.has(cell),
	}));
	let fit = 0;
	let holdout = 0;
	for (const [k, n] of L.cellSplit) {
		if (k.endsWith(":fit")) fit += n;
		else holdout += n;
	}
	const avgLat = c.http.net > 0 ? c.http.latencyMsTotal / c.http.net : 0;
	const etaH = rate > 0 ? Math.max(0, c.args.goalGames - L.games) / rate : null;
	return {
		fit,
		holdout,
		requests,
		avgLat,
		etaH,
		rapid,
		short,
		summary: {
			updatedAt: new Date().toISOString(),
			state,
			config: { ...c.args, window: [MONTH_FIRST, MONTH_LAST] },
			totals: {
				games: L.games,
				keptSides: L.sides,
				keptSidesFit: fit,
				keptSidesHoldout: holdout,
				playersWithKeptSides: L.playerTotal.size,
				visitedPlayers: c.frontier.visited.size,
				visits: c.visitsBefore + c.visits,
				requestsNetworkTotal: requests,
				requestsNetworkThisRun: c.http.net,
				cacheHitsOwnThisRun: c.http.hitsOwn,
				cacheHitsCalibThisRun: c.http.hitsCalib,
				retriesThisRun: c.http.retries,
				avgLatencyMs: Math.round(avgLat),
				gamesPerHour: Math.round(rate),
				etaHoursToGoalGames: etaH === null ? null : Number(etaH.toFixed(2)),
			},
			cells,
			short,
			parked: [...c.parked],
			rapidControls: Object.fromEntries(rapid),
			candidates: Object.fromEntries(ALL_CELLS.map((cell) => [cell, c.frontier.size(cell)])),
		},
	};
}

function statusMarkdown(
	c: Crawl,
	state: string,
	rate: number,
	s: ReturnType<typeof crawlSummary>
): string {
	const L = c.ledger;
	const { fit, holdout, requests, avgLat, etaH, rapid, short } = s;
	const lines: string[] = [];
	lines.push("# Timing crawl — status", "");
	lines.push(`Updated ${s.summary.updatedAt} — **${state}**`, "");
	lines.push(
		`Games **${L.games.toLocaleString()}** / goal ${c.args.goalGames.toLocaleString()} · kept sides ${L.sides.toLocaleString()} (fit ${fit.toLocaleString()}, holdout ${holdout.toLocaleString()}) · players with kept sides ${L.playerTotal.size.toLocaleString()} · visited ${c.frontier.visited.size.toLocaleString()}`
	);
	lines.push(
		`Requests: ${requests.toLocaleString()} network total (this run ${c.http.net}, own-cache hits ${c.http.hitsOwn}, calibration-cache hits ${c.http.hitsCalib}, retries ${c.http.retries}), avg latency ${Math.round(avgLat)} ms`
	);
	lines.push(
		`Rate ≈ ${Math.round(rate).toLocaleString()} games/h (last hour) · ETA to game goal: ${etaH === null ? "n/a" : `${etaH.toFixed(1)} h`}`,
		""
	);
	lines.push(
		`Cells: kept game-sides per (time class, mover band). Target ${c.args.target} (✗ = below), cap ${c.args.cellCap}. Band 3200 = 3200+.`,
		""
	);
	lines.push("| band | bullet | blitz | rapid |", "|---:|---:|---:|---:|");
	for (const b of BANDS) {
		const row = TIME_CLASSES.map((tc) => {
			const cell = cellOf(tc, b);
			const n = L.fill(cell);
			return `${n.toLocaleString()}${n < c.args.target ? " ✗" : ""}${c.parked.has(cell) ? " (parked)" : ""}`;
		});
		lines.push(`| ${b} | ${row.join(" | ")} |`);
	}
	lines.push("");
	lines.push(
		`Short cells: ${short.length}. Open-and-short with candidates: ${c.openShort().length}.`,
		""
	);
	lines.push(
		"Rapid controls (games): " +
			rapid
				.slice(0, 12)
				.map(([k, n]) => `${k} ${n}`)
				.join(", "),
		""
	);
	lines.push(
		"Definitions: a *kept side* counts toward its cell and its player's caps (≤ " +
			`${c.args.perPlayer} overall, ≤ ${c.args.perPlayerTc} per time class); a game is stored iff ≥ 1 side is kept ` +
			"(`whiteKept`/`blackKept`). Sides under 600 are never kept. See tools/timing-crawl/policy.ts."
	);
	return `${lines.join("\n")}\n`;
}

/** Write `summary.json` and `STATUS.md` for the run's current `state`. */
export function writeReport(c: Crawl, rate: RateMeter, state: string): void {
	const r = rate.sample(c.ledger.games);
	const s = crawlSummary(c, state, r);
	atomicWrite(c.paths.summary, `${JSON.stringify(s.summary, null, "\t")}\n`);
	atomicWrite(c.paths.status, statusMarkdown(c, state, r, s));
}
