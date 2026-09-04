/**
 * `PanelStore` — the panel's single source of SW state (§4.3, §10.4).
 *
 * Connects `PORT_NAMES.panel` through `connectPort` (which reconnects on its own with backoff)
 * and requests `MSG.PANEL_GET_SNAPSHOT` through `sendTyped` on boot and after every disconnect:
 * a message flushed over the port to a dead receiver is dropped (Task 4), so the handshake is a
 * request/response that is retried with the port's own backoff (`TIMINGS.portReconnect*`) until
 * the restarted service worker answers.
 * `subscribe` replays the latest snapshot to late subscribers; `dispatch` is a typed send.
 */

import type { PanelPortMessage, PanelSnapshot } from "@core/constants/messages";
import { type MessageType, MSG } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import {
	type MessageResponseMap,
	sendTyped,
	type TypedMessage,
} from "@core/messaging/typed-messages";

/** Message types the panel may send to the SW. */
export type PanelCommandType = Extract<MessageType, `sl:panel:${string}`>;

export type SnapshotListener = (snapshot: PanelSnapshot) => void;
export type PortMessageListener = (
	message: Exclude<PanelPortMessage, { kind: "snapshot" }>
) => void;

export interface PanelStore {
	readonly snapshot: PanelSnapshot | null;
	/** Whether the SW is reachable (answered the last handshake or pushed since the last drop). */
	readonly connected: boolean;
	/** Subscribe to snapshots; the latest one is replayed synchronously. Returns the unsubscribe. */
	subscribe(cb: SnapshotListener): () => void;
	/** Non-snapshot port traffic (toasts, timing-log entries). */
	onPortMessage(cb: PortMessageListener): () => void;
	/** Typed request to the SW. */
	dispatch<T extends PanelCommandType>(command: TypedMessage<T>): Promise<MessageResponseMap[T]>;
	/** Ask the SW for a fresh snapshot now (retries with backoff until answered). */
	refresh(): void;
	dispose(): void;
}

export function createPanelStore(): PanelStore {
	let snapshot: PanelSnapshot | null = null;
	let connected = false;
	let disposed = false;
	const listeners = new Set<SnapshotListener>();
	const portListeners = new Set<PortMessageListener>();

	// ── snapshot handshake with backoff ─────────────────────────────────────
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay: number = TIMINGS.portReconnectBaseMs;
	let generation = 0;

	function set(next: PanelSnapshot): void {
		snapshot = next;
		for (const cb of [...listeners]) {
			try {
				cb(next);
			} catch (error) {
				log.warn("panel store: subscriber threw", error);
			}
		}
	}

	function cancelRetry(): void {
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
	}

	function requestSnapshot(): void {
		if (disposed) return;
		cancelRetry();
		const gen = ++generation;
		sendTyped({ type: MSG.PANEL_GET_SNAPSHOT }).then(
			(result) => {
				if (disposed || gen !== generation) return;
				retryDelay = TIMINGS.portReconnectBaseMs;
				connected = true; // the SW answered: it is reachable again
				set(result);
			},
			(error: unknown) => {
				if (disposed || gen !== generation) return;
				log.debug("panel store: snapshot request failed; retrying", { error });
				const wait = retryDelay;
				retryDelay = Math.min(retryDelay * 2, TIMINGS.portReconnectMaxMs);
				retryTimer = setTimeout(() => {
					retryTimer = null;
					requestSnapshot();
				}, wait);
			}
		);
	}

	// ── port ────────────────────────────────────────────────────────────────
	const port: ConnectedPort<never> = connectPort<never, PanelPortMessage>(PORT_NAMES.panel, {
		onMessage(message) {
			connected = true;
			if (message.kind === "snapshot") {
				cancelRetry();
				generation += 1; // an in-flight request is superseded by the push
				retryDelay = TIMINGS.portReconnectBaseMs;
				set(message.snapshot);
				return;
			}
			for (const cb of [...portListeners]) cb(message);
		},
		onDisconnect(reason) {
			connected = false;
			log.debug("panel store: port dropped", { reason: reason ?? null });
			// The SW went away: ask again once it answers (the port reconnects on its own).
			requestSnapshot();
		},
	});
	void port.ready.then(() => {
		if (!disposed) connected = true;
	});
	requestSnapshot();

	return {
		get snapshot() {
			return snapshot;
		},
		get connected() {
			return connected;
		},
		subscribe(cb) {
			listeners.add(cb);
			if (snapshot) cb(snapshot);
			return () => void listeners.delete(cb);
		},
		onPortMessage(cb) {
			portListeners.add(cb);
			return () => void portListeners.delete(cb);
		},
		dispatch(command) {
			return sendTyped(command);
		},
		refresh: requestSnapshot,
		dispose() {
			if (disposed) return;
			disposed = true;
			cancelRetry();
			listeners.clear();
			portListeners.clear();
			port.disconnect();
			connected = false;
		},
	};
}
