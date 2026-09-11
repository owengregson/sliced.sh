/**
 * Early capture-phase pointer tracking. Idle trusted samples anchor the next hand;
 * while the virtual pointer is visible, unmatched mouse input is stopped and counted.
 * Prepared browser events bypass that counter and never overwrite the real start point.
 */

import { createPointerControl, POINTER_EVENT_TYPES } from "@content/pointer-control";
import type { PreparedPointer } from "@core/constants/cdp";
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
	setVirtualActive(active: boolean): void;
	prepareVirtualPointer(pointer: PreparedPointer): void;
	virtualPointerDelivered(pointer: PreparedPointer): boolean;
	dispose(): void;
}

export interface CursorTrackerOptions {
	window?: Window;
	/** Receives samples: moves throttled while the hand is idle, everything while it is active. */
	onSample?: (sample: CursorSample) => void;
	minIntervalMs?: number;
	now?: () => number;
}

const SAMPLE_TYPES = new Set(["pointermove", "pointerdown", "pointerup"]);

export function createCursorTracker(options: CursorTrackerOptions = {}): CursorTracker {
	const win = options.window ?? window;
	const now = options.now ?? (() => Date.now());
	const minInterval = options.minIntervalMs ?? TIMINGS.cursorReportIntervalMs;
	let last: CursorSample | null = null;
	let lastPosted = Number.NEGATIVE_INFINITY;
	let hand = false;
	let realDuringHand = 0;
	let virtualActive = false;
	const control = createPointerControl(win, now);

	const onPointer = (ev: Event): void => {
		if (control.filter(ev)) return;
		if (!ev.isTrusted || !SAMPLE_TYPES.has(ev.type)) return;
		const pe = ev as PointerEvent;
		if (typeof pe.clientX !== "number" || typeof pe.clientY !== "number") return;
		const t = now();
		const sample: CursorSample = { x: pe.clientX, y: pe.clientY, t, real: true };
		if (!virtualActive) last = sample;
		if (hand || virtualActive) realDuringHand += 1;
		if (!options.onSample) return;
		if (!hand && !virtualActive && ev.type === "pointermove" && t - lastPosted < minInterval) return;
		lastPosted = t;
		options.onSample(sample);
	};
	const opts: AddEventListenerOptions = { capture: true, passive: false };
	for (const type of POINTER_EVENT_TYPES) win.addEventListener(type, onPointer, opts);

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
		setVirtualActive(active) {
			virtualActive = active;
			control.setActive(active);
		},
		prepareVirtualPointer: (pointer) => control.prepare(pointer),
		virtualPointerDelivered: (pointer) => control.delivered(pointer),
		dispose() {
			control.setActive(false);
			for (const type of POINTER_EVENT_TYPES) win.removeEventListener(type, onPointer, opts);
		},
	};
}
