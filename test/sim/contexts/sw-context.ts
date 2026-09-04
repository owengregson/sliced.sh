// test/sim/contexts/sw-context.ts
/**
 * "Run the service worker": the SW is the simulator's default context
 * (`sim.chrome` is its `chrome`), so booting installs `sim.chrome` as the
 * global, makes the SW the owner of listeners registered from now on, and
 * runs the optional `entry` (the SW module's top-level side effects).
 * `teardown()` is the SW being terminated: every listener it registered
 * on any fake and every port it held are dropped; `chrome.storage.session`
 * survives (Chrome keeps it across SW restarts). Boot again to "restart".
 */

import type { Simulator } from "@test/sim";
import type { RuntimeSubsystem } from "@test/sim/chrome/runtime";
import { installGlobalChrome } from "@test/sim/contexts/bus";

export interface BootOptions {
	/** Executed after the context's globals are installed (e.g. `() => import("@service/service-worker")`). */
	entry?: () => Promise<unknown> | unknown;
}

export interface SimContext {
	readonly kind: "sw" | "panel" | "content" | "offscreen";
	readonly id: string;
	readonly chrome: typeof globalThis.chrome;
	readonly runtime: RuntimeSubsystem;
	/** Install this context's globals (chrome, window…) and make it the listener owner; returns the restore. */
	activate(): () => void;
	/** Run `fn` with this context active; globals are restored once it settles. */
	run<T>(fn: () => T | Promise<T>): Promise<T>;
	teardown(): Promise<void>;
}

export interface SwContext extends SimContext {
	readonly kind: "sw";
}

const booted = new WeakSet<Simulator>();

export async function bootSwContext(sim: Simulator, options: BootOptions = {}): Promise<SwContext> {
	if (booted.has(sim))
		throw new Error("bootSwContext: the service worker is already running; teardown first");
	booted.add(sim);
	const context = sim.bus.defaultContext;

	const activate = (): (() => void) => {
		const restoreChrome = installGlobalChrome(sim.chrome);
		const restoreActive = sim.bus.activate(context.id);
		return () => {
			restoreActive();
			restoreChrome();
		};
	};
	context.activate = activate;

	let restoreBoot = activate();
	try {
		await options.entry?.();
	} catch (error) {
		restoreBoot();
		booted.delete(sim);
		throw error;
	}

	return {
		kind: "sw",
		id: context.id,
		chrome: sim.chrome,
		runtime: sim.runtime,
		activate,
		async run(fn) {
			const restore = activate();
			try {
				return await fn();
			} finally {
				restore();
			}
		},
		async teardown() {
			if (!booted.has(sim)) return;
			booted.delete(sim);
			sim.bus.clearContext(context.id);
			sim.runtime.cleanup();
			restoreBoot();
			restoreBoot = () => {};
			await sim.time.runMicrotasks(); // let port disconnects reach the other ends
		},
	};
}
