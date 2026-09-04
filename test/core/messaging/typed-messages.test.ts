// test/core/messaging/typed-messages.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { MSG } from "@core/constants";
import { sendTyped, sendTypedToTab } from "@core/messaging/typed-messages";

type Reply = (response?: unknown) => void;

function installFakeSend(reply: unknown, tabReply: unknown = reply, lastError?: string) {
	const sent: unknown[] = [];
	const runtime = {
		lastError: undefined as { message: string } | undefined,
		sendMessage: (msg: unknown, cb: Reply) => {
			sent.push(msg);
			if (lastError) runtime.lastError = { message: lastError };
			cb(reply);
			runtime.lastError = undefined;
		},
	};
	(globalThis as Record<string, unknown>).chrome = {
		runtime,
		tabs: {
			sendMessage: (_tabId: number, msg: unknown, cb: Reply) => {
				sent.push(msg);
				cb(tabReply);
			},
		},
	};
	return sent;
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).chrome;
});

describe("sendTyped", () => {
	it("sends the typed message and unwraps {success:true, response}", async () => {
		const sent = installFakeSend({ success: true, response: { ok: true } });
		const r = await sendTyped({ type: MSG.OFFSCREEN_PING });
		expect(r).toEqual({ ok: true });
		expect(sent).toEqual([{ type: MSG.OFFSCREEN_PING }]);
	});
	it("rejects with Error(error) on {success:false}", async () => {
		installFakeSend({ success: false, error: "invalid key" });
		await expect(sendTyped({ type: MSG.PANEL_LOGIN, key: "k" })).rejects.toThrow("invalid key");
	});
	it("rejects when no envelope comes back (no handler)", async () => {
		installFakeSend(undefined);
		await expect(sendTyped({ type: MSG.PANEL_LOGOUT })).rejects.toThrow("no response");
	});
	it("rejects with lastError from the runtime wrapper", async () => {
		installFakeSend(undefined, undefined, "Receiving end does not exist");
		await expect(sendTyped({ type: MSG.PANEL_LOGOUT })).rejects.toThrow("Receiving end");
	});
});

describe("sendTypedToTab", () => {
	it("unwraps the tabs result and then the router envelope", async () => {
		installFakeSend(null, { success: true, response: undefined });
		await expect(
			sendTypedToTab(4, { type: MSG.CONTENT_HIGHLIGHT, from: "e2", to: "e4", style: "both" })
		).resolves.toBeUndefined();
	});
	it("rejects when the content script answered with an error envelope", async () => {
		installFakeSend(null, { success: false, error: "no board" });
		await expect(sendTypedToTab(4, { type: MSG.CONTENT_CLEAR_HIGHLIGHT })).rejects.toThrow(
			"no board"
		);
	});
	it("rejects when the tab is unreachable", async () => {
		installFakeSend(null, undefined);
		(globalThis as unknown as { chrome: { tabs: unknown } }).chrome.tabs = {
			sendMessage: () => {
				throw new Error("No tab with id: 4");
			},
		};
		await expect(sendTypedToTab(4, { type: MSG.CONTENT_START_NEW_GAME })).rejects.toThrow(
			"No tab with id"
		);
	});
});
