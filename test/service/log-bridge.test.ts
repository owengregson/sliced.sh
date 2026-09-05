// test/service/log-bridge.test.ts — the SW log bridge (ring + `PORT_NAMES.logStream` fan-out)
// against the panel's `logging-bridge.ts` in the simulator: backlog on connect, live entries,
// level filter applied at source, bounded ring, backlog re-sent after a SW restart.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LIMITS, MSG, TIMINGS } from "@core/constants";
import { __setLogSinkOutsideServiceWorker, type LogEntry, log, setLogLevel } from "@core/logger";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import { createLoggingBridge, type LoggingBridge } from "@panel/logging-bridge";
import { registerLogHandlers } from "@service/handlers/log";
import { installLogBridge, type LogBridge } from "@service/log-bridge";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";

let sim: Simulator;
let sw: SwContext;
let panel: PanelContext;
let router: MessageRouter;
let bridge: LogBridge;
let panelBridge: LoggingBridge | null = null;

function entry(level: LogEntry["level"], text: string, at = 1): LogEntry {
	return { level, args: [text], meta: { source: "test", timestamp: at } };
}

async function bootSw(): Promise<SwContext> {
	return bootSwContext(sim, {
		entry: () => {
			router = installMessageRouter();
			bridge = installLogBridge(router);
			registerLogHandlers(router, bridge);
			router.install();
		},
	});
}

async function settle(): Promise<void> {
	await sim.time.runMicrotasks();
	await sim.time.runMicrotasks();
}

beforeEach(async () => {
	__setLogSinkOutsideServiceWorker(true); // the simulator's SW has no ServiceWorkerGlobalScope
	sim = createSimulator();
	sim.time.install();
	sw = await bootSw();
	panel = await bootPanelContext(sim);
});

afterEach(async () => {
	panelBridge?.dispose();
	panelBridge = null;
	bridge.dispose();
	router.dispose();
	setLogLevel("info");
	__setLogSinkOutsideServiceWorker(false);
	await panel.teardown();
	await sw.teardown();
	await sim.dispose();
});

