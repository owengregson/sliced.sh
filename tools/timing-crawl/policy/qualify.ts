/**
 * tools/timing-crawl/policy/qualify.ts — which games qualify: the crawl window, the archive-month
 * filter, the cheap pre-filter on a raw archive entry and the per-ply clock profile.
 */

import { parsePgn } from "../../calibration/build-corpus";
import {
	parseTimeControl,
	type StoredGame,
	TIME_CLASSES,
	type TimeClass,
} from "../../calibration/common";
import { acceptGame } from "../../calibration/crawl-chesscom";

export const MIN_PLIES = 20;

/** Window (inclusive month names as the archive URLs spell them; end_time half-open in seconds). */
export const MONTH_FIRST = "2025/09";
export const MONTH_LAST = "2026/08";
export const WINDOW_START_S = Date.UTC(2025, 8, 1) / 1000;
export const WINDOW_END_S = Date.UTC(2026, 8, 1) / 1000;

export function inWindow(endTimeS: number): boolean {
	return endTimeS >= WINDOW_START_S && endTimeS < WINDOW_END_S;
}

/** The month of an archive URL (`…/games/2026/03` → `2026/03`) when inside the window. */
export function archiveMonth(url: string): string | null {
	const m = /\/games\/(\d{4}\/\d{2})$/.exec(url);
	if (!m?.[1] || m[1] < MONTH_FIRST || m[1] > MONTH_LAST) return null;
	return m[1];
}

export interface ClockProfile {
	san: string[];
	clockMs: number[];
}

/** SAN and clocks per ply, or null when any ply lacks a readable `[%clk]`. */
export function clockProfile(pgn: string): ClockProfile | null {
	const parsed = parsePgn(pgn);
	const clockMs: number[] = [];
	for (const c of parsed.clocksMs) {
		if (c === null) return null;
		clockMs.push(c);
	}
	if (clockMs.length !== parsed.sans.length) return null;
	return { san: parsed.sans, clockMs };
}

/** A stored (already `acceptGame`d) game → its clock profile, or null when it fails the filters. */
export function qualifyStored(g: StoredGame): ClockProfile | null {
	if (!TIME_CLASSES.includes(g.time_class)) return null;
	if (!inWindow(g.end_time)) return null;
	if (!parseTimeControl(g.time_control)) return null;
	if (!(g.white.rating > 0) || !(g.black.rating > 0)) return null;
	const prof = clockProfile(g.pgn);
	if (!prof || prof.san.length < MIN_PLIES) return null;
	return prof;
}

/** A raw archive entry → stored game + profile, or null. */
export function qualifyArchive(raw: unknown): { game: StoredGame; prof: ClockProfile } | null {
	const game = acceptGame(raw as Parameters<typeof acceptGame>[0]);
	if (!game) return null;
	const prof = qualifyStored(game);
	return prof ? { game, prof } : null;
}

/** Cheap pre-filter on the raw entry (no PGN parsing). */
export interface RawGame {
	uuid?: string;
	url?: string;
	rules?: string;
	rated?: boolean;
	time_class?: string;
	end_time?: number;
	white?: { username?: string; rating?: number };
	black?: { username?: string; rating?: number };
}

export function prefilter(g: RawGame): g is RawGame & { uuid: string; time_class: TimeClass } {
	return (
		g.rules === "chess" &&
		g.rated === true &&
		(g.time_class === "bullet" || g.time_class === "blitz" || g.time_class === "rapid") &&
		typeof g.uuid === "string" &&
		typeof g.end_time === "number" &&
		inWindow(g.end_time)
	);
}
