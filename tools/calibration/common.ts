/**
 * tools/calibration/common.ts — shared shapes, paths and constants for the chess.com calibration
 * corpus (`crawl-chesscom.ts` → `build-corpus.ts`) and the harness's data directory. Nothing here
 * runs in the extension.
 */

import path from "node:path";

export const TIME_CLASSES = ["bullet", "blitz", "rapid"] as const;
export type TimeClass = (typeof TIME_CLASSES)[number];

/** Bucket centres, chess.com rating; a side belongs to the nearest one within ± `BUCKET_HALF_WIDTH`. */
export const BUCKETS: readonly number[] = Array.from({ length: 13 }, (_, i) => 600 + 200 * i);
export const BUCKET_HALF_WIDTH = 100;

/** The in-window months (inclusive), `YYYY/MM` as the archive URLs spell them. */
export const MONTH_FIRST = "2026/01";
export const MONTH_LAST = "2026/08";

export const DATA_DIR = path.resolve(import.meta.dir, "../../data/calibration");
export const PATHS = {
	cache: path.join(DATA_DIR, "http-cache"),
	games: path.join(DATA_DIR, "games.jsonl"),
	samples: path.join(DATA_DIR, "samples.jsonl"),
	state: path.join(DATA_DIR, "crawl-state.json"),
	timeClassRule: path.join(DATA_DIR, "time-class-rule.json"),
	corpus: path.join(DATA_DIR, "corpus.jsonl"),
	corpusSummary: path.join(DATA_DIR, "corpus-summary.json"),
} as const;

/** `verify.ts` results, one directory per label; `crossfit.ts` reads their summaries. */
export const VERIFY_DIR = path.join(DATA_DIR, "verify");

export interface GameSide {
	username: string;
	rating: number;
	result: string;
}

/** One accepted game as `games.jsonl` stores it (a slim copy of the archive entry). */
export interface StoredGame {
	uuid: string;
	url: string;
	end_time: number;
	time_control: string;
	time_class: TimeClass;
	white: GameSide;
	black: GameSide;
	pgn: string;
}

/** One (game, side) pair selected for a cell, as `samples.jsonl` stores it. */
export interface Sample {
	uuid: string;
	side: "w" | "b";
	tc: TimeClass;
	bucket: number;
	/** Lowercased username. */
	player: string;
}

/** The cell a rating belongs to, or null when it is more than the half width from every centre. */
export function bucketFor(rating: number): number | null {
	let best: number | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const centre of BUCKETS) {
		const d = Math.abs(rating - centre);
		if (d < bestDist) {
			bestDist = d;
			best = centre;
		}
	}
	return bestDist <= BUCKET_HALF_WIDTH ? best : null;
}

export function cellKey(tc: TimeClass, bucket: number): string {
	return `${tc}:${bucket}`;
}

/** `"180+2"` → base 180 s, increment 2 s; `"60"` → 60 + 0; null for daily (`"1/86400"`) or junk. */
export function parseTimeControl(tc: string): { baseS: number; incS: number } | null {
	const m = /^(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(tc.trim());
	if (!m) return null;
	return { baseS: Number(m[1]), incS: m[2] !== undefined ? Number(m[2]) : 0 };
}

/**
 * The candidate live-game time-class rule: estimated duration `base + 40 × inc` seconds;
 * bullet under 180, blitz under 600, rapid otherwise. `crawl-chesscom.ts` verifies it against
 * chess.com's own `time_class` on every fetched game.
 */
export function timeClassFor(baseS: number, incS: number): TimeClass {
	const eff = baseS + 40 * incS;
	if (eff < 180) return "bullet";
	if (eff < 600) return "blitz";
	return "rapid";
}
