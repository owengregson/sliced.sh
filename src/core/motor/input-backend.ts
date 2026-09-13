/**
 * Transport-agnostic input backend (§9.3, §9.8). The hand controller computes
 * every path and press on an absolute schedule and hands each event to the
 * backend with its due time (`atMs`, epoch ms on the controller's clock);
 * the backend waits until then, dispatches, and resolves once the event has
 * been acknowledged. v2.0 ships `CdpInputBackend`; the native host of §9.8
 * implements the same interface.
 */

import type { MouseButton, PathPoint, Pt } from "./types";

export interface InputBackend {
	/**
	 * Free move (`buttons: 0`) or, while pressed, a drag move (`buttons: 1`, or `2` while a line
	 * preview holds the right button). An abort during the wait throws `AbortedError` without
	 * dispatching.
	 */
	move(p: Pt, atMs: number, signal?: AbortSignal): Promise<void>;
	/** `button` defaults to `left`; `right` is only ever a line preview's arrow drag. */
	press(
		p: Pt,
		atMs: number,
		signal?: AbortSignal,
		beforePress?: () => void,
		button?: MouseButton
	): Promise<void>;
	/** Never aborted: the abort path itself releases at the current point. `button` as for `press`. */
	release(p: Pt, atMs: number, button?: MouseButton): Promise<void>;
	/**
	 * Dispatch a path on an absolute schedule (`dtMs` after the previous point,
	 * drift-corrected, re-anchored after a stall). `beforePoint` runs before every
	 * dispatch and may throw to stop the travel (the focus gate).
	 */
	travel(path: readonly PathPoint[], signal?: AbortSignal, beforePoint?: () => void): Promise<void>;
	/** Where the backend last put the cursor. */
	position(): Pt;
	/** §13.2 `PointerOffset`: path length dispatched so far (px), when the backend tracks it. */
	travelledPx?(): number;
	/** `true` while the left button is held. */
	pressed(): boolean;
	/**
	 * Every button currently held, as the `buttons` bitmask the backend last dispatched (`CDP.mouse`
	 * bits). A backend that only ever tracks the left button may omit it; `pressed()` then answers.
	 */
	pressedButtons?(): number;
	dispose(): void;
}
