// test/service/debugger-manager.test.ts — Step 2: attach lifecycle per Appendix H.7 / §9.2 / §13.4.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CDP, DEBUGGER_ATTACH_REASONS, TIMINGS } from "@core/constants";
import { defaultScheduler } from "@core/util/scheduler";
import { DebuggerManager } from "@service/debugger-manager";
import { Keepalive } from "@service/keepalive";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
let tabId: number;
let keepalive: Keepalive;
const prevChrome = (globalThis as Record<string, unknown>).chrome;
const managers: DebuggerManager[] = [];

beforeEach(() => {
	sim = createSimulator({ startAt: 1_000_000 });
	sim.time.install();
	tabId = sim.openTab("https://www.chess.com/game/live/1").tabId;
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
	keepalive = new Keepalive();
});
afterEach(async () => {
	for (const m of managers.splice(0)) m.dispose();
	sim.time.uninstall();
	(globalThis as Record<string, unknown>).chrome = prevChrome;
	await sim.dispose();
});

async function makeManager(): Promise<DebuggerManager> {
	const m = new DebuggerManager({ keepalive, scheduler: defaultScheduler, now: sim.now });
	managers.push(m);
	await m.ready;
	return m;
}

describe("DebuggerManager", () => {
	it("enables acknowledged native focus emulation and restores it without activating a tab", async () => {
		const m = await makeManager();
		await m.ensureAttached(tabId);
		expect(m.isFocusMaintained(tabId)).toBe(false);
		await m.setFocusMaintained(tabId, true);
		expect(m.isFocusMaintained(tabId)).toBe(true);
		await m.setFocusMaintained(tabId, false);
		expect(m.isFocusMaintained(tabId)).toBe(false);
		expect(sim.debugger.commandsFor(CDP.focusEmulation).map((c) => c.params)).toEqual([
			{ enabled: true },
			{ enabled: false },
		]);
		await m.setFocusMaintained(tabId, true);
		sim.debugger.detachByUser(tabId);
		expect(m.isFocusMaintained(tabId)).toBe(false);
	});

	it("never treats a rejected focus command as an active focus hold", async () => {
		const m = await makeManager();
		await m.ensureAttached(tabId);
		sim.debugger.respond(CDP.focusEmulation, () => {
			throw new Error("unavailable");
		});
		await expect(m.setFocusMaintained(tabId, true)).rejects.toThrow("unavailable");
		expect(m.isFocusMaintained(tabId)).toBe(false);
	});

	it("attaches once per tab with protocol 1.3, dedupes concurrent calls, and holds the keepalive", async () => {
		const versions: string[] = [];
		const realAttach = sim.chrome.debugger.attach.bind(sim.chrome.debugger);
		sim.chrome.debugger.attach = ((target, version, cb) => {
			versions.push(version);
			return realAttach(target, version, cb);
		}) as typeof sim.chrome.debugger.attach;
		const m = await makeManager();
		await Promise.all([m.ensureAttached(tabId), m.ensureAttached(tabId), m.ensureAttached(tabId)]);
		await m.ensureAttached(tabId);
		expect(versions).toEqual([CDP.protocolVersion]);
		expect(sim.debugger.attachments.filter((a) => a.action === "attach")).toHaveLength(1);
		expect(m.isAttached(tabId)).toBe(true);
		expect(keepalive.reasons()).toEqual(["debugger"]);
		await m.detach(tabId);
		expect(m.isAttached(tabId)).toBe(false);
		expect(sim.debugger.isAttached(tabId)).toBe(false);
		expect(keepalive.reasons()).toEqual([]);
	});

	it("rebuilds the attach map from getTargets() after a service-worker restart", async () => {
		const first = await makeManager();
		await first.ensureAttached(tabId);
		first.dispose(); // SW evicted: in-memory state gone, the debugger stays attached
		const restarted = await makeManager();
		expect(restarted.isAttached(tabId)).toBe(true);
		await restarted.ensureAttached(tabId);
		expect(sim.debugger.attachments.filter((a) => a.action === "attach")).toHaveLength(1);
		expect(keepalive.reasons()).toEqual(["debugger"]);
	});

	it("ensureAttached waits for the getTargets() rebuild: an arm racing the restart never re-attaches", async () => {
		await new Promise<void>((r) => sim.chrome.debugger.attach({ tabId }, CDP.protocolVersion, r));
		let release: (() => void) | null = null;
		const realGetTargets = sim.chrome.debugger.getTargets.bind(sim.chrome.debugger);
		sim.chrome.debugger.getTargets = ((cb?: (t: chrome.debugger.TargetInfo[]) => void) => {
			const gate = new Promise<void>((r) => {
				release = r;
			});
			return gate
				.then(() => realGetTargets())
				.then((targets) => {
					cb?.(targets);
					return targets;
				});
		}) as typeof sim.chrome.debugger.getTargets;
		let attachCalls = 0;
		const realAttach = sim.chrome.debugger.attach.bind(sim.chrome.debugger);
		sim.chrome.debugger.attach = ((target, version, cb) => {
			attachCalls += 1;
			return realAttach(target, version, cb);
		}) as typeof sim.chrome.debugger.attach;
		const m = new DebuggerManager({ keepalive, scheduler: defaultScheduler, now: sim.now });
		managers.push(m);
		const arming = m.ensureAttached(tabId);
		await sim.time.runMicrotasks();
		expect(m.isAttached(tabId)).toBe(false); // rebuild still pending
		(release as unknown as () => void)();
		await arming;
		expect(attachCalls).toBe(0);
		expect(m.isAttached(tabId)).toBe(true);
		expect(keepalive.reasons()).toEqual(["debugger"]);
	});

	it("onDetach(canceled_by_user) clears state, releases the keepalive and notifies subscribers", async () => {
		const m = await makeManager();
		await m.ensureAttached(tabId);
		const seen: Array<[number, string]> = [];
		const off = m.onDetached((id, reason) => seen.push([id, reason]));
		sim.debugger.detachByUser(tabId);
		await sim.time.runMicrotasks();
		expect(m.isAttached(tabId)).toBe(false);
		expect(seen).toEqual([[tabId, "canceled_by_user"]]);
		expect(keepalive.reasons()).toEqual([]);
		expect(m.lastError(tabId)).toBeUndefined();
		off();
		// re-attach on the next explicit request (arm time), not implicitly
		await m.ensureAttached(tabId);
		expect(m.isAttached(tabId)).toBe(true);
		sim.closeTab(tabId);
		await sim.time.runMicrotasks();
		expect(m.isAttached(tabId)).toBe(false);
		expect(seen).toHaveLength(1); // unsubscribed
	});

	it("detaches after debuggerIdleDetachMs without activity; send()/touch() reset the idle timer", async () => {
		const m = await makeManager();
		await m.ensureAttached(tabId);
		const idle = TIMINGS.debuggerIdleDetachMs;
		await sim.time.advance(idle - 1000);
		expect(m.isAttached(tabId)).toBe(true);
		await m.send(tabId, CDP.inputDispatchMouseEvent, { type: "mouseMoved", x: 5, y: 5 });
		await sim.time.advance(2000);
		expect(m.isAttached(tabId)).toBe(true);
		m.touch(tabId);
		await sim.time.advance(idle - 10);
		expect(m.isAttached(tabId)).toBe(true);
		const detached: string[] = [];
		m.onDetached((_id, reason) => detached.push(reason));
		await sim.time.advance(20);
		expect(m.isAttached(tabId)).toBe(false);
		expect(sim.debugger.isAttached(tabId)).toBe(false);
		expect(detached).toEqual(["idle"]);
		expect(keepalive.reasons()).toEqual([]);
	});

	it("maps attach errors to user-facing reasons and remembers the last one per tab", async () => {
		const m = await makeManager();
		// another client (DevTools) already holds the tab
		await new Promise<void>((r) => sim.chrome.debugger.attach({ tabId }, CDP.protocolVersion, r));
		await expect(m.ensureAttached(tabId)).rejects.toThrow(DEBUGGER_ATTACH_REASONS.anotherDebugger);
		expect(m.lastError(tabId)).toBe(DEBUGGER_ATTACH_REASONS.anotherDebugger);
		expect(m.isAttached(tabId)).toBe(false);
		await expect(m.ensureAttached(404)).rejects.toThrow(DEBUGGER_ATTACH_REASONS.noTab);
		const restricted = sim.openTab("chrome://extensions", { active: false }).tabId;
		const realAttach = sim.chrome.debugger.attach.bind(sim.chrome.debugger);
		sim.chrome.debugger.attach = ((target, version, cb) => {
			if (target.tabId === restricted) {
				sim.bus.withLastError("Cannot attach to this target.", () => cb?.());
				return undefined;
			}
			return realAttach(target, version, cb);
		}) as typeof sim.chrome.debugger.attach;
		await expect(m.ensureAttached(restricted)).rejects.toThrow(
			DEBUGGER_ATTACH_REASONS.restrictedPage
		);
		expect(m.lastError(restricted)).toBe(DEBUGGER_ATTACH_REASONS.restrictedPage);
		expect(keepalive.reasons()).toEqual([]);
	});

	it("send() requires an attachment and dispose() drops listeners and timers without detaching", async () => {
		const m = await makeManager();
		await expect(m.send(tabId, "Page.enable")).rejects.toThrow();
		await m.ensureAttached(tabId);
		expect(await m.send(tabId, "Page.enable")).toEqual({});
		m.dispose();
		expect(sim.time.pendingTimers()).toBe(0);
		expect(sim.debugger.isAttached(tabId)).toBe(true);
		sim.debugger.detachByUser(tabId);
		expect(m.isAttached(tabId)).toBe(false); // state cleared locally, no listener left to observe
	});
});
