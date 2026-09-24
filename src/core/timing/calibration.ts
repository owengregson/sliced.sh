/**
 * Reading the think-time calibration (`TIMING_CALIBRATION`): the situation of a move, the log
 * shift of its sampled think and the premove propensities for a rating in a chess.com time class.
 * Pure; the only chess logic is delegated to the chess helpers.
 */

import { loadPosition } from "@core/chess/fen";
import { material } from "@core/chess/material";
import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, parseUci } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import {
	TIMING_CALIBRATION_LIMITS as LIMITS,
	TIMING_CALIBRATION,
	type TimingCalibrationSituation,
	type TimingCalibrationTable,
	type TimingCalibrationTimeClass,
} from "@core/constants/timing-calibration";
import { maiaCalibrationTimeClass } from "@core/strength/maia-calibration";
import { clamp } from "@core/util/clamp";

export type { TimingCalibrationSituation, TimingCalibrationTable, TimingCalibrationTimeClass };

/** chess.com's time class of a clock (the rule the Maia calibration uses). */
export function calibrationTimeClass(baseSec: number, incSec: number): TimingCalibrationTimeClass {
	return maiaCalibrationTimeClass(baseSec * 1000, incSec * 1000);
}

/** Linear between knots, flat outside; `values` has one entry per knot. */
export function interpolateKnots(
	knots: readonly number[],
	values: readonly number[],
	rating: number
): number {
	const n = Math.min(knots.length, values.length);
	const first = values[0];
	if (n === 0 || first === undefined) return 0;
	if (!Number.isFinite(rating) || rating <= (knots[0] ?? 0)) return first;
	for (let i = 1; i < n; i++) {
		const k1 = knots[i] ?? 0;
		if (rating > k1) continue;
		const k0 = knots[i - 1] ?? k1;
		const v0 = values[i - 1] ?? 0;
		const v1 = values[i] ?? v0;
		return k1 > k0 ? v0 + ((rating - k0) / (k1 - k0)) * (v1 - v0) : v1;
	}
	return values[n - 1] ?? first;
}

/** The log shift of the sampled think for `situation` at `rating` (clamped). */
export function thinkShift(
	timeClass: TimingCalibrationTimeClass,
	rating: number,
	situation: TimingCalibrationSituation,
	table: TimingCalibrationTable = TIMING_CALIBRATION
): number {
	const c = table[timeClass];
	return clamp(
		interpolateKnots(c.knots, c.shift[situation], rating),
		LIMITS.shiftMin,
		LIMITS.shiftMax
	);
}

export type PremoveKind = "recapture" | "other";

/**
 * The calibrated premove probability for `kind` at `rating`, scaled by the persona's own premove
 * propensity `personaP` (0.5 = the population mean); `null` when the table keeps the propensity.
 */
export function calibratedPremoveProbability(
	timeClass: TimingCalibrationTimeClass,
	rating: number,
	kind: PremoveKind,
	personaP: number,
	table: TimingCalibrationTable = TIMING_CALIBRATION
): number | null {
	const c = table[timeClass];
	const values = c.premove[kind];
	if (values === null) return null;
	const base = interpolateKnots(c.knots, values, rating);
	const persona = 1 + LIMITS.premovePersona * ((clamp(personaP, 0, 1) - 0.5) / 0.5);
	return clamp(base * persona, LIMITS.premoveMin, LIMITS.premoveMax);
}

/**
 * The premove attempt probabilities the session hands `premoveCandidate` (`PremoveContext.propensity`):
 * the calibrated recapture (`trade`) and other (`ordinary`) values for the rating in the time class,
 * persona-scaled; a kind the table leaves `null` is omitted, so the strength propensity answers.
 */
export function premovePropensity(
	timeClass: TimingCalibrationTimeClass,
	rating: number,
	personaP: number,
	table: TimingCalibrationTable = TIMING_CALIBRATION
): { trade?: number; ordinary?: number; tradeReplyMinProb?: number } {
	const trade = calibratedPremoveProbability(timeClass, rating, "recapture", personaP, table);
	const ordinary = calibratedPremoveProbability(timeClass, rating, "other", personaP, table);
	return {
		// A calibrated trade propensity comes with the trade's own prediction gate
		// (`PREMOVE.tradeReplyMinProb`): the two were fitted together.
		...(trade === null ? {} : { trade, tradeReplyMinProb: PREMOVE.tradeReplyMinProb }),
		...(ordinary === null ? {} : { ordinary }),
	};
}

/** Material balance from `color`'s point of view; null on an invalid FEN. */
function balance(fen: string, color: "w" | "b"): number | null {
	const m = material(fen);
	return m ? (color === "w" ? m.diff : -m.diff) : null;
}

/**
 * Whether `move` in `fen` is an obvious recapture: the last move (`lastMove`, played from
 * `priorFen`) captured on a square, `move` captures back on it, and afterwards the mover's
 * material balance is at least what it was before that capture.
 */
export function isObviousRecapture(
	priorFen: string | null | undefined,
	lastMove: string | undefined,
	fen: string,
	move: string
): boolean {
	if (!priorFen || !lastMove) return false;
	const last = classifyMove(priorFen, lastMove);
	const square = parseUci(lastMove)?.to;
	if (!last?.isCapture || !square) return false;
	const facts = classifyMove(fen, move, lastMove);
	if (!facts?.isRecapture) return false;
	const color = loadPosition(fen)?.turn();
	const after = applyMoves(fen, [move]);
	if (!color || !after) return false;
	const before = balance(priorFen, color);
	const now = balance(after, color);
	return before !== null && now !== null && now >= before;
}

/** Whether any legal move in `fen` is an obvious recapture of `lastMove` (played from `priorFen`). */
export function obviousRecaptureAvailable(
	priorFen: string | null | undefined,
	lastMove: string | undefined,
	fen: string
): boolean {
	if (!priorFen || !lastMove) return false;
	const square = parseUci(lastMove)?.to;
	const board = loadPosition(fen);
	if (!square || !board || !classifyMove(priorFen, lastMove)?.isCapture) return false;
	return board
		.moves({ verbose: true })
		.filter((m) => m.to === square && (m.isCapture() || m.isEnPassant()))
		.some((m) => isObviousRecapture(priorFen, lastMove, fen, `${m.from}${m.to}${m.promotion ?? ""}`));
}

export interface SituationInput {
	isOnlyLegal: boolean;
	inBook: boolean;
	obviousRecapture: boolean;
	inCheck: boolean;
}

/** The calibration situation, most specific first. */
export function calibrationSituation(s: SituationInput): TimingCalibrationSituation {
	if (s.isOnlyLegal) return "forced";
	if (s.inBook) return "book";
	if (s.obviousRecapture) return "recapture";
	if (s.inCheck) return "check";
	return "ordinary";
}
