/** What the planners hand the hand: candidates, hand actions, preview selections and line previews. */

import type { Square } from "@typedefs/game";
import type { Occupancy, PathPoint, Pt, Rect } from "./geometry";
import type { ClickStyle } from "./profile";

/**
 * One modelled preview selection (§9.3a). Timings are in dispatch order:
 * `approach` → press at `press` → hold `holdMs` → (`dragPath` while held) →
 * release at `release` → `hoverPath` to the destination square → `dwellMs` →
 * optional `deselect` click (path, press/hold/release) → the committed approach.
 */
export interface PreviewSelection {
	piece: Square;
	pieceRect: Rect;
	style: ClickStyle;
	/**
	 * `switch`: the next press (the committed piece) switches the selection;
	 * `deselect`: click an empty / enemy square first, clearing the selection;
	 * `switch-to-idle`: the only safe square was an own piece with no legal moves —
	 * the click selects it (a third selection), and the committed press switches again.
	 * In every mode no press can fire a move other than the committed one.
	 */
	resolve: "switch" | "deselect" | "switch-to-idle";
	/** The previewed piece's destination square the hand drifts over. */
	hoverSquare: Square;
	hoverPoint: Pt;
	hoverPath: PathPoint[];
	/** Path from the current cursor to `press`. */
	approach: PathPoint[];
	press: Pt;
	release: Pt;
	/** Pause between the approach's last point and the press (sampled by the planner). */
	prePressMs: number;
	holdMs: number;
	dwellMs: number;
	/** Drag style only: out 8–40 px and back, dispatched while the button is held. */
	dragPath?: PathPoint[];
	/** Drag style only: press → movement onset and deceleration → release (sampled by the planner). */
	grabDelayMs?: number;
	settleMs?: number;
	deselect?: {
		square: Square;
		press: Pt;
		release: Pt;
		path: PathPoint[];
		prePressMs: number;
		holdMs: number;
		/** Known when the caller supplied `occupancy`. */
		occupancy?: Occupancy;
	};
	/** Hesitation form: the previewed piece is the committed piece itself. */
	isCommittedPiece: boolean;
	/** Every phase after the approach path (hold, drag, hover, dwell, deselect). */
	totalAfterApproachMs: number;
}

/** A MultiPV candidate with its selection probability (§9.3). */
export interface MoveCandidate {
	from: Square;
	to: Square;
	probability: number;
	uci: string;
}

export interface HandAction {
	kind: "rest" | "hover" | "trace" | "feint" | "drift" | "preview";
	target?: Pt;
	rect?: Rect;
	/** Dwell after the path (or the whole duration for a path-less action). */
	dwellMs: number;
	path?: PathPoint[];
	preview?: PreviewSelection;
}

/**
 * The mouse buttons the hand ever uses: `left` for every move, preview selection and click;
 * `right` only for a line preview's arrow drags (`LINE_PREVIEW`), which chess.com renders and
 * which can never move a piece.
 */
export type MouseButton = "left" | "right";

/** One arrow of a line preview: a right-button drag from `from` to `to`, with its sampled pauses. */
export interface LinePreviewArrow {
	from: Square;
	to: Square;
	/** Pause on the from-square before the right press. */
	prePressMs: number;
	/** Right button held still before the drag sets off. */
	pressToDragMs: number;
	/** Settle over the to-square before the release. */
	settleMs: number;
	/** After the release: the pause before the next arrow, or the look at the finished line. */
	afterMs: number;
	/** Whole-arrow estimate (approach + press + drag + release + `afterMs`), for the time bound. */
	estimateMs: number;
}

export interface LinePreviewLine {
	/** UCI of the line's first ply (the candidate it previews), for logs and tests. */
	uci: string;
	arrows: LinePreviewArrow[];
	/** Pause before this line starts (0 for the first line). */
	beforeMs: number;
	/** Whole-line estimate: `beforeMs` plus every arrow's estimate. */
	estimateMs: number;
}

/**
 * A planned line preview (`src/core/motor/line-preview.ts`), drawn by the hand inside the decision
 * phase before the touch is planned. `seed` is the stream the hand draws the arrow paths and press
 * points from, so the gesture never consumes the move's own motor stream.
 */
export interface LinePreviewPlan {
	seed: string;
	lines: LinePreviewLine[];
	/** Rest after the last arrow before the approach (the decision pause absorbs it). */
	restBeforeApproachMs: number;
	/**
	 * What the gesture is expected to take in all, `restBeforeApproachMs` included: the executor
	 * takes this off the exploration budget so scan/preview hovers make room for it.
	 */
	reserveMs: number;
}
