// test/sim/contexts/panel-context.ts
/**
 * A side-panel page: its own `chrome.runtime` (so messages/ports cross the
 * bus to the SW), the shared fakes a panel may use, and a happy-dom window
 * at the panel URL installed as `window` / `document`. `send(message)` is
 * `chrome.runtime.sendMessage` from the panel, resolving with the reply.
 */

import type { Simulator } from "@test/sim";
import { createRuntimeSubsystem } from "@test/sim/chrome/runtime";
import { installGlobalChrome } from "@test/sim/contexts/bus";
import type { BootOptions, SimContext } from "@test/sim/contexts/sw-context";
import { installWindowGlobals } from "@test/sim/dom/tab-dom";
import { type Document, Window } from "happy-dom";

export interface PanelContext extends SimContext {
	readonly kind: "panel";
	readonly window: Window;
	readonly document: Document;
	send(message: unknown): Promise<unknown>;
}

export interface PanelBootOptions extends BootOptions {
	/** Initial `document.body` markup (default: an empty `<main id="app">`). */
	html?: string;
}

export async function bootPanelContext(
	sim: Simulator,
	options: PanelBootOptions = {}
): Promise<PanelContext> {
	const context = sim.bus.registerContext("panel");
	const runtime = createRuntimeSubsystem(sim.bus, context, {
		extensionContexts: sim.extensionContexts,
	});
	const chrome = sim.chromeFor("panel", runtime);
	const window = new Window({ url: context.url, width: 400, height: 800 });
	window.document.documentElement.innerHTML = "<head></head><body></body>";
	window.document.body.innerHTML = options.html ?? '<main id="app"></main>';

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

	return {
		kind: "panel",
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
		send(message: unknown): Promise<unknown> {
			return runtime.api.sendMessage(message) as Promise<unknown>;
		},
		async teardown() {
			if (!alive) return;
			alive = false;
			sim.bus.unregisterContext(context.id);
			runtime.cleanup();
			restoreBoot();
			restoreBoot = () => {};
			await sim.time.runMicrotasks();
			await window.happyDOM.close();
		},
	};
}
