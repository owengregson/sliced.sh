/**
 * tools/timing-crawl/policy.ts — the pure half of the think-time crawl (`crawl.ts`): which games
 * qualify, which 100-Elo cell a side fills, the per-player caps, which cell the crawl works on
 * next, how a player's months are spread, and the derived per-ply clock/think record. Nothing here
 * touches the network or the disk.
 *
 * Definitions (the contract `games.jsonl` is written under):
 *
 * - **Qualifying game**: chess.com archive entry that the calibration's `acceptGame` accepts
 *   (rated, `rules = chess`, standard start, live bullet/blitz/rapid, both usernames and ratings),
 *   `end_time` in [2025-09-01, 2026-09-01) UTC, at least `MIN_PLIES` half-moves, and a `[%clk]`
 *   on every half-move.
 * - **Cell**: (time class, band of the MOVER's rating in that game). Bands are 600, 700, …, 3200:
 *   `floor(rating / 100) × 100`, 3200 and above fold into 3200; under 600 is no band.
 * - **Kept side**: a (game, colour) that counts. A side is kept iff its player's rating has a band,
 *   its cell holds fewer than `cellCap` kept sides, and its player holds fewer than `perPlayer`
 *   kept sides overall and fewer than `perPlayerTc` in that time class. A game is stored iff at
 *   least one of its sides is kept; `whiteKept` / `blackKept` say which. A side that is not kept
 *   does not count toward its player's caps nor toward its cell — downstream work that wants the
 *   caps honoured uses kept sides only.
 * - **Visited player's own sides** are additionally rationed per month (`monthQuota`) so a player's
 *   kept sides spread over the months and time classes they played, instead of the first N.
 */

import { parsePgn, type Split, splitFor } from "../calibration/build-corpus";
import {
	parseTimeControl,
	type StoredGame,
	TIME_CLASSES,
	type TimeClass,
} from "../calibration/common";
import { acceptGame } from "../calibration/crawl-chesscom";

export const BAND_MIN = 600;
export const BAND_MAX = 3200;
export const BAND_WIDTH = 100;
export const BANDS: readonly number[] = Array.from(
	{ length: (BAND_MAX - BAND_MIN) / BAND_WIDTH + 1 },
	(_, i) => BAND_MIN + BAND_WIDTH * i
);
export const MIN_PLIES = 20;

/** Window (inclusive month names as the archive URLs spell them; end_time half-open in seconds). */
export const MONTH_FIRST = "2025/09";
export const MONTH_LAST = "2026/08";
export const WINDOW_START_S = Date.UTC(2025, 8, 1) / 1000;
export const WINDOW_END_S = Date.UTC(2026, 8, 1) / 1000;

export type Colour = "w" | "b";

/** One `games.jsonl` record. */
export interface TimingGame extends StoredGame {
	plies: number;
	whiteSplit: Split;
	blackSplit: Split;
	whiteKept: boolean;
	blackKept: boolean;
}

/** One `moves.jsonl` record: the derived per-ply clocks (ply i is White's when i is even). */
export interface MovesRecord {
	uuid: string;
	tc: TimeClass;
	time_control: string;
	baseMs: number;
	incMs: number;
	whiteElo: number;
	blackElo: number;
	whiteKept: boolean;
	blackKept: boolean;
	san: string[];
	/** The mover's clock after each ply, ms. */
	clockMs: number[];
	/** The mover's think per ply: previous own clock (base for the first) − clock + increment. */
	thinkMs: number[];
}

export interface Caps {
	perPlayer: number;
	perPlayerTc: number;
	cellCap: number;
}

export const DEFAULT_CAPS: Caps = { perPlayer: 150, perPlayerTc: 30, cellCap: 8000 };

// ── bands and cells ──────────────────────────────────────────────────────────────────────────

export function bandFor(rating: number): number | null {
	if (!(rating >= BAND_MIN)) return null;
	return Math.min(BAND_MAX, Math.floor(rating / BAND_WIDTH) * BAND_WIDTH);
}

