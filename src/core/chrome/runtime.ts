/**
 * Promise/unsubscribe wrappers over `chrome.runtime.*` used by messaging
 * (Task 4), the logger, and the offscreen guard.
 */

export type RuntimeMessageHandler = (
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void
) => boolean | undefined;

/** Resolves with the responder's reply; rejects with `lastError` (e.g. no receiver). */
export function runtimeSendMessage<R = unknown>(message: unknown): Promise<R> {
	return new Promise((resolve, reject) =>
		chrome.runtime.sendMessage(message, (response: R) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(response);
		})
	);
}

/**
 * Read (and thereby clear) `chrome.runtime.lastError`. Call inside a
 * `port.onDisconnect` listener so Chrome does not log "Unchecked
 * runtime.lastError"; returns the message, if any.
 */
export function consumeRuntimeLastError(): string | undefined {
	return chrome.runtime.lastError?.message;
}

export function runtimeConnect(name: string): chrome.runtime.Port {
	return chrome.runtime.connect({ name });
}

export function runtimeGetURL(path: string): string {
	return chrome.runtime.getURL(path);
}

export function runtimeGetContexts(
	filter: chrome.runtime.ContextFilter
): Promise<chrome.runtime.ExtensionContext[]> {
	return new Promise((resolve, reject) =>
		chrome.runtime.getContexts(filter, (contexts) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(contexts);
		})
	);
}

/** `handler` returns `true` to keep `sendResponse` alive for an async reply. */
export function onRuntimeMessage(handler: RuntimeMessageHandler): () => void {
	const listener = (
		message: unknown,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void
	): boolean => handler(message, sender, sendResponse) === true;
	chrome.runtime.onMessage.addListener(listener);
	return () => chrome.runtime.onMessage.removeListener(listener);
}

export function onRuntimeConnect(handler: (port: chrome.runtime.Port) => void): () => void {
	chrome.runtime.onConnect.addListener(handler);
	return () => chrome.runtime.onConnect.removeListener(handler);
}

/** Subscribe to `chrome.runtime.onInstalled`; returns the unsubscribe. */
export function onRuntimeInstalled(
	handler: (details: chrome.runtime.InstalledDetails) => void
): () => void {
	chrome.runtime.onInstalled.addListener(handler);
	return () => chrome.runtime.onInstalled.removeListener(handler);
}

/** Subscribe to `chrome.runtime.onStartup`; returns the unsubscribe. */
export function onRuntimeStartup(handler: () => void): () => void {
	chrome.runtime.onStartup.addListener(handler);
	return () => chrome.runtime.onStartup.removeListener(handler);
}
