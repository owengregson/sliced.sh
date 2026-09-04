/**
 * Raw `chrome.offscreen` wrappers. `offscreenEnsure` guards `createDocument`
 * with `runtime.getContexts` (Chrome 116+; `hasDocument` is 150+). The deduped
 * single-in-flight manager (`ensureOffscreen`) is Task 9's; this is the call.
 */

import { runtimeGetContexts } from "@core/chrome/runtime";

/** Resolves `true` when a document was created, `false` when one already existed. */
export async function offscreenEnsure(params: chrome.offscreen.CreateParameters): Promise<boolean> {
	const existing = await runtimeGetContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
	if (existing.length > 0) return false;
	await new Promise<void>((resolve, reject) =>
		chrome.offscreen.createDocument(params, () => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
	return true;
}

export function offscreenClose(): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.offscreen.closeDocument(() => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
}
