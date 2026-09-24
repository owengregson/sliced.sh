/** One committed move as the executor receives it. */

import type { BoardGeometryReply } from "@core/constants/messages";
import type { PromoPiece, Site, Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { MotorRepertoireContext } from "../repertoire";
import type { Pt, Rect } from "./geometry";
import type { LinePreviewPlan, MoveCandidate } from "./gestures";
import type { MotorProfile } from "./profile";

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
