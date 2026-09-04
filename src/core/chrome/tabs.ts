/**
 * Promise wrappers over `chrome.tabs.*` (Appendix H.7).
 *
 * `tabsSendMessage` deliberately resolves with `{ success: false, error }`
 * instead of rejecting — callers treat absent content scripts as non-fatal
 * (the script may not be ready or the tab may have just closed).
 */

import { log } from "@core/logger";

export interface TabsSendMessageResult {
	success: boolean;
	response?: unknown;
	error?: string;
}

export function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
	return new Promise((resolve, reject) =>
		chrome.tabs.query(queryInfo, (tabs) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(tabs);
		})
	);
}

/**
 * Send a message to a content script in `tabId`. Resolves (never rejects) with
 * `{ success, response?, error? }`; `error` carries the `lastError` message or
 * the synchronous throw, if any.
 */
export function tabsSendMessage(
	tabId: number,
	message: unknown,
	options: chrome.tabs.MessageSendOptions | null = null
): Promise<TabsSendMessageResult> {
	const type =
		message && typeof message === "object"
			? ((message as Record<string, unknown>).type ?? null)
			: null;
	return new Promise((resolve) => {
		const handleResponse = (response: unknown): void => {
			const err = chrome.runtime.lastError;
			if (err) {
				log.warn("tabsSendMessage error", { tabId, type, error: err.message });
				resolve({ success: false, error: err.message ?? "unknown error" });
			} else {
				resolve({ success: true, response });
			}
		};
		try {
			if (options) chrome.tabs.sendMessage(tabId, message, options, handleResponse);
			else chrome.tabs.sendMessage(tabId, message, handleResponse);
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			log.warn("tabsSendMessage threw", { tabId, type, error });
			resolve({ success: false, error });
		}
	});
}
