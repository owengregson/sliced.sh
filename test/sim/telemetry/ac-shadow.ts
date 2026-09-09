// test/sim/telemetry/ac-shadow.ts
/**
 * The telemetry shadow (Task 33, Part I §13.2, Appendix I): a fake of the
 * chess.com `fps` plugin plus the lichess blur bit, computed **only** from what
 * the simulated page sees — `window` `focus`/`blur`, `document`
 * `visibilitychange`, pointer events (with their `isTrusted`) and the moves
 * the site's own selection model submits. It never reads executor internals.
 *
 * The site half is modelled after chessground / chess.com's board:
 *   - pointerdown on a legal destination of the selected piece plays the move
 *     (click-click); pointerdown on an own piece selects it (switching from
 *     any earlier selection) and starts a drag; anything else clears the
 *     selection;
 *   - pointerup on a different square than the press: a legal destination
 *     plays the move (drag), any other square clears the selection (the piece
 *     snaps back); pointerup on the press square keeps the selection (a click).
 *
 * One `AcObservation` is closed per submitted move. Its period runs from the
 * previous submission (or the shadow's creation) to this submission; the
 * *own-turn* part starts at `positionArrived()`, the way the client's move
 * window opens when the opponent's move lands. Field semantics:
 *   `BlurCount`            blur events in the period
 *   `DidBlurOn…Turn`       a blur before / after `positionArrived`
 *   `DidFocusOn…Turn`      a focus regain before / after `positionArrived`
 *   `DidToggle`            a blur followed by a focus inside the period
 *   `DidSelectMultiplePieces`  more than one distinct piece selected
 *   `EventTrusted`         every event of the committing gesture was trusted
 *   `LastFocusToMoveTime`  submission − last focus regain (absent without one)
 *   `MoveHoldTime`         submission − `positionArrived`
 *   `MoveToFirstBlurTime`  first blur in the period − period start (absent without one)
 *   `PointerOffset`        pointer path length over the period ("continuity")
 *   `TotalBlurTime` / `TotalFocusTime`  split of the period by focus state
 * `lichessBlur` is 1 when any blur fell in the period (lila `blur.ts`).
 */

import type { Occupancy } from "@core/motor/types";
import type { TabDom } from "@test/sim/dom/tab-dom";
import type { Square } from "@typedefs/game";
import type { AcBlob, LichessBlurBit } from "@typedefs/telemetry";

/** The simulated site's board, as the selection model needs it. */
export interface SiteModel {
	/** The square an event target belongs to, `null` off the board. */
	squareOf(target: EventTarget | null): Square | null;
	/** Relative to the side the page plays. */
	occupancy(sq: Square): Occupancy;
	legalDestinations(sq: Square): Square[];
	/** The site applies the move; `false` when it refuses (not our turn, illegal). */
	submit(from: Square, to: Square): boolean;
}

export type PressAction = "select" | "switch" | "deselect" | "move" | "none";

export interface PressRecord {
	square: Square | null;
	releaseSquare: Square | null;
	/** Distance between press and release positions (a click's drift). */
	driftPx: number;
	/**
	 * Pointer moves dispatched between this press and its release. `0` means the gesture was a
	 * click; anything else is a drag (including a preview drag that snaps back to its own
	 * square, whose release is nowhere near the press even though the square is the same).
	 */
	movesDuring: number;
	trusted: boolean;
	/** What the press did in the site model at press time (`move` for a click-click's second press). */
	action: PressAction;
	at: number;
	/** Pointer moves seen in the period before this press. */
	movesBefore: number;
}

export interface AcDiagnostics {
	/** Distinct pieces selected during the period, in order. */
	selections: Square[];
	presses: PressRecord[];
	/** Pointer moves / presses before the committing press. */
	movesBeforeCommit: number;
	pressesBeforeCommit: number;
	/** A piece other than the moved one still selected when the committing press arrived. */
	pendingSelectionAtCommit: Square | null;
	pointerMaxStepPx: number;
	/** Jump from the previous period's last pointer position to this period's first one. */
	pointerFirstStepPx: number | null;
	periodStart: number;
	positionAt: number | null;
	submittedAt: number;
	from: Square;
	to: Square;
}

export interface AcObservation {
	ac: AcBlob;
	lichessBlur: LichessBlurBit;
	diag: AcDiagnostics;
}

export interface AcShadow {
	readonly observations: AcObservation[];
	/** The client's move window opens: the position we are to move in has arrived. */
	positionArrived(at?: number): void;
	onMove(cb: (obs: AcObservation) => void): () => void;
	pendingSelection(): Square | null;
	/** Last pointer position the page saw. */
	pointerPosition(): { x: number; y: number } | null;
	dispose(): void;
}

export interface AcShadowOptions {
	now: () => number;
}

