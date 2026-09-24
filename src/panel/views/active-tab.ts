/** The game tab a view's per-tab commands target: the active tab of the panel's window. */

import { tabsQuery } from "@core/chrome/tabs";
import { log } from "@core/logger";

export interface ActiveTab {
	/** `null` until the query resolves (or when the window has no active tab with an id). */
	readonly id: number | null;
}

/**
 * Resolve the active tab once, at mount. `scope` prefixes the warning logged when the query
 * fails; `disposed` stops a late answer from landing on an unmounted view.
 */
export function trackActiveTab(scope: string, disposed: () => boolean): ActiveTab {
	let id: number | null = null;
	tabsQuery({ active: true, currentWindow: true })
		.then((tabs) => {
			if (disposed()) return;
			const tabId = tabs[0]?.id;
			id = typeof tabId === "number" ? tabId : null;
		})
		.catch((error: unknown) => log.warn(`${scope}: tabs.query failed`, error));
	return {
		get id() {
			return id;
		},
	};
}

/** The active tab's id, resolved on demand (the active tab may change after mount). */
export async function activeTabId(): Promise<number | null> {
	const tabs = await tabsQuery({ active: true, currentWindow: true });
	return tabs[0]?.id ?? null;
}
