/**
 * The line preview (owner, 2026-09-12; `LINE_PREVIEW`): on a long think the hand occasionally
 * maps out the line it is considering the way a player previews a sequence before moving —
 * one **right-button** drag per ply of the chosen move's PV (our move, their reply, our next
 * move …), which chess.com renders as an arrow, with a human pause between arrows and a longer
 * look at the finished line; sometimes a second line (an alternative candidate's PV) after a
 * pause. The move's own left press then clears every arrow on the site.
 *
 * Pure and seeded: given the recommendation's lines, the fitted timing plan and the persona's
 * motor profile, `planLinePreview` decides whether this move gets a preview and returns the
 * complete gesture (squares and sampled pauses) or `null`. The hand generates the actual pointer
 * paths at draw time from `LinePreviewPlan.seed`, so nothing here — and nothing the gesture does
 * — consumes the move's own motor stream. Eligibility (`linePreviewEligibility`):
 *
 *   - a searched move in `normal` / `long` mode: never a premove, an instant plan, a clock race
 *     or a lone-king race (`fastTouch` is the executor's word for those);
 *   - a think of at least `LINE_PREVIEW.minThinkMs` with at least `minClockMs` on the clock;
 *   - a PV whose first `plies[0]` plies are legal from the position (a PV is validated by
 *     replaying it, never trusted);
 *   - the whole gesture, estimated from the profile's Fitts times plus the sampled pauses, fits
 *     inside the window's scan + preview + decision phases with `marginMs` to spare;
 *   - the probability draw, `linePreviewProbability(thinkMs)` — skipped under `force`.
 *
 * "Never twice on one move" and the per-game cap are the executor's (`MoveExecutor` keeps the
 * per-game count and the set of previewed moves); this module decides one move at a time.
 */

import { loadPosition } from "@core/chess/fen";
import { playUci } from "@core/chess/san";
import { distance, isSquare } from "@core/chess/squares";
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import type { MoveWindowBudget, TimingMode } from "@typedefs/timing";
import { LINE_PREVIEW } from "./constants";
import { rectCentre, sampleRange } from "./geometry";
import { fittsMs } from "./path-generator";
import type {
	BoardGeometry,
	LinePreviewArrow,
	LinePreviewLine,
	LinePreviewPlan,
	MotorProfile,
	Pt,
} from "./types";

/** How the executor runs the preview: the model (`auto`), forced on for QA/tests, or off. */
export type LinePreviewMode = "auto" | "force" | "off";

/** The slice of a `TimingPlan` the planner reads. */
export interface LinePreviewTiming {
	mode: TimingMode;
	thinkMs: number;
	window: MoveWindowBudget;
	/** `clockRace` / `loneKing` > 0 mark the urgent plans that never preview. */
	features: Record<string, number>;
}

export interface LinePreviewInput {
	fen: string;
	/** The move that will be played; its PV is the line drawn. */
	chosenUci: string;
	/** The recommendation's MultiPV lines (`pvUci` in play order). */
	lines: ReadonlyArray<{ pvUci: readonly string[] }>;
	timing: LinePreviewTiming;
	myClockMs: number;
	/** `true` when the move is entered as a premove or a scramble hold: never previewed. */
	premove?: boolean;
	/** Where the opponent's last-moved piece stands: lines active around it are preferred. */
	lastMoveTo?: Square;
	profile: MotorProfile;
	geometry: BoardGeometry;
	/** Where the hand is when the move is dispatched (the first approach is estimated from here). */
	cursor: Pt;
	/** The stream the hand draws the arrow paths and press points from. */
	seed: string;
	mode?: LinePreviewMode;
}

export interface LinePly {
	from: Square;
	to: Square;
	uci: string;
}

/** `P(preview | eligible)` at `thinkMs`: linear between the `LINE_PREVIEW.probability` knots, flat beyond. */
export function linePreviewProbability(thinkMs: number): number {
	const knots = LINE_PREVIEW.probability;
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (!first || !last) return 0;
	if (thinkMs <= first[0]) return thinkMs < first[0] ? 0 : first[1];
	if (thinkMs >= last[0]) return last[1];
	for (let i = 1; i < knots.length; i++) {
		const a = knots[i - 1];
		const b = knots[i];
		if (!a || !b || thinkMs > b[0]) continue;
		const t = (thinkMs - a[0]) / (b[0] - a[0]);
		return a[1] + t * (b[1] - a[1]);
	}
	return last[1];
}