interface Period {
	start: number;
	positionAt: number | null;
	blurCount: number;
	blurredSince: number | null;
	blurTime: number;
	firstBlurAt: number | null;
	lastFocusAt: number | null;
	blurBeforePosition: boolean;
	blurAfterPosition: boolean;
	focusBeforePosition: boolean;
	focusAfterPosition: boolean;
	toggled: boolean;
	selections: Square[];
	presses: PressRecord[];
	moves: number;
	pathPx: number;
	maxStepPx: number;
	firstStepPx: number | null;
}

interface PointerLike {
	isTrusted: boolean;
	clientX: number;
	clientY: number;
	target: EventTarget | null;
}

export function createAcShadow(dom: TabDom, model: SiteModel, options: AcShadowOptions): AcShadow {
	const { now } = options;
	const win = dom.window as unknown as Window;
	const doc = dom.document as unknown as Document;
	const observations: AcObservation[] = [];
	const listeners = new Set<(obs: AcObservation) => void>();
	let focused = true;
	let pointer: { x: number; y: number } | null = null;
	let selected: Square | null = null;
	let dragFrom: Square | null = null;
	let press: PressRecord | null = null;
	let pressPoint: { x: number; y: number } | null = null;
	/** Trust of the gesture that ends up submitting the move. */
	let gestureTrusted = true;
	let period = fresh(now());

	function fresh(start: number): Period {
		return {
			start,
			positionAt: null,
			blurCount: 0,
			blurredSince: focused ? null : start,
			blurTime: 0,
			firstBlurAt: null,
			lastFocusAt: null,
			blurBeforePosition: false,
			blurAfterPosition: false,
			focusBeforePosition: false,
			focusAfterPosition: false,
			toggled: false,
			selections: [],
			presses: [],
			moves: 0,
			pathPx: 0,
			maxStepPx: 0,
			firstStepPx: null,
		};
	}

	const own = (): boolean => period.positionAt !== null;

	function onBlur(): void {
		if (!focused) return;
		focused = false;
		const t = now();
		period.blurCount += 1;
		period.blurredSince = t;
		if (period.firstBlurAt === null) period.firstBlurAt = t;
		if (own()) period.blurAfterPosition = true;
		else period.blurBeforePosition = true;
	}

	function onFocus(): void {
		if (focused) return;
		focused = true;
		const t = now();
		if (period.blurredSince !== null) {
			period.blurTime += t - period.blurredSince;
			period.blurredSince = null;
			period.toggled = true;
		}
		period.lastFocusAt = t;
		if (own()) period.focusAfterPosition = true;
		else period.focusBeforePosition = true;
	}

	function onVisibility(): void {
		// The client only pauses audio on `visibilitychange` (Appendix I); nothing to record.
	}

	function track(e: PointerLike): void {
		const p = { x: e.clientX, y: e.clientY };
		if (pointer) {
			const step = Math.hypot(p.x - pointer.x, p.y - pointer.y);
			if (period.moves === 0 && period.presses.length === 0 && period.firstStepPx === null)
				period.firstStepPx = step;
			period.pathPx += step;
			if (step > period.maxStepPx) period.maxStepPx = step;
		}
		pointer = p;
	}

	function select(sq: Square): PressAction {
		const action: PressAction = selected === null ? "select" : selected === sq ? "none" : "switch";
		if (action !== "none") {
			selected = sq;
			if (!period.selections.includes(sq)) period.selections.push(sq);
		}
		return action;
	}

	function submit(from: Square, to: Square, at: number): boolean {
		if (!model.submit(from, to)) return false;
		selected = null;
		dragFrom = null;
		close(from, to, at);
		return true;
	}

	function onPointerDown(ev: Event): void {
		const e = ev as unknown as PointerLike;
		const at = now();
		track(e);
		const sq = model.squareOf(e.target);
		const record: PressRecord = {
			square: sq,
			releaseSquare: null,
			driftPx: 0,
			movesDuring: 0,
			trusted: e.isTrusted,
			action: "none",
			at,
			movesBefore: period.moves,
		};
		press = record;
		pressPoint = { x: e.clientX, y: e.clientY };
		gestureTrusted = e.isTrusted;
		period.presses.push(record);
		if (sq === null) return;
		if (selected !== null && sq !== selected && model.legalDestinations(selected).includes(sq)) {
			record.action = "move";
			const pending = selected;
			if (!submit(pending, sq, at)) record.action = "none";
			return;
		}
		if (model.occupancy(sq) === "own") {
			record.action = select(sq);
			dragFrom = sq;
			return;
		}
		if (selected !== null) {
			selected = null;
			record.action = "deselect";
		}
	}

	function onPointerUp(ev: Event): void {
		const e = ev as unknown as PointerLike;
		const at = now();
		track(e);
		const sq = model.squareOf(e.target);
		if (press) {
			press.releaseSquare = sq;
			press.movesDuring = period.moves - press.movesBefore;
			if (pressPoint) press.driftPx = Math.hypot(e.clientX - pressPoint.x, e.clientY - pressPoint.y);
		}
		gestureTrusted = gestureTrusted && e.isTrusted;
		const from = dragFrom;
		dragFrom = null;
		if (from === null || sq === null || sq === from) {
			press = null;
			return;
		}
		if (model.legalDestinations(from).includes(sq)) {
			if (press) press.action = "move";
			submit(from, sq, at);
		} else selected = null;
		press = null;
	}

	function onPointerMove(ev: Event): void {
		track(ev as unknown as PointerLike);
		period.moves += 1;
	}

	/** Close the period at a submission and open the next one. */
	function close(from: Square, to: Square, at: number): void {
		const p = period;
		const blurTime = p.blurTime + (p.blurredSince !== null ? at - p.blurredSince : 0);
		const commit = p.presses[p.presses.length - 1];
		const before = p.presses.slice(0, -1);
		const ac: AcBlob = {
			BlurCount: p.blurCount,
			DidBlurOnOpponentTurn: p.blurBeforePosition,
			DidBlurOnOwnTurn: p.blurAfterPosition,
			DidFocusOnOpponentTurn: p.focusBeforePosition,
			DidFocusOnOwnTurn: p.focusAfterPosition,
			DidSelectMultiplePieces: p.selections.length > 1,
			DidToggle: p.toggled,
			EventTrusted: gestureTrusted,
			MoveHoldTime: at - (p.positionAt ?? p.start),
			PointerOffset: p.pathPx,
			TotalBlurTime: blurTime,
			TotalFocusTime: at - p.start - blurTime,
		};
		if (p.lastFocusAt !== null) ac.LastFocusToMoveTime = at - p.lastFocusAt;
		if (p.firstBlurAt !== null) ac.MoveToFirstBlurTime = p.firstBlurAt - p.start;
		const pendingRaw = pendingBefore(commit, before);
		const pendingAtCommit = pendingRaw === from ? null : pendingRaw;
		const obs: AcObservation = {
			ac,
			lichessBlur: p.blurCount > 0 ? 1 : 0,
			diag: {
				selections: [...p.selections],
				presses: [...p.presses],
				movesBeforeCommit: commit ? commit.movesBefore : p.moves,
				pressesBeforeCommit: before.length,
				pendingSelectionAtCommit: pendingAtCommit,
				pointerMaxStepPx: p.maxStepPx,
				pointerFirstStepPx: p.firstStepPx,
				periodStart: p.start,
				positionAt: p.positionAt,
				submittedAt: at,
				from,
				to,
			},
		};
		observations.push(obs);
		period = fresh(at);
		gestureTrusted = true;
		for (const l of [...listeners]) l(obs);
	}

	/** The selection in force when the committing press arrived: the last piece selected before it, unless a deselect cleared it. */
	function pendingBefore(commit: PressRecord | undefined, before: PressRecord[]): Square | null {
		if (!commit) return null;
		let pending: Square | null = null;
		for (const r of before) {
			// A press whose release landed on another square is a drag; when it did not submit a
			// move the piece snaps back and the selection goes with it (`onPointerUp`).
			const snappedBack =
				r.square !== null && r.releaseSquare !== null && r.releaseSquare !== r.square;
			if (r.action === "select" || r.action === "switch") pending = snappedBack ? null : r.square;
			else if (r.action === "deselect" || snappedBack) pending = null;
		}
		return pending;
	}

	const opts: AddEventListenerOptions = { capture: true, passive: true };
	win.addEventListener("blur", onBlur, opts);
	win.addEventListener("focus", onFocus, opts);
	doc.addEventListener("visibilitychange", onVisibility, opts);
	win.addEventListener("pointermove", onPointerMove, opts);
	win.addEventListener("pointerdown", onPointerDown, opts);
	win.addEventListener("pointerup", onPointerUp, opts);

	return {
		observations,
		positionArrived(at) {
			period.positionAt = at ?? now();
		},
		onMove(cb) {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
		pendingSelection: () => selected,
		pointerPosition: () => (pointer ? { ...pointer } : null),
		dispose() {
			win.removeEventListener("blur", onBlur, opts);
			win.removeEventListener("focus", onFocus, opts);
			doc.removeEventListener("visibilitychange", onVisibility, opts);
			win.removeEventListener("pointermove", onPointerMove, opts);
			win.removeEventListener("pointerdown", onPointerDown, opts);
			win.removeEventListener("pointerup", onPointerUp, opts);
			listeners.clear();
		},
	};
}
