/**
 * Promise wrappers over `chrome.tabs.*` (Appendix H.7).
 *
 * `tabsSendMessage` deliberately resolves with `{ success: false, error }`
 * instead of rejecting — callers treat absent content scripts as non-fatal
 * (the script may not be ready or the tab may have just closed).
 */

import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";

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
			const error = errorMessage(err);
			log.warn("tabsSendMessage threw", { tabId, type, error });
			resolve({ success: false, error });
		}
	});
}

export function tabsGet(tabId: number): Promise<chrome.tabs.Tab> {
	return new Promise((resolve, reject) =>
		chrome.tabs.get(tabId, (tab) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(tab);
		})
	);
}

export type TabUpdatedHandler = (
	tabId: number,
	changeInfo: chrome.tabs.OnUpdatedInfo,
	tab: chrome.tabs.Tab
) => void;

/** Subscribe to `chrome.tabs.onUpdated`; returns the unsubscribe. */
export function onTabUpdated(handler: TabUpdatedHandler): () => void {
	chrome.tabs.onUpdated.addListener(handler);
	return () => chrome.tabs.onUpdated.removeListener(handler);
}

/** Subscribe to `chrome.tabs.onActivated`; returns the unsubscribe. */
export function onTabActivated(handler: (info: chrome.tabs.OnActivatedInfo) => void): () => void {
	chrome.tabs.onActivated.addListener(handler);
	return () => chrome.tabs.onActivated.removeListener(handler);
}

/** Subscribe to `chrome.tabs.onRemoved`; returns the unsubscribe. */
export function onTabRemoved(
	handler: (tabId: number, info: chrome.tabs.OnRemovedInfo) => void
): () => void {
	chrome.tabs.onRemoved.addListener(handler);
	return () => chrome.tabs.onRemoved.removeListener(handler);
}
