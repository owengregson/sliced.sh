/**
 * tools/timing-crawl/crawl/args.ts — the crawl's command line: `--data` and `--calib` directories
 * and the numeric knobs, walked strictly left to right (every flag takes a value; an unknown flag
 * or a non-number throws).
 */

import path from "node:path";
import { ROOT } from "../../lib/paths";

export interface Args {
	data: string;
	calib: string;
	target: number;
	cellCap: number;
	goalGames: number;
	perPlayer: number;
	perPlayerTc: number;
	stall: number;
	minYield: number;
	fewMonths: number;
	scarceFrom: number;
	candCap: number;
	harvest: number;
	maxRequests: number;
	reportEvery: number;
	seed: number;
}

const NUMERIC: Record<string, keyof Args> = {
	"--target": "target",
	"--cell-cap": "cellCap",
	"--goal-games": "goalGames",
	"--per-player": "perPlayer",
	"--per-player-tc": "perPlayerTc",
	"--stall": "stall",
	"--min-yield": "minYield",
	"--few-months": "fewMonths",
	"--scarce-from": "scarceFrom",
	"--cand-cap": "candCap",
	"--harvest": "harvest",
	"--max-requests": "maxRequests",
	"--report-every": "reportEvery",
	"--seed": "seed",
};

/**
 * The value is read before the flag is judged, so a trailing flag of any name reports
 * `<flag> needs a value` (not `unknown argument`) — kept from the original command line.
 */
export function parseArgs(argv: string[]): Args {
	const a: Args = {
		data: path.resolve(ROOT, "data/timing/crawl"),
		calib: path.resolve(ROOT, "data/calibration"),
		target: 4000,
		cellCap: 8000,
		goalGames: 250_000,
		perPlayer: 150,
		perPlayerTc: 30,
		stall: 20,
		minYield: 0.5,
		fewMonths: 3,
		scarceFrom: 2000,
		candCap: 5_000,
		harvest: 250,
		maxRequests: Number.POSITIVE_INFINITY,
		reportEvery: 180,
		seed: 11,
	};
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i] as string;
		const v = argv[++i];
		if (v === undefined) throw new Error(`${k} needs a value`);
		if (k === "--data") a.data = path.resolve(v);
		else if (k === "--calib") a.calib = path.resolve(v);
		else if (NUMERIC[k]) {
			const n = Number(v);
			if (!Number.isFinite(n)) throw new Error(`${k} needs a number`);
			(a as unknown as Record<string, number>)[NUMERIC[k] as string] = n;
		} else throw new Error(`unknown argument ${k}`);
	}
	return a;
}
