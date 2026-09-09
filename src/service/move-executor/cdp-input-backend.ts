/**
 * `InputBackend` over `chrome.debugger` (§9.3, v2.0): one `CdpMouse` per tab
 * whose commands go through the `DebuggerManager` (so every dispatch touches
 * the idle timer) or any `Cdp` function. The hand controller never sees CDP;
 * the native host of §9.8 slots in behind the same interface.
 */

import type { InputBackend } from "@core/motor/input-backend";
import type { PathPoint, Pt } from "@core/motor/types";
import type { DebuggerManager } from "@service/debugger-manager";
import { type Cdp, CdpMouse, type CdpMouseOptions } from "./cdp-mouse";

export class CdpInputBackend implements InputBackend {
	private readonly mouse: CdpMouse;

	constructor(cdp: Cdp, start: Pt, options: CdpMouseOptions = {}) {
		this.mouse = new CdpMouse(cdp, start, options);
	}

	/** A backend whose commands are routed through the manager (idle timer, attach check). */
	static forTab(
		manager: DebuggerManager,
		tabId: number,
		start: Pt,
		options: CdpMouseOptions = {}
	): CdpInputBackend {
		return new CdpInputBackend(
			(method, params) => manager.send(tabId, method, params),
			start,
			options
		);
	}

	move(p: Pt, atMs: number, signal?: AbortSignal): Promise<void> {
		return this.mouse.moveAt(p, atMs, signal);
	}

	press(p: Pt, atMs: number, signal?: AbortSignal): Promise<void> {
		return this.mouse.pressAt(p, atMs, signal);
	}

	release(p: Pt, atMs: number): Promise<void> {
		return this.mouse.releaseAt(p, atMs);
	}

	travel(path: readonly PathPoint[], signal?: AbortSignal, beforePoint?: () => void): Promise<void> {
		return this.mouse.travel(path, signal, beforePoint);
	}

	position(): Pt {
		return this.mouse.position;
	}

	travelledPx(): number {
		return this.mouse.travelledPx;
	}

	pressed(): boolean {
		return this.mouse.pressed;
	}

	dispose(): void {
		// nothing to release: the debugger attachment belongs to the manager
	}
}
