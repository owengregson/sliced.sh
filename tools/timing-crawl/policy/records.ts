/**
 * tools/timing-crawl/policy/records.ts — the two records the crawl writes: a `games.jsonl` line
 * (`TimingGame`) and its derived per-ply clock/think line in `moves.jsonl` (`MovesRecord`).
 */

import { type Split, splitFor } from "../../calibration/build-corpus";
import { parseTimeControl, type StoredGame, type TimeClass } from "../../calibration/common";
import type { Colour } from "./cells";
import type { ClockProfile } from "./qualify";

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
