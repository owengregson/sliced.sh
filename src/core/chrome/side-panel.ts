/** Promise wrappers over `chrome.sidePanel.*` (per-tab policy lives in Task 9). */

function settle(resolve: () => void, reject: (e: Error) => void): void {
	const err = chrome.runtime.lastError;
	if (err) reject(new Error(err.message));
	else resolve();
}

export function sidePanelSetOptions(options: chrome.sidePanel.PanelOptions): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.sidePanel.setOptions(options, () => settle(resolve, reject))
	);
}

export function sidePanelSetBehavior(behavior: chrome.sidePanel.PanelBehavior): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.sidePanel.setPanelBehavior(behavior, () => settle(resolve, reject))
	);
}

/** Must be called in response to a user gesture. */
export function sidePanelOpen(options: chrome.sidePanel.OpenOptions): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.sidePanel.open(options, () => settle(resolve, reject))
	);
}
