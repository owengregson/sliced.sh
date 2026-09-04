// test/sim/chrome/tabs.ts
/**
 * `chrome.tabs`: a map of virtual tabs with `create/query/get/update/remove`
 * and `onCreated/onUpdated/onActivated/onRemoved`. `sendMessage` routes to
 * the content context(s) booted for that tab through the bus. Unknown tab
 * ids fail with Chrome's "No tab with id: N." `lastError`.
 */

import type { Bus, Respond } from "@test/sim/contexts/bus";
import type { VirtualTab } from "@test/sim/types";

type TabCallback = (tab: chrome.tabs.Tab) => void;

const noTab = (tabId: number): string => `No tab with id: ${tabId}.`;

const escapeRegExp = (s: string): string => s.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");

/**
 * Convert a Chrome match pattern (`*://*.chess.com/*`, `<all_urls>`) into a
 * RegExp; anything that is not a match pattern is treated as a URL prefix.
 */
function matchPattern(pattern: string): RegExp {
	if (pattern === "<all_urls>") return /^(https?|file|ftp|wss?):\/\//;
	const m = /^(\*|https?|file|ftp|wss?):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)?$/.exec(pattern);
	if (!m) return new RegExp(`^${escapeRegExp(pattern)}`);
	const scheme = m[1] === "*" ? "https?" : m[1];
	const hostPart = m[2];
	const host =
		hostPart === undefined || hostPart === "*"
			? "[^/]*"
			: hostPart.startsWith("*.")
				? `([^/]+\\.)?${escapeRegExp(hostPart.slice(2))}`
				: escapeRegExp(hostPart);
	const path = m[3] === undefined ? "(/.*)?" : escapeRegExp(m[3]).replace(/\\\*/g, ".*");
	return new RegExp(`^${scheme}://${host}${path}$`);
}

export interface TabsOptions {
	/** Internal (not bus-owned) hook fired after a tab is removed; wires the debugger's target_closed detach. */
	onTabRemoved?: (tabId: number) => void;
}

