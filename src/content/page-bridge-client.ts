/**
 * `PageBridgeClient` — the ISOLATED-world end of the MAIN ⇄ ISOLATED bridge
 * (Task 21), implementing the adapter's `PageBridge`.
 *
 * Wire (§13.3 rule 5): `window.postMessage({ [key]: token, k, i?, p? },
 * location.origin)` both ways, where `key = deriveToken(seed,
 * SPOOF_PURPOSES.messageKey)`; the page posts `token = deriveToken(seed,
 * pageToken)`, this side posts `deriveToken(seed, contentToken)`, and each
 * side accepts only the other's value — no direction field, no product
 * name. Payload fields are the single letters of `BRIDGE_WIRE`;
 * `page-bridge/codec.ts` translates between them and the adapter's shapes.
 *
 * `call` correlates replies by `i` and rejects on timeout; `on` subscribes
 * to unsolicited page events; `isAvailable()` turns true once the page side
 * has posted `ready` (or answered anything). A `getState` probe is posted at
 * construction so a bridge that started before this listener existed is
 * still discovered.
 */

import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/bridge-protocol";
import { BRIDGE_WIRE as W } from "@core/constants/bridge";
import { SPOOF_PURPOSES } from "@core/constants/spoof";
import { TIMINGS } from "@core/constants/timings";
import { deriveToken } from "@core/spoof";
import { type Dict, decodePayload, encodePayload, isDict, str } from "./page-bridge/codec";

export {
	type BridgeCursor,
	type BridgeLegalMove,
	decodePayload,
	decodeState,
	encodePayload,
} from "./page-bridge/codec";

export interface PageBridgeClient extends PageBridge {
	/** Fire-and-forget command: no id, no pending entry, no reply (Fix D's pointer mirror). */
	notify(kind: string, payload?: unknown): void;
	/** Remove the message listener and reject every pending call. */
	dispose(): void;
}

export interface PageBridgeClientOptions {
	window?: Window;
	/** Spoof seed (default: the build define `__SL_SPOOF_SEED__`). */
	seed?: string;
	/** Default per-call timeout (default `TIMINGS.adapterBridgeTimeoutMs`). */
	timeoutMs?: number;
}

interface Pending {
	resolve(value: unknown): void;
	reject(reason: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export function createPageBridgeClient(options: PageBridgeClientOptions = {}): PageBridgeClient {
	const win = options.window ?? window;
	const seed = options.seed ?? __SL_SPOOF_SEED__;
	const key = deriveToken(seed, SPOOF_PURPOSES.messageKey);
	const own = deriveToken(seed, SPOOF_PURPOSES.contentToken);
	const accept = deriveToken(seed, SPOOF_PURPOSES.pageToken);
	const defaultTimeout = options.timeoutMs ?? TIMINGS.adapterBridgeTimeoutMs;
	const pending = new Map<string, Pending>();
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	let available = false;
	let disposed = false;
	let serial = 0;

	const emit = (kind: string, payload: unknown): void => {
		for (const cb of listeners.get(kind) ?? []) cb(payload);
	};

	const markAvailable = (payload: unknown): void => {
		if (available) return;
		available = true;
		emit(BRIDGE_KINDS.ready, payload);
	};

	const onMessage = (ev: MessageEvent): void => {
		if (ev.source !== win || ev.origin !== win.location.origin) return;
		const data: unknown = ev.data;
		if (!isDict(data) || data[key] !== accept) return;
		const kind = str(data[W.kind]);
		if (kind === undefined) return;
		const payload = decodePayload(kind, data[W.payload]);
		const id = str(data[W.id]);
		if (id !== undefined) {
			const p = pending.get(id);
			if (p) {
				pending.delete(id);
				clearTimeout(p.timer);
				markAvailable(payload);
				p.resolve(payload);
				return;
			}
		}
		if (kind === BRIDGE_KINDS.ready) {
			markAvailable(payload);
			return;
		}
		emit(kind, payload);
	};
	win.addEventListener("message", onMessage);

	const send = (kind: string, id: string | undefined, payload: unknown): void => {
		const envelope: Dict = { [key]: own, [W.kind]: kind };
		if (id !== undefined) envelope[W.id] = id;
		const encoded = encodePayload(kind, payload);
		if (encoded !== undefined) envelope[W.payload] = encoded;
		win.postMessage(envelope, win.location.origin);
	};

	const client: PageBridgeClient = {
		isAvailable: () => available && !disposed,
		call<T = unknown>(kind: string, payload?: unknown, timeoutMs?: number): Promise<T> {
			if (disposed) return Promise.reject(new Error("bridge: disposed"));
			const id = String(++serial);
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`bridge: ${kind} timed out`));
				}, timeoutMs ?? defaultTimeout);
				pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
				try {
					send(kind, id, payload);
				} catch (error) {
					pending.delete(id);
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		},
		notify(kind, payload) {
			if (disposed) return;
			// No id, so the page side has nothing to correlate a reply to and posts none.
			send(kind, undefined, payload);
		},
		on(kind, cb) {
			let set = listeners.get(kind);
			if (!set) {
				set = new Set();
				listeners.set(kind, set);
			}
			set.add(cb);
			return () => {
				set?.delete(cb);
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			available = false;
			win.removeEventListener("message", onMessage);
			for (const [id, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error("bridge: disposed"));
				pending.delete(id);
			}
			listeners.clear();
		},
	};

	// Discovery probe: a bridge that posted `ready` before this listener existed answers this.
	client.call(BRIDGE_KINDS.getState, undefined, defaultTimeout).catch(() => {
		// no page side yet — `ready` will arrive when it starts
	});
	return client;
}
