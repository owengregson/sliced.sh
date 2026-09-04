// test/sim/contexts/content-context.ts
/**
 * The ISOLATED-world content script of one tab: its own `chrome.runtime`
 * (registered on the bus for that `tabId`, so `tabs.sendMessage(tabId)`
 * reaches it and its messages carry `sender.tab`), `chrome.storage`, and
 * the tab's happy-dom (from `sim.openTab`) installed as `window` /
 * `document`. Content scripts do not receive `runtime.sendMessage` or
 * `runtime.onConnect` from other contexts, as in Chrome.
 */

import type { Simulator } from "@test/sim";
import { createRuntimeSubsystem } from "@test/sim/chrome/runtime";
import { installGlobalChrome } from "@test/sim/contexts/bus";
import type { BootOptions, SimContext } from "@test/sim/contexts/sw-context";
import { installWindowGlobals, type TabDom } from "@test/sim/dom/tab-dom";

export interface ContentContext extends SimContext {
	readonly kind: "content";
	readonly tabId: number;
	readonly dom: TabDom;
}

export async function bootContentContext(
	sim: Simulator,
	tabId: number,
	options: BootOptions = {}
): Promise<ContentContext> {
	const tab = sim.tabs.get(tabId);
	if (!tab) throw new Error(`bootContentContext: no tab ${tabId} (use sim.openTab first)`);
	const dom = sim.getTabDom(tabId);
	if (!dom) throw new Error(`bootContentContext: tab ${tabId} has no DOM (use sim.openTab)`);
	const context = sim.bus.registerContext("content", { tabId, url: tab.url });
	const runtime = createRuntimeSubsystem(sim.bus, context, {
		extensionContexts: sim.extensionContexts,
	});
	const chrome = sim.chromeFor("content", runtime);

	const activate = (): (() => void) => {
		const restoreChrome = installGlobalChrome(chrome);
		const restoreWindow = installWindowGlobals(dom.window);
		const restoreActive = sim.bus.activate(context.id);
		return () => {
			restoreActive();
			restoreWindow();
			restoreChrome();
		};
	};
	context.activate = activate;

	let restoreBoot = activate();
	let alive = true;
	try {
		await options.entry?.();
	} catch (error) {
		restoreBoot();
		sim.bus.unregisterContext(context.id);
		throw error;
	}

	const teardown = async (): Promise<void> => {
		if (!alive) return;
		alive = false;
		offRemoved();
		sim.bus.unregisterContext(context.id);
		runtime.cleanup();
		restoreBoot();
		restoreBoot = () => {};
		await sim.time.runMicrotasks();
	};

	// Closing the tab destroys its content script.
	const onRemoved = (removedId: number): void => {
		if (removedId === tabId) void teardown();
	};
	sim.tabs.api.onRemoved.addListener(onRemoved);
	const offRemoved = (): void => sim.tabs.api.onRemoved.removeListener(onRemoved);

	return {
		kind: "content",
		id: context.id,
		tabId,
		dom,
		chrome,
		runtime,
		activate,
		async run(fn) {
			const restore = activate();
			try {
				return await fn();
			} finally {
				restore();
			}
		},
		teardown,
	};
}
