/**
 * Resilient `chrome.runtime.connect` ports (§4.3, Appendix B / H.2).
 *
 * `connectPort` is the page side (panel, offscreen, ISOLATED content script):
 * it connects immediately, reconnects after a disconnect or a failed
 * `connect()` with exponential backoff (250 → 4000 ms, doubling, reset once
 * the peer sends a message), and queues `post()` calls while no port is live
 * so they are delivered in order once one is. `acceptPorts` is the service
 * worker side: it filters `onConnect` by port name and hands each connection
 * to `onConnect` as a small typed wrapper.
 *
 * Remember (Q4): on Chrome 114+ an idle port does not keep the SW alive —
 * messages do.
 */

import { consumeRuntimeLastError, onRuntimeConnect, runtimeConnect } from "@core/chrome/runtime";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";

/** `setTimeout`-compatible scheduler; injectable so backoff is testable without waiting. */
export interface PortScheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ConnectPortOptions<TIn> {
	onMessage?: (msg: TIn) => void;
	/** Called after every disconnect (before the reconnect is scheduled). */
	onDisconnect?: (reason: string | undefined) => void;
	scheduler?: PortScheduler;
}

export interface ConnectedPort<TOut> {
	/** Post now, or queue until the port is (re)connected. No-op after `disconnect()`. */
	post(msg: TOut): void;
	/** Close the port, cancel any pending reconnect, drop the queue. */
	disconnect(): void;
	/** Resolves once the first connection is established. */
	ready: Promise<void>;
}

const defaultScheduler: PortScheduler = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function connectPort<TOut, TIn>(
	name: string,
	options: ConnectPortOptions<TIn> = {}
): ConnectedPort<TOut> {
	const scheduler = options.scheduler ?? defaultScheduler;
	let port: chrome.runtime.Port | null = null;
	let closed = false;
	let delayMs: number = TIMINGS.portReconnectBaseMs;
	let timer: unknown = null;
	let queue: TOut[] = [];
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	function scheduleReconnect(): void {
		if (closed || timer !== null) return;
		const wait = delayMs;
		delayMs = Math.min(delayMs * 2, TIMINGS.portReconnectMaxMs);
		timer = scheduler.setTimeout(() => {
			timer = null;
			connect();
		}, wait);
	}

	function flush(): void {
		const live = port;
		if (!live || queue.length === 0) return;
		const pending = queue;
		queue = [];
		for (let i = 0; i < pending.length; i += 1) {
			const msg = pending[i] as TOut;
			try {
				live.postMessage(msg);
			} catch (error) {
				// Port died before onDisconnect fired: keep this and the rest for the next port.
				queue = pending.slice(i).concat(queue);
				log.debug("port: postMessage failed; re-queued", { name, error });
				return;
			}
		}
	}

	function connect(): void {
		if (closed) return;
		let next: chrome.runtime.Port;
		try {
			next = runtimeConnect(name);
		} catch (error) {
			log.debug("port: connect failed", { name, error });
			scheduleReconnect();
			return;
		}
		port = next;
		next.onMessage.addListener((msg: TIn) => {
			if (port !== next) return;
			delayMs = TIMINGS.portReconnectBaseMs; // the peer is alive — a later drop retries promptly
			options.onMessage?.(msg);
		});
		next.onDisconnect.addListener(() => {
			const reason = consumeRuntimeLastError();
			if (port !== next) return;
			port = null;
			log.debug("port: disconnected", { name, reason: reason ?? null });
			options.onDisconnect?.(reason);
			scheduleReconnect();
		});
		flush();
		resolveReady();
	}

	connect();

	return {
		ready,
		post(msg: TOut): void {
			if (closed) return;
			queue.push(msg);
			flush();
		},
		disconnect(): void {
			if (closed) return;
			closed = true;
			if (timer !== null) {
				scheduler.clearTimeout(timer);
				timer = null;
			}
			queue = [];
			const live = port;
			port = null;
			try {
				live?.disconnect();
			} catch {
				// already gone
			}
		},
	};
}

/** A connection accepted on the service-worker side. */
export interface AcceptedPort<TOut, TIn> {
	post(msg: TOut): void;
	onMessage(fn: (msg: TIn) => void): () => void;
	onDisconnect(fn: (reason: string | undefined) => void): () => void;
	sender: chrome.runtime.MessageSender | undefined;
}

/**
 * Accept every `runtime.onConnect` port named `name`. Returns an unsubscribe
 * that stops accepting new connections (existing ports are untouched).
 */
export function acceptPorts<TOut, TIn>(
	name: string,
	onConnect: (port: AcceptedPort<TOut, TIn>) => void
): () => void {
	return onRuntimeConnect((raw) => {
		if (!raw || raw.name !== name) return;
		// Always consume `lastError` on disconnect (suppresses the bfcache "Unchecked
		// runtime.lastError" noise) even if the consumer never subscribes.
		raw.onDisconnect.addListener(() => void consumeRuntimeLastError());
		const wrapper: AcceptedPort<TOut, TIn> = {
			sender: raw.sender,
			post(msg) {
				try {
					raw.postMessage(msg);
				} catch (error) {
					log.debug("port: postMessage to peer failed", { name, error });
				}
			},
			onMessage(fn) {
				const listener = (msg: TIn): void => fn(msg);
				raw.onMessage.addListener(listener);
				return () => raw.onMessage.removeListener(listener);
			},
			onDisconnect(fn) {
				const listener = (): void => fn(consumeRuntimeLastError());
				raw.onDisconnect.addListener(listener);
				return () => raw.onDisconnect.removeListener(listener);
			},
		};
		onConnect(wrapper);
	});
}
