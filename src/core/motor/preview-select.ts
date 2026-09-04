/**
 * Preview selections (§9.3a, V2.1): the rate model `p_preview` and the
 * planner that turns a candidate piece into a complete, always-resolvable
 * selection (click or drag style, hover over one of its destinations, then
 * switch to the committed piece or deselect first). Never presses a legal
 * destination of the previewed piece unless that is the committed move; drag
 * previews always release on the origin square.
 */

import { distance, squareOf } from "@core/chess/squares";
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { TimingMode } from "@typedefs/timing";
import { CLICK, PREVIEW, SAMPLING } from "./constants";
import { sampleRange } from "./motor-profile";
import { generatePath } from "./path-generator";
import { clampIntoRect, clickReleasePoint, samplePointInRect } from "./sampling";
import type {
	BoardGeometry,
	ClickStyle,
	MotorProfile,
	MoveCandidate,
	PathPoint,
	PreviewSelection,
	Pt,
	Rect,
} from "./types";

export interface PreviewContext {
	persona: PersonaId;
	nReasonable: number;
	thinkMs: number;
	mode: TimingMode;
	myClockMs: number;
	/** `Settings.execution.previewSelectScale` (0 when previews are off). */
	previewScale: number;
}

/** `g(thinkMs)`: 0 below 1 200 ms, 1 at 4 s, 1.6 at 10 s (linear ramps, flat beyond). */
export function thinkRamp(thinkMs: number): number {
	if (thinkMs < PREVIEW.gZeroMs) return 0;
	if (thinkMs <= PREVIEW.gOneMs)
		return (thinkMs - PREVIEW.gZeroMs) / (PREVIEW.gOneMs - PREVIEW.gZeroMs);
	if (thinkMs >= PREVIEW.gMaxMs) return PREVIEW.gMaxValue;
	return (
		1 + ((thinkMs - PREVIEW.gOneMs) / (PREVIEW.gMaxMs - PREVIEW.gOneMs)) * (PREVIEW.gMaxValue - 1)
	);
}

/** `p_preview = clamp(base(persona) · f(n_reasonable) · g(thinkMs) · scale, 0, 0.35)`, gated. */
export function previewProbability(ctx: PreviewContext): number {
	if (ctx.mode === "premove" || ctx.mode === "instant") return 0;
	if (ctx.myClockMs < PREVIEW.clockFloorMs) return 0;
	if (!(ctx.previewScale > 0)) return 0;
	const f = 1 + PREVIEW.fSlope * (Math.max(1, ctx.nReasonable) - 1);
	const p = PREVIEW.base[ctx.persona] * f * thinkRamp(ctx.thinkMs) * ctx.previewScale;
	return Math.min(PREVIEW.cap, Math.max(0, p));
}

export interface PreviewPlanInput {
	cursor: Pt;
	candidates: readonly MoveCandidate[];
	committed: { from: Square; to: Square };
	geometry: BoardGeometry;
	legalDestinations(sq: Square): Square[];
	profile: MotorProfile;
	/** Budget for approach + hold + drag + hover + dwell + deselect. */
	maxMs: number;
	/** Pieces previewed earlier in this move (the same move is never previewed twice). */
	exclude?: readonly Square[];
}

function pathMs(path: readonly PathPoint[]): number {
	let t = 0;
	for (const p of path) t += p.dtMs;
	return t;
}

const ALL_SQUARES: Square[] = [];
for (let r = 0; r < 8; r++)
	for (let f = 0; f < 8; f++) {
		const sq = squareOf(f, r);
		if (sq) ALL_SQUARES.push(sq);
	}

/** Aggregate candidate probability per from-square, remembering the most likely destination. */
function byPiece(cands: readonly MoveCandidate[]): Map<Square, { weight: number; to: Square }> {
	const out = new Map<Square, { weight: number; to: Square }>();
	const best = new Map<Square, number>();
	for (const c of cands) {
		const p = Math.max(0, c.probability);
		const cur = out.get(c.from);
		if (!cur) {
			out.set(c.from, { weight: p, to: c.to });
			best.set(c.from, p);
			continue;
		}
		cur.weight += p;
		if (p > (best.get(c.from) ?? 0)) {
			best.set(c.from, p);
			cur.to = c.to;
		}
	}
	return out;
}

/**
 * A square whose click resolves the selection: not a legal destination of the
 * previewed piece, not the piece itself, not the committed squares, and with no
 * legal moves of its own (so it is empty, an enemy piece, or an immobile own
 * piece — none of which can turn the committed press into a move). Nearby
 * squares are preferred.
 */
function deselectSquare(
	piece: Square,
	dests: readonly Square[],
	committed: { from: Square; to: Square },
	legalDestinations: (sq: Square) => Square[],
	rng: Rng
): Square | null {
	const banned = new Set<Square>([piece, committed.from, committed.to, ...dests]);
	const pool: Square[] = [];
	const weights: number[] = [];
	for (const sq of ALL_SQUARES) {
		if (banned.has(sq) || legalDestinations(sq).length > 0) continue;
		const d = distance(piece, sq).chebyshev;
		pool.push(sq);
		weights.push(d <= PREVIEW.deselectMaxDistance ? 1 / (1 + d) : 0.05 / (1 + d));
	}
	return pool.length === 0 ? null : rng.weighted(pool, weights);
}

function smallRect(p: Pt, size: number): Rect {
	return { left: p.x - size / 2, top: p.y - size / 2, width: size, height: size };
}

const last = (path: readonly PathPoint[], fallback: Pt): Pt => {
	const p = path[path.length - 1];
	return p ? { x: p.x, y: p.y } : { x: Math.round(fallback.x), y: Math.round(fallback.y) };
};

