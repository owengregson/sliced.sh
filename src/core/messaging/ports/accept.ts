/**
 * The service-worker side of a port: filters `onConnect` by port name and hands each
 * connection to `onConnect` as a small typed wrapper.
 */

import { consumeRuntimeLastError, onRuntimeConnect } from "@core/chrome/runtime";
import { log } from "@core/logger";

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
