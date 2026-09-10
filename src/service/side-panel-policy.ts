/**
 * Per-tab side-panel policy (Appendix B §2): the panel is enabled on
 * chess.com tabs and disabled elsewhere, unless the user opened it globally.
 * `install()` sets `openPanelOnActionClick` once, disables the global default,
 * reconciles existing tabs, and follows `tabs.onUpdated` / `onActivated` /
 * `onRemoved`. The host test is derived from `SITE_MATCHES.chesscom` (no
 * second literal).
 */

import { sidePanelSetBehavior, sidePanelSetOptions } from "@core/chrome/side-panel";
import { onTabActivated, onTabRemoved, onTabUpdated, tabsGet, tabsQuery } from "@core/chrome/tabs";
import { SITE_MATCHES } from "@core/constants/match-patterns";
import { log } from "@core/logger";

export const PANEL_PAGE_PATH = "pages/panel.html";

/**
 * `*://*.chess.com/*` → a test on `URL.hostname` (`*.` allows the bare host too,
 * as Chrome does). An unparseable pattern fails closed (matches nothing).
 */
export function hostTestFromMatchPattern(pattern: string): (hostname: string) => boolean {
	const m = /^[^:]+:\/\/([^/]+)\//.exec(pattern);
	if (!m || m[1] === undefined) return () => false;
	const hostPart = m[1];
	if (hostPart === "*") return () => true;
	if (hostPart.startsWith("*.")) {
		const base = hostPart.slice(2).toLowerCase();
		return (host) => host === base || host.endsWith(`.${base}`);
	}
	const exact = hostPart.toLowerCase();
	return (host) => host === exact;
}

const IS_SITE_HOST = hostTestFromMatchPattern(SITE_MATCHES.chesscom);

export function isChessHost(url: string | undefined): boolean {
	if (!url) return false;
	let hostname: string;
	let protocol: string;
	try {
		({ hostname, protocol } = new URL(url));
	} catch {
		return false;
	}
	if (protocol !== "http:" && protocol !== "https:") return false;
	return IS_SITE_HOST(hostname.toLowerCase());
}

export class SidePanelPolicy {
	private unsubscribes: Array<() => void> = [];
	private installed = false;
	private globalOpen = false;
	private readonly known = new Map<number, boolean>();

	/** Register tab listeners and reconcile existing tabs. Idempotent. */
	install(): void {
		if (this.installed) return;
		this.installed = true;
		this.unsubscribes = [
			onTabUpdated((tabId, changeInfo, tab) => {
				if (!changeInfo.url && changeInfo.status !== "loading") return;
				const url = changeInfo.url ?? tab.url;
				if (!url) return;
				void this.apply(tabId, url);
			}),
			onTabActivated(({ tabId }) => {
				void tabsGet(tabId)
					.then((tab) => this.apply(tabId, tab.url, true))
					.catch((error: unknown) => log.debug("side-panel: onActivated lookup failed", error));
			}),
			onTabRemoved((tabId) => void this.known.delete(tabId)),
		];
		void this.configureDefaults().then(() => this.reconcileAll());
	}

	/** The user opened the panel globally: keep it available on every tab until closed. */
	setGlobalOpen(open: boolean): void {
		if (this.globalOpen === open) return;
		this.globalOpen = open;
		if (this.installed) void this.reconcileAll();
	}

	isGlobalOpen(): boolean {
		return this.globalOpen;
	}

	/** Re-evaluate every open tab. */
	async reconcileAll(): Promise<void> {
		try {
			const tabs = await tabsQuery({});
			await Promise.all(
				tabs.map((tab) => (tab.id === undefined ? undefined : this.apply(tab.id, tab.url)))
			);
		} catch (error) {
			log.warn("side-panel: reconcile failed", error);
		}
	}

	dispose(): void {
		for (const off of this.unsubscribes) off();
		this.unsubscribes = [];
		this.installed = false;
		this.known.clear();
	}

	private async configureDefaults(): Promise<void> {
		try {
			await sidePanelSetBehavior({ openPanelOnActionClick: true });
			await sidePanelSetOptions({ enabled: false });
		} catch (error) {
			log.warn("side-panel: default configuration failed", error);
		}
	}

	/** `force` re-sends even when the cached decision is unchanged (tab activation). */
	private async apply(tabId: number, url: string | undefined, force = false): Promise<void> {
		const enabled = this.globalOpen || isChessHost(url);
		if (!force && this.known.get(tabId) === enabled) return;
		this.known.set(tabId, enabled);
		try {
			await sidePanelSetOptions(
				enabled ? { tabId, path: PANEL_PAGE_PATH, enabled: true } : { tabId, enabled: false }
			);
		} catch (error) {
			this.known.delete(tabId);
			log.debug("side-panel: setOptions failed", { tabId, error });
		}
	}
}
