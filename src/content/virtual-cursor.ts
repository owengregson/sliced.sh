/**
 * Pointer-mirror relay (Fix D, §13.3 rule 4). The `cursorTo` / `cursorHide`
 * port commands carry points the service worker's hand has already dispatched;
 * this module forwards each one to the MAIN-world bridge, which owns the
 * element — nothing in this world inserts DOM (`Markings.draw`: "no DOM
 * insertion from the adapter").
 *
 * It deliberately reads no pointer event of its own. A point the hand dispatched
 * arrives at the page as a *trusted* event, indistinguishable from the owner's
 * real mouse, so a mirror fed from `CursorTracker` would follow the real cursor
 * and sit on top of it — the one outcome that makes the feature useless.
 *
 * Each position is one fire-and-forget `notify`, not a `call`: the hand
 * dispatches a point every few milliseconds (~45/s measured over a move), and a
 * mirror reply would allocate a pending entry and timer for an answer nobody
 * reads. Separately, controlled mouse input has a pre-dispatch admission request;
 * that acknowledgment is required before the browser receives the event.
 *
 * This is also the only place the mirror is deduplicated, and the only place it
 * *can* be: `drawn` and the element share a lifetime — both live in the tab —
 * whereas the service worker is suspended and rebuilt underneath them, so it
 * posts its hides unconditionally and this decides whether there is anything to
 * erase.
 *
 * Two things were added on 2026-09-13:
 *
 *   - `allowed` — the page-kind gate. On a page that is not a game page the
 *     relay draws nothing: a `cursorTo` is claimed and dropped, so the shield the
 *     first draw would raise never goes up.
 *   - the unlock glide — a hide of a drawn mirror first glides the arrow from
 *     where it is to the owner's real pointer (`realPosition`), over
 *     `CURSOR_UNLOCK.glideMs`, and only then erases it. The interpolated points go
 *     down the same `cursorTo` draw path as the hand's own — drawing only, nothing
 *     is dispatched — and the mirror counts as shown for the whole glide, so the
 *     shield stays up until the arrow has reached the real mouse and the two
 *     cursors swap without a jump. A new `cursorTo` cancels the glide (the hand
 *     took the pointer back); no known real position skips it.
 */

import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/bridge-protocol";
import { POINTER_CONTROL, type PreparedPointer } from "@core/constants/cdp";
import { CURSOR_UNLOCK } from "@core/constants/cursor";
import type { GamePortCommand } from "@core/constants/messages";
import { defaultScheduler, type Scheduler } from "@core/util/scheduler";

export interface VirtualCursor {
	/** Whether the mirror is currently drawn on the page (true for the whole unlock glide). */
	shown(): boolean;
	/** Whether an unlock glide is in progress: still drawn, on its way to the real pointer. */
	gliding(): boolean;
	/** Apply a port command; returns whether it was one of the mirror's. */
	apply(cmd: GamePortCommand): boolean;
	/** Wait until native hit testing can reach the announced virtual coordinate. */
	prepare(pointer: PreparedPointer): Promise<boolean>;
	/** Erase the mirror at once if it is drawn (no glide) and accept nothing further. */
	dispose(): void;
}

export interface Point {
	x: number;
	y: number;
}

export interface VirtualCursorOptions {
	/** Fired when the mirror appears and when it is gone (after the glide, if there was one). */
	onVisibilityChange?: (shown: boolean) => void;
	/** Whether the mirror may be drawn on this page at all; default: always. */
	allowed?: () => boolean;
	/** The owner's real pointer position in viewport CSS px, or `null` when none is known. */
	realPosition?: () => Point | null;
	/** Timers for the glide (tests pass a fake). */
	scheduler?: Scheduler;
}