/**
 * Plan one preview selection, or `null` when nothing previewable fits.
 * The previewed piece is a different candidate with probability 0.8 (drawn
 * from the runner-up distribution), else the committed piece (hesitation form).
 */
export function planPreview(input: PreviewPlanInput, rng: Rng): PreviewSelection | null {
	const { committed, geometry, legalDestinations, profile } = input;
	const exclude = new Set<Square>(input.exclude ?? []);
	const pieces = byPiece(input.candidates);
	const others: Square[] = [];
	const weights: number[] = [];
	for (const [sq, v] of pieces) {
		if (sq === committed.from || exclude.has(sq) || legalDestinations(sq).length === 0) continue;
		others.push(sq);
		weights.push(v.weight);
	}
	const committedOk = !exclude.has(committed.from) && legalDestinations(committed.from).length > 0;
	let piece: Square;
	if (
		others.length > 0 &&
		weights.some((w) => w > 0) &&
		(!committedOk || rng.chance(PREVIEW.differentPieceProb))
	)
		piece = rng.weighted(others, weights);
	else if (committedOk) piece = committed.from;
	else return null;
	const isCommittedPiece = piece === committed.from;
	const dests = legalDestinations(piece);
	const preferredTo = isCommittedPiece ? committed.to : pieces.get(piece)?.to;
	const hoverSquare =
		preferredTo !== undefined && dests.includes(preferredTo) ? preferredTo : rng.pick(dests);

	const resolve: PreviewSelection["resolve"] =
		isCommittedPiece || dests.includes(committed.from) || !rng.chance(PREVIEW.switchProb)
			? "deselect"
			: "switch";
	let dSquare: Square | null = null;
	if (resolve === "deselect") {
		dSquare = deselectSquare(piece, dests, committed, legalDestinations, rng);
		if (dSquare === null) return null;
	}

	const style: ClickStyle = rng.chance(PREVIEW.dragStyleProb) ? "drag" : "click";
	const pieceRect = geometry.squareRect(piece);
	const press = samplePointInRect(
		pieceRect,
		SAMPLING.press.sigmaFrac,
		SAMPLING.press.innerFrac,
		rng
	);
	const approach = generatePath(input.cursor, press, pieceRect, profile, rng);
	const pressAt = last(approach, press);
	const holdMs = sampleRange(profile.pressHoldMs, rng);
	let fixed = pathMs(approach) + sampleRange(CLICK.prePressPauseMs, rng) + holdMs;

	let release: Pt;
	let dragPath: PathPoint[] | undefined;
	if (style === "drag") {
		const disp = sampleRange(PREVIEW.dragDisplacementPx, rng);
		const angle = rng.next() * 2 * Math.PI;
		const outPt = { x: pressAt.x + Math.cos(angle) * disp, y: pressAt.y + Math.sin(angle) * disp };
		const outPath = generatePath(
			pressAt,
			outPt,
			smallRect(outPt, SAMPLING.hover.innerFrac * 8),
			profile,
			rng
		);
		const outEnd = last(outPath, outPt);
		const pad = (pieceRect.width * (1 - SAMPLING.release.innerFrac)) / 2;
		const back = clampIntoRect(
			{
				x: pressAt.x + rng.normal(0, PREVIEW.dragReturnSigmaPx),
				y: pressAt.y + rng.normal(0, PREVIEW.dragReturnSigmaPx),
			},
			pieceRect,
			pad
		);
		const backPath = generatePath(outEnd, back, pieceRect, profile, rng);
		dragPath = [...outPath, ...backPath];
		release = last(dragPath, back);
		fixed +=
			pathMs(dragPath) +
			sampleRange(profile.grabDelayMs, rng) +
			sampleRange(profile.releaseSettleMs, rng);
	} else {
		release = clickReleasePoint(pressAt, rng);
	}

	const hoverRect = geometry.squareRect(hoverSquare);
	const hoverTarget = samplePointInRect(
		hoverRect,
		SAMPLING.hover.sigmaFrac,
		SAMPLING.hover.innerFrac,
		rng
	);
	const hoverPath = generatePath(release, hoverTarget, hoverRect, profile, rng);
	const hoverPoint = last(hoverPath, hoverTarget);
	fixed += pathMs(hoverPath);

	let deselect: PreviewSelection["deselect"];
	if (dSquare !== null) {
		const dRect = geometry.squareRect(dSquare);
		const dTarget = samplePointInRect(dRect, SAMPLING.press.sigmaFrac, SAMPLING.press.innerFrac, rng);
		const dPath = generatePath(hoverPoint, dTarget, dRect, profile, rng);
		const dPress = last(dPath, dTarget);
		const dHold = sampleRange(profile.pressHoldMs, rng);
		deselect = {
			square: dSquare,
			press: dPress,
			release: clickReleasePoint(dPress, rng),
			path: dPath,
			holdMs: dHold,
		};
		fixed += pathMs(dPath) + sampleRange(CLICK.prePressPauseMs, rng) + dHold;
	}

	let dwellMs = sampleRange(PREVIEW.dwellMs, rng);
	if (fixed + dwellMs > input.maxMs) dwellMs = input.maxMs - fixed;
	if (dwellMs < PREVIEW.dwellMs[0]) return null;

	const selection: PreviewSelection = {
		piece,
		pieceRect,
		style,
		resolve,
		hoverSquare,
		hoverPoint,
		hoverPath,
		approach,
		press: pressAt,
		release,
		holdMs,
		dwellMs,
		isCommittedPiece,
		totalAfterApproachMs: fixed - pathMs(approach) + dwellMs,
	};
	if (dragPath) selection.dragPath = dragPath;
	if (deselect) selection.deselect = deselect;
	return selection;
}
