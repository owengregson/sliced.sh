// test/sim/contexts/bus.ts
/**
 * The simulator's core: the registry of extension contexts (one SW, any
 * number of panel / content / offscreen contexts), `chrome.runtime.lastError`
 * plumbing shared by every fake, listener ownership (so tearing a context
 * down removes the listeners it registered on shared fakes), and the two
 * transports between contexts — one-shot messages and long-lived ports.
 *
 * Chrome semantics modelled here (see `assumptions.md` for the deviations):
 *   - `runtime.sendMessage` reaches every *other* extension context except
 *     content scripts; `tabs.sendMessage` reaches the content context(s) of
 *     one tab. A listener may answer synchronously with `sendResponse`, or
 *     return `true` and answer later. No listener at all → the caller sees
 *     `lastError` "Could not establish connection. Receiving end does not
 *     exist."; listeners but no answer → "The message port closed before a
 *     response was received.".
 *   - `runtime.connect(name)` opens a channel; `onConnect` fires in every
 *     other non-content context that listens, each receiving its own port
 *     end with a `sender`. `postMessage` fan-outs to the other ends on a
 *     microtask; `disconnect` closes the channel and fires `onDisconnect`
 *     on the *other* ends only. Posting on a closed port throws.
 */

import type {
	ConnectListener,
	ContextKind,
	LastErrorHost,
	RuntimeMessageListener,
	SimEvent,
} from "@test/sim/types";

export const NO_RECEIVER_ERROR = "Could not establish connection. Receiving end does not exist.";
export const PORT_CLOSED_ERROR = "The message port closed before a response was received.";
export const DISCONNECTED_PORT_ERROR = "Attempting to use a disconnected port object";

export type Respond = (value: unknown, error?: string) => void;

export interface ContextRecord {
	id: string;
	kind: ContextKind;
	tabId: number | undefined;
	url: string;
	messageListeners: Set<RuntimeMessageListener>;
	connectListeners: Set<ConnectListener>;
	/**
	 * Installs this context's globals (`chrome`, `window`, …) and returns the
	 * restore. Set by the context booters; `runAs` uses it so a callback runs
	 * in the context that registered it, as in Chrome.
	 */
	activate?: () => () => void;
}

export interface RegisterContextOptions {
	tabId?: number;
	url?: string;
}

interface Channel {
	name: string;
	closed: boolean;
	endpoints: Endpoint[];
}

interface Endpoint {
	channel: Channel;
	ownerId: string;
	connected: boolean;
	onMessage: SimEvent<[unknown, chrome.runtime.Port]>;
	onDisconnect: SimEvent<[chrome.runtime.Port]>;
	api: chrome.runtime.Port;
}

interface OwnedEvent {
	removeOwner(ownerId: string): void;
}

/** Chrome serialises messages and storage values as JSON: functions/undefined are dropped. */
export function jsonClone<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

interface GlobalEntry {
	token: symbol;
	value: unknown;
}
interface GlobalStack {
	base: { had: boolean; value: unknown };
	entries: GlobalEntry[];
}
const globalStacks = new Map<string, GlobalStack>();

/**
 * Install globals on behalf of a context; returns the restore. Each global
 * keeps a stack of installers so teardown may happen in any order: removing
 * a lower entry leaves the current top in place, removing the top re-applies
 * the next entry (or the value from before the first install).
 */
export function installGlobals(values: Record<string, unknown>): () => void {
	const g = globalThis as Record<string, unknown>;
	const token = Symbol("sim-globals");
	for (const [name, value] of Object.entries(values)) {
		let stack = globalStacks.get(name);
		if (!stack) {
			stack = { base: { had: name in g, value: g[name] }, entries: [] };
			globalStacks.set(name, stack);
		}
		stack.entries.push({ token, value });
		g[name] = value;
	}
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		for (const name of Object.keys(values)) {
			const stack = globalStacks.get(name);
			if (!stack) continue;
			const index = stack.entries.findIndex((e) => e.token === token);
			if (index < 0) continue;
			const wasTop = index === stack.entries.length - 1;
			stack.entries.splice(index, 1);
			if (!wasTop) continue; // a later context owns the global; it restores its own predecessor
			const top = stack.entries[stack.entries.length - 1];
			if (top) g[name] = top.value;
			else {
				if (stack.base.had) g[name] = stack.base.value;
				else delete g[name];
				globalStacks.delete(name);
			}
		}
	};
}

