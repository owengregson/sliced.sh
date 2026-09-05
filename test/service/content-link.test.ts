// test/service/content-link.test.ts — SW-side per-tab game-port registry (controller ruling).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EXECUTOR, type GamePortCommand, type GamePortMessage, PORT_NAMES } from "@core/constants";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import { defaultScheduler } from "@core/util/scheduler";
import { ContentLink } from "@service/content-link";
import { createSimulator, type Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";

let sim: Simulator;
let sw: SwContext;
let content: ContentContext;
let tabId: number;
let link: ContentLink;
let port: ConnectedPort<GamePortMessage>;
const received: GamePortCommand[] = [];

beforeEach(async () => {
	sim = createSimulator({ startAt: 1_000_000 });
	sim.time.install();
	tabId = sim.openTab("https://lichess.org/abcd1234").tabId;
	received.length = 0;
	sw = await bootSwContext(sim, {
		entry: () => {
			link = new ContentLink({ scheduler: defaultScheduler, now: sim.now });
		},
	});
	content = await bootContentContext(sim, tabId, {
		entry: () => {
			port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
				onMessage: (m) => received.push(m),
				scheduler: defaultScheduler,
			});
		},
	});
	await sim.time.runMicrotasks();
});
afterEach(async () => {
	await sw.run(() => link.dispose());
	await content.teardown();
	await sw.teardown();
	sim.time.uninstall();
	await sim.dispose();
});

describe("ContentLink", () => {
	it("tracks one port per tab with its window, posts commands and delivers messages per tab", async () => {
		expect(link.isConnected(tabId)).toBe(true);
		expect(link.windowIdOf(tabId)).toBe(1);
		expect(link.tabs()).toEqual([tabId]);
		expect(link.post(tabId, { kind: "clearHighlight" })).toBe(true);
		expect(link.post(999, { kind: "clearHighlight" })).toBe(false);
		await sim.time.runMicrotasks();
		expect(received).toEqual([{ kind: "clearHighlight" }]);

		const perTab: GamePortMessage[] = [];
		const all: Array<[number, GamePortMessage]> = [];
		const offTab = link.onMessage(tabId, (m) => perTab.push(m));
		const offAll = link.onMessage("*", (id, m) => all.push([id, m]));
		await content.run(async () => {
			port.post({ kind: "focus", hasFocus: false, visibility: "visible", at: sim.now() });
		});
		await sim.time.runMicrotasks();
		expect(perTab).toEqual([
			{ kind: "focus", hasFocus: false, visibility: "visible", at: 1_000_000 },
		]);
		expect(all).toEqual([[tabId, perTab[0] as GamePortMessage]]);
		offTab();
		offAll();
	});

	it("request() correlates the reply by id and consumes it; unmatched ids are ignored", async () => {
		const seen: GamePortMessage[] = [];
		link.onMessage(tabId, (m) => seen.push(m));
		const pending = link.request(tabId, { kind: "geometry" }, EXECUTOR.geometryTimeoutMs);
		await sim.time.runMicrotasks();
		const cmd = received[0];
		if (cmd?.kind !== "geometry") throw new Error("geometry command not delivered");
		expect(typeof cmd.id).toBe("string");
		await content.run(async () => {
			port.post({
				kind: "geometryResult",
				id: "not-this-one",
				boardRect: { left: 0, top: 0, width: 8, height: 8 },
				flipped: true,
			});
			port.post({
				kind: "geometryResult",
				id: cmd.id,
				boardRect: { left: 100, top: 60, width: 640, height: 640 },
				flipped: false,
			});
		});
		const reply = await pending;
		expect(reply.kind).toBe("geometryResult");
		expect(reply.boardRect).toEqual({ left: 100, top: 60, width: 640, height: 640 });
		expect(reply.flipped).toBe(false);
		// the correlated reply was consumed; the stray one reached the subscribers
		expect(seen.map((m) => (m.kind === "geometryResult" ? m.id : m.kind))).toEqual(["not-this-one"]);
	});

	it("request() rejects with a timeout error after timeoutMs, and immediately for an unknown tab", async () => {
		const p = link.request(tabId, { kind: "observeMove", expected: { from: "e2", to: "e4" } }, 300);
		const settled = { value: null as string | null };
		p.then(
			() => {
				settled.value = "resolved";
			},
			(e: Error) => {
				settled.value = e.message;
			}
		);
		await sim.time.advance(299);
		expect(settled.value).toBeNull();
		await sim.time.advance(2);
		expect(settled.value).toBe("timeout");
		await expect(link.request(999, { kind: "geometry" }, 100)).rejects.toThrow("no content port");
		expect(sim.time.pendingTimers()).toBe(0);
	});

	it("request() aborts at once on its signal, dropping the pending entry and its timer", async () => {
		const ac = new AbortController();
		const outcome = link.request(tabId, { kind: "geometry" }, 5000, ac.signal).then(
			() => "resolved",
			(e: Error) => e.message
		);
		await sim.time.runMicrotasks();
		expect(sim.time.pendingTimers()).toBe(1);
		ac.abort();
		expect(await outcome).toBe("aborted");
		expect(sim.time.pendingTimers()).toBe(0);
		// a late reply to the aborted id is ignored, an already-aborted signal rejects immediately
		const cmd = received.at(-1);
		if (cmd?.kind !== "geometry") throw new Error("geometry command not delivered");
		await content.run(async () => {
			port.post({
				kind: "geometryResult",
				id: cmd.id,
				boardRect: { left: 0, top: 0, width: 1, height: 1 },
				flipped: false,
			});
		});
		await sim.time.runMicrotasks();
		await expect(link.request(tabId, { kind: "geometry" }, 5000, ac.signal)).rejects.toThrow(
			"aborted"
		);
		expect(sim.time.pendingTimers()).toBe(0);
	});

	it("reports disconnects, rejects in-flight requests, and dispose() stops accepting ports", async () => {
		const gone: number[] = [];
		link.onDisconnect((id) => gone.push(id));
		const connected: number[] = [];
		link.onConnect((id) => connected.push(id));
		const inflight = link.request(tabId, { kind: "geometry" }, 5000).then(
			() => "resolved",
			(e: Error) => e.message
		);
		await content.run(async () => port.disconnect());
		await sim.time.runMicrotasks();
		expect(gone).toEqual([tabId]);
		expect(link.isConnected(tabId)).toBe(false);
		expect(await inflight).toBe("disconnected");
		expect(sim.time.pendingTimers()).toBe(0);
		// a fresh content port re-registers the tab
		await content.run(async () => {
			port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
				scheduler: defaultScheduler,
			});
		});
		await sim.time.runMicrotasks();
		expect(connected).toEqual([tabId]);
		expect(link.isConnected(tabId)).toBe(true);
		// one shared realm in the simulator: unsubscribe from the SW's own runtime
		await sw.run(() => link.dispose());
		expect(link.isConnected(tabId)).toBe(false);
		await content.run(async () => {
			port.disconnect();
			port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
				scheduler: defaultScheduler,
			});
		});
		await sim.time.runMicrotasks();
		expect(link.isConnected(tabId)).toBe(false);
		await content.run(async () => port.disconnect());
	});
});
