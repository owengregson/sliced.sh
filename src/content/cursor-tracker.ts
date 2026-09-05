/**
 * `CursorTracker` (Task 21, §13.5): passive capture-phase `pointermove` /
 * `pointerdown` / `pointerup` listeners on `window` that record only
 * *trusted* pointer events (the real mouse). It reports the last sample as
 * `{ x, y, t, real: true }` on request, posts samples to the game port at a
 * bounded rate (`pointermove` no more than once per
 * `TIMINGS.cursorReportIntervalMs`; presses and releases always), and counts
 * real pointer events while the virtual hand is active so the service
 * worker can tell the user touched the mouse mid-execution.
 *
 * Nothing here dispatches events or reads page storage.
 */

import { TIMINGS } from "@core/constants/timings";

export interface CursorSample {
	x: number;
	y: number;
	t: number;
	real: true;
}

export interface CursorTracker {
	/** Last trusted pointer sample, or `null` before any. */
	report(): CursorSample | null;
	/** Start counting real pointer events (the hand is moving). */
	beginHand(): void;
	/** Stop counting; returns how many real pointer events arrived meanwhile. */
	endHand(): number;
	handActive(): boolean;
	dispose(): void;
}

export interface CursorTrackerOptions {
	window?: Window;
	/** Receives rate-bounded samples (moves throttled; presses/releases always). */
	onSample?: (sample: CursorSample) => void;
	minIntervalMs?: number;
	now?: () => number;
}

const TYPES = ["pointermove", "pointerdown", "pointerup"] as const;

export function createCursorTracker(options: CursorTrackerOptions = {}): CursorTracker {
	const win = options.window ?? window;
	const now = options.now ?? (() => Date.now());
	const minInterval = options.minIntervalMs ?? TIMINGS.cursorReportIntervalMs;
	let last: CursorSample | null = null;
	let lastPosted = Number.NEGATIVE_INFINITY;
	let hand = false;
	let realDuringHand = 0;

	const onPointer = (ev: Event): void => {
		if (!ev.isTrusted) return;
		const pe = ev as PointerEvent;
		if (typeof pe.clientX !== "number" || typeof pe.clientY !== "number") return;
		const t = now();
		last = { x: pe.clientX, y: pe.clientY, t, real: true };
		if (hand) realDuringHand += 1;
		if (!options.onSample) return;
		if (ev.type === "pointermove" && t - lastPosted < minInterval) return;
		lastPosted = t;
		options.onSample(last);
	};
	const opts: AddEventListenerOptions = { capture: true, passive: true };
	for (const type of TYPES) win.addEventListener(type, onPointer, opts);

	return {
		report: () => (last ? { ...last } : null),
		beginHand() {
			hand = true;
			realDuringHand = 0;
		},
		endHand() {
			hand = false;
			const n = realDuringHand;
			realDuringHand = 0;
			return n;
		},
		handActive: () => hand,
		dispose() {
			for (const type of TYPES) win.removeEventListener(type, onPointer, opts);
		},
	};
}