/** Swap `globalThis.chrome` for a context; returns the restore (order-independent, see `installGlobals`). */
export function installGlobalChrome(chrome: typeof globalThis.chrome): () => void {
	return installGlobals({ chrome });
}

/** A plain `chrome.events.Event`-shaped fake (no ownership tracking). */
export function createPlainEvent<Args extends unknown[]>(): SimEvent<Args> {
	const listeners = new Set<(...args: Args) => unknown>();
	return {
		addListener: (l) => void listeners.add(l),
		removeListener: (l) => void listeners.delete(l),
		hasListener: (l) => listeners.has(l),
		fire: (...args) => {
			for (const l of [...listeners]) l(...args);
		},
		count: () => listeners.size,
		clear: () => listeners.clear(),
	};
}

export interface Bus {
	readonly extensionId: string;
	readonly defaultContext: ContextRecord;
	now(): number;
	getURL(path: string): string;

	// ── lastError ─────────────────────────────────────────────────────────
	readonly lastError: LastErrorHost;
	/** Run `fn` with `chrome.runtime.lastError = { message }` set for its duration. */
	withLastError(message: string, fn: () => void): void;
	/** Assign `lastError` directly (tests that drive a stubbed callback by hand). */
	setLastError(error: chrome.runtime.LastError | undefined): void;
	/**
	 * Complete a Chrome API call: with a callback, invoke it (setting
	 * `lastError` on failure) and return `undefined`; without one, return a
	 * settled Promise. Mirrors Chrome's dual callback/Promise surface.
	 */
	settle<T>(callback: unknown, value: T, error?: string): Promise<T> | undefined;
	/** As `settle`, for results that arrive asynchronously. */
	settleAsync<T>(callback: unknown, result: Promise<T>): Promise<T> | undefined;

	// ── listener ownership ────────────────────────────────────────────────
	/** An event whose listeners are attributed to the context active at `addListener` time. */
	event<Args extends unknown[]>(): SimEvent<Args>;
	activeContextId(): string;
	/** Make `id` the active context (listener owner); returns the restore function. */
	activate(id: string): () => void;
	/** Run `fn` with context `id` active (its globals installed when it has an `activate` hook). */
	runAs<T>(id: string, fn: () => T): T;

	// ── contexts ──────────────────────────────────────────────────────────
	registerContext(kind: ContextKind, options?: RegisterContextOptions): ContextRecord;
	getContext(id: string): ContextRecord | undefined;
	contexts(): ContextRecord[];
	/** Drop every listener and port owned by `id` (the context "died"); keeps the record. */
	clearContext(id: string): void;
	/** `clearContext` + remove the record. Never used on the default SW context. */
	unregisterContext(id: string): void;
	/** Called with the context id whenever a context is cleared (used to cancel its fake timers). */
	onContextCleared(hook: (id: string) => void): () => void;
	/** Lets `sender.tab` carry the real tab object for content contexts. */
	setTabResolver(resolve: (tabId: number) => chrome.tabs.Tab | undefined): void;
	senderFor(ctx: ContextRecord): chrome.runtime.MessageSender;

	// ── one-shot messages ─────────────────────────────────────────────────
	dispatchRuntime(fromId: string, message: unknown, respond: Respond): void;
	dispatchToTab(fromId: string, tabId: number, message: unknown, respond: Respond): void;

	// ── ports ─────────────────────────────────────────────────────────────
	connect(fromId: string, name: string): chrome.runtime.Port;
	/** Open channels touching context `id` (or all when omitted). */
	openPortCount(id?: string): number;
}

export interface BusOptions {
	extensionId: string;
	now: () => number;
}