/** Smooth start and end: the arrow leaves its rest point and settles on the mouse. */
function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** The glide's points from `from` to `to`, exclusive of `from` and inclusive of `to`. */
export function glidePoints(from: Point, to: Point): Point[] {
	const steps = Math.max(1, Math.ceil(CURSOR_UNLOCK.glideMs / CURSOR_UNLOCK.stepMs));
	const out: Point[] = [];
	for (let i = 1; i <= steps; i += 1) {
		const e = i === steps ? 1 : easeInOutCubic(i / steps);
		out.push({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
	}
	return out;
}

export function createVirtualCursor(
	bridge: PageBridge,
	options: VirtualCursorOptions = {}
): VirtualCursor {
	const scheduler = options.scheduler ?? defaultScheduler;
	let drawn = false;
	let disposed = false;
	/** The last point the mirror was told, i.e. where the arrow is. */
	let at: Point | null = null;
	let glideTimer: unknown = null;
	let glideQueue: Point[] = [];

	const send = (kind: string, payload?: unknown): boolean => {
		if (disposed || !bridge.isAvailable() || bridge.notify === undefined) return false;
		bridge.notify(kind, payload);
		return true;
	};

	const cancelGlide = (): void => {
		if (glideTimer !== null) scheduler.clearTimeout(glideTimer);
		glideTimer = null;
		glideQueue = [];
	};

	const hideNow = (): void => {
		if (!drawn) return;
		// Cleared only on a send that actually left: a hide we could not deliver must not be
		// forgotten, or the element stays on the page with nothing left to erase it.
		if (send(BRIDGE_KINDS.cursorHide)) {
			drawn = false;
			at = null;
			options.onVisibilityChange?.(false);
		}
	};

	const glideStep = (): void => {
		glideTimer = null;
		const next = glideQueue.shift();
		if (next === undefined || disposed) {
			cancelGlide();
			hideNow();
			return;
		}
		// The page side going away mid-glide: nothing to move any more, erase what can be erased.
		if (!send(BRIDGE_KINDS.cursorTo, { x: next.x, y: next.y, down: false })) {
			cancelGlide();
			hideNow();
			return;
		}
		at = next;
		if (glideQueue.length === 0) {
			hideNow();
			return;
		}
		glideTimer = scheduler.setTimeout(glideStep, CURSOR_UNLOCK.stepMs);
	};

	/**
	 * The unlock: glide to the real pointer, then hide. Straight to the hide when nothing is
	 * drawn, when no real position is known, when the arrow is already there, or when the page
	 * side cannot be reached (there is nothing to animate on a dead bridge, and the hide is kept
	 * pending exactly as before).
	 */
	const release = (): void => {
		if (!drawn) return;
		if (glideTimer !== null) return; // already on its way
		const real = options.realPosition?.() ?? null;
		if (
			real === null ||
			at === null ||
			!bridge.isAvailable() ||
			(real.x === at.x && real.y === at.y)
		) {
			hideNow();
			return;
		}
		glideQueue = glidePoints(at, real);
		glideTimer = scheduler.setTimeout(glideStep, CURSOR_UNLOCK.stepMs);
	};

	const api: VirtualCursor = {
		shown: () => drawn,
		gliding: () => glideTimer !== null,
		async prepare(pointer) {
			if (disposed) return false;
			// The first accepted point creates the mirror. A hidden mirror has no
			// hit-test shield to open, including when its display setting is off.
			if (!drawn) return true;
			if (!bridge.isAvailable()) return false;
			try {
				const opened = await bridge.call<boolean>(
					BRIDGE_KINDS.cursorPrepare,
					{ x: pointer.x, y: pointer.y },
					POINTER_CONTROL.prepareTimeoutMs
				);
				return opened === true && !disposed && drawn;
			} catch {
				return false;
			}
		},
		apply(cmd) {
			switch (cmd.kind) {
				case "cursorTo":
					// Not a game page: claimed and dropped, so no shield ever goes up here.
					if (options.allowed?.() === false) return true;
					// The hand took the pointer back mid-glide: the arrow continues from where it is.
					cancelGlide();
					if (
						send(BRIDGE_KINDS.cursorTo, {
							x: cmd.x,
							y: cmd.y,
							down: cmd.down,
							...(cmd.effects === false ? { effects: false } : {}),
						})
					) {
						at = { x: cmd.x, y: cmd.y };
						if (!drawn) {
							drawn = true;
							options.onVisibilityChange?.(true);
						}
					}
					return true;
				case "cursorHide":
					release();
					return true;
				default:
					return false;
			}
		},
		dispose() {
			if (disposed) return;
			cancelGlide();
			hideNow();
			disposed = true;
			options.onVisibilityChange?.(false);
		},
	};
	return api;
}
