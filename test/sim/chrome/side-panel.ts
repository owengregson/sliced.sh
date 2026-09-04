// test/sim/chrome/side-panel.ts
/**
 * `chrome.sidePanel`: records `setOptions` per tab (or globally when no
 * `tabId`), `setPanelBehavior`, and every `open` call. Chrome requires a
 * user gesture for `open`; the fake does not (`opens` lets tests assert it
 * was called from the right place).
 */

import type { Bus } from "@test/sim/contexts/bus";

export interface SidePanelState {
	behavior: chrome.sidePanel.PanelBehavior;
	global: chrome.sidePanel.PanelOptions;
	byTab: Map<number, chrome.sidePanel.PanelOptions>;
	opens: Array<{ options: chrome.sidePanel.OpenOptions; at: number }>;
}

export function createSidePanelSubsystem(bus: Bus) {
	const state: SidePanelState = {
		behavior: { openPanelOnActionClick: false },
		global: { path: "pages/panel.html", enabled: true },
		byTab: new Map(),
		opens: [],
	};

	const api = {
		setOptions(options: chrome.sidePanel.PanelOptions, callback?: () => void) {
			const { tabId, ...rest } = options;
			if (tabId === undefined) state.global = { ...state.global, ...rest };
			else state.byTab.set(tabId, { ...(state.byTab.get(tabId) ?? {}), ...rest, tabId });
			return bus.settle(callback, undefined);
		},
		getOptions(
			options: chrome.sidePanel.GetPanelOptions,
			callback?: (options: chrome.sidePanel.PanelOptions) => void
		) {
			const result =
				options.tabId === undefined
					? { ...state.global }
					: { ...state.global, ...(state.byTab.get(options.tabId) ?? {}), tabId: options.tabId };
			return bus.settle(callback, result);
		},
		setPanelBehavior(behavior: chrome.sidePanel.PanelBehavior, callback?: () => void) {
			state.behavior = { ...state.behavior, ...behavior };
			return bus.settle(callback, undefined);
		},
		getPanelBehavior(callback?: (behavior: chrome.sidePanel.PanelBehavior) => void) {
			return bus.settle(callback, { ...state.behavior });
		},
		open(options: chrome.sidePanel.OpenOptions, callback?: () => void) {
			if (options.tabId === undefined && options.windowId === undefined) {
				return bus.settle(callback, undefined, "At least one of tabId and windowId must be provided.");
			}
			state.opens.push({ options: { ...options }, at: bus.now() });
			return bus.settle(callback, undefined);
		},
	};

	return {
		api,
		state,
		/** Effective options for a tab (global merged with the per-tab override). */
		optionsFor(tabId: number): chrome.sidePanel.PanelOptions {
			return { ...state.global, ...(state.byTab.get(tabId) ?? {}) };
		},
	};
}

export type SidePanelSubsystem = ReturnType<typeof createSidePanelSubsystem>;
