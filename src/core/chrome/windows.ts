/** Subscription wrappers over `chrome.windows.*` (focus discipline, §13.4). */

/** `chrome.windows.WINDOW_ID_NONE`: the browser lost focus entirely. */
export function windowIdNone(): number {
	return chrome.windows.WINDOW_ID_NONE;
}

/** The window the calling extension page belongs to (`chrome.windows.getCurrent`). */
export function windowsGetCurrent(): Promise<chrome.windows.Window> {
	return new Promise((resolve, reject) =>
		chrome.windows.getCurrent((window) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(window);
		})
	);
}

/** Subscribe to `chrome.windows.onFocusChanged`; returns the unsubscribe. */
export function onWindowFocusChanged(handler: (windowId: number) => void): () => void {
	chrome.windows.onFocusChanged.addListener(handler);
	return () => chrome.windows.onFocusChanged.removeListener(handler);
}
