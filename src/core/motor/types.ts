/**
 * Motor-core types (§9.3, Appendix G §7.1): geometry, path points, the motor
 * profile, hand actions produced by the exploration planner and the V2.1
 * preview selections (§9.3a). `ExecutionResult` is defined once in
 * `@typedefs/game` (Task 2) and only re-exported here (C1). The `InputBackend`
 * interface belongs to Task 18 (`input-backend.ts`).
 */

import type { BoardGeometryReply } from "@core/constants/messages";
import type { ExecutionResult, PromoPiece, Site, Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { MotorRepertoireContext } from "./repertoire";

export type { ExecutionResult };

export interface Pt {
	x: number;
	y: number;
}

/** Viewport CSS px. */
export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** `dtMs` is the delay BEFORE dispatching this point. */
export interface PathPoint {
	x: number;
	y: number;
	dtMs: number;
}

/** Inclusive `[lo, hi]` range sampled uniformly per move. */
export type MsRange = [number, number];

export type MotorStyle = "bezier" | "wind";
export type ClickStyle = "drag" | "click";
export type TimeControlClass = "bullet" | "blitz" | "rapid" | "classical";
export type MotorMoveKind = "normal" | "premove" | "capture" | "recapture" | "promotion" | "castle";
export type RestStyle = "piece" | "clock" | "offboard" | "mixed";

/** Appendix G §8 defaults plus the V2.1 exploration block and a version for fitted profiles (§9.6). */
export interface MotorProfile {
	version: number;
	/** Time before the hand starts moving after the decision (not think time). */
	reactionMs: MsRange;
	/** Fitts intercept (s) and slope (s/bit). */
	fittsA: number;
	fittsB: number;
	/** 1.0 = model; blitz ≈ 0.75, classical ≈ 1.3. */
	travelSpeedScale: number;
	peakSpeedCapPxPerS: number;
	/** σ of the AR(1) tremor. */
	jitterPx: number;
	overshootProb: number;
	/** Pause with the piece held before dropping. */
	hesitationProb: number;
	/** Second small sub-movement inside the target. */
	microCorrectionProb: number;
	pressHoldMs: MsRange;
	grabDelayMs: MsRange;
	releaseSettleMs: MsRange;
	sampleIntervalMs: number;
	/** Promotion "look" before the picker click; `[0, 0]` for other moves. */
	lookDelayMs: MsRange;
	styleMix: { bezier: number; wind: number };
	exploration: {
		hoverProb: number;
		feintProb: number;
		/** Persona base rate of §9.3a. */
		previewBase: number;
		restStyle: RestStyle;
	};
}

export type HandState =
	| "rest"
	| "orientation"
	| "exploring"
	| "approaching"
	| "grabbing"
	| "dragging"
	| "dropping"
	| "correcting"
	| "promoting"
	/** The piece is carried to its destination and held there, waiting for the opponent's move. */
	| "holding";

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

/** Board geometry supplied by the site adapter (§9.5), viewport CSS px. */
export interface BoardGeometry {
	boardRect: Rect;
	squareRect(sq: Square): Rect;
}

/** What a square holds, from the adapter's placement (used to pick safe deselect clicks). */
export type Occupancy = "own" | "enemy" | "empty";

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

/** What the exploration planner needs beyond the committed move (Task 18 hand controller). */
export interface ExplorationInput {
	/** Optional coherent attention model; caller supplies live tactical and clock context. */
	repertoire?: MotorRepertoireContext;
	candidates: readonly MoveCandidate[];
	nReasonable: number;
	myClockMs: number;
	persona: PersonaId;
	/** `Settings.execution.previewSelectScale`, 0 when previews are off. */
	previewScale: number;
	legalDestinations(sq: Square): Square[];
}

/**
 * A scramble hold's decision source: the hand carries the piece to its destination and then waits
 * on `decide()` with the button down. `release` drops it there (the move is played); `abandon`
 * carries it back to its origin square and lets go there (nothing is played). The executor resolves
 * it from the session's verdict on the opponent's move, from a timeout, or from a cancel.
 */
export interface HoldDirective {
	decide(): Promise<"release" | "abandon">;
}

/** How a committed move is entered on the board (`Settings.execution.inputMode`, resolved per move). */
export type InputStyle = "drag" | "click";

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

export interface ExecutionPlan {
	tabId: number;
	site: Site;
	/** Present for a scramble hold: pause with the piece held over the destination until told. */
	hold?: HoldDirective;
	/** Absent → a drag. `click` clicks the piece, carries the pointer over and clicks the square. */
	style?: InputStyle;
	from: { x: number; y: number; rect: Rect; square: Square };
	to: { x: number; y: number; rect: Rect; square: Square };
	promotion?: PromoPiece;
	motor: MotorProfile;
	/** Live movement-speed multiplier, captured when this gesture starts. */
	motorSpeed?: number;
	/** Last known cursor (the hand owns the pointer, §13.5). */
	startPoint?: Pt;
	expected: { san?: string; uci: string; premove: boolean };
	timeoutMs?: number;
	/** Absent → the pre-touch window is a plain rest (no hovers, no previews). */
	exploration?: ExplorationInput;
	/** A geometry reply the caller already holds (avoids a duplicate read at the start). */
	geometry?: { reply: BoardGeometryReply; readAt: number };
	/** Present when this move gets a line preview (right-button arrows along the PV, `LINE_PREVIEW`). */
	linePreview?: LinePreviewPlan;
}
