// test/sim/types.ts
/**
 * Shared types for the extension simulator (Task 8, ported from tranquill's
 * `test/sim`). Runtime helpers live in `contexts/bus.ts`; this file is types
 * only so every fake can import it without cycles.
 */

/** The four extension contexts the simulator models (content is per tab). */
export type ContextKind = "sw" | "panel" | "content" | "offscreen";

export interface SimulatorOptions {
	/** Pre-seed `chrome.storage.local`. */
	storageLocal?: Record<string, unknown>;
	/** Pre-seed `chrome.storage.session`. */
	storageSession?: Record<string, unknown>;
	/** Virtual clock start (ms epoch). Defaults to 2023-11-14T22:13:20Z. */
	startAt?: number;
}

export type StorageAreaName = "local" | "session";

export interface StorageChange {
	oldValue?: unknown;
	newValue?: unknown;
}

export type StorageChangeListener = (
	changes: Record<string, StorageChange>,
	areaName: StorageAreaName
) => void;

export interface AlarmRecord {
	name: string;
	/** ms epoch */
	scheduledTime: number;
	periodInMinutes?: number;
}

export type AlarmListener = (alarm: chrome.alarms.Alarm) => void;

export interface VirtualTab {
	id: number;
	url: string;
	title: string;
	status: "loading" | "complete";
	active: boolean;
	windowId: number;
}

/** One `chrome.debugger.sendCommand` observed by the fake, stamped with the virtual clock. */
export interface CdpCommandRecord {
	tabId: number;
	method: string;
	params: Record<string, unknown> | undefined;
	/** `sim.time.now()` at the moment the command was issued (ms epoch, monotonic). */
	at: number;
}

/** Handler a test scripts for a CDP method (`sim.debugger.respond(method, handler)`). */
export type CdpResponder = (
	params: Record<string, unknown> | undefined,
	tabId: number
) => unknown | Promise<unknown>;

export interface TtsCallRecord {
	utterance: string;
	options: chrome.tts.TtsOptions;
	at: number;
}

export interface OffscreenDocumentRecord {
	url: string;
	reasons: string[];
	justification: string;
	createdAt: number;
}

/** A `chrome.runtime.onMessage` listener as Chrome types it (`true` keeps `sendResponse` alive). */
export type RuntimeMessageListener = (
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void
	// biome-ignore lint/suspicious/noConfusingVoidType: listeners under test legitimately return nothing
) => boolean | undefined | void;

export type ConnectListener = (port: chrome.runtime.Port) => void;

/** The value `chrome.runtime.lastError` exposes while a failed callback runs. */
export interface LastErrorHost {
	/** Current error (undefined outside a failing callback). Reading it marks it checked. */
	readonly current: chrome.runtime.LastError | undefined;
	/** Errors that a callback never read — the "Unchecked runtime.lastError" Chrome would log. */
	readonly unchecked: string[];
}

/** Minimal `chrome.events.Event`-shaped fake with a `fire` helper. */
export interface SimEvent<Args extends unknown[]> {
	addListener(listener: (...args: Args) => unknown): void;
	removeListener(listener: (...args: Args) => unknown): void;
	hasListener(listener: (...args: Args) => unknown): boolean;
	/** Invoke every listener (snapshot) in registration order. */
	fire(...args: Args): void;
	count(): number;
	clear(): void;
}

/** Record of a DOM event the CDP input bridge dispatched into a tab. */
export interface DispatchedPointerEvent {
	tabId: number;
	type: string;
	x: number;
	y: number;
	button: number;
	buttons: number;
	/** `id` of the target element if it has one, else its tag name (lower-case). */
	target: string;
	at: number;
}

/** Something the time controller can drive (alarms); timers are built in. */
export interface TimerSource {
	/** Earliest due time (ms epoch) or `null` when idle. */
	nextDue(): number | null;
	/** Fire everything due at or before `now`; returns how many fired. */
	fireDue(now: number): number;
}