/**
 * The plies of `pvUci` that are legal in sequence from `fen`, stopped at the first that is not.
 * A PV is replayed rather than trusted: an arrow from a square that holds nothing would be a
 * signature of its own.
 */
export function legalPlies(fen: string, pvUci: readonly string[]): LinePly[] {
	const board = loadPosition(fen);
	if (!board) return [];
	const out: LinePly[] = [];
	for (const uci of pvUci) {
		const from = uci.slice(0, 2);
		const to = uci.slice(2, 4);
		if (!isSquare(from) || !isSquare(to) || !playUci(board, uci)) break;
		out.push({ from, to, uci });
	}
	return out;
}

/**
 * How much of `plies` happens around the opponent's last-moved piece: the plies whose from- or
 * to-square lies within `LINE_PREVIEW.nearRadius` (Chebyshev) of `lastMoveTo`. `0` without one.
 */
export function lineActivityNear(
	plies: readonly LinePly[],
	lastMoveTo: Square | undefined
): number {
	if (!lastMoveTo) return 0;
	let n = 0;
	for (const ply of plies) {
		if (
			distance(ply.from, lastMoveTo).chebyshev <= LINE_PREVIEW.nearRadius ||
			distance(ply.to, lastMoveTo).chebyshev <= LINE_PREVIEW.nearRadius
		)
			n += 1;
	}
	return n;
}

/** The pre-touch budget a preview may be charged to: everything after the orientation, before the approach. */
export function linePreviewBudgetMs(window: MoveWindowBudget): number {
	return Math.max(0, window.scanMs + window.previewMs + window.decisionMs);
}

export type LinePreviewVerdict =
	| { ok: true }
	| {
			ok: false;
			reason: "off" | "mode" | "urgent" | "premove" | "think" | "clock" | "no-line";
	  };

/** The sample-size-free rules; the fit and the probability draw are `planLinePreview`'s. */
export function linePreviewEligibility(
	input: Pick<
		LinePreviewInput,
		"fen" | "chosenUci" | "lines" | "timing" | "myClockMs" | "premove" | "mode"
	>
): LinePreviewVerdict {
	if (input.mode === "off") return { ok: false, reason: "off" };
	const t = input.timing;
	if (t.mode !== "normal" && t.mode !== "long") return { ok: false, reason: "mode" };
	if ((t.features.clockRace ?? 0) > 0 || (t.features.loneKing ?? 0) > 0)
		return { ok: false, reason: "urgent" };
	if (input.premove === true) return { ok: false, reason: "premove" };
	if (t.thinkMs < LINE_PREVIEW.minThinkMs) return { ok: false, reason: "think" };
	if (input.myClockMs < LINE_PREVIEW.minClockMs) return { ok: false, reason: "clock" };
	const line = chosenLine(input.chosenUci, input.lines);
	if (!line || legalPlies(input.fen, line.pvUci).length < LINE_PREVIEW.plies[0])
		return { ok: false, reason: "no-line" };
	return { ok: true };
}

/** The line whose first ply is the chosen move (a book / premove choice has none). */
function chosenLine(
	chosenUci: string,
	lines: ReadonlyArray<{ pvUci: readonly string[] }>
): { pvUci: readonly string[] } | null {
	return lines.find((l) => l.pvUci[0] === chosenUci) ?? null;
}

interface Estimator {
	profile: MotorProfile;
	geometry: BoardGeometry;
	rng: Rng;
}

/** One arrow with its pauses sampled and its duration estimated from `cursor` (Fitts + allowances). */
function sampleArrow(
	ply: LinePly,
	cursor: Pt,
	last: boolean,
	e: Estimator
): { arrow: LinePreviewArrow; end: Pt } {
	const fromRect = e.geometry.squareRect(ply.from);
	const toRect = e.geometry.squareRect(ply.to);
	const fromCentre = rectCentre(fromRect);
	const toCentre = rectCentre(toRect);
	const approachMs =
		fittsMs(
			Math.hypot(fromCentre.x - cursor.x, fromCentre.y - cursor.y),
			fromRect.width,
			e.profile,
			e.rng
		) + LINE_PREVIEW.travelAllowanceMs;
	const dragMs =
		fittsMs(
			Math.hypot(toCentre.x - fromCentre.x, toCentre.y - fromCentre.y),
			toRect.width,
			e.profile,
			e.rng
		) + LINE_PREVIEW.travelAllowanceMs;
	const prePressMs = sampleRange(LINE_PREVIEW.prePressMs, e.rng);
	const pressToDragMs = sampleRange(LINE_PREVIEW.pressToDragMs, e.rng);
	const settleMs = sampleRange(LINE_PREVIEW.releaseSettleMs, e.rng);
	const afterMs = sampleRange(last ? LINE_PREVIEW.afterLineMs : LINE_PREVIEW.betweenArrowsMs, e.rng);
	return {
		arrow: {
			from: ply.from,
			to: ply.to,
			prePressMs,
			pressToDragMs,
			settleMs,
			afterMs,
			estimateMs: approachMs + prePressMs + pressToDragMs + dragMs + settleMs + afterMs,
		},
		end: toCentre,
	};
}

