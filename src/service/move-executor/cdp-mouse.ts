/**
 * `CdpMouse` (Appendix G §7.4): `Input.dispatchMouseEvent` with the verified
 * parameter shapes — `mousePressed{button:left,buttons:1,clickCount:1}`,
 * `mouseMoved{button:left,buttons:1}` while held, `mouseReleased{button:left,
 * buttons:0,clickCount:1}`, free moves `button:none,buttons:0`. The browser stamps
 * ordinary events; owned-page input uses the current wall-clock stamp that was
 * admitted by the content capture filter before dispatch —
 * on an absolute-time schedule: each point is due at the previous due time
 * plus its `dtMs`, a late ack skips the sleep instead of accumulating drift,
 * and a stall longer than `CDP.stallResyncMs` re-anchors the schedule. Every
 * dispatch resolves after the renderer acknowledges the event.
 *
 * `onDispatch` (Fix D) is the tap the pointer mirror is fed from: it reports
 * every point the renderer has *acknowledged*, in the rounded viewport CSS px
 * the command carried, with the left-button state that command carried. It is
 * deliberately after the ack and not before it — what the page is shown must be
 * what the page was told, never a plan, and a point the renderer rejected was
 * never told to anyone.
 */

import { CDP, POINTER_CONTROL, type PreparedPointer } from "@core/constants/cdp";
import type { PathPoint, Pt } from "@core/motor/types";
import {
	defaultNow,
	defaultScheduler,
	type Scheduler,
	sleep,
	throwIfAborted,
} from "@core/util/scheduler";

export type Cdp = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface CdpMouseOptions {
	/** Resolves after the page admits this event; returns its epoch-ms stamp when controlled. */
	beforeDispatch?: (pointer: PreparedPointer, signal?: AbortSignal) => Promise<number | undefined>;
	afterDispatch?: (pointer: PreparedPointer) => Promise<boolean>;
	now?: () => number;
	scheduler?: Scheduler;
	/** Every acknowledged point (viewport CSS px, rounded) and whether the left button was down. */
	onDispatch?: (p: { x: number; y: number; pressed: boolean }) => void;
}

type MouseEventType = "mousePressed" | "mouseReleased" | "mouseMoved";

export class CdpMouse {
	private pos: Pt;
	private buttons: number = CDP.mouse.noButtons;
	/** §13.2 `PointerOffset`: summed straight-line distance between dispatched points. */
	private travelled = 0;
	private readonly beforeDispatch: CdpMouseOptions["beforeDispatch"];
	private readonly afterDispatch: CdpMouseOptions["afterDispatch"];
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly onDispatch: ((p: { x: number; y: number; pressed: boolean }) => void) | null;

	constructor(
		private readonly cdp: Cdp,
		start: Pt,
		options: CdpMouseOptions = {}
	) {
		this.pos = { x: Math.round(start.x), y: Math.round(start.y) };
		this.beforeDispatch = options.beforeDispatch;
		this.afterDispatch = options.afterDispatch;
		this.now = options.now ?? defaultNow;
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.onDispatch = options.onDispatch ?? null;
	}

	get position(): Pt {
		return { ...this.pos };
	}

	get pressed(): boolean {
		return (this.buttons & CDP.mouse.leftButtons) !== 0;
	}

	/** Path length dispatched so far (px) — the `ac` blob's `PointerOffset`. */
	get travelledPx(): number {
		return this.travelled;
	}

	/** Resolve once the clock reaches `atMs` (early on abort). */
	waitUntil(atMs: number, signal?: AbortSignal): Promise<void> {
		const wait = atMs - this.now();
		if (wait < CDP.minSleepMs) return Promise.resolve();
		return sleep(wait, this.scheduler, signal);
	}

	async moveAt(p: Pt, atMs: number, signal?: AbortSignal): Promise<void> {
		await this.waitUntil(atMs, signal);
		throwIfAborted(signal);
		await this.dispatch("mouseMoved", p, this.buttons, {}, signal);
	}

	/** The button state only changes once the renderer acknowledged the press. */
	async pressAt(p: Pt, atMs: number, signal?: AbortSignal, beforePress?: () => void): Promise<void> {
		await this.waitUntil(atMs, signal);
		throwIfAborted(signal);
		await this.dispatch(
			"mousePressed",
			p,
			this.buttons | CDP.mouse.leftButtons,
			{ clickCount: CDP.mouse.clickCount },
			signal,
			beforePress
		);

		this.buttons |= CDP.mouse.leftButtons;
	}

	/** Release never waits on an abort: it is the abort path's own cleanup. */
	async releaseAt(p: Pt, atMs: number, signal?: AbortSignal): Promise<void> {
		await this.waitUntil(atMs, signal);
		await this.dispatch("mouseReleased", p, this.buttons & ~CDP.mouse.leftButtons, {
			button: "left",
			clickCount: CDP.mouse.clickCount,
		});
		this.buttons &= ~CDP.mouse.leftButtons;
	}

	/**
	 * Dispatch `path` honouring `dtMs` against the clock; resyncs after a stall >
	 * `stallResyncMs`. `beforePoint` runs once the point is due, immediately
	 * before its dispatch (not before the wait: a focus edge that lands while a
	 * point's timer is armed must still stop that point, §9.6a), and may throw.
	 */
	async travel(
		path: readonly PathPoint[],
		signal?: AbortSignal,
		beforePoint?: () => void
	): Promise<void> {
		let due = this.now();
		for (const pt of path) {
			throwIfAborted(signal);
			due += pt.dtMs;
			await this.waitUntil(due, signal);
			throwIfAborted(signal);
			beforePoint?.();
			await this.dispatch("mouseMoved", pt, this.buttons, {}, signal, beforePoint);
			if (this.now() - due > CDP.stallResyncMs) due = this.now();
		}
	}

	private async dispatch(
		type: MouseEventType,
		p: Pt,
		buttons: number,
		extra: Record<string, unknown> = {},
		signal?: AbortSignal,
		beforeInput?: () => void
	): Promise<void> {
		const x = Math.round(p.x);
		const y = Math.round(p.y);
		const timestampMs = await this.beforeDispatch?.(
			{ type, x, y, buttons, timestampMs: this.now() },
			signal
		);
		throwIfAborted(signal);
		beforeInput?.();
		await this.cdp(CDP.inputDispatchMouseEvent, {
			...(timestampMs === undefined ? {} : { timestamp: timestampMs / POINTER_CONTROL.msPerSecond }),
			type,
			x,
			y,
			button: (buttons & CDP.mouse.leftButtons) !== 0 || type !== "mouseMoved" ? "left" : "none",
			buttons,
			modifiers: CDP.mouse.modifiers,
			...extra,
		});
		// Preserve actual browser button state even if the page rejected the event:
		// recovery still owes a release after a dispatched press.
		this.buttons = buttons;
		this.travelled += Math.hypot(x - this.pos.x, y - this.pos.y);
		this.pos = { x, y };
		this.onDispatch?.({ x, y, pressed: (buttons & CDP.mouse.leftButtons) !== 0 });
		if (timestampMs !== undefined && type !== "mouseMoved" && this.afterDispatch) {
			const delivered = await this.afterDispatch({ type, x, y, buttons, timestampMs });
			if (!delivered) throw new Error(POINTER_CONTROL.notDelivered);
		}
	}
}