export function cellOf(tc: TimeClass, band: number): string {
	return `${tc}:${band}`;
}

export const ALL_CELLS: readonly string[] = TIME_CLASSES.flatMap((tc) =>
	BANDS.map((b) => cellOf(tc, b))
);

export function parseCell(cell: string): { tc: TimeClass; band: number } {
	const [tc, band] = cell.split(":");
	return { tc: tc as TimeClass, band: Number(band) };
}

// ── qualification ────────────────────────────────────────────────────────────────────────────

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

// ── derived record ───────────────────────────────────────────────────────────────────────────

export function movesRecord(g: TimingGame, prof: ClockProfile): MovesRecord {
	const tcp = parseTimeControl(g.time_control) ?? { baseS: 0, incS: 0 };
	const baseMs = Math.round(tcp.baseS * 1000);
	const incMs = Math.round(tcp.incS * 1000);
	const thinkMs: number[] = [];
	for (let i = 0; i < prof.clockMs.length; i++) {
		const prev = i >= 2 ? (prof.clockMs[i - 2] ?? baseMs) : baseMs;
		thinkMs.push(prev - (prof.clockMs[i] ?? 0) + incMs);
	}
	return {
		uuid: g.uuid,
		tc: g.time_class,
		time_control: g.time_control,
		baseMs,
		incMs,
		whiteElo: g.white.rating,
		blackElo: g.black.rating,
		whiteKept: g.whiteKept,
		blackKept: g.blackKept,
		san: prof.san,
		clockMs: prof.clockMs,
		thinkMs,
	};
}

export function timingGame(
	g: StoredGame,
	plies: number,
	kept: Record<Colour, boolean>
): TimingGame {
	return {
		uuid: g.uuid,
		url: g.url,
		end_time: g.end_time,
		time_control: g.time_control,
		time_class: g.time_class,
		white: g.white,
		black: g.black,
		pgn: g.pgn,
		plies,
		whiteSplit: splitFor(g.white.username),
		blackSplit: splitFor(g.black.username),
		whiteKept: kept.w,
		blackKept: kept.b,
	};
}

// ── ledger: caps and cell fills ──────────────────────────────────────────────────────────────

export class Ledger {
	readonly cellFill = new Map<string, number>();
	readonly cellSplit = new Map<string, number>();
	readonly playerTotal = new Map<string, number>();
	readonly playerTc = new Map<string, number>();
	readonly rapidControls = new Map<string, number>();
	readonly uuids = new Set<string>();
	readonly urls = new Set<string>();
	games = 0;
	sides = 0;

	constructor(readonly caps: Caps) {
		for (const c of ALL_CELLS) this.cellFill.set(c, 0);
	}

	fill(cell: string): number {
		return this.cellFill.get(cell) ?? 0;
	}

	seen(uuid: string, url?: string): boolean {
		return this.uuids.has(uuid) || (url !== undefined && url !== "" && this.urls.has(url));
	}

	/** Room left for a player in a time class under both caps. */
	room(player: string, tc: TimeClass): number {
		const p = player.toLowerCase();
		const total = this.caps.perPlayer - (this.playerTotal.get(p) ?? 0);
		const inTc = this.caps.perPlayerTc - (this.playerTc.get(`${p}:${tc}`) ?? 0);
		return Math.max(0, Math.min(total, inTc));
	}

	cellOpen(tc: TimeClass, rating: number): boolean {
		const band = bandFor(rating);
		return band !== null && this.fill(cellOf(tc, band)) < this.caps.cellCap;
	}

	/** Whether a side would be kept right now (band, open cell, player room). */
	eligible(player: string, tc: TimeClass, rating: number): boolean {
		return this.cellOpen(tc, rating) && this.room(player, tc) > 0;
	}

