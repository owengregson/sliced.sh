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
