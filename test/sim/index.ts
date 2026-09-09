// test/sim/index.ts
/**
 * Extension simulator façade (Task 8). `createSimulator()` wires the fakes
 * under one `chrome` object (the service worker's view, with the default SW
 * context's `runtime`), the bus that connects contexts, the virtual clock,
 * and the CDP input bridge that turns `Input.dispatchMouseEvent` into DOM
 * events on a tab's happy-dom. Boot other contexts with the helpers in
 * `contexts/*` (`bootSwContext`, `bootPanelContext`, `bootContentContext`,
 * `bootOffscreenContext`).
 */

import { type CdpInputBridge, createCdpInputBridge } from "@test/sim/bridges/cdp-input";
import { type AlarmsSubsystem, createAlarmsSubsystem } from "@test/sim/chrome/alarms";
import { type CommandsSubsystem, createCommandsSubsystem } from "@test/sim/chrome/commands";
import { createDebuggerSubsystem, type DebuggerSubsystem } from "@test/sim/chrome/debugger";
import { createOffscreenSubsystem, type OffscreenSubsystem } from "@test/sim/chrome/offscreen";
import { createRuntimeSubsystem, type RuntimeSubsystem } from "@test/sim/chrome/runtime";
import { createScriptingSubsystem, type ScriptingSubsystem } from "@test/sim/chrome/scripting";
import { createSidePanelSubsystem, type SidePanelSubsystem } from "@test/sim/chrome/side-panel";
import { createStorageSubsystem, type StorageSubsystem } from "@test/sim/chrome/storage";
import { createTabsSubsystem, type TabsSubsystem } from "@test/sim/chrome/tabs";
import { createTtsSubsystem, type TtsSubsystem } from "@test/sim/chrome/tts";
import { createWindowsSubsystem, type WindowsSubsystem } from "@test/sim/chrome/windows";
import { type Bus, createBus, installGlobalChrome } from "@test/sim/contexts/bus";
import { createTabDom, type TabDom } from "@test/sim/dom/tab-dom";
import { createTimeController, type TimeController } from "@test/sim/time/time-controller";
import type { ContextKind, SimulatorOptions, VirtualTab } from "@test/sim/types";

export type { Bus } from "@test/sim/contexts/bus";
export type { TabDom } from "@test/sim/dom/tab-dom";
export type { TimeController } from "@test/sim/time/time-controller";
export type {
	CdpCommandRecord,
	CdpResponder,
	ContextKind,
	SimulatorOptions,
	VirtualTab,
} from "@test/sim/types";

/** A Chrome-style extension id (32 chars a–p). */
export const SIM_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const DEFAULT_START_AT = 1_700_000_000_000;

export interface OpenTabOptions {
	active?: boolean;
	width?: number;
	height?: number;
	/** The browser window the tab belongs to (default 1); `active` is per window. */
	windowId?: number;
}

export interface OpenedTab {
	tabId: number;
	tab: VirtualTab;
	dom: TabDom;
}

export interface Simulator {
	/** The service worker's `chrome` (default SW context runtime + every shared fake). */
	chrome: typeof globalThis.chrome;
	extensionId: string;
	bus: Bus;
	/** The default SW context's runtime (lifecycle triggers: `fireOnInstalled`, …). */
	runtime: RuntimeSubsystem;
	storage: StorageSubsystem;
	tabs: TabsSubsystem;
	alarms: AlarmsSubsystem;
	debugger: DebuggerSubsystem;
	sidePanel: SidePanelSubsystem;
	offscreen: OffscreenSubsystem;
	commands: CommandsSubsystem;
	tts: TtsSubsystem;
	scripting: ScriptingSubsystem;
	windows: WindowsSubsystem;
	time: TimeController;
	now(): number;
	/** The CDP → DOM bridge (dispatched pointer events, per-tab pointer state). */
	input: CdpInputBridge;
	/** Create a loaded tab with its own happy-dom (registered with the input bridge). */
	openTab(url: string, options?: OpenTabOptions): OpenedTab;
	closeTab(tabId: number): void;
	getTabDom(tabId: number): TabDom | undefined;
	/** What `chrome.runtime.getContexts` reports. */
	extensionContexts(): chrome.runtime.ExtensionContext[];
	/** The `chrome` object a context of `kind` sees: its own runtime + the fakes it may use (full for sw/panel). */
	chromeFor(kind: ContextKind, runtime: RuntimeSubsystem): typeof globalThis.chrome;
	/** Uninstall fake timers and close every tab DOM. */
	dispose(): Promise<void>;
}

/** The simulator `test/setup.ts` installed behind the global `chrome`. */
export function getSimulator(): Simulator {
	const sim = (globalThis as { __sim?: Simulator }).__sim;
	if (!sim) throw new Error("getSimulator: test/setup.ts has not installed a simulator");
	return sim;
}

