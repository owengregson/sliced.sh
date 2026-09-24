/**
 * The adapter's cache of what the MAIN-world bridge last said about the board. Unsolicited page
 * events and `getState` replies are both *merged* into it — a partial event never erases a field
 * an earlier answer supplied — which is also why a cached field can be one answer behind.
 */

import { TIMINGS } from "@core/constants/timings";
import { BRIDGE_KINDS, type BridgeState, type PageBridge } from "../bridge-protocol";

const BRIDGE_CALL_TIMEOUT_MS = TIMINGS.adapterBridgeTimeoutMs;

export class BridgeStateCache {
	private current: BridgeState | null = null;

	get state(): BridgeState | null {
		return this.current;
	}

	get fen(): string | null {
		return this.current?.fen ?? null;
	}

	/** Merge an event payload (anything but an object is ignored). */
	merge(payload: unknown): void {
		if (payload && typeof payload === "object")
			this.current = { ...this.current, ...(payload as BridgeState) };
	}

	/**
	 * Ask the page for its state (no-op without a ready bridge); resolves once the cache is updated,
	 * with this request's own answer — never an older value merged into the cache.
	 */
	refresh(bridge: PageBridge | null): Promise<BridgeState | null> {
		if (!bridge) return Promise.resolve(null);
		return bridge
			.call<BridgeState>(BRIDGE_KINDS.getState, undefined, BRIDGE_CALL_TIMEOUT_MS)
			.then((state) => {
				if (!state || typeof state !== "object") return null;
				this.current = { ...this.current, ...state };
				return state;
			})
			.catch(() => {
				// page side absent or slow: DOM readers carry on
				return null;
			});
	}
}
