/** Subscription wrappers over `chrome.windows.*` (focus discipline, §13.4). */

/** `chrome.windows.WINDOW_ID_NONE`: the browser lost focus entirely. */
export function windowIdNone(): number {
	return chrome.windows.WINDOW_ID_NONE;
}

/** Subscribe to `chrome.windows.onFocusChanged`; returns the unsubscribe. */
export function onWindowFocusChanged(handler: (windowId: number) => void): () => void {
	chrome.windows.onFocusChanged.addListener(handler);
	return () => chrome.windows.onFocusChanged.removeListener(handler);
}
