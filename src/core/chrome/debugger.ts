/** Promise wrappers over `chrome.debugger.*` (Appendix H.7); hot path for the executor. */

export function debuggerAttach(tabId: number, protocolVersion: string): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.debugger.attach({ tabId }, protocolVersion, () => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
}

export function debuggerDetach(tabId: number): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.debugger.detach({ tabId }, () => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
}

export function debuggerSend(
	tabId: number,
	method: string,
	params?: Record<string, unknown>
): Promise<unknown> {
	return new Promise((resolve, reject) =>
		chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(result);
		})
	);
}
