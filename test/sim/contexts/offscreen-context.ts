// test/sim/contexts/offscreen-context.ts
/**
 * The offscreen document's page: own `chrome.runtime` + `chrome.storage`
 * and a happy-dom window at the offscreen URL. Booting adopts a document
 * record if the SW has not called `offscreen.createDocument` yet, so
 * `runtime.getContexts` stays coherent; `offscreen.closeDocument()` tears
 * the context down (its ports disconnect, as in Chrome).
 */

import type { Simulator } from "@test/sim";
import { createRuntimeSubsystem } from "@test/sim/chrome/runtime";
import { installGlobalChrome } from "@test/sim/contexts/bus";
import type { BootOptions, SimContext } from "@test/sim/contexts/sw-context";
import { installWindowGlobals } from "@test/sim/dom/tab-dom";
import { type Document, Window } from "happy-dom";

export interface OffscreenContext extends SimContext {
	readonly kind: "offscreen";
	readonly window: Window;
	readonly document: Document;
}

export async function bootOffscreenContext(
	sim: Simulator,
	options: BootOptions = {}
): Promise<OffscreenContext> {
	const existing = sim.offscreen.document();
	const url = existing ? sim.bus.getURL(existing.url) : sim.bus.getURL("pages/offscreen.html");
	if (!existing) sim.offscreen.adopt("pages/offscreen.html");
	const context = sim.bus.registerContext("offscreen", { url });
	const runtime = createRuntimeSubsystem(sim.bus, context, {
		extensionContexts: sim.extensionContexts,
	});
	const chrome = sim.chromeFor("offscreen", runtime);
	const window = new Window({ url, width: 1, height: 1 });
	window.document.documentElement.innerHTML = "<head></head><body></body>";

	const activate = (): (() => void) => {
		const restoreChrome = installGlobalChrome(chrome);
		const restoreWindow = installWindowGlobals(window);
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
		offClose();
		sim.bus.unregisterContext(context.id);
		runtime.cleanup();
		restoreBoot();
		restoreBoot = () => {};
		await sim.time.runMicrotasks();
		await window.happyDOM.close();
	};
	const offClose = sim.offscreen.onClose(() => void teardown());

	return {
		kind: "offscreen",
		id: context.id,
		chrome,
		runtime,
		window,
		document: window.document,
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
