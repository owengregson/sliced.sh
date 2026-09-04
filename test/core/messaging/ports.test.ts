// test/core/messaging/ports.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { PORT_NAMES } from "@core/constants";
import { acceptPorts, connectPort, type PortScheduler } from "@core/messaging/ports";

type Listener<T> = (arg: T) => void;

interface FakePort {
	name: string;
	sender?: chrome.runtime.MessageSender;
	posted: unknown[];
	disconnected: boolean;
	postMessage(msg: unknown): void;
	disconnect(): void;
	onMessage: {
		addListener: Listener<Listener<unknown>>;
		removeListener: Listener<Listener<unknown>>;
	};
	onDisconnect: { addListener: Listener<() => void>; removeListener: Listener<() => void> };
	/** Simulate the peer sending a message. */
	emitMessage(msg: unknown): void;
	/** Simulate the peer going away (optionally with a `lastError`). */
	emitDisconnect(error?: string): void;
}

interface FakeRuntime {
	ports: FakePort[];
	connectListeners: Set<(port: chrome.runtime.Port) => void>;
	/** Make the next `n` `runtime.connect` calls throw. */
	failConnects(n: number): void;
	/** Fire `onConnect` as Chrome would on the SW side. */
	emitConnect(port: FakePort): void;
	/** `lastError` observed by the most recent onDisconnect listener while it ran. */
	lastErrorSeen: unknown;
}

function makeFakePort(
	name: string,
	runtime: { lastError: { message: string } | undefined },
	sender?: chrome.runtime.MessageSender
): FakePort {
	const messageListeners = new Set<Listener<unknown>>();
	const disconnectListeners = new Set<() => void>();
	const port: FakePort = {
		name,
		posted: [],
		disconnected: false,
		postMessage(msg) {
			if (port.disconnected) throw new Error("Attempting to use a disconnected port object");
			port.posted.push(msg);
		},
		disconnect() {
			port.disconnected = true;
		},
		onMessage: {
			addListener: (l) => void messageListeners.add(l),
			removeListener: (l) => void messageListeners.delete(l),
		},
		onDisconnect: {
			addListener: (l) => void disconnectListeners.add(l),
			removeListener: (l) => void disconnectListeners.delete(l),
		},
		emitMessage(msg) {
			for (const l of messageListeners) l(msg);
		},
		emitDisconnect(error) {
			port.disconnected = true;
			runtime.lastError = error === undefined ? undefined : { message: error };
			try {
				for (const l of disconnectListeners) l();
			} finally {
				runtime.lastError = undefined;
			}
		},
	};
	if (sender) port.sender = sender;
	return port;
}

function installFakeRuntime(): FakeRuntime {
	const ports: FakePort[] = [];
	const connectListeners = new Set<(port: chrome.runtime.Port) => void>();
	let failing = 0;
	const runtime: {
		lastError: { message: string } | undefined;
		connect: (info: { name: string }) => FakePort;
		onConnect: {
			addListener: Listener<(port: chrome.runtime.Port) => void>;
			removeListener: Listener<(port: chrome.runtime.Port) => void>;
		};
	} = {
		lastError: undefined,
		connect: ({ name }) => {
			if (failing > 0) {
				failing -= 1;
				throw new Error("Extension context invalidated.");
			}
			const port = makeFakePort(name, runtime);
			ports.push(port);
			return port;
		},
		onConnect: {
			addListener: (l) => void connectListeners.add(l),
			removeListener: (l) => void connectListeners.delete(l),
		},
	};
	(globalThis as Record<string, unknown>).chrome = { runtime };
	return {
		ports,
		connectListeners,
		failConnects: (n) => {
			failing = n;
		},
		emitConnect: (port) => {
			for (const l of connectListeners) l(port as unknown as chrome.runtime.Port);
		},
		lastErrorSeen: undefined,
	};
}

interface FakeScheduler extends PortScheduler {
	pending: Array<{ id: number; fn: () => void; ms: number }>;
	/** Run the earliest pending timer. */
	fire(): void;
}