describe("SW log bridge + panel logging bridge", () => {
	it("sends the ring backlog on connect, in order", async () => {
		bridge.push(entry("info", "one"));
		bridge.push(entry("warn", "two"));
		bridge.push(entry("error", "three"));
		const events: string[] = [];
		panelBridge = await panel.run(() => {
			const bridge = createLoggingBridge({ level: "debug" });
			bridge.subscribe((ev) => events.push(ev.kind));
			return bridge;
		});
		await settle();
		expect(events).toEqual(["backlog"]);
		expect(panelBridge.entries.map((e) => e.args[0])).toEqual(["one", "two", "three"]);
		expect(bridge.subscriberCount()).toBe(1);
	});

	it("streams new entries: direct pushes, forwarded MSG.LOG envelopes and the SW logger", async () => {
		panelBridge = await panel.run(() => createLoggingBridge({ level: "debug" }));
		const live: string[] = [];
		panelBridge.subscribe((ev) => {
			if (ev.kind === "entry") live.push(String(ev.entry.args[0]));
		});
		await settle();
		bridge.push(entry("info", "pushed"));
		await settle();
		// A second extension page forwards a log envelope to the SW (`@core/logger` path).
		const other = await bootPanelContext(sim);
		const reply = await other.send({
			type: MSG.LOG,
			level: "warn",
			args: ["forwarded"],
			meta: { source: "other", timestamp: 2 },
		});
		expect(reply).toMatchObject({ success: true });
		await settle();
		// The SW's own logger feeds the ring through the bridge's sink.
		await sw.run(() => log.info("direct"));
		await settle();
		expect(live).toEqual(["pushed", "forwarded", "direct"]);
		expect(bridge.backlog().map((e) => e.args[0])).toEqual(["pushed", "forwarded", "direct"]);
		await other.teardown();
	});

	it("applies the level filter at the source: the SW stops sending below the level", async () => {
		panelBridge = await panel.run(() => createLoggingBridge({ level: "info" }));
		const received: string[] = [];
		panelBridge.subscribe((ev) => {
			if (ev.kind === "entry") received.push(`${ev.entry.level}:${ev.entry.args[0]}`);
		});
		await settle();
		expect(bridge.subscriberLevels()).toEqual(["info"]);
		bridge.push(entry("debug", "hidden-debug"));
		bridge.push(entry("info", "shown-info"));
		await settle();
		panelBridge.setLevel("warn");
		await settle();
		expect(bridge.subscriberLevels()).toEqual(["warn"]);
		bridge.push(entry("info", "hidden-info"));
		bridge.push(entry("warn", "shown-warn"));
		bridge.push(entry("error", "shown-error"));
		await settle();
		expect(received).toEqual(["info:shown-info", "warn:shown-warn", "error:shown-error"]);
		expect(panelBridge.level).toBe("warn");
		// `silent` stops everything.
		panelBridge.setLevel("silent");
		await settle();
		bridge.push(entry("error", "silenced"));
		await settle();
		expect(received).toHaveLength(3);
	});

	it("bounds the ring to LIMITS.logRingMax and the backlog is filtered by level", async () => {
		for (let i = 0; i < LIMITS.logRingMax + 10; i += 1) bridge.push(entry("info", `e${i}`));
		bridge.push(entry("debug", "trailing-debug"));
		const backlog = bridge.backlog();
		expect(backlog).toHaveLength(LIMITS.logRingMax);
		expect(backlog[0]?.args[0]).toBe("e11");
		expect(backlog[backlog.length - 1]?.args[0]).toBe("trailing-debug");
		panelBridge = await panel.run(() => createLoggingBridge({ level: "info" }));
		await settle();
		expect(panelBridge.entries).toHaveLength(LIMITS.logRingMax - 1);
		expect(panelBridge.entries.some((e) => e.args[0] === "trailing-debug")).toBe(false);
	});

	it("re-sends the backlog and re-applies the level after a service-worker restart", async () => {
		const events: string[] = [];
		panelBridge = await panel.run(() => {
			const bridge = createLoggingBridge({ level: "debug" });
			bridge.subscribe((ev) =>
				events.push(ev.kind === "backlog" ? `backlog:${ev.entries.length}` : "entry")
			);
			return bridge;
		});
		await settle();
		panelBridge.setLevel("warn");
		await settle();
		expect(bridge.subscriberLevels()).toEqual(["warn"]);
		bridge.push(entry("error", "before-restart"));
		await settle();
		expect(events).toEqual(["backlog:0", "entry"]);

		// The SW dies: its ports close and the panel schedules a reconnect with backoff.
		bridge.dispose();
		router.dispose();
		await sw.teardown();
		await settle();
		expect(sim.bus.openPortCount()).toBe(0);
		sw = await bootSw();
		bridge.push(entry("warn", "after-restart"));
		bridge.push(entry("debug", "too-verbose"));
		await sim.time.advance(TIMINGS.portReconnectBaseMs);
		await settle();
		expect(bridge.subscriberCount()).toBe(1);
		expect(bridge.subscriberLevels()).toEqual(["warn"]);
		expect(events).toEqual(["backlog:0", "entry", "backlog:1"]);
		expect(panelBridge.entries.map((e) => e.args[0])).toEqual(["after-restart"]);
	});

	it("never re-enters through the logger: a dead subscriber that logs at debug cannot recurse", async () => {
		setLogLevel("debug");
		let sends = 0;
		const dead = {
			level: "debug" as const,
			send(): void {
				sends += 1;
				// What `acceptPorts`' post does on a dead port: log the failure (debug) and swallow.
				log.debug("port: postMessage to peer failed");
				throw new Error("Attempting to use a disconnected port object");
			},
		};
		const healthy: string[] = [];
		const alive = {
			level: "debug" as const,
			send: (m: { kind: string }) => void healthy.push(m.kind),
		};
		bridge.addSubscriber(dead);
		bridge.addSubscriber(alive);
		bridge.sendBacklog(dead);
		bridge.sendBacklog(alive);
		await settle();
		expect(sends).toBe(1); // the backlog
		bridge.push(entry("info", "x"));
		await settle();
		expect(sends).toBe(2); // one send per delivery, no recursion
		expect(healthy).toEqual(["backlog", "entry"]); // the throw did not break the other subscriber
		// The debug entries the dead subscriber logged went to the ring only.
		const ringText = bridge.backlog().map((e) => String(e.args[0]));
		expect(ringText.filter((t) => t === "x")).toHaveLength(1);
		expect(ringText.filter((t) => t.startsWith("port: postMessage")).length).toBeGreaterThan(0);
		expect(bridge.backlog().length).toBeLessThan(10);
	});

	it("dispose closes the port and drops the SW subscriber", async () => {
		panelBridge = await panel.run(() => createLoggingBridge({ level: "info" }));
		await settle();
		expect(bridge.subscriberCount()).toBe(1);
		panelBridge.dispose();
		panelBridge = null;
		await settle();
		expect(bridge.subscriberCount()).toBe(0);
		expect(sim.bus.openPortCount()).toBe(0);
	});

	it("PANEL_EXPORT_TIMING_LOG / PANEL_CLEAR_TIMING_LOG read and clear LOCAL_KEYS.timingLog", async () => {
		const { LOCAL_KEYS } = await import("@core/constants");
		const empty = (await panel.send({ type: MSG.PANEL_EXPORT_TIMING_LOG })) as {
			success: boolean;
			response: unknown[];
		};
		expect(empty).toEqual({ success: true, response: [] });
		sim.storage.data.local[LOCAL_KEYS.timingLog] = [{ gameId: "g", ply: 1 }];
		const full = (await panel.send({ type: MSG.PANEL_EXPORT_TIMING_LOG })) as {
			success: boolean;
			response: unknown[];
		};
		expect(full.response).toEqual([{ gameId: "g", ply: 1 }]);
		const cleared = await panel.send({ type: MSG.PANEL_CLEAR_TIMING_LOG });
		expect(cleared).toMatchObject({ success: true });
		expect(sim.storage.data.local[LOCAL_KEYS.timingLog]).toBeUndefined();
	});

	it("PANEL_RESET_SESSION zeroes LOCAL_KEYS.sessionStats", async () => {
		const { LOCAL_KEYS } = await import("@core/constants");
		sim.storage.data.local[LOCAL_KEYS.sessionStats] = { games: 6, moves: 200, avgThinkMs: 3100 };
		const reply = await panel.send({ type: MSG.PANEL_RESET_SESSION });
		expect(reply).toMatchObject({ success: true });
		expect(sim.storage.data.local[LOCAL_KEYS.sessionStats]).toEqual({
			games: 0,
			moves: 0,
			avgThinkMs: 0,
		});
	});
});
