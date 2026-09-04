// test/sim/chrome/runtime.ts
/**
 * `chrome.runtime` for ONE extension context. Every booted context (and the
 * default SW behind `sim.chrome`) gets its own instance so messages and ports
 * cross context boundaries through the bus; `lastError` is a getter onto the
 * bus-wide host, so whichever runtime the code under test reads it from sees
 * the error of the callback currently running.
 */

import type { Bus, ContextRecord } from "@test/sim/contexts/bus";
import type { ConnectListener, RuntimeMessageListener } from "@test/sim/types";

export interface RuntimeOptions {
	/** Live extension contexts for `runtime.getContexts` (wired by `createSimulator`). */
	extensionContexts?: () => chrome.runtime.ExtensionContext[];
}

type SendMessageCallback = (response: unknown) => void;

export function createRuntimeSubsystem(
	bus: Bus,
	context: ContextRecord,
	opts: RuntimeOptions = {}
) {
	const extensionContexts = opts.extensionContexts ?? (() => []);
	const onInstalled = bus.event<[chrome.runtime.InstalledDetails]>();
	const onStartup = bus.event<[]>();
	const onSuspend = bus.event<[]>();
	const onSuspendCanceled = bus.event<[]>();
	const onUpdateAvailable = bus.event<[chrome.runtime.UpdateAvailableDetails]>();
	const reloads: number[] = [];

	function sendMessage(...args: unknown[]) {
		// Overloads: (message, cb?) | (message, options, cb?) | (extensionId, message, options?, cb?)
		let rest = [...args];
		const callback =
			typeof rest[rest.length - 1] === "function" ? (rest.pop() as SendMessageCallback) : undefined;
		if (rest.length >= 2 && typeof rest[0] === "string" && rest.length <= 3) {
			// extensionId form (only when a second non-callback arg follows the id)
			rest = rest.slice(1);
		}
		const message = rest[0];
		if (typeof callback === "function") {
			bus.dispatchRuntime(context.id, message, (value, error) => bus.settle(callback, value, error));
			return undefined;
		}
		return new Promise<unknown>((resolve, reject) => {
			bus.dispatchRuntime(context.id, message, (value, error) => {
				if (error === undefined) resolve(value);
				else reject(new Error(error));
			});
		});
	}

	function connect(a?: unknown, b?: unknown): chrome.runtime.Port {
		const info = (typeof a === "string" ? b : a) as { name?: string } | undefined;
		return bus.connect(context.id, info?.name ?? "");
	}

	const api = {
		id: bus.extensionId,
		get lastError(): chrome.runtime.LastError | undefined {
			return bus.lastError.current;
		},
		set lastError(error: chrome.runtime.LastError | undefined) {
			bus.setLastError(error);
		},
		getURL: (path: string): string => bus.getURL(path),
		getManifest: (): chrome.runtime.Manifest => ({
			name: "sliced.gg",
			short_name: "sliced",
			manifest_version: 3,
			version: "2.0.0",
			minimum_chrome_version: "128",
		}),
		getPlatformInfo(callback?: (info: chrome.runtime.PlatformInfo) => void) {
			const info: chrome.runtime.PlatformInfo = { os: "mac", arch: "arm64", nacl_arch: "arm" };
			return bus.settle(callback, info);
		},
		getContexts(
			filter: chrome.runtime.ContextFilter,
			callback?: (contexts: chrome.runtime.ExtensionContext[]) => void
		) {
			let list = extensionContexts();
			if (filter.contextTypes) {
				const wanted = new Set<string>(filter.contextTypes);
				list = list.filter((c) => wanted.has(c.contextType));
			}
			if (filter.contextIds) {
				const wanted = new Set(filter.contextIds);
				list = list.filter((c) => wanted.has(c.contextId));
			}
			if (filter.tabIds) {
				const wanted = new Set(filter.tabIds);
				list = list.filter((c) => wanted.has(c.tabId));
			}
			return bus.settle(callback, list);
		},
		sendMessage,
		connect,
		reload(): void {
			reloads.push(bus.now());
		},
		setUninstallURL(_url: string, callback?: () => void) {
			return bus.settle(callback, undefined);
		},
		onMessage: {
			addListener: (l: RuntimeMessageListener) => void context.messageListeners.add(l),
			removeListener: (l: RuntimeMessageListener) => void context.messageListeners.delete(l),
			hasListener: (l: RuntimeMessageListener) => context.messageListeners.has(l),
		},
		onConnect: {
			addListener: (l: ConnectListener) => void context.connectListeners.add(l),
			removeListener: (l: ConnectListener) => void context.connectListeners.delete(l),
			hasListener: (l: ConnectListener) => context.connectListeners.has(l),
		},
		onInstalled: {
			addListener: onInstalled.addListener,
			removeListener: onInstalled.removeListener,
			hasListener: onInstalled.hasListener,
		},
		onStartup: {
			addListener: onStartup.addListener,
			removeListener: onStartup.removeListener,
			hasListener: onStartup.hasListener,
		},
		onSuspend: {
			addListener: onSuspend.addListener,
			removeListener: onSuspend.removeListener,
			hasListener: onSuspend.hasListener,
		},
		onSuspendCanceled: {
			addListener: onSuspendCanceled.addListener,
			removeListener: onSuspendCanceled.removeListener,
			hasListener: onSuspendCanceled.hasListener,
		},
		onUpdateAvailable: {
			addListener: onUpdateAvailable.addListener,
			removeListener: onUpdateAvailable.removeListener,
			hasListener: onUpdateAvailable.hasListener,
		},
		OnInstalledReason: {
			INSTALL: "install",
			UPDATE: "update",
			CHROME_UPDATE: "chrome_update",
			SHARED_MODULE_UPDATE: "shared_module_update",
		},
		ContextType: {
			TAB: "TAB",
			POPUP: "POPUP",
			BACKGROUND: "BACKGROUND",
			OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT",
			SIDE_PANEL: "SIDE_PANEL",
			DEVELOPER_TOOLS: "DEVELOPER_TOOLS",
		},
	};

	return {
		api,
		context,
		/** Fire the SW lifecycle events the simulator never raises on its own. */
		fireOnInstalled(details: chrome.runtime.InstalledDetails): void {
			onInstalled.fire(details);
		},
		fireOnStartup(): void {
			onStartup.fire();
		},
		fireOnSuspend(): void {
			onSuspend.fire();
		},
		fireOnUpdateAvailable(details: chrome.runtime.UpdateAvailableDetails): void {
			onUpdateAvailable.fire(details);
		},
		listenerCounts: () => ({
			message: context.messageListeners.size,
			connect: context.connectListeners.size,
			installed: onInstalled.count(),
			startup: onStartup.count(),
			suspend: onSuspend.count(),
		}),
		/** Timestamps of `runtime.reload()` calls. */
		reloads: (): number[] => [...reloads],
		/** Drop every listener this runtime registered (used by context teardown). */
		cleanup(): void {
			context.messageListeners.clear();
			context.connectListeners.clear();
			onInstalled.clear();
			onStartup.clear();
			onSuspend.clear();
			onSuspendCanceled.clear();
			onUpdateAvailable.clear();
		},
	};
}

export type RuntimeSubsystem = ReturnType<typeof createRuntimeSubsystem>;
