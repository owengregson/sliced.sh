// test/core/messaging/router.test.ts
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { MSG } from "@core/constants";
import { log } from "@core/logger";
import { installMessageRouter } from "@core/messaging/router";

const sender = { id: "ext" } as chrome.runtime.MessageSender;
const tabSender = { id: "ext", tab: { id: 7 } } as chrome.runtime.MessageSender;

type OnMessageListener = (
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void
) => boolean;

function installFakeRuntimeOnMessage() {
	const listeners = new Set<OnMessageListener>();
	(globalThis as Record<string, unknown>).chrome = {
		runtime: {
			lastError: undefined,
			onMessage: {
				addListener: (l: OnMessageListener) => void listeners.add(l),
				removeListener: (l: OnMessageListener) => void listeners.delete(l),
				hasListener: (l: OnMessageListener) => listeners.has(l),
			},
		},
	};
	return listeners;
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).chrome;
});

describe("installMessageRouter._dispatch", () => {
	it("returns undefined for unhandled or malformed messages", () => {
		const router = installMessageRouter();
		expect(router._dispatch({ type: "sl:nope" }, sender)).toBeUndefined();
		expect(router._dispatch({ type: MSG.OFFSCREEN_PING }, sender)).toBeUndefined();
		expect(router._dispatch(null, sender)).toBeUndefined();
		expect(router._dispatch("string", sender)).toBeUndefined();
		expect(router._dispatch({ notType: 1 }, sender)).toBeUndefined();
	});

	it("wraps a sync handler's value in {success:true, response}", async () => {
		const router = installMessageRouter();
		router.on(MSG.OFFSCREEN_PING, () => ({ ok: true }));
		const result = router._dispatch({ type: MSG.OFFSCREEN_PING }, sender);
		expect(result).toBeInstanceOf(Promise);
		expect(await result).toEqual({ success: true, response: { ok: true } });
	});

	it("awaits an async handler", async () => {
		const router = installMessageRouter();
		router.on(MSG.PANEL_EXPORT_TIMING_LOG, async () => {
			await Promise.resolve();
			return [];
		});
		expect(await router._dispatch({ type: MSG.PANEL_EXPORT_TIMING_LOG }, sender)).toEqual({
			success: true,
			response: [],
		});
	});

	it("passes the payload and sender to the handler", async () => {
		const router = installMessageRouter();
		let seen: unknown[] = [];
		router.on(MSG.PANEL_SET_AUTO_MOVE, (msg, from) => {
			seen = [msg.tabId, msg.armed, from.tab?.id];
		});
		await router._dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId: 3, armed: true }, tabSender);
		expect(seen).toEqual([3, true, 7]);
	});

	it("responds {success:true} when a handler returns undefined (fire-and-forget)", async () => {
		const router = installMessageRouter();
		router.on(MSG.PANEL_CANCEL_PENDING, () => undefined);
		expect(await router._dispatch({ type: MSG.PANEL_CANCEL_PENDING, tabId: 1 }, sender)).toEqual({
			success: true,
			response: undefined,
		});
	});

	it("turns a sync throw into {success:false, error}", async () => {
		const router = installMessageRouter();
		router.on(MSG.PANEL_LOGIN, () => {
			throw new Error("bad key");
		});
		expect(await router._dispatch({ type: MSG.PANEL_LOGIN, key: "x" }, sender)).toEqual({
			success: false,
			error: "bad key",
		});
	});

	it("turns a rejected promise into {success:false, error}", async () => {
		const router = installMessageRouter();
		router.on(MSG.PANEL_LOGIN, () => Promise.reject(new Error("network")));
		expect(await router._dispatch({ type: MSG.PANEL_LOGIN, key: "x" }, sender)).toEqual({
			success: false,
			error: "network",
		});
		router.on(MSG.PANEL_LOGOUT, () => Promise.reject("plain string"));
		expect(await router._dispatch({ type: MSG.PANEL_LOGOUT }, sender)).toEqual({
			success: false,
			error: "plain string",
		});
	});

	it("warns on duplicate registration and lets the last writer win", async () => {
		const warn = spyOn(log, "warn").mockImplementation(() => {});
		try {
			const router = installMessageRouter();
			router.on(MSG.OFFSCREEN_PING, () => ({ ok: true }));
			expect(warn).not.toHaveBeenCalled();
			router.on(MSG.OFFSCREEN_PING, () => {
				throw new Error("second");
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("already registered");
			expect(await router._dispatch({ type: MSG.OFFSCREEN_PING }, sender)).toEqual({
				success: false,
				error: "second",
			});
		} finally {
			warn.mockRestore();
		}
	});
});

describe("installMessageRouter.install", () => {
	it("adds one onRuntimeMessage listener; async keeps the channel open; dispose removes it", async () => {
		const listeners = installFakeRuntimeOnMessage();
		const router = installMessageRouter();
		router.on(MSG.OFFSCREEN_PING, () => ({ ok: true }));
		router.on(MSG.PANEL_EXPORT_TIMING_LOG, async () => []);
		router.install();
		router.install();
		expect(listeners.size).toBe(1);
		const listener = [...listeners][0]!;

		const syncResponses: unknown[] = [];
		const keepOpenSync = listener({ type: MSG.OFFSCREEN_PING }, sender, (r) => syncResponses.push(r));
		expect(keepOpenSync).toBe(false);
		expect(syncResponses).toEqual([{ success: true, response: { ok: true } }]);

		const asyncResponses: unknown[] = [];
		let resolveDone: () => void = () => {};
		const done = new Promise<void>((r) => {
			resolveDone = r;
		});
		const keepOpenAsync = listener({ type: MSG.PANEL_EXPORT_TIMING_LOG }, sender, (r) => {
			asyncResponses.push(r);
			resolveDone();
		});
		expect(keepOpenAsync).toBe(true);
		expect(asyncResponses).toEqual([]);
		await done;
		expect(asyncResponses).toEqual([{ success: true, response: [] }]);

		expect(listener({ type: "sl:unknown" }, sender, () => {})).toBe(false);

		router.dispose();
		expect(listeners.size).toBe(0);
		router.install();
		expect(listeners.size).toBe(1);
		router.dispose();
	});
});
