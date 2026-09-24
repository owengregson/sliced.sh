/**
 * Heuristic prior table (§7.2 step 8; Appendix E §3.3/§3.4) — pure and
 * deterministic: multiplicative on a base of 1.0 per candidate line, detected
 * with `classifyMove` plus a short walk of each line's PV. Never uses the rng.
 */

import { loadPosition } from "@core/chess/fen";
import { parseUci } from "@core/chess/san";
import type { EvalLine } from "@typedefs/engine";
import { SELECTION_CONSTANTS as C } from "./constants";
import { cpEffective, effectiveElo } from "./elo-map";
import { findKing, hasQueen } from "./prior/board";
import { type PriorBreakdown, type PriorEnv, priorForLine } from "./prior/rules";
import { simplificationFactors } from "./simplification";
import type { PriorContext } from "./types";

export type { PriorBreakdown, PriorTerm } from "./prior/rules";

/** Per-line prior breakdown keyed by UCI (1.0 with no terms for unparseable lines). */
export function heuristicPriorDetailed(
	fen: string,
	lines: readonly EvalLine[],
	ctx: PriorContext
): Map<string, PriorBreakdown> {
	const out = new Map<string, PriorBreakdown>();
	const chess = loadPosition(fen);
	if (!chess) {
		for (const line of lines) {
			const uci = line.pvUci[0];
			if (uci !== undefined) out.set(uci, { value: 1, terms: [] });
		}
		return out;
	}
	const us = chess.turn();
	let bestCp = Number.NEGATIVE_INFINITY;
	for (const line of lines) bestCp = Math.max(bestCp, cpEffective(line.score));
	const prevOwnUci = ctx.state.previousOwnMoves[ctx.state.previousOwnMoves.length - 1];
	const queensOn = { w: hasQueen(chess, "w"), b: hasQueen(chess, "b") };
	const bestCpSafe = Number.isFinite(bestCp) ? bestCp : 0;
	const env: PriorEnv = {
		fen,
		chess,
		us,
		E: effectiveElo(ctx.targetElo, ctx.form),
		ply: ctx.ply,
		phase: ctx.phase,
		lastMove: ctx.lastMove,
		prevOwn: prevOwnUci === undefined ? null : parseUci(prevOwnUci),
		bestCp: bestCpSafe,
		inCheck: chess.inCheck(),
		queensOn,
		kingSquare: findKing(chess, us),
		wonEndgame:
			ctx.phase === "endgame" && !queensOn.w && !queensOn.b && bestCpSafe >= C.endgame.wonCp,
	};
	const simplification = simplificationFactors(fen, lines, ctx.phase);
	for (const line of lines) {
		const uci = line.pvUci[0];
		if (uci === undefined) continue;
		const breakdown = priorForLine(line, env);
		const factor = simplification.get(uci);
		if (factor !== undefined) {
			breakdown.value *= factor;
			breakdown.terms.push({ rule: "endgame-simplification", factor });
		}
		out.set(uci, breakdown);
	}
	return out;
}

/** `heuristicPrior(fen, lines, ctx) → Map<uci, prior>` (Appendix E §3.4). */
export function heuristicPrior(
	fen: string,
	lines: readonly EvalLine[],
	ctx: PriorContext
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [uci, b] of heuristicPriorDetailed(fen, lines, ctx)) out.set(uci, b.value);
	return out;
}