function makeScheduler(): FakeScheduler {
	let nextId = 1;
	const scheduler: FakeScheduler = {
		pending: [],
		setTimeout(fn, ms) {
			const id = nextId++;
			scheduler.pending.push({ id, fn, ms });
			return id;
		},
		clearTimeout(handle) {
			scheduler.pending = scheduler.pending.filter((t) => t.id !== handle);
		},
		fire() {
			const next = scheduler.pending.shift();
			if (!next) throw new Error("no pending timer");
			next.fn();
		},
	};
	return scheduler;
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).chrome;
});

describe("connectPort", () => {
	it("connects immediately, resolves ready, and posts straight through", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const received: unknown[] = [];
		const port = connectPort<{ kind: "uci"; line: string }, { kind: "line"; line: string }>(
			PORT_NAMES.engine,
			{ onMessage: (m) => received.push(m), scheduler }
		);
		await port.ready;
		expect(rt.ports).toHaveLength(1);
		expect(rt.ports[0]?.name).toBe(PORT_NAMES.engine);
		port.post({ kind: "uci", line: "isready" });
		expect(rt.ports[0]?.posted).toEqual([{ kind: "uci", line: "isready" }]);
		rt.ports[0]?.emitMessage({ kind: "line", line: "readyok" });
		expect(received).toEqual([{ kind: "line", line: "readyok" }]);
		expect(scheduler.pending).toHaveLength(0);
		port.disconnect();
	});

	it("queues post() before ready and flushes once connected", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		rt.failConnects(1);
		const port = connectPort<{ n: number }, never>(PORT_NAMES.panel, { scheduler });
		let readyResolved = false;
		void port.ready.then(() => {
			readyResolved = true;
		});
		port.post({ n: 1 });
		port.post({ n: 2 });
		await Promise.resolve();
		expect(readyResolved).toBe(false);
		expect(rt.ports).toHaveLength(0);
		expect(scheduler.pending.map((t) => t.ms)).toEqual([250]);
		scheduler.fire();
		await port.ready;
		expect(readyResolved).toBe(true);
		expect(rt.ports).toHaveLength(1);
		expect(rt.ports[0]?.posted).toEqual([{ n: 1 }, { n: 2 }]);
		port.disconnect();
	});

	it("reconnects after a disconnect and re-posts messages queued meanwhile", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const reasons: Array<string | undefined> = [];
		const port = connectPort<{ n: number }, never>(PORT_NAMES.game, {
			onDisconnect: (reason) => reasons.push(reason),
			scheduler,
		});
		await port.ready;
		port.post({ n: 1 });
		rt.ports[0]?.emitDisconnect("The message port closed before a response was received.");
		expect(reasons).toEqual(["The message port closed before a response was received."]);
		port.post({ n: 2 });
		port.post({ n: 3 });
		expect(rt.ports).toHaveLength(1);
		expect(scheduler.pending.map((t) => t.ms)).toEqual([250]);
		scheduler.fire();
		expect(rt.ports).toHaveLength(2);
		expect(rt.ports[0]?.posted).toEqual([{ n: 1 }]);
		expect(rt.ports[1]?.posted).toEqual([{ n: 2 }, { n: 3 }]);
		port.post({ n: 4 });
		expect(rt.ports[1]?.posted).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
		port.disconnect();
	});

	it("backs off 250 → 4000 ms doubling, and resets once the peer talks", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		rt.failConnects(6);
		const port = connectPort<never, { ok: true }>(PORT_NAMES.engine, { scheduler });
		const delays: number[] = [];
		for (let i = 0; i < 6; i += 1) {
			expect(scheduler.pending).toHaveLength(1);
			delays.push(scheduler.pending[0]?.ms ?? -1);
			scheduler.fire();
		}
		expect(delays).toEqual([250, 500, 1000, 2000, 4000, 4000]);
		await port.ready;
		expect(scheduler.pending).toHaveLength(0);
		expect(rt.ports).toHaveLength(1);
		rt.ports[0]?.emitMessage({ ok: true });
		rt.ports[0]?.emitDisconnect();
		expect(scheduler.pending.map((t) => t.ms)).toEqual([250]);
		port.disconnect();
	});

	it("disconnect() clears the reconnect timer, closes the port, and stops reconnecting", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const port = connectPort<{ n: number }, never>(PORT_NAMES.game, { scheduler });
		await port.ready;
		rt.ports[0]?.emitDisconnect();
		expect(scheduler.pending).toHaveLength(1);
		port.disconnect();
		expect(scheduler.pending).toHaveLength(0);
		port.post({ n: 9 });
		expect(rt.ports).toHaveLength(1);

		const rt2ports = rt.ports.length;
		const live = connectPort<{ n: number }, never>(PORT_NAMES.game, { scheduler });
		await live.ready;
		live.disconnect();
		expect(rt.ports[rt2ports]?.disconnected).toBe(true);
		expect(scheduler.pending).toHaveLength(0);
		live.post({ n: 1 });
		expect(rt.ports[rt2ports]?.posted).toEqual([]);
	});

	it("re-queues a message when postMessage throws on a dead port", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const port = connectPort<{ n: number }, never>(PORT_NAMES.panel, { scheduler });
		await port.ready;
		const first = rt.ports[0]!;
		first.disconnected = true; // dead, but onDisconnect not yet delivered
		port.post({ n: 1 });
		first.emitDisconnect();
		scheduler.fire();
		expect(rt.ports[1]?.posted).toEqual([{ n: 1 }]);
		port.disconnect();
	});
});

