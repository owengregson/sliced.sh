/**
 * Declarative click actions installed once on the panel root (Appendix H.6 model). Templates
 * wire common actions without per-view JavaScript:
 *
 *   data-action="view-switch"     data-tab="settings"    → select a top-bar tab
 *   data-action="open-url"        data-url="website"     → open a `URLS` entry in a new tab
 *                                                          (or an `https:` / JSON `data:` URL —
 *                                                          the Engine view's Export, Task 26)
 *   data-action="dismiss-update"                         → "Later" on the update interrupt
 *
 * Opening tabs is refused while a game is live (§13.4: no `chrome.tabs.create` mid-game).
 */

import { tabsCreate } from "@core/chrome/tabs";
import { URLS } from "@core/constants/urls";
import { log } from "@core/logger";
import { PANEL_TABS, type PanelTab } from "./view";

export interface ActionHost {
	setTab(tab: PanelTab): void;
	dismissUpdate(): void;
	/** Whether hands-off mode is active (tabs may not be opened). */
	readonly handsOff: boolean;
}

export type UrlKey = keyof typeof URLS;

/** Where "Play" / "Start a new game" deep-link (Appendix F §4.2 / §4.3), as a `URLS` key. */
export const PLAY_URL: UrlKey = "chesscomPlay";

/** Media type of the Engine view's timing-log export (the only `data:` URL the panel opens). */
export const JSON_DATA_URL_PREFIX = "data:application/json";

function resolveUrl(raw: string): string | null {
	if (Object.hasOwn(URLS, raw)) {
		// Only string entries are navigable; the registry also holds match-pattern lists.
		const value: unknown = URLS[raw as UrlKey];
		return typeof value === "string" ? value : null;
	}
	return /^https:\/\//.test(raw) || raw.startsWith(JSON_DATA_URL_PREFIX) ? raw : null;
}

export function installActionHandlers(root: HTMLElement, host: ActionHost): () => void {
	const onClick = (event: MouseEvent): void => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const el = target.closest<HTMLElement>("[data-action]");
		if (!el || !root.contains(el)) return;
		const action = el.dataset.action;
		if (!action) return;
		if (el.getAttribute("aria-disabled") === "true") {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		switch (action) {
			case "view-switch": {
				const tab = el.dataset.tab;
				if (tab && (PANEL_TABS as readonly string[]).includes(tab)) host.setTab(tab as PanelTab);
				else log.warn("actions: view-switch without a valid data-tab", { tab });
				break;
			}
			case "open-url": {
				const url = resolveUrl(el.dataset.url ?? "");
				if (!url) {
					log.warn("actions: open-url with an unknown url", { url: el.dataset.url });
					break;
				}
				if (host.handsOff) {
					log.info("actions: open-url refused during a live game");
					break;
				}
				tabsCreate({ url }).catch((error: unknown) => log.warn("actions: tabs.create failed", error));
				break;
			}
			case "dismiss-update":
				host.dismissUpdate();
				break;
			default:
				log.warn("actions: unknown data-action", { action });
		}
	};
	root.addEventListener("click", onClick);
	return () => root.removeEventListener("click", onClick);
}
