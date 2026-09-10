// test/core/timing/helpers.ts — shared fixtures for the timing-model tests.

import type { TimingContext } from "@core/timing/types";
import type { EvalLine } from "@typedefs/engine";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** A generic middlegame (Ruy Lopez-ish structure), white to move. */
export const MIDDLEGAME_FEN =
	"r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
/** After 1.e4 d5 2.exd5 — black to move, Qxd5 recaptures. */
export const AFTER_EXD5 = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

export function line(multipv: number, cp: number, ...pv: string[]): EvalLine {
	return { multipv, score: { cp }, depth: 10, pvUci: pv, pvSan: [] };
}

/** Four lines, best +20 with the rest close: a non-trivial choice. */
export function middlegameLines(): EvalLine[] {
	return [
		line(1, 20, "d2d4", "e5d4"),
		line(2, 10, "a2a4", "b5a4"),
		line(3, -5, "b1a3", "c8e6"),
		line(4, -30, "h3h4", "h7h6"),
	];
}

export function ctx(over: Partial<TimingContext> = {}): TimingContext {
	return {
		fen: MIDDLEGAME_FEN,
		ply: 24,
		moves: [],
		myColor: "w",
		chosenMove: "d2d4",
		lines: middlegameLines(),
		evalBeforeOppMove: 25,
		expectedOppReply: null,
		myClockMs: 120_000,
		oppClockMs: 120_000,
		baseSec: 180,
		incSec: 0,
		oppThinkMsHistory: [3000, 4000, 2500],
		myThinkMsHistory: [],
		site: "chesscom",
		targetElo: 1650,
		profile: "balanced",
		engineReady: true,
		inputMethod: "drag",
		autoQueen: true,
		nowMs: 1_000_000,
		...over,
	};
}

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function pearson(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < n; i++) {
		ma += a[i] ?? 0;
		mb += b[i] ?? 0;
	}
	ma /= n;
	mb /= n;
	let sab = 0;
	let saa = 0;
	let sbb = 0;
	for (let i = 0; i < n; i++) {
		const da = (a[i] ?? 0) - ma;
		const db = (b[i] ?? 0) - mb;
		sab += da * db;
		saa += da * da;
		sbb += db * db;
	}
	return sab / Math.sqrt(saa * sbb);
}