function sampleLine(
	plies: readonly LinePly[],
	cursor: Pt,
	beforeMs: number,
	e: Estimator
): { line: LinePreviewLine; end: Pt } {
	const arrows: LinePreviewArrow[] = [];
	let at = cursor;
	let estimateMs = beforeMs;
	plies.forEach((ply, i) => {
		const { arrow, end } = sampleArrow(ply, at, i === plies.length - 1, e);
		arrows.push(arrow);
		estimateMs += arrow.estimateMs;
		at = end;
	});
	return {
		line: { uci: plies[0]?.uci ?? "", arrows, beforeMs, estimateMs },
		end: at,
	};
}

/**
 * Decide and plan the preview for one move. `null` when the move is not eligible, when the draw
 * says no, or when no length of line fits the budget. Every random choice comes from `rng`,
 * which the executor seeds per move (`…:line`), so the decision never perturbs the motor stream.
 */
export function planLinePreview(input: LinePreviewInput, rng: Rng): LinePreviewPlan | null {
	const verdict = linePreviewEligibility(input);
	if (!verdict.ok) return null;
	const mode = input.mode ?? "auto";
	if (mode !== "force" && !rng.chance(linePreviewProbability(input.timing.thinkMs))) return null;
	const chosen = chosenLine(input.chosenUci, input.lines);
	if (!chosen) return null;
	const plies = legalPlies(input.fen, chosen.pvUci);
	const [minPlies, maxPlies] = LINE_PREVIEW.plies;
	const wanted = Math.min(plies.length, rng.int(minPlies, maxPlies));
	const budget = linePreviewBudgetMs(input.timing.window);
	const restMs = sampleRange(LINE_PREVIEW.restBeforeApproachMs, rng);
	const e: Estimator = { profile: input.profile, geometry: input.geometry, rng };

	// A second line: another candidate whose PV starts differently and is legal for at least the
	// minimum length, drawn as far as its own PV allows (never longer than the first line). Lines
	// that do something around the piece the opponent just moved are preferred, and make a second
	// line more likely in the first place.
	const alternatives = input.lines
		.filter((l) => l.pvUci[0] !== undefined && l.pvUci[0] !== input.chosenUci)
		.map((l) => legalPlies(input.fen, l.pvUci))
		.filter((p) => p.length >= minPlies);
	const activity = alternatives.map((p) => lineActivityNear(p.slice(0, maxPlies), input.lastMoveTo));
	const anyActive = activity.some((a) => a > 0);
	const wantSecond = rng.chance(
		anyActive ? LINE_PREVIEW.nearSecondLineProb : LINE_PREVIEW.secondLineProb
	);
	const second =
		wantSecond && alternatives.length > 0
			? rng.weighted(
					alternatives,
					activity.map((a) => 1 + LINE_PREVIEW.nearWeight * a)
				)
			: null;

	// Fit. A wanted second line is kept as long as any length of the first line leaves room for
	// it (two shorter lines are what a player comparing candidates draws); only when no length
	// does is it dropped, and the first line alone is fitted longest first.
	const fits = (lines: LinePreviewLine[]): LinePreviewPlan | null => {
		const total = lines.reduce((s, l) => s + l.estimateMs, 0) + restMs;
		if (total + LINE_PREVIEW.marginMs > budget) return null;
		return { seed: input.seed, lines, restBeforeApproachMs: restMs, reserveMs: total };
	};
	if (second) {
		for (let n = wanted; n >= minPlies; n--) {
			const first = sampleLine(plies.slice(0, n), input.cursor, 0, e);
			const beforeMs = sampleRange(LINE_PREVIEW.betweenLinesMs, rng);
			const alt = sampleLine(second.slice(0, Math.min(n, second.length)), first.end, beforeMs, e);
			const plan = fits([first.line, alt.line]);
			if (plan) return plan;
		}
	}
	for (let n = wanted; n >= minPlies; n--) {
		const plan = fits([sampleLine(plies.slice(0, n), input.cursor, 0, e).line]);
		if (plan) return plan;
	}
	return null;
}
