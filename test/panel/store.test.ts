// test/panel/store.test.ts — `PanelStore`: snapshot replay to late subscribers, dispatch via
// `sendTyped`, and the handshake re-sent after a service-worker restart (ruling: Task 4's port
// drops a flushed batch to a dead receiver, so `PANEL_GET_SNAPSHOT` is re-requested per connection).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	MSG,
	type PanelPortMessage,
	type PanelSnapshot,
	PORT_NAMES,
	TOAST_KEYS,
} from "@core/constants";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import { createPanelStore, type PanelStore } from "@panel/store";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { makeSnapshot } from "./fixtures";

interface FakeSw {
	ctx: SwContext;
	ports: AcceptedPort<PanelPortMessage, never>[];
	snapshotRequests: number;
	router: MessageRouter;
	push(snapshot: PanelSnapshot): void;
}

let sim: Simulator;
let panel: PanelContext;
let store: PanelStore | null = null;

async function bootFakeSw(snapshot: PanelSnapshot, playNow: string[] = []): Promise<FakeSw> {
	const state: FakeSw = {
		ctx: undefined as unknown as SwContext,
		ports: [],
		snapshotRequests: 0,
		router: undefined as unknown as MessageRouter,
		push(s) {
			for (const p of state.ports) p.post({ kind: "snapshot", snapshot: s });
		},
	};
	state.ctx = await bootSwContext(sim, {
		entry: () => {
			acceptPorts<PanelPortMessage, never>(PORT_NAMES.panel, (port) => {
				state.ports.push(port);
			});
			state.router = installMessageRouter();
			state.router.on(MSG.PANEL_GET_SNAPSHOT, () => {
				state.snapshotRequests += 1;
				return snapshot;
			});
			state.router.on(MSG.PANEL_PLAY_NOW, (msg) => {
				playNow.push(`play:${msg.tabId}`);
			});
			state.router.install();
		},
	});
	return state;
}

beforeEach(async () => {
	sim = createSimulator();
	sim.time.install();
});
afterEach(async () => {
	store?.dispose();
	store = null;
	await panel?.teardown();
	await sim.dispose();
});

describe("PanelStore", () => {
	it("requests the snapshot on connect, replays it to late subscribers, and forwards port messages", async () => {
		const snap = makeSnapshot({ state: "live:opponent-turn" });
		const sw = await bootFakeSw(snap);
		panel = await bootPanelContext(sim);
		const seen: PanelSnapshot[] = [];
		store = await panel.run(() => createPanelStore());
		expect(sw.snapshotRequests).toBe(1);
		const unsub = store.subscribe((s) => seen.push(s));
		await sim.time.advance(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.session.state).toBe("live:opponent-turn");
		expect(store.snapshot?.session.state).toBe("live:opponent-turn");

		// A late subscriber gets the latest snapshot immediately.
		const late: PanelSnapshot[] = [];
		store.subscribe((s) => late.push(s));
		expect(late).toHaveLength(1);
		expect(late[0]).toEqual(seen[0] as PanelSnapshot);

		// Port pushes update everyone; unsubscribed callbacks stop.
		unsub();
		const toasts: string[] = [];
		store.onPortMessage((m) => {
			if (m.kind === "toast") toasts.push(m.key);
		});
		sw.push(makeSnapshot({ state: "game-over" }));
		for (const p of sw.ports) p.post({ kind: "toast", level: "info", key: TOAST_KEYS.reattached });
		await sim.time.advance(0);
		expect(seen).toHaveLength(1);
		expect(late).toHaveLength(2);
		expect(late[1]?.session.state).toBe("game-over");
		expect(store.snapshot?.session.state).toBe("game-over");
		expect(toasts).toEqual([TOAST_KEYS.reattached]);
		await sw.ctx.teardown();
	});

	it("dispatch() sends a typed message and resolves with the reply", async () => {
		const plays: string[] = [];
		const sw = await bootFakeSw(makeSnapshot(), plays);
		panel = await bootPanelContext(sim);
		store = await panel.run(() => createPanelStore());
		await sim.time.advance(0);
		await panel.run(() => store?.dispatch({ type: MSG.PANEL_PLAY_NOW, tabId: 7 }));
		expect(plays).toEqual(["play:7"]);
		await sw.ctx.teardown();
	});

	it("re-requests PANEL_GET_SNAPSHOT after a service-worker restart", async () => {
		const first = await bootFakeSw(makeSnapshot({ state: "waiting-for-game" }));
		panel = await bootPanelContext(sim);
		store = await panel.run(() => createPanelStore());
		const states: string[] = [];
		store.subscribe((s) => states.push(s.session.state));
		await sim.time.advance(0);
		expect(first.snapshotRequests).toBe(1);
		expect(states).toEqual(["waiting-for-game"]);

		// The SW dies: the port drops, nothing answers for a while.
		await first.ctx.teardown();
		await sim.time.advance(100);
		expect(store.connected).toBe(false);

		// It restarts with new state; the store must reconnect and ask again.
		const second = await bootFakeSw(makeSnapshot({ state: "live:my-turn:analysing" }));
		await sim.time.advance(10_000);
		expect(second.snapshotRequests).toBeGreaterThanOrEqual(1);
		expect(states.at(-1)).toBe("live:my-turn:analysing");
		expect(store.connected).toBe(true);
		expect(sim.bus.openPortCount()).toBe(1);

		// Snapshots pushed over the new port arrive.
		second.push(makeSnapshot({ state: "game-over" }));
		await sim.time.advance(0);
		expect(states.at(-1)).toBe("game-over");

		// Dispose stops the retry loop and closes the port.
		store.dispose();
		store = null;
		await sim.time.advance(0);
		expect(sim.bus.openPortCount()).toBe(0);
		await second.ctx.teardown();
	});
});