export function createTabsSubsystem(bus: Bus, options: TabsOptions = {}) {
	let nextId = 1;
	const tabs = new Map<number, VirtualTab>();
	const onCreated = bus.event<[chrome.tabs.Tab]>();
	const onUpdated = bus.event<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>();
	const onRemoved = bus.event<[number, chrome.tabs.OnRemovedInfo]>();
	const onActivated = bus.event<[chrome.tabs.OnActivatedInfo]>();
	const onReplaced = bus.event<[number, number]>();

	const toApi = (tab: VirtualTab): chrome.tabs.Tab => ({
		id: tab.id,
		url: tab.url,
		title: tab.title,
		status: tab.status,
		active: tab.active,
		windowId: tab.windowId,
		index: [...tabs.keys()].indexOf(tab.id),
		pinned: false,
		highlighted: tab.active,
		incognito: false,
		selected: tab.active,
		discarded: false,
		autoDiscardable: true,
		groupId: -1,
		frozen: false,
	});

	function activateTab(tab: VirtualTab): void {
		let changed = !tab.active;
		for (const other of tabs.values()) {
			if (other.id !== tab.id && other.active && other.windowId === tab.windowId) {
				other.active = false;
				changed = true;
			}
		}
		tab.active = true;
		if (changed) onActivated.fire({ tabId: tab.id, windowId: tab.windowId });
	}

	function sendMessage(tabId: number, message: unknown, ...rest: unknown[]) {
		const callback = typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1] : undefined;
		const respond: Respond = (value, error) => {
			if (typeof callback === "function") bus.settle(callback, value, error);
		};
		if (typeof callback === "function") {
			if (!tabs.has(tabId)) respond(undefined, noTab(tabId));
			else bus.dispatchToTab(bus.activeContextId(), tabId, message, respond);
			return undefined;
		}
		return new Promise<unknown>((resolve, reject) => {
			const settle: Respond = (value, error) =>
				error === undefined ? resolve(value) : reject(new Error(error));
			if (!tabs.has(tabId)) settle(undefined, noTab(tabId));
			else bus.dispatchToTab(bus.activeContextId(), tabId, message, settle);
		});
	}

	const api = {
		TAB_ID_NONE: -1,
		create(props: chrome.tabs.CreateProperties, callback?: TabCallback) {
			const id = nextId++;
			const tab: VirtualTab = {
				id,
				url: props.url ?? "about:blank",
				title: props.url ?? "New Tab",
				status: "loading",
				active: props.active ?? true,
				windowId: props.windowId ?? 1,
			};
			tabs.set(id, tab);
			if (tab.active) {
				for (const other of tabs.values()) {
					if (other.id !== id && other.windowId === tab.windowId) other.active = false;
				}
			}
			onCreated.fire(toApi(tab));
			// Chrome fires status:"loading" right after creation; "complete" arrives later
			// (`sim.openTab` / `tabs.setStatus`).
			onUpdated.fire(id, { status: "loading" }, toApi(tab));
			if (tab.active) onActivated.fire({ tabId: id, windowId: tab.windowId });
			return bus.settle(callback, toApi(tab));
		},
		query(info: chrome.tabs.QueryInfo, callback?: (tabs: chrome.tabs.Tab[]) => void) {
			const wanted = info.url === undefined ? null : Array.isArray(info.url) ? info.url : [info.url];
			const patterns = wanted?.map(matchPattern) ?? null;
			const result = [...tabs.values()]
				.filter((t) => {
					if (patterns && !patterns.some((p) => p.test(t.url))) return false;
					if (info.active !== undefined && t.active !== info.active) return false;
					if (info.status !== undefined && t.status !== info.status) return false;
					if (info.windowId !== undefined && info.windowId !== -2 && t.windowId !== info.windowId)
						return false;
					return true;
				})
				.map(toApi);
			return bus.settle(callback, result);
		},
		get(tabId: number, callback?: TabCallback) {
			const t = tabs.get(tabId);
			if (!t) return bus.settle(callback, undefined as unknown as chrome.tabs.Tab, noTab(tabId));
			return bus.settle(callback, toApi(t));
		},
		update(
			tabIdOrProps: number | chrome.tabs.UpdateProperties,
			propsOrCallback?: chrome.tabs.UpdateProperties | TabCallback,
			maybeCallback?: TabCallback
		) {
			const explicitId = typeof tabIdOrProps === "number";
			const props = (explicitId ? propsOrCallback : tabIdOrProps) as chrome.tabs.UpdateProperties;
			const callback = explicitId ? maybeCallback : (propsOrCallback as TabCallback | undefined);
			const t = explicitId ? tabs.get(tabIdOrProps) : [...tabs.values()].find((tab) => tab.active);
			if (!t) {
				const id = explicitId ? tabIdOrProps : -1;
				return bus.settle(callback, undefined as unknown as chrome.tabs.Tab, noTab(id));
			}
			const change: chrome.tabs.OnUpdatedInfo = {};
			if (props.url !== undefined && props.url !== t.url) {
				t.url = props.url;
				t.status = "loading";
				change.url = props.url;
				change.status = "loading";
			}
			if (Object.keys(change).length > 0) onUpdated.fire(t.id, change, toApi(t));
			if (props.active === true) activateTab(t);
			return bus.settle(callback, toApi(t));
		},
		remove(tabIds: number | number[], callback?: () => void) {
			const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
			const missing = ids.find((id) => !tabs.has(id));
			if (missing !== undefined) return bus.settle(callback, undefined, noTab(missing));
			for (const id of ids) {
				const tab = tabs.get(id);
				tabs.delete(id);
				if (!tab) continue;
				options.onTabRemoved?.(id);
				onRemoved.fire(id, { windowId: tab.windowId, isWindowClosing: false });
			}
			return bus.settle(callback, undefined);
		},
		sendMessage,
		onCreated: {
			addListener: onCreated.addListener,
			removeListener: onCreated.removeListener,
			hasListener: onCreated.hasListener,
		},
		onUpdated: {
			addListener: onUpdated.addListener,
			removeListener: onUpdated.removeListener,
			hasListener: onUpdated.hasListener,
		},
		onRemoved: {
			addListener: onRemoved.addListener,
			removeListener: onRemoved.removeListener,
			hasListener: onRemoved.hasListener,
		},
		onActivated: {
			addListener: onActivated.addListener,
			removeListener: onActivated.removeListener,
			hasListener: onActivated.hasListener,
		},
		onReplaced: {
			addListener: onReplaced.addListener,
			removeListener: onReplaced.removeListener,
			hasListener: onReplaced.hasListener,
		},
	};

	return {
		api,
		/** Mark a tab loaded/loading; fires `onUpdated` with the status change. */
		setStatus(tabId: number, status: VirtualTab["status"]): void {
			const t = tabs.get(tabId);
			if (!t) throw new Error(noTab(tabId));
			t.status = status;
			onUpdated.fire(tabId, { status }, toApi(t));
		},
		/** Navigate a tab (fires `onUpdated` with `url` + `status:"loading"`, then `"complete"`). */
		navigate(tabId: number, url: string): void {
			const t = tabs.get(tabId);
			if (!t) throw new Error(noTab(tabId));
			t.url = url;
			t.title = url;
			t.status = "loading";
			onUpdated.fire(tabId, { url, status: "loading" }, toApi(t));
			t.status = "complete";
			onUpdated.fire(tabId, { status: "complete" }, toApi(t));
		},
		/** Make a tab the active one in its window (fires `onActivated` when it changes). */
		activate(tabId: number): void {
			const t = tabs.get(tabId);
			if (!t) throw new Error(noTab(tabId));
			activateTab(t);
		},
		all: (): VirtualTab[] => [...tabs.values()],
		get: (tabId: number): VirtualTab | undefined => tabs.get(tabId),
		/** `chrome.tabs.Tab` view of a tab, or `undefined` (used by the bus for `sender.tab`). */
		toApi: (tabId: number): chrome.tabs.Tab | undefined => {
			const t = tabs.get(tabId);
			return t ? toApi(t) : undefined;
		},
		activeTab: (): VirtualTab | undefined => [...tabs.values()].find((t) => t.active),
	};
}

export type TabsSubsystem = ReturnType<typeof createTabsSubsystem>;
