/**
 * Feature computation (Appendix D §2): the 25 named features from the
 * `TimingContext` — MultiPV lines at the feature depth, the chosen move, the
 * clocks and the per-game histories. Pure; the only chess logic is delegated
 * to the Task 5 helpers.
 */

import { parseFen } from "@core/chess/fen";
import { material, nonPawnMaterial } from "@core/chess/material";
import { classifyMove } from "@core/chess/move-classify";
import { phase as phaseOf } from "@core/chess/phase";
import { legalMoves, parseUci } from "@core/chess/san";
import { distance } from "@core/chess/squares";
import { cpEquivalent } from "@core/engine/uci-client";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { Square } from "@typedefs/game";
import { TIMING_CONSTANTS } from "./constants";
import type { Features, GameTimingState, PhaseName, TcClass, TimingContext } from "./types";

const F = TIMING_CONSTANTS.features;

/** `(elo − 1650) / 850` clamped to [−1, 1]. */
export function eloZ(elo: number): number {
	return clamp((elo - F.eloCentre) / F.eloHalfRange, -1, 1);
}

/** Lichess convention on `base + 40·inc`; no clock at all → `"untimed"`. */
export function tcClass(baseSec: number, incSec: number): TcClass {
	if (baseSec <= 0 && incSec <= 0) return "untimed";
	const eff = baseSec + F.incWeight * incSec;
	if (eff < F.bulletMaxBaseEff) return "bullet";
	if (eff < F.blitzMaxBaseEff) return "blitz";
	if (eff < F.rapidMaxBaseEff) return "rapid";
	return "classical";
}

/** `"180+2"` → `[180, 2]`; `"-"` / `"untimed"` / unparsable → `[0, 0]`. */
export function parseTimeControl(tc: string): [number, number] {
	const m = /^\s*(\d+)\s*\+\s*(\d+)\s*$/.exec(tc);
	if (!m) return [0, 0];
	return [Number(m[1]), Number(m[2])];
}

function lineCp(l: EvalLine): number {
	return cpEquivalent(l.score);
}

/** Non-pawn pieces and pawns on the board (the budget controller's `N_rem` inputs). */
export function pieceCounts(fen: string): { pieces: number; pawns: number } {
	const parts = parseFen(fen);
	if (!parts) return { pieces: 0, pawns: 0 };
	let pieces = 0;
	let pawns = 0;
	for (const ch of parts.placement) {
		const c = ch.toLowerCase();
		if (c === "p") pawns++;
		else if (c === "n" || c === "b" || c === "r" || c === "q") pieces++;
	}
	return { pieces, pawns };
}

function cvOf(xs: readonly number[]): number {
	const m = meanOf(xs);
	if (m <= 0) return 0;
	let v = 0;
	for (const x of xs) v += (x - m) ** 2;
	return Math.sqrt(v / xs.length) / m;
}

/** §8.4b item 5: near-constant sub-second replies mark a bot opponent. */
export function isBotPace(oppThinkMs: readonly number[]): boolean {
	const B = TIMING_CONSTANTS.botPace;
	if (oppThinkMs.length < B.minMoves) return false;
	const last = oppThinkMs.slice(-B.minMoves);
	return last.every((ms) => ms < B.maxReplyMs) && cvOf(last) < B.maxCv;
}

function meanOf(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	let s = 0;
	for (const x of xs) s += x;
	return s / xs.length;
}

/** Mean of `ln t_actual − ln t_model_body` over the observed moves (0 at move 1). */
export function myPaceResid(state: Pick<GameTimingState, "paceResiduals"> | undefined): number {
	return state ? meanOf(state.paceResiduals) : 0;
}

