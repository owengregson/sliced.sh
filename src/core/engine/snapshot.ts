/**
 * Panel evaluation snapshot (Appendix E §7.2, Task 13). Engine scores arrive
 * from the side to move; the panel shows everything from White's point of view:
 * `evalBar = 2·win(cpWhite) − 1` in `[-1, 1]` (mates → `±1`), `scoreText`
 * `"+0.34"` / `"M5"` / `"-M2"`, WDL flipped when Black is to move, and SAN for
 * every PV. Pure: no engine state, no timers.
 */

import { sideToMove } from "@core/chess/fen";
import { pvToSan } from "@core/chess/san";
import { LIMITS } from "@core/constants/limits";
import { clamp } from "@core/util/clamp";
import type { Eval, EvalLine } from "@typedefs/engine";
import type { Color } from "@typedefs/game";
import type { AnalysisResult, AnalysisUpdate } from "./types";

/** `win(cp) = 1 / (1 + e^(−k·cp))`, `k = LIMITS.winProbK` (lichess calibration). */
export function winProb(cp: number): number {
	return 1 / (1 + Math.exp(-LIMITS.winProbK * cp));
}

export interface SnapshotLine {
	multipv: number;
	/** White's point of view. */
	score: Eval;
	/** White's point of view, `"+0.34"` / `"M5"` / `"-M2"`. */
	scoreText: string;
	depth: number;
	pvUci: string[];
	pvSan: string[];
}

export interface EvalSnapshot {
	fen: string;
	sideToMove: Color;
	requestId: string;
	/** White's point of view in `[-1, 1]`: `2·win(cpWhite) − 1`; mates → `±1`; `0` before any line. */
	evalBar: number;
	/** White's point of view; `""` before any line. */
	scoreText: string;
	/** Per-mille from White's point of view (`UCI_ShowWDL`). */
	wdl?: { w: number; d: number; l: number };
	lines: SnapshotLine[];
	depth: number;
	seldepth?: number;
	nodes: number;
	nps: number;
	timeMs: number;
	/** `null` while searching, on `bestmove (none)`, or when the search failed. */
	bestmove: string | null;
}

/**
 * Side-to-move score → White's point of view. `mate 0` (the side to move is
 * checkmated) has no sign to flip: it stays `0`, and `formatScore` /
 * `evalBarFor` read the loser from `stm`.
 */
export function toWhitePov(score: Eval, stm: Color): Eval {
	if (score.mate !== undefined) {
		const mate = stm === "w" ? score.mate : -score.mate;
		return { mate: mate === 0 ? 0 : mate };
	}
	if (score.cp !== undefined) return { cp: stm === "w" ? score.cp : -score.cp };
	return {};
}

/** White is winning a mate score: positive, or `mate 0` with Black to move (Black is mated). */
function whiteWinsMate(mate: number, stm: Color): boolean {
	return mate === 0 ? stm === "b" : mate > 0;
}

/** `"+0.34"` / `"0.00"` / `"-1.20"` / `"M5"` / `"-M2"` (`"-M0"`: White is mated); `""` for an empty score. */
export function formatScore(white: Eval, stm: Color): string {
	if (white.mate !== undefined)
		return `${whiteWinsMate(white.mate, stm) ? "" : "-"}M${Math.abs(white.mate)}`;
	if (white.cp === undefined) return "";
	const pawns = (white.cp / 100).toFixed(2);
	return white.cp > 0 ? `+${pawns}` : pawns;
}

/** `[-1, 1]` from a White-POV score: mates saturate, cp through `winProb`. */
export function evalBarFor(white: Eval, stm: Color): number {
	if (white.mate !== undefined) return whiteWinsMate(white.mate, stm) ? 1 : -1;
	if (white.cp === undefined) return 0;
	return clamp(2 * winProb(white.cp) - 1, -1, 1);
}

function toLine(l: EvalLine, fen: string, stm: Color): SnapshotLine {
	const score = toWhitePov(l.score, stm);
	return {
		multipv: l.multipv,
		score,
		scoreText: formatScore(score, stm),
		depth: l.depth,
		pvUci: l.pvUci,
		pvSan: l.pvSan.length > 0 ? l.pvSan : pvToSan(fen, l.pvUci),
	};
}

/** Snapshot from a live `AnalysisUpdate` (no `bestmove` yet). */
export function updateToSnapshot(
	update: AnalysisUpdate,
	fen: string,
	bestmove: string | null = null
): EvalSnapshot {
	const stm: Color = sideToMove(fen) ?? "w";
	const lines = update.lines.map((l) => toLine(l, fen, stm));
	const top = lines[0];
	const topWdl = update.lines[0]?.wdl;
	const snap: EvalSnapshot = {
		fen,
		sideToMove: stm,
		requestId: update.id,
		evalBar: top ? evalBarFor(top.score, stm) : 0,
		scoreText: top?.scoreText ?? "",
		lines,
		depth: update.depth,
		nodes: update.nodes,
		nps: update.nps,
		timeMs: update.timeMs,
		bestmove,
	};
	if (update.seldepth !== undefined) snap.seldepth = update.seldepth;
	if (topWdl) {
		const [w, d, l] = topWdl;
		snap.wdl = stm === "w" ? { w, d, l } : { w: l, d, l: w };
	}
	return snap;
}

/** Snapshot of a finished search (`result.final` plus its `bestmove`). */
export function toEvalSnapshot(result: AnalysisResult, fen: string): EvalSnapshot {
	return updateToSnapshot(result.final, fen, result.bestmove);
}
