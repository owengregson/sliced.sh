// test/content/feed-port.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { createFeedPort } from "@content/feed-port";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import type { PortScheduler } from "@core/messaging/ports";

type Listener<T> = (arg: T) => void;

interface FakePort {
	name: string;
	posted: unknown[];
	disconnected: boolean;
	postMessage(msg: unknown): void;
	disconnect(): void;
	onMessage: {
		addListener: Listener<Listener<unknown>>;
		removeListener: Listener<Listener<unknown>>;
	};
	onDisconnect: { addListener: Listener<() => void>; removeListener: Listener<() => void> };
	emitMessage(msg: unknown): void;
	emitDisconnect(): void;
}

function installFakeRuntime(): { ports: FakePort[] } {
	const ports: FakePort[] = [];
	const runtime = {
		lastError: undefined as { message: string } | undefined,
		connect: ({ name }: { name: string }): FakePort => {
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
				emitDisconnect() {
					port.disconnected = true;
					for (const l of disconnectListeners) l();
				},
			};
			ports.push(port);
			return port;
		},
	};
	(globalThis as Record<string, unknown>).chrome = { runtime };
	return { ports };
}

interface FakeScheduler extends PortScheduler {
	pending: Array<{ id: number; fn: () => void; ms: number }>;
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

const prevChrome = (globalThis as Record<string, unknown>).chrome;
afterEach(() => {
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

const hello: GamePortMessage = {
	kind: "hello",
	site: "chesscom",
	pageKind: "live-game",
	adapterVersion: "test",
};
const position: GamePortMessage = {
	kind: "position",
	snapshot: {
		site: "chesscom",
		gameId: "1",
		fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
		ply: 0,
		sideToMove: "w",
		myColor: "w",
		clocks: { w: { ms: 0, running: false }, b: { ms: 0, running: false } },
		capturedAt: 1,
	},
};

describe("FeedPort", () => {
	it("connects PORT_NAMES.game, posts in order and delivers commands", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const commands: GamePortCommand[] = [];
		const feed = createFeedPort({ onCommand: (c) => commands.push(c), scheduler });
		await feed.ready;
		expect(rt.ports[0]?.name).toBe(PORT_NAMES.game);
		feed.post(hello);
		feed.post({ kind: "focus", hasFocus: true, visibility: "visible", at: 1 });
		expect(rt.ports[0]?.posted).toEqual([
			hello,
			{ kind: "focus", hasFocus: true, visibility: "visible", at: 1 },
		]);
		rt.ports[0]?.emitMessage({ kind: "clearHighlight" });
		expect(commands).toEqual([{ kind: "clearHighlight" }]);
		feed.dispose();
		expect(rt.ports[0]?.disconnected).toBe(true);
	});
	it("re-sends hello and the last position first on every reconnect, then later messages", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const feed = createFeedPort({ onCommand: () => {}, scheduler });
		await feed.ready;
		feed.post(hello);
		feed.post(position);
		const newer: GamePortMessage = {
			...position,
			snapshot: { ...position.snapshot, ply: 1, capturedAt: 2 },
		};
		feed.post(newer);
		rt.ports[0]?.emitDisconnect();
		feed.post({ kind: "gameEnded", result: "1-0" });
		feed.post({ kind: "focus", hasFocus: true, visibility: "visible", at: 9 });
		scheduler.fire();
		// hello + last position first, then everything posted during the outage, in order
		expect(rt.ports[1]?.posted).toEqual([
			hello,
			newer,
			{ kind: "gameEnded", result: "1-0" },
			{ kind: "focus", hasFocus: true, visibility: "visible", at: 9 },
		]);
		// the new port dies at once (SW still gone): Chrome loses what was flushed into it, so the
		// next reconnect gets hello and the last position again — with the last focus reading between
		// them.
		//
		// That middle entry is a deliberate change (2026-09-10). This assertion used to read
		// `[hello, newer]`, i.e. it asserted that a focus reading was *not* replayed. It has to be:
		// `FocusGate` holds the page's focus state in the service worker's memory, nothing can ask the
		// page for it, and `canExecute` answers `unfocused` while it holds none — so a restarted worker
		// on a tab the owner has not blurred since load would skip every move with nothing to release
		// it. Everything the old assertion checked is still checked: `hello` still goes first, the last
		// position still precedes the outage queue, and a reading queued during the outage still wins
		// over the remembered one (the test below).
		rt.ports[1]?.emitDisconnect();
		scheduler.fire();
		expect(rt.ports[2]?.posted).toEqual([
			hello,
			{ kind: "focus", hasFocus: true, visibility: "visible", at: 9 },
			newer,
		]);
		// …and the focus reading goes *before* the position, which is not cosmetic: a first reading
		// fires a focus edge in the reconnected worker, and after the position that edge would land in
		// the move window the position opened — stamping the §13.2 focus fields on that move, and at
		// ply 0 satisfying the §13.4 first-move release with no owner action at all.
		const replayed = (rt.ports[2]?.posted ?? []) as GamePortMessage[];
		const focusAt = replayed.findIndex((m) => m.kind === "focus");
		const positionAt = replayed.findIndex((m) => m.kind === "position");
		expect(focusAt).toBeGreaterThanOrEqual(0);
		expect(focusAt).toBeLessThan(positionAt);
		feed.post({ kind: "focus", hasFocus: false, visibility: "hidden", at: 3 });
		expect(rt.ports[2]?.posted).toHaveLength(4);
		feed.dispose();
	});
	it("replays the last focus reading, and a newer one queued during the outage wins", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const feed = createFeedPort({ onCommand: () => {}, scheduler });
		await feed.ready;
		const focused: GamePortMessage = { kind: "focus", hasFocus: true, visibility: "visible", at: 1 };
		const blurred: GamePortMessage = { kind: "focus", hasFocus: false, visibility: "hidden", at: 2 };
		feed.post(hello);
		feed.post(focused);
		rt.ports[0]?.emitDisconnect();
		scheduler.fire();
		// Nothing else was sent, so the remembered reading is replayed on its own.
		expect(rt.ports[1]?.posted).toEqual([hello, focused]);

		// A newer reading posted during the next outage is the one that matters, and it must not be
		// sent twice: the remembered one is skipped when the outage queue already carries a `focus`.
		rt.ports[1]?.emitDisconnect();
		feed.post(blurred);
		scheduler.fire();
		expect(rt.ports[2]?.posted).toEqual([hello, blurred]);
		feed.dispose();
	});

	it("re-sends only what it has: hello alone before any position", async () => {
		const rt = installFakeRuntime();
		const scheduler = makeScheduler();
		const feed = createFeedPort({ onCommand: () => {}, scheduler });
		await feed.ready;
		feed.post(hello);
		rt.ports[0]?.emitDisconnect();
		scheduler.fire();
		expect(rt.ports[1]?.posted).toEqual([hello]);
		feed.dispose();
	});
});

it("notifies pointer cleanup immediately when the game connection disconnects", async () => {
	const rt = installFakeRuntime();
	const scheduler = makeScheduler();
	let disconnected = 0;
	const feed = createFeedPort({
		onCommand: () => {},
		onDisconnect: () => {
			disconnected += 1;
		},
		scheduler,
	});
	await feed.ready;
	rt.ports[0]?.emitDisconnect();
	expect(disconnected).toBe(1);
	feed.dispose();
});
