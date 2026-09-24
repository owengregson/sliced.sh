/** The executor's public shapes: its dependencies, its per-game config and the per-move context. */

import type { PreparedPointer } from "@core/constants/cdp";
import type { LinePreviewMode } from "@core/motor/line-preview";
import type { MotorRepertoireContext } from "@core/motor/repertoire";
import type {
	ExecutionResult,
	MotorMoveKind,
	MoveCandidate,
	TimeControlClass,
} from "@core/motor/types";
import type { Scheduler } from "@core/util/scheduler";
import type { BoardRectSource } from "@service/board-watch";
import type { ReplyFor, RequestInput, RequestKind } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { HandOwnership } from "@service/hand-ownership";
import type { Recommendation, Site, Square } from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";
import type { FocusSource } from "../hand/motor";

/** The slice of `ContentLink` the executor needs (geometry + verification requests). */
export interface ExecutorLink {
	/** Whether the pointer mirror is on the page (drawn and not hidden since); absent = no. */
	pointerControlled?(tabId: number): boolean;
	confirmPointer?(tabId: number, pointer: PreparedPointer): Promise<boolean>;
	preparePointer?(
		tabId: number,
		pointer: PreparedPointer,
		signal?: AbortSignal
	): Promise<number | undefined>;
	request<K extends RequestKind>(
		tabId: number,
		cmd: RequestInput<K>,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<ReplyFor<K>>;
}

export interface ExecutorGameConfig {
	persona: PersonaId;
	motorSpeed?: number;
	tcClass: TimeControlClass;
	/** `Settings.execution.previewSelectScale`, 0 when previews are off. */
	previewScale: number;
	/** Seeds the per-game hand (profile offsets, per-move sampling). */
	gameSeed: number | string;
	/** `Settings.execution.verifyMoves` (default true). */
	verifyMoves?: boolean;
	/** `Settings.execution.inputMode` (default `drag`: every committed move a drag). */
	inputMode?: Settings["execution"]["inputMode"];
	/**
	 * The line preview (`LINE_PREVIEW`): `auto` (default) runs the model, `force` skips only its
	 * probability draw (QA / tests — every other rule still applies), `off` never previews.
	 */
	linePreview?: LinePreviewMode;
}

export interface MoveExecutorDeps extends ExecutorGameConfig {
	tabId: number;
	site: Site;
	debugger: DebuggerManager;
	link: ExecutorLink;
	focus: FocusSource;
	ownership: HandOwnership;
	/**
	 * §9.5: the board's rect as the page last reported it. Used for the post-attach settle wait and
	 * handed to the hand as its reflow guard. Omitted: neither runs (the pre-v2.6 behaviour).
	 */
	board?: BoardRectSource;
	now?: () => number;
	scheduler?: Scheduler;
}

/** Per-move context the session knows and the recommendation does not carry. */
export interface MoveContext {
	repertoire?: MotorRepertoireContext;
	myClockMs?: number;
	/** A recovery must observe current square occupancy even when optional move verification is off. */
	requirePositionCheck?: boolean;
	nReasonable?: number;
	candidates?: readonly MoveCandidate[];
	legalDestinations?: (sq: Square) => Square[];
	moveKind?: MotorMoveKind;
	/**
	 * Fix F: this move is being **sent as a premove**, during the opponent's turn. Three things
	 * change. The position guard stops asking whether the destination is free of our own pieces —
	 * a recapture premove is aimed at the very piece the opponent is about to take. Verification is
	 * not attempted at all: a premove does not land until the opponent moves, so `observeMove` would
	 * time out and the retry policy would send the move a second time. And the outcome is
	 * `dispatched`, never `executed`: nothing has been played, and nothing here can even tell
	 * whether the site kept the gesture.
	 */
	queuedPremove?: boolean;
	/**
	 * The scramble hold (`SCRAMBLE_HOLD`): during the opponent's turn the hand carries the piece to
	 * its destination and holds it there until `releaseHold()` (the move is played the moment the
	 * opponent's move landed) or `abandonHold()` (the piece goes back). Like a premove the
	 * destination guard is relaxed — the position it is aimed at does not exist yet — but unlike a
	 * premove the release happens on *our* turn, so the move is verified and reported `executed`.
	 */
	holdUntilReply?: boolean;
	/** How long the hold may wait for the opponent before the piece goes back (default scramble). */
	holdMaxMs?: number;
	/** The opponent's last move: the line preview prefers lines active around its piece. */
	lastMove?: { from: Square; to: Square };
}

export interface ExecutionReport {
	rec: Recommendation;
	result: ExecutionResult;
}