describe("acceptPorts", () => {
	it("filters onConnect by port name and wraps the port", () => {
		const rt = installFakeRuntime();
		const runtime = (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome
			.runtime;
		const seen: Array<{ tabId: number | undefined; messages: unknown[]; gone: boolean }> = [];
		const unsubscribe = acceptPorts<{ kind: "keybinds" }, { kind: "hello" }>(
			PORT_NAMES.game,
			(port) => {
				const record = { tabId: port.sender?.tab?.id, messages: [] as unknown[], gone: false };
				seen.push(record);
				port.onMessage((m) => record.messages.push(m));
				port.onDisconnect(() => {
					record.gone = true;
				});
				port.post({ kind: "keybinds" });
			}
		);
		expect(rt.connectListeners.size).toBe(1);

		const other = makeFakePort(PORT_NAMES.panel, runtime as never);
		rt.emitConnect(other);
		expect(seen).toHaveLength(0);

		const game = makeFakePort(
			PORT_NAMES.game,
			runtime as never,
			{
				id: "ext",
				tab: { id: 42 },
			} as chrome.runtime.MessageSender
		);
		rt.emitConnect(game);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.tabId).toBe(42);
		expect(game.posted).toEqual([{ kind: "keybinds" }]);
		game.emitMessage({ kind: "hello" });
		expect(seen[0]?.messages).toEqual([{ kind: "hello" }]);
		game.emitDisconnect("bfcache");
		expect(seen[0]?.gone).toBe(true);

		unsubscribe();
		expect(rt.connectListeners.size).toBe(0);
	});

	it("onMessage/onDisconnect return unsubscribers", () => {
		const rt = installFakeRuntime();
		const runtime = (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome
			.runtime;
		const messages: unknown[] = [];
		let disconnects = 0;
		const unsubscribe = acceptPorts<never, { n: number }>(PORT_NAMES.engine, (port) => {
			const offMessage = port.onMessage((m) => messages.push(m));
			const offDisconnect = port.onDisconnect(() => {
				disconnects += 1;
			});
			offMessage();
			offDisconnect();
		});
		const engine = makeFakePort(PORT_NAMES.engine, runtime as never);
		rt.emitConnect(engine);
		engine.emitMessage({ n: 1 });
		engine.emitDisconnect();
		expect(messages).toEqual([]);
		expect(disconnects).toBe(0);
		unsubscribe();
	});
});
