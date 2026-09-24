/** What one virtual-hand execution did (Task 18 shape). */

import type { Square } from "./board";

/** Result of one virtual-hand execution (Task 18 shape). */
export interface ExecutionResult {
	ok: boolean;
	/**
	 * `dispatched` (Fix F) is a **premove gesture the hand completed during the opponent's turn**.
	 * That is *all* it claims: the drag went out. Whether chess.com kept it as a premove, snapped
	 * the piece back or read it as a selection is not observable from here — nothing in the
	 * executor can see it — so the word is `dispatched` rather than `queued` or `executed`, and the
	 * next position is the only thing that decides which it was. `ok` is true because the hand did
	 * its work; a premove must never be reported as a move that landed.
	 */
	outcome: "executed" | "dispatched" | "skipped" | "paused" | "aborted" | "failed";
	reason?: string;
	/**
	 * How the move was committed: a drag, or — since the owner's 2026-09-11 reversal, as
	 * `Settings.execution.inputMode` — a click-click. The panel's Last-action row and the timing log
	 * name it.
	 */
	tier: "drag" | "click";
	attempts: number;
	endPoint: { x: number; y: number };
	elapsedMs: number;
	/** Epoch start of the hand window; elapsedMs retains the physical hand-window duration. */
	startedAt?: number;
	/** Actual drop/promotion submission, before post-drop rest and verification. */
	submittedAt?: number;
	/** Manual acceleration or a retry must not train the natural timing feedback. */
	paceOverride?: boolean;
	timeline: Array<{ phase: string; startMs: number; endMs: number }>;
	error?: string;
	/** Task 24: epoch ms the execution finished — identifies one result across snapshots (stamped by the executor). */
	at?: number;
	/** SAN of the move this result belongs to (Task 26's Last-action row). */
	san?: string;
	/** §13.2 `PointerOffset`: pointer path length the hand dispatched during this execution, px. */
	pointerOffsetPx?: number;
	/**
	 * §13.2 `DidSelectMultiplePieces`: the squares the hand *pressed* other than the committed
	 * from-square — the preview selections (§9.3a) and any deselect click. With the committed
	 * press these are the distinct pieces the page saw selected in this move window.
	 */
	previewedSquares?: Square[];
	/**
	 * Right-button drags the hand dispatched in this execution — the arrows of a line preview
	 * (`LINE_PREVIEW`). Present only when at least one went out. Not a press in the §13.2 sense:
	 * an arrow selects nothing and can submit nothing, so it is neither in `previewedSquares` nor
	 * behind `pressedAny`.
	 */
	annotations?: number;
	/** The committed press was dispatched — even a skipped/aborted attempt may have landed the move. */
	pressed?: boolean;
	/**
	 * *Any* press was dispatched in this attempt, the §9.3a preview selections included. A preview
	 * press is never `pressed` (it is not the committed press), but it is a real `mousedown` on a
	 * real square: if the window ends between it and its release — a reflow, a focus skip mid-drag —
	 * the page can have seen `down` on one square and `up` on another, which is a submitted move. So
	 * this is the flag that decides whether the board must be looked at before reporting the outcome.
	 */
	pressedAny?: boolean;
}