	/**
	 * Record a stored game. `want` says which sides the caller asks to keep; each is re-checked for
	 * eligibility (and a player can never keep both sides of one game). Returns the kept flags, or
	 * null when nothing is kept (the game is then not stored) or the game is a duplicate.
	 */
	admit(g: StoredGame, want: Record<Colour, boolean>): Record<Colour, boolean> | null {
		if (this.seen(g.uuid, g.url)) return null;
		const tc = g.time_class;
		const w = want.w && this.eligible(g.white.username, tc, g.white.rating);
		let b = want.b && this.eligible(g.black.username, tc, g.black.rating);
		if (w && b && g.white.username.toLowerCase() === g.black.username.toLowerCase()) b = false;
		if (!w && !b) return null;
		const kept = { w, b };
		this.record(g, kept);
		return kept;
	}

	/** Book a game with fixed kept flags (used when replaying `games.jsonl` on load). */
	record(g: StoredGame, kept: Record<Colour, boolean>): void {
		this.uuids.add(g.uuid);
		if (g.url) this.urls.add(g.url);
		this.games++;
		if (g.time_class === "rapid") {
			this.rapidControls.set(g.time_control, (this.rapidControls.get(g.time_control) ?? 0) + 1);
		}
		for (const colour of ["w", "b"] as const) {
			if (!kept[colour]) continue;
			const side = colour === "w" ? g.white : g.black;
			const band = bandFor(side.rating);
			if (band === null) continue;
			const p = side.username.toLowerCase();
			const cell = cellOf(g.time_class, band);
			this.cellFill.set(cell, this.fill(cell) + 1);
			const sk = `${cell}:${splitFor(p)}`;
			this.cellSplit.set(sk, (this.cellSplit.get(sk) ?? 0) + 1);
			this.playerTotal.set(p, (this.playerTotal.get(p) ?? 0) + 1);
			const pk = `${p}:${g.time_class}`;
			this.playerTc.set(pk, (this.playerTc.get(pk) ?? 0) + 1);
			this.sides++;
		}
	}
}

// ── priorities ───────────────────────────────────────────────────────────────────────────────

/**
 * Cells in the order the crawl should work on them: open cells (below `cellCap`) that are not
 * parked, by fill / target ascending (the most under-filled first), ties by a random key.
 */
export function rankCells(
	fills: ReadonlyMap<string, number>,
	target: number,
	cellCap: number,
	parked: ReadonlySet<string>,
	random: () => number
): string[] {
	return ALL_CELLS.filter((c) => (fills.get(c) ?? 0) < cellCap && !parked.has(c))
		.map((c) => ({ c, r: (fills.get(c) ?? 0) / target, k: random() }))
		.sort((a, b) => a.r - b.r || a.k - b.k)
		.map((x) => x.c);
}

/** Months of a visited player to fetch at most: scarce (high) bands get the whole window. */
export function maxMonthsFor(band: number, scarceFrom = 2000, few = 3): number {
	return band >= scarceFrom ? 12 : few;
}

/** Own sides to take from the next month so the rest of the room spreads over the remaining months. */
export function monthQuota(room: number, monthsLeft: number): number {
	if (room <= 0) return 0;
	return Math.ceil(room / Math.max(1, monthsLeft));
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffle<T>(xs: T[], random: () => number): T[] {
	for (let i = xs.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const t = xs[i] as T;
		xs[i] = xs[j] as T;
		xs[j] = t;
	}
	return xs;
}

export interface VisitYield {
	/** Kept sides the visit added to the cell it was made for. */
	gain: number;
	/** Network requests it cost (cache hits are free). */
	requests: number;
}

/**
 * Park a cell for the rest of the run once its last `window` focused visits added fewer than
 * `minYield` kept sides per network request between them (a scarce population, or one already
 * harvested). A cache-only window never parks.
 */
export function shouldPark(
	recent: readonly VisitYield[],
	window: number,
	minYield: number
): boolean {
	if (recent.length < window) return false;
	let gain = 0;
	let requests = 0;
	for (const v of recent.slice(-window)) {
		gain += v.gain;
		requests += v.requests;
	}
	return requests > 0 && gain < minYield * requests;
}