export function computeFeatures(
	ctx: TimingContext,
	state?: Pick<GameTimingState, "paceResiduals">
): Features {
	const untimed = tcClass(ctx.baseSec, ctx.incSec) === "untimed";
	const base_s = untimed ? TIMING_CONSTANTS.untimedVirtual.clockS : ctx.baseSec;
	const inc_s = untimed ? TIMING_CONSTANTS.untimedVirtual.incS : ctx.incSec;
	const tc = tcClass(ctx.baseSec, ctx.incSec);
	const base_eff = base_s + F.incWeight * inc_s;
	const clock_s = untimed ? base_s : Math.max(0, ctx.myClockMs / 1000);
	const opp_clock_s = untimed ? base_s : Math.max(0, ctx.oppClockMs / 1000);
	const elo_z = eloZ(ctx.targetElo);

	// Lines / evals (side-to-move POV = our POV: we are to move).
	const lines = ctx.lines;
	const cps = lines.map(lineCp);
	const bestCp = cps[0] ?? 0;
	const secondCp = cps[1] ?? bestCp;
	const chosenIdx = lines.findIndex((l) => l.pvUci[0] === ctx.chosenMove);
	const k = lines.length;
	const chosen_rank = chosenIdx >= 0 ? chosenIdx : k;
	const worstCp = cps.length ? Math.min(...cps) : bestCp;
	const chosenCp = chosenIdx >= 0 ? (cps[chosenIdx] ?? bestCp) : worstCp;
	const chosen_gap = Math.log(1 + Math.max(0, bestCp - chosenCp) / F.decisivenessScaleCp);
	const n_reasonable = Math.max(1, cps.filter((cp) => bestCp - cp <= F.nReasonableCp).length);
	const decisiveness = Math.log(1 + Math.abs(bestCp - secondCp) / F.decisivenessScaleCp);
	const eval_cp = chosenCp;
	const swing = ctx.evalBeforeOppMove === null ? 0 : ctx.evalBeforeOppMove - bestCp;
	const swing_bad = Math.log(1 + Math.max(0, swing) / F.swingScaleCp);
	const swing_good = Math.log(1 + Math.max(0, -swing) / F.swingScaleCp);

	// Move type.
	const prevMove = ctx.moves.length ? ctx.moves[ctx.moves.length - 1] : undefined;
	const cls = classifyMove(ctx.fen, ctx.chosenMove, prevMove);
	const parts = parseUci(ctx.chosenMove);
	const from: Square = parts?.from ?? "a1";
	const to: Square = parts?.to ?? "a1";
	const dist = parts ? distance(parts.from, parts.to).chebyshev : 1;
	const nLegal = Math.max(1, legalMoves(ctx.fen).length);
	const is_only_legal = cls?.isOnlyMove || nLegal === 1 ? 1 : 0;
	const is_forced =
		n_reasonable === 1 && decisiveness > Math.log(1 + F.forcedCp / F.decisivenessScaleCp) ? 1 : 0;
	// Either half puts us "in book": the session's book policy answered (§7.3), or we are early
	// and playing the engine's best move.
	const in_book = ctx.inBook === true || (ctx.ply < F.bookMaxPly && chosenIdx === 0) ? 1 : 0;
	const ponder_hit =
		prevMove !== undefined && ctx.expectedOppReply !== null && prevMove === ctx.expectedOppReply
			? 1
			: 0;
	const is_recapture = cls?.isRecapture ? 1 : 0;
	const premove_eligible = ponder_hit || is_recapture || in_book || is_only_legal ? 1 : 0;

	// Phase / material.
	const npm = nonPawnMaterial(ctx.fen) ?? F.phaseMaterialFull;
	const ph: PhaseName = phaseOf(ctx.fen, ctx.ply) ?? "middlegame";
	const mat = material(ctx.fen);
	const matDiff = mat ? (ctx.myColor === "w" ? mat.diff : -mat.diff) : 0;
	const { pieces, pawns } = pieceCounts(ctx.fen);

	// Clock / pace.
	const pressure = untimed ? 1 : clamp(clock_s / base_eff, 0, 1);
	const expectedUsed = Math.min(1, ctx.ply / (2 * F.expectedMovesN0));
	const budget_used_ratio = untimed ? 0 : clamp(1 - pressure - expectedUsed, -1, 1);
	const oppLast3 = ctx.oppThinkMsHistory.slice(-F.oppPaceMoves).map((ms) => ms / 1000);
	const oppLastS =
		ctx.oppThinkMsHistory.length > 0
			? (ctx.oppThinkMsHistory[ctx.oppThinkMsHistory.length - 1] ?? 0) / 1000
			: 0;
	// Reference allocation for the pace term: the clock-free schedule (no persona dependence).
	const allocRef = Math.max(
		TIMING_CONSTANTS.budget.allocMinS,
		untimed ? base_eff / F.expectedMovesN0 : clock_s / F.expectedMovesN0
	);
	const opp_pace =
		oppLast3.length === 0 || (!untimed && clock_s < F.oppPaceMinClockS)
			? 0
			: clamp(
					Math.log(meanOf(oppLast3) + F.oppPaceOffsetS) - Math.log(allocRef + F.oppPaceOffsetS),
					-F.oppPaceClamp,
					F.oppPaceClamp
				);

	return {
		elo_z,
		tc,
		log_base_eff: Math.log(base_eff),
		inc_s,
		log_clock: Math.log(Math.max(F.clockFloorS, clock_s)),
		pressure,
		clock_ratio: clamp(
			Math.log((clock_s + 1) / (opp_clock_s + 1)),
			-F.clockRatioClamp,
			F.clockRatioClamp
		),
		ply: ctx.ply,
		ply_sq: (ctx.ply / F.plySqScale) ** 2,
		phase: ph,
		phase_c: clamp((F.phaseMaterialFull - npm) / F.phaseMaterialFull, 0, 1),
		phase_mid: ph === "middlegame" ? 1 : 0,
		phase_end: ph === "endgame" ? 1 : 0,
		in_book,
		n_reasonable,
		ln_n_reasonable: Math.log(n_reasonable),
		decisiveness,
		chosen_rank,
		chosen_gap,
		eval_abs: Math.log(1 + Math.abs(eval_cp) / F.evalAbsScaleCp),
		eval_sign: Math.tanh(eval_cp / F.evalSignScaleCp),
		swing_bad,
		swing_good,
		ponder_hit,
		is_capture: cls?.isCapture ? 1 : 0,
		is_recapture,
		is_check: cls?.isCheck ? 1 : 0,
		gives_mate: cls?.givesMate ? 1 : 0,
		is_promotion: cls?.isPromotion ? 1 : 0,
		is_castle: cls?.isCastle ? 1 : 0,
		is_only_legal,
		is_forced,
		n_legal: Math.log(nLegal),
		dist,
		opp_pace,
		opp_last: Math.log(oppLastS + F.oppPaceOffsetS),
		opp_is_bot: isBotPace(ctx.oppThinkMsHistory) ? 1 : 0,
		my_pace_resid: myPaceResid(state),
		budget_used_ratio,
		material_imb: Math.tanh(matDiff / F.materialScale),
		clock_s,
		eval_cp,
		premove_eligible,
		base_eff,
		base_s,
		non_pawn_pieces: pieces,
		pawns,
		from,
		to,
	};
}

/** Numbers only (categoricals one-hot) for `TimingPlan.features` and the log. */
export function featuresToRecord(f: Features): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(f)) {
		if (typeof value === "number") out[key] = value;
	}
	for (const c of ["bullet", "blitz", "rapid", "classical", "untimed"] as const)
		out[`tc_${c}`] = f.tc === c ? 1 : 0;
	for (const p of ["opening", "middlegame", "endgame"] as const)
		out[`phase_${p}`] = f.phase === p ? 1 : 0;
	return out;
}
