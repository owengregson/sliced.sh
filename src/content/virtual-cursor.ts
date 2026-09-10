/**
 * Pointer-mirror relay (Fix D, §13.3 rule 4). The `cursorTo` / `cursorHide`
 * port commands carry points the service worker's hand has already dispatched;
 * this module forwards each one to the MAIN-world bridge, which owns the
 * element — nothing in this world inserts DOM (`AdapterBase.draw`: "no DOM
 * insertion from the adapter").
 *
 * It deliberately reads no pointer event of its own. A point the hand dispatched
 * arrives at the page as a *trusted* event, indistinguishable from the owner's
 * real mouse, so a mirror fed from `CursorTracker` would follow the real cursor
 * and sit on top of it — the one outcome that makes the feature useless.
 *
 * Each position is one fire-and-forget `notify`, not a `call`: the hand
 * dispatches a point every few milliseconds (~45/s measured over a move), and a
 * reply per point would double the traffic and allocate a pending entry and a
 * timer for an answer nobody reads. The only state kept here is whether
 * something is on screen, so a hide is posted once and only when there is
 * something to erase.
 */

import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/adapter";
import type { GamePortCommand } from "@core/constants/messages";

export interface VirtualCursor {
	/** Whether the mirror is currently drawn on the page. */
	shown(): boolean;
	/** Apply a port command; returns whether it was one of the mirror's. */
	apply(cmd: GamePortCommand): boolean;
	/** Erase the mirror if it is drawn and accept nothing further. */
	dispose(): void;
}

export function createVirtualCursor(bridge: PageBridge): VirtualCursor {
	let drawn = false;
	let disposed = false;

	const send = (kind: string, payload?: unknown): boolean => {
		if (disposed || !bridge.isAvailable() || bridge.notify === undefined) return false;
		bridge.notify(kind, payload);
		return true;
	};

	const hide = (): void => {
		if (!drawn) return;
		drawn = false;
		send(BRIDGE_KINDS.cursorHide);
	};

	const api: VirtualCursor = {
		shown: () => drawn,
		apply(cmd) {
			switch (cmd.kind) {
				case "cursorTo":
					if (send(BRIDGE_KINDS.cursorTo, { x: cmd.x, y: cmd.y, down: cmd.down })) drawn = true;
					return true;
				case "cursorHide":
					hide();
					return true;
				default:
					return false;
			}
		},
		dispose() {
			if (disposed) return;
			hide();
			disposed = true;
		},
	};
	return api;
}
