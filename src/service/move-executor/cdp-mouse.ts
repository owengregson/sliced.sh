/**
 * `CdpMouse` (Appendix G §7.4): `Input.dispatchMouseEvent` with the verified
 * parameter shapes — `mousePressed{button:left,buttons:1,clickCount:1}`,
 * `mouseMoved{button:left,buttons:1}` while held, `mouseReleased{button:left,
 * buttons:0,clickCount:1}`, free moves `button:none,buttons:0`, never a
 * `timestamp` (the default wall-clock stamp is the only consistent one) —
 * on an absolute-time schedule: each point is due at the previous due time
 * plus its `dtMs`, a late ack skips the sleep instead of accumulating drift,
 * and a stall longer than `CDP.stallResyncMs` re-anchors the schedule. Every
 * dispatch resolves after the renderer acknowledges the event.
 */

import { CDP } from "@core/constants/cdp";
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
	now?: () => number;
	scheduler?: Scheduler;
}

type MouseEventType = "mousePressed" | "mouseReleased" | "mouseMoved";

export class CdpMouse {
	private pos: Pt;
	private buttons: number = CDP.mouse.noButtons;
	/** §13.2 `PointerOffset`: summed straight-line distance between dispatched points. */
	private travelled = 0;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;

	constructor(
		private readonly cdp: Cdp,
		start: Pt,
		options: CdpMouseOptions = {}
	) {
		this.pos = { x: Math.round(start.x), y: Math.round(start.y) };
		this.now = options.now ?? defaultNow;
		this.scheduler = options.scheduler ?? defaultScheduler;
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
		await this.dispatch("mouseMoved", p, this.buttons);
	}

	/** The button state only changes once the renderer acknowledged the press. */
	async pressAt(p: Pt, atMs: number, signal?: AbortSignal): Promise<void> {
		await this.waitUntil(atMs, signal);
		throwIfAborted(signal);
		await this.dispatch("mousePressed", p, this.buttons | CDP.mouse.leftButtons, {
			clickCount: CDP.mouse.clickCount,
		});
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
			await this.dispatch("mouseMoved", pt, this.buttons);
			if (this.now() - due > CDP.stallResyncMs) due = this.now();
		}
	}

	private async dispatch(
		type: MouseEventType,
		p: Pt,
		buttons: number,
		extra: Record<string, unknown> = {}
	): Promise<void> {
		const x = Math.round(p.x);
		const y = Math.round(p.y);
		await this.cdp(CDP.inputDispatchMouseEvent, {
			type,
			x,
			y,
			button: (buttons & CDP.mouse.leftButtons) !== 0 || type !== "mouseMoved" ? "left" : "none",
			buttons,
			modifiers: CDP.mouse.modifiers,
			...extra,
		});
		this.travelled += Math.hypot(x - this.pos.x, y - this.pos.y);
		this.pos = { x, y };
	}
}
