/**
 * The preview planner (§9.3a): a candidate piece turned into a complete, always-resolvable
 * selection — click or drag style, a hover over one of its destinations, then a switch to the
 * committed piece or a deselect first.
 */
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { CLICK, PREVIEW, SAMPLING } from "../constants";
import { clampIntoRect, lastPoint, pathMs, sampleRange, smallRect } from "../geometry";
import { generatePath } from "../path-generator";
import { clickReleasePoint, samplePointInRect } from "../sampling";
import type {
	BoardGeometry,
	ClickStyle,
	MotorProfile,
	MoveCandidate,
	Occupancy,
	PathPoint,
	PreviewSelection,
	Pt,
	Rect,
} from "../types";
import { type DeselectChoice, deselectSquare } from "./deselect";

export interface PreviewPlanInput {
	cursor: Pt;
	candidates: readonly MoveCandidate[];
	committed: { from: Square; to: Square };
	geometry: BoardGeometry;
	legalDestinations(sq: Square): Square[];
	/** Adapter placement; without it deselect squares are inferred from `legalDestinations`. */
	occupancy?: (sq: Square) => Occupancy;
	profile: MotorProfile;
	/** Budget for approach + hold + drag + hover + dwell + deselect. */
	maxMs: number;
	/** Pieces previewed earlier in this move (the same move is never previewed twice). */
	exclude?: readonly Square[];
	/** Piece still selected from an earlier `switch`-resolved preview; its destinations are banned. */
	selected?: Square | null;
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
 * Plan one preview selection, or `null` when nothing previewable fits.
 * The previewed piece is a different candidate with probability 0.8 (drawn
 * from the runner-up distribution), else the committed piece (hesitation form).
 */
export function planPreview(input: PreviewPlanInput, rng: Rng): PreviewSelection | null {
	const { committed, geometry, legalDestinations, profile, occupancy } = input;
	const chosen = choosePiece(input, rng);
	if (!chosen) return null;
	const { piece, dests, hoverSquare, isCommittedPiece } = chosen;

	// `switch` is only safe when the committed press is not a legal destination of the piece.
	const wantSwitch =
		!isCommittedPiece && !dests.includes(committed.from) && rng.chance(PREVIEW.switchProb);
	let choice: DeselectChoice | null = null;
	if (!wantSwitch) {
		choice = deselectSquare(piece, dests, committed, legalDestinations, occupancy, rng);
		if (choice === null) return null;
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
	const pressAt = lastPoint(approach, press);
	const holdMs = sampleRange(profile.pressHoldMs, rng);
	const prePressMs = sampleRange(CLICK.prePressPauseMs, rng);
	let fixed = pathMs(approach) + prePressMs + holdMs;

	let release: Pt;
	let drag: DragExcursion | undefined;
	if (style === "drag") {
		drag = dragExcursion(pressAt, pieceRect, profile, rng);
		release = drag.release;
		fixed += drag.ms;
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
	const hoverPoint = lastPoint(hoverPath, hoverTarget);
	fixed += pathMs(hoverPath);

	let deselect: DeselectClick | undefined;
	if (choice !== null) {
		deselect = deselectClick(hoverPoint, choice, geometry, profile, rng);
		fixed += deselect.ms;
	}

	let dwellMs = sampleRange(PREVIEW.dwellMs, rng);
	if (fixed + dwellMs > input.maxMs) dwellMs = input.maxMs - fixed;
	if (dwellMs < PREVIEW.dwellMs[0]) return null;

	const selection: PreviewSelection = {
		piece,
		pieceRect,
		style,
		resolve: choice === null ? "switch" : choice.resolve,
		hoverSquare,
		hoverPoint,
		hoverPath,
		approach,
		press: pressAt,
		release,
		prePressMs,
		holdMs,
		dwellMs,
		isCommittedPiece,
		totalAfterApproachMs: fixed - pathMs(approach) + dwellMs,
	};
	if (drag) {
		selection.dragPath = drag.path;
		selection.grabDelayMs = drag.grabDelayMs;
		selection.settleMs = drag.settleMs;
	}
	if (deselect) selection.deselect = deselect.click;
	return selection;
}

interface ChosenPiece {
	piece: Square;
	dests: Square[];
	/** The destination the hand drifts over: the likeliest one, else any legal one. */
	hoverSquare: Square;
	isCommittedPiece: boolean;
}

/** The piece to preview: a pressable runner-up, else the committed piece itself. */
function choosePiece(input: PreviewPlanInput, rng: Rng): ChosenPiece | null {
	const { committed, legalDestinations } = input;
	const exclude = new Set<Square>(input.exclude ?? []);
	const selected = input.selected ?? null;
	// Pressing a legal destination of the currently selected piece would play that move.
	const selectedDests = new Set<Square>(selected === null ? [] : legalDestinations(selected));
	const pressable = (sq: Square): boolean =>
		!exclude.has(sq) && !selectedDests.has(sq) && legalDestinations(sq).length > 0;

	const pieces = byPiece(input.candidates);
	const others: Square[] = [];
	const weights: number[] = [];
	for (const [sq, v] of pieces) {
		if (sq === committed.from || !pressable(sq)) continue;
		others.push(sq);
		weights.push(v.weight);
	}
	const committedOk = pressable(committed.from);
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
	return { piece, dests, hoverSquare, isCommittedPiece };
}

interface DragExcursion {
	/** Out 8–40 px and back, dispatched while the button is held. */
	path: PathPoint[];
	release: Pt;
	grabDelayMs: number;
	settleMs: number;
	/** The excursion's share of the preview's fixed time. */
	ms: number;
}

/** A drag-style preview's held excursion: out a little and back, never leaving the origin. */
function dragExcursion(
	pressAt: Pt,
	pieceRect: Rect,
	profile: MotorProfile,
	rng: Rng
): DragExcursion {
	const disp = sampleRange(PREVIEW.dragDisplacementPx, rng);
	const angle = rng.next() * 2 * Math.PI;
	// The executor must release immediately on cancellation. Keep the entire held
	// path inside the origin, not just its final point, so that release cannot move.
	const contain = (points: PathPoint[]): PathPoint[] =>
		points.map((point) => ({
			...point,
			...clampIntoRect(point, pieceRect, PREVIEW.dragBoundaryPadPx),
		}));
	const outPt = clampIntoRect(
		{ x: pressAt.x + Math.cos(angle) * disp, y: pressAt.y + Math.sin(angle) * disp },
		pieceRect,
		PREVIEW.dragBoundaryPadPx
	);
	const outPath = contain(
		generatePath(pressAt, outPt, smallRect(outPt, PREVIEW.dragTargetRectPx), profile, rng)
	);
	const outEnd = lastPoint(outPath, outPt);
	const pad = (pieceRect.width * (1 - SAMPLING.release.innerFrac)) / 2;
	const back = clampIntoRect(
		{
			x: pressAt.x + rng.normal(0, PREVIEW.dragReturnSigmaPx),
			y: pressAt.y + rng.normal(0, PREVIEW.dragReturnSigmaPx),
		},
		pieceRect,
		pad
	);
	const backPath = contain(generatePath(outEnd, back, pieceRect, profile, rng));
	// Consider the excursion before taking it back. The hand already checks cancellation
	// throughout path waits; storing this in the return leg also accounts for it in maxMs.
	const returnStart = backPath[0];
	if (returnStart) returnStart.dtMs += sampleRange(PREVIEW.dragReconsiderMs, rng);
	const path = [...outPath, ...backPath];
	const grabDelayMs = sampleRange(profile.grabDelayMs, rng);
	const settleMs = sampleRange(profile.releaseSettleMs, rng);
	return {
		path,
		release: lastPoint(path, back),
		grabDelayMs,
		settleMs,
		ms: pathMs(path) + grabDelayMs + settleMs,
	};
}

interface DeselectClick {
	click: NonNullable<PreviewSelection["deselect"]>;
	/** The click's share of the preview's fixed time. */
	ms: number;
}

/** The click that clears the selection on `choice`'s square. */
function deselectClick(
	from: Pt,
	choice: DeselectChoice,
	geometry: BoardGeometry,
	profile: MotorProfile,
	rng: Rng
): DeselectClick {
	const dRect = geometry.squareRect(choice.square);
	const dTarget = samplePointInRect(dRect, SAMPLING.press.sigmaFrac, SAMPLING.press.innerFrac, rng);
	const dPath = generatePath(from, dTarget, dRect, profile, rng);
	const dPress = lastPoint(dPath, dTarget);
	const dHold = sampleRange(profile.pressHoldMs, rng);
	const dPrePress = sampleRange(CLICK.prePressPauseMs, rng);
	const click: DeselectClick["click"] = {
		square: choice.square,
		press: dPress,
		release: clickReleasePoint(dPress, rng),
		path: dPath,
		prePressMs: dPrePress,
		holdMs: dHold,
	};
	if (choice.occupancy) click.occupancy = choice.occupancy;
	return { click, ms: pathMs(dPath) + dPrePress + dHold };
}

/** The square left selected after `pv` resolves (what the next press must respect). */
export function selectedAfter(pv: PreviewSelection): Square | null {
	if (pv.resolve === "switch") return pv.piece;
	if (pv.resolve === "switch-to-idle") return pv.deselect?.square ?? null;
	return null;
}
