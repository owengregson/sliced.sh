/**
 * §9.5: report the board's rect whenever the page moves or resizes it. The hand plans a whole
 * drag from one geometry read, so a reflow mid-drag — which is exactly what the debugger's
 * infobar causes when the user arms during a game (owner's live test, 2026-09-09) — leaves every
 * remaining path point in the old coordinate space and drops the piece on the wrong square.
 *
 * A `ResizeObserver` on the board catches the board being resized, one on the document element
 * catches the viewport changing height (the infobar) even when the board keeps its size, and the
 * window's `resize` / `scroll` catch the rest — the rect is viewport-relative, so a scroll moves
 * it. All passive reads: nothing is dispatched, stored or defined on the page (§13.3).
 */

import { EXECUTOR } from "@core/constants/cdp";
import { rectShiftPx } from "@core/motor/geometry";
import type { Rect } from "../contract";
import { animationFrameOf, resizeObserverOf } from "./page-constructors";

export interface BoardRectWatchHost {
	readonly win: Window;
	readonly doc: Document;
	boardElement(): Element | null;
	getBoardRect(): Rect | null;
	destroyed(): boolean;
	/** Where the watch's own teardown goes (the adapter's lifetime disposers, in install order). */
	addDisposer(fn: () => void): void;
}

export class BoardRectWatch {
	private readonly cbs = new Set<(rect: Rect) => void>();
	/** The watch is installed on the first subscription, once. */
	private installed = false;
	private observer: ResizeObserver | null = null;
	private target: Element | null = null;
	private last: Rect | null = null;

	constructor(private readonly host: BoardRectWatchHost) {}

	subscribe(cb: (rect: Rect) => void): () => void {
		this.cbs.add(cb);
		this.install();
		return () => {
			this.cbs.delete(cb);
		};
	}

	/** Point the rect observer at the current board (and the document element) after a replacement. */
	retarget(): void {
		const observer = this.observer;
		if (!observer) return;
		const board = this.host.boardElement();
		if (board !== null && board === this.target) return;
		observer.disconnect();
		this.target = board;
		if (board) observer.observe(board);
		// The infobar changes the viewport's height without necessarily resizing the board element.
		const root = this.host.doc.documentElement;
		if (root) observer.observe(root);
	}

	/** Drop every subscriber (the adapter is being destroyed). */
	clear(): void {
		this.cbs.clear();
	}

	private install(): void {
		const { host } = this;
		if (this.installed || host.destroyed()) return;
		this.installed = true;
		const win = host.win;
		const report = (): void => this.report();
		// `scroll` fires far more often than the board moves, so it is coalesced per animation frame
		// rather than debounced on a timer: the report feeds the hand's mid-drag reflow guard, so it
		// must land within a frame of the page settling, not 40 ms later. `resize` — the infobar's
		// own signal — and the `ResizeObserver` (already frame-aligned) report at once.
		//
		// **Leading edge**: the first scroll of a burst reports immediately and the rest of that
		// frame is coalesced into one trailing report. Trailing-only cost the guard a whole frame on
		// the very first movement, which is the movement that matters; and the trailing report is
		// what makes the *final* rect of a burst known, without which a board that stopped somewhere
		// new could still look unmoved to the guard. At most two reports per frame either way, and
		// `report` drops the ones that moved nothing.
		let frame: number | null = null;
		let pending = false;
		const raf = animationFrameOf(win);
		const coalesced = (): void => {
			if (!raf) {
				report();
				return;
			}
			if (frame !== null) {
				pending = true;
				return;
			}
			report();
			frame = raf(() => {
				frame = null;
				if (!pending) return;
				pending = false;
				report();
			});
		};
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		win.addEventListener("resize", report, opts);
		win.addEventListener("scroll", coalesced, opts);
		host.addDisposer(() => {
			win.removeEventListener("resize", report, opts);
			win.removeEventListener("scroll", coalesced, opts);
			const cancel = win.cancelAnimationFrame?.bind(win);
			if (frame !== null && cancel) cancel(frame);
			frame = null;
			pending = false;
		});
		const Observer = resizeObserverOf(win);
		if (Observer) {
			const observer = new Observer(report);
			this.observer = observer;
			host.addDisposer(() => {
				observer.disconnect();
				this.observer = null;
				this.target = null;
			});
			this.retarget();
		}
		// The baseline: the service worker needs one rect before it can tell a change from a first look.
		this.report();
	}

	private report(): void {
		if (this.host.destroyed() || this.cbs.size === 0) return;
		const rect = this.host.getBoardRect();
		if (!rect || !(rect.width > 0)) return;
		const last = this.last;
		// Only real movement: a `scroll` that moved nothing must not rearm the settle window the
		// executor waits on after an attach.
		if (last && rectShiftPx(last, rect) <= EXECUTOR.boardMoveTolerancePx) return;
		this.last = rect;
		for (const cb of [...this.cbs]) cb(rect);
	}
}