export function createBus(options: BusOptions): Bus {
	const { extensionId, now } = options;
	const getURL = (path: string): string =>
		`chrome-extension://${extensionId}/${path.replace(/^\//, "")}`;

	// ── lastError ───────────────────────────────────────────────────────────
	let currentError: chrome.runtime.LastError | undefined;
	let checked = false;
	const unchecked: string[] = [];
	const lastError: LastErrorHost = {
		get current() {
			checked = true;
			return currentError;
		},
		unchecked,
	};

	function withLastError(message: string, fn: () => void): void {
		const outer = currentError;
		const outerChecked = checked;
		currentError = { message };
		checked = false;
		try {
			fn();
		} finally {
			if (!checked) unchecked.push(message);
			currentError = outer;
			checked = outerChecked;
		}
	}

	function setLastError(error: chrome.runtime.LastError | undefined): void {
		currentError = error;
		checked = error === undefined;
	}

	function settle<T>(callback: unknown, value: T, error?: string): Promise<T> | undefined {
		if (typeof callback === "function") {
			const cb = callback as (v: T) => void;
			if (error === undefined) cb(value);
			else withLastError(error, () => cb(value));
			return undefined;
		}
		return error === undefined ? Promise.resolve(value) : Promise.reject(new Error(error));
	}

	function settleAsync<T>(callback: unknown, result: Promise<T>): Promise<T> | undefined {
		if (typeof callback === "function") {
			const owner = activeContextId();
			result.then(
				(value) => runAs(owner, () => settle(callback, value)),
				(err: unknown) =>
					runAs(owner, () =>
						settle(callback, undefined as T, err instanceof Error ? err.message : String(err))
					)
			);
			return undefined;
		}
		return result;
	}

	// ── contexts & ownership ────────────────────────────────────────────────
	const contexts = new Map<string, ContextRecord>();
	const counters = new Map<ContextKind, number>();
	const ownedEvents: OwnedEvent[] = [];
	const activeStack: string[] = [];

	function nextId(kind: ContextKind): string {
		const n = counters.get(kind) ?? 0;
		counters.set(kind, n + 1);
		return n === 0 ? kind : `${kind}#${n}`;
	}

	function registerContext(kind: ContextKind, opts: RegisterContextOptions = {}): ContextRecord {
		const id = nextId(kind);
		const url =
			opts.url ??
			(kind === "sw"
				? getURL("js/service-worker.js")
				: kind === "panel"
					? getURL("pages/panel.html")
					: kind === "offscreen"
						? getURL("pages/offscreen.html")
						: `https://tab-${opts.tabId ?? 0}.invalid/`);
		const record: ContextRecord = {
			id,
			kind,
			tabId: opts.tabId,
			url,
			messageListeners: new Set(),
			connectListeners: new Set(),
		};
		contexts.set(id, record);
		return record;
	}

	const defaultContext = registerContext("sw");
	activeStack.push(defaultContext.id);

	const activeContextId = (): string => activeStack[activeStack.length - 1] ?? defaultContext.id;

	function activate(id: string): () => void {
		activeStack.push(id);
		let restored = false;
		return () => {
			if (restored) return;
			restored = true;
			const index = activeStack.lastIndexOf(id);
			if (index > 0) activeStack.splice(index, 1);
		};
	}

	function runAs<T>(id: string, fn: () => T): T {
		if (id === activeContextId()) return fn();
		const ctx = contexts.get(id);
		const restore = ctx?.activate ? ctx.activate() : activate(id);
		try {
			return fn();
		} finally {
			restore();
		}
	}

	function event<Args extends unknown[]>(): SimEvent<Args> {
		type Listener = (...args: Args) => unknown;
		const owners = new Map<Listener, string>();
		const ev: SimEvent<Args> = {
			addListener: (l) => void owners.set(l, activeContextId()),
			removeListener: (l) => void owners.delete(l),
			hasListener: (l) => owners.has(l),
			fire: (...args) => {
				for (const [l, owner] of [...owners]) runAs(owner, () => l(...args));
			},
			count: () => owners.size,
			clear: () => owners.clear(),
		};
		ownedEvents.push({
			removeOwner(ownerId) {
				for (const [l, owner] of owners) if (owner === ownerId) owners.delete(l);
			},
		});
		return ev;
	}

	// ── senders ─────────────────────────────────────────────────────────────
	let tabResolver: (tabId: number) => chrome.tabs.Tab | undefined = () => undefined;

	function senderFor(ctx: ContextRecord): chrome.runtime.MessageSender {
		const sender: chrome.runtime.MessageSender = { id: extensionId, url: ctx.url };
		try {
			sender.origin = new URL(ctx.url).origin;
		} catch {
			// unparsable url — leave origin unset
		}
		if (ctx.kind === "content" && ctx.tabId !== undefined) {
			sender.tab = tabResolver(ctx.tabId) ?? minimalTab(ctx.tabId, ctx.url);
			sender.frameId = 0;
		}
		return sender;
	}

	// ── one-shot messages ───────────────────────────────────────────────────
	interface Target {
		ctxId: string;
		listener: RuntimeMessageListener;
	}

	function deliver(
		fromId: string,
		listeners: Target[],
		sender: chrome.runtime.MessageSender,
		message: unknown,
		reply: Respond
	): void {
		// The sender's callback runs under the sender's globals, even when a listener answers synchronously.
		const respond: Respond = (value, error) => runAs(fromId, () => reply(value, error));
		if (listeners.length === 0) {
			respond(undefined, NO_RECEIVER_ERROR);
			return;
		}
		let responded = false;
		let keepAlive = false;
		const sendResponse = (response?: unknown): void => {
			if (responded) return;
			responded = true;
			respond(jsonClone(response));
		};
		for (const { ctxId, listener } of listeners) {
			const result = runAs(ctxId, () => listener(jsonClone(message), sender, sendResponse));
			if (result === true) keepAlive = true;
		}
		if (!responded && !keepAlive) respond(undefined, PORT_CLOSED_ERROR);
	}

	function dispatchRuntime(fromId: string, message: unknown, respond: Respond): void {
		const from = contexts.get(fromId);
		if (!from) throw new Error(`sim bus: unknown context ${fromId}`);
		const listeners: Target[] = [];
		for (const ctx of contexts.values()) {
			if (ctx.id === fromId || ctx.kind === "content") continue;
			for (const listener of ctx.messageListeners) listeners.push({ ctxId: ctx.id, listener });
		}
		deliver(fromId, listeners, senderFor(from), message, respond);
	}

	function dispatchToTab(fromId: string, tabId: number, message: unknown, respond: Respond): void {
		const from = contexts.get(fromId);
		if (!from) throw new Error(`sim bus: unknown context ${fromId}`);
		const listeners: Target[] = [];
		for (const ctx of contexts.values()) {
			if (ctx.kind !== "content" || ctx.tabId !== tabId) continue;
			for (const listener of ctx.messageListeners) listeners.push({ ctxId: ctx.id, listener });
		}
		deliver(fromId, listeners, senderFor(from), message, respond);
	}

	// ── ports ───────────────────────────────────────────────────────────────
	const channels = new Set<Channel>();

	function closeChannel(channel: Channel, initiator: Endpoint | null, error?: string): void {
		if (channel.closed) return;
		channel.closed = true;
		channels.delete(channel);
		if (initiator) initiator.connected = false;
		for (const ep of channel.endpoints) {
			if (ep === initiator) continue;
			queueMicrotask(() => {
				if (!ep.connected) return;
				ep.connected = false;
				const fire = (): void => ep.onDisconnect.fire(ep.api);
				runAs(ep.ownerId, () => (error === undefined ? fire() : withLastError(error, fire)));
			});
		}
	}

	function makeEndpoint(
		channel: Channel,
		ownerId: string,
		sender: chrome.runtime.MessageSender | undefined
	): Endpoint {
		const onMessage = createPlainEvent<[unknown, chrome.runtime.Port]>();
		const onDisconnect = createPlainEvent<[chrome.runtime.Port]>();
		const endpoint: Endpoint = {
			channel,
			ownerId,
			connected: true,
			onMessage,
			onDisconnect,
			api: undefined as unknown as chrome.runtime.Port,
		};
		const api = {
			name: channel.name,
			postMessage(message: unknown): void {
				if (!endpoint.connected) throw new Error(DISCONNECTED_PORT_ERROR);
				const payload = jsonClone(message);
				for (const other of channel.endpoints) {
					if (other === endpoint) continue;
					queueMicrotask(() => {
						if (other.connected) runAs(other.ownerId, () => other.onMessage.fire(payload, other.api));
					});
				}
			},
			disconnect(): void {
				if (!endpoint.connected) return;
				closeChannel(channel, endpoint);
			},
			onMessage: {
				addListener: onMessage.addListener,
				removeListener: onMessage.removeListener,
				hasListener: onMessage.hasListener,
			},
			onDisconnect: {
				addListener: onDisconnect.addListener,
				removeListener: onDisconnect.removeListener,
				hasListener: onDisconnect.hasListener,
			},
		} as unknown as chrome.runtime.Port;
		if (sender) api.sender = sender;
		endpoint.api = api;
		channel.endpoints.push(endpoint);
		return endpoint;
	}

	function connect(fromId: string, name: string): chrome.runtime.Port {
		const from = contexts.get(fromId);
		if (!from) throw new Error(`sim bus: unknown context ${fromId}`);
		const channel: Channel = { name, closed: false, endpoints: [] };
		const local = makeEndpoint(channel, fromId, undefined);
		const receivers = [...contexts.values()].filter(
			(ctx) => ctx.id !== fromId && ctx.kind !== "content" && ctx.connectListeners.size > 0
		);
		if (receivers.length === 0) {
			closeChannel(channel, null, NO_RECEIVER_ERROR);
			return local.api;
		}
		channels.add(channel);
		const sender = senderFor(from);
		for (const ctx of receivers) {
			const remote = makeEndpoint(channel, ctx.id, sender);
			for (const listener of [...ctx.connectListeners]) runAs(ctx.id, () => listener(remote.api));
		}
		return local.api;
	}

	function openPortCount(id?: string): number {
		let n = 0;
		for (const channel of channels) {
			if (channel.closed) continue;
			if (id === undefined || channel.endpoints.some((ep) => ep.ownerId === id)) n += 1;
		}
		return n;
	}

	const clearedHooks = new Set<(id: string) => void>();

	function clearContext(id: string): void {
		const ctx = contexts.get(id);
		if (!ctx) return;
		ctx.messageListeners.clear();
		ctx.connectListeners.clear();
		for (const owned of ownedEvents) owned.removeOwner(id);
		for (const channel of [...channels]) {
			const mine = channel.endpoints.find((ep) => ep.ownerId === id);
			if (mine) closeChannel(channel, mine);
		}
		for (const hook of [...clearedHooks]) hook(id);
	}

	function unregisterContext(id: string): void {
		if (id === defaultContext.id)
			throw new Error("sim bus: the default SW context cannot be removed");
		clearContext(id);
		contexts.delete(id);
		const index = activeStack.lastIndexOf(id);
		if (index > 0) activeStack.splice(index, 1);
	}

	return {
		extensionId,
		defaultContext,
		now,
		getURL,
		lastError,
		withLastError,
		setLastError,
		settle,
		settleAsync,
		event,
		activeContextId,
		activate,
		runAs,
		registerContext,
		getContext: (id) => contexts.get(id),
		contexts: () => [...contexts.values()],
		clearContext,
		unregisterContext,
		onContextCleared: (hook) => {
			clearedHooks.add(hook);
			return () => void clearedHooks.delete(hook);
		},
		setTabResolver: (resolve) => {
			tabResolver = resolve;
		},
		senderFor,
		dispatchRuntime,
		dispatchToTab,
		connect,
		openPortCount,
	};
}

function minimalTab(id: number, url: string): chrome.tabs.Tab {
	return {
		id,
		url,
		index: 0,
		windowId: 1,
		active: true,
		pinned: false,
		highlighted: true,
		incognito: false,
		selected: true,
		discarded: false,
		autoDiscardable: true,
		groupId: -1,
		frozen: false,
	};
}