export function createSimulator(options: SimulatorOptions = {}): Simulator {
	const time = createTimeController(options.startAt ?? DEFAULT_START_AT);
	const now = time.now;
	const bus = createBus({ extensionId: SIM_EXTENSION_ID, now });

	const storage = createStorageSubsystem(bus, options);
	const tabs = createTabsSubsystem(bus, {
		// Chrome detaches the debugger when its target goes away (`debuggerSub` is assigned below;
		// the hook only runs on a later `tabs.remove`).
		onTabRemoved: (tabId) => debuggerSub.detachTargetClosed(tabId),
	});
	bus.setTabResolver(tabs.toApi);
	const alarms = createAlarmsSubsystem(bus);
	time.addSource(alarms.source);
	const input = createCdpInputBridge(now);
	const debuggerSub = createDebuggerSubsystem(bus, { send: input.send, tabs: tabs.all });
	const sidePanel = createSidePanelSubsystem(bus);
	const offscreen = createOffscreenSubsystem(bus);
	const commands = createCommandsSubsystem(bus);
	const tts = createTtsSubsystem(bus);
	const scripting = createScriptingSubsystem(bus);
	const windows = createWindowsSubsystem(bus);

	function extensionContexts(): chrome.runtime.ExtensionContext[] {
		const list: chrome.runtime.ExtensionContext[] = [];
		let offscreenListed = false;
		for (const ctx of bus.contexts()) {
			if (ctx.kind === "content") continue;
			const contextType: `${chrome.runtime.ContextType}` =
				ctx.kind === "sw" ? "BACKGROUND" : ctx.kind === "panel" ? "SIDE_PANEL" : "OFFSCREEN_DOCUMENT";
			if (ctx.kind === "offscreen") offscreenListed = true;
			list.push({
				contextId: ctx.id,
				contextType,
				documentUrl: ctx.url,
				documentOrigin: `chrome-extension://${SIM_EXTENSION_ID}`,
				frameId: ctx.kind === "sw" ? -1 : 0,
				incognito: false,
				tabId: -1,
				windowId: ctx.kind === "sw" ? -1 : 1,
			});
		}
		const doc = offscreen.document();
		if (doc && !offscreenListed) {
			list.push({
				contextId: "offscreen-document",
				contextType: "OFFSCREEN_DOCUMENT",
				documentUrl: bus.getURL(doc.url),
				documentOrigin: `chrome-extension://${SIM_EXTENSION_ID}`,
				frameId: 0,
				incognito: false,
				tabId: -1,
				windowId: -1,
			});
		}
		return list;
	}

	const runtime = createRuntimeSubsystem(bus, bus.defaultContext, { extensionContexts });

	function chromeFor(kind: ContextKind, rt: RuntimeSubsystem): typeof globalThis.chrome {
		const shared = {
			runtime: rt.api,
			storage: storage.api,
		};
		// Extension pages (SW, side panel) have the full API; content scripts and the offscreen
		// document only `runtime` + `storage`.
		const full =
			kind === "sw" || kind === "panel"
				? {
						...shared,
						tabs: tabs.api,
						alarms: alarms.api,
						debugger: debuggerSub.api,
						sidePanel: sidePanel.api,
						offscreen: offscreen.api,
						commands: commands.api,
						tts: tts.api,
						scripting: scripting.api,
						windows: windows.api,
					}
				: shared;
		return full as unknown as typeof globalThis.chrome;
	}

	const chrome = chromeFor("sw", runtime);
	bus.defaultContext.activate = () => {
		const restoreChrome = installGlobalChrome(chrome);
		const restoreActive = bus.activate(bus.defaultContext.id);
		return () => {
			restoreActive();
			restoreChrome();
		};
	};
	time.setContextHook({ capture: bus.activeContextId, run: bus.runAs });
	bus.onContextCleared((id) => void time.cancelOwner(id));
	const tabDoms = new Map<number, TabDom>();

	function openTab(url: string, opts: OpenTabOptions = {}): OpenedTab {
		let created: chrome.tabs.Tab | undefined;
		tabs.api.create({ url, active: opts.active ?? true, windowId: opts.windowId ?? 1 }, (tab) => {
			created = tab;
		});
		const tabId = created?.id;
		if (tabId === undefined) throw new Error("sim.openTab: tabs.create did not return a tab");
		const dom = createTabDom(url, {
			width: opts.width ?? 1280,
			height: opts.height ?? 800,
		});
		tabDoms.set(tabId, dom);
		input.registerTab(tabId, dom);
		tabs.setStatus(tabId, "complete");
		const tab = tabs.get(tabId);
		if (!tab) throw new Error("sim.openTab: tab vanished");
		return { tabId, tab, dom };
	}

	function closeTab(tabId: number): void {
		input.unregisterTab(tabId);
		const dom = tabDoms.get(tabId);
		tabDoms.delete(tabId);
		void dom?.close();
		if (tabs.get(tabId)) tabs.api.remove(tabId, () => {});
	}

	return {
		chrome,
		extensionId: SIM_EXTENSION_ID,
		bus,
		runtime,
		storage,
		tabs,
		alarms,
		debugger: debuggerSub,
		sidePanel,
		offscreen,
		commands,
		tts,
		scripting,
		windows,
		time,
		now,
		input,
		openTab,
		closeTab,
		getTabDom: (tabId) => tabDoms.get(tabId),
		extensionContexts,
		chromeFor,
		async dispose() {
			time.uninstall();
			for (const dom of tabDoms.values()) await dom.close();
			tabDoms.clear();
		},
	};
}
