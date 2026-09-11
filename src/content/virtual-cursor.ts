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
 * mirror reply would allocate a pending entry and timer for an answer nobody
 * reads. Separately, controlled mouse input has a pre-dispatch admission request;
 * that acknowledgment is required before the browser receives the event.
 *
 * This is also the only place the mirror is deduplicated, and the only place it
 * *can* be: `drawn` and the element share a lifetime — both live in the tab —
 * whereas the service worker is suspended and rebuilt underneath them, so it
 * posts its hides unconditionally and this decides whether there is anything to
 * erase.
 */

import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/adapter";
import { POINTER_CONTROL, type PreparedPointer } from "@core/constants/cdp";
import type { GamePortCommand } from "@core/constants/messages";

export interface VirtualCursor {
	/** Whether the mirror is currently drawn on the page. */
	shown(): boolean;
	/** Apply a port command; returns whether it was one of the mirror's. */
	apply(cmd: GamePortCommand): boolean;
	/** Wait until native hit testing can reach the announced virtual coordinate. */
	prepare(pointer: PreparedPointer): Promise<boolean>;
	/** Erase the mirror if it is drawn and accept nothing further. */
	dispose(): void;
}

export function createVirtualCursor(
	bridge: PageBridge,
	onVisibilityChange?: (shown: boolean) => void
): VirtualCursor {
	let drawn = false;
	let disposed = false;

	const send = (kind: string, payload?: unknown): boolean => {
		if (disposed || !bridge.isAvailable() || bridge.notify === undefined) return false;
		bridge.notify(kind, payload);
		return true;
	};

	const hide = (): void => {
		if (!drawn) return;
		// Cleared only on a send that actually left: a hide we could not deliver must not be
		// forgotten, or the element stays on the page with nothing left to erase it.
		if (send(BRIDGE_KINDS.cursorHide)) {
			drawn = false;
			onVisibilityChange?.(false);
		}
	};

	const api: VirtualCursor = {
		shown: () => drawn,
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
					if (send(BRIDGE_KINDS.cursorTo, { x: cmd.x, y: cmd.y, down: cmd.down }) && !drawn) {
						drawn = true;
						onVisibilityChange?.(true);
					}
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
			onVisibilityChange?.(false);
		},
	};
	return api;
}
