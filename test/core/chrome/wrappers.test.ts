// test/core/chrome/wrappers.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import {
	chromeLocalGet,
	chromeLocalSet,
	chromeSessionRemove,
	chromeSessionSet,
} from "@core/chrome/storage";
import { tabsSendMessage } from "@core/chrome/tabs";
import { LOCAL_KEYS, SESSION_KEYS } from "@core/constants";
import { type FakeChromeStorage, installFakeChromeStorage } from "../../fakes/chrome-storage";

let fake: FakeChromeStorage;
beforeEach(() => {
	fake = installFakeChromeStorage();
});

describe("chrome storage wrappers", () => {
	it("resolve null for a missing key and round-trip values", async () => {
		expect(await chromeLocalGet(LOCAL_KEYS.licenseKey)).toBeNull();
		await chromeLocalSet(LOCAL_KEYS.licenseKey, "abc");
		expect(await chromeLocalGet(LOCAL_KEYS.licenseKey)).toBe("abc");
		await chromeSessionSet(SESSION_KEYS.autoMoveArmed, { 7: true });
		expect(fake.data.session[SESSION_KEYS.autoMoveArmed]).toEqual({ 7: true });
		await chromeSessionRemove(SESSION_KEYS.autoMoveArmed);
		expect(fake.data.session[SESSION_KEYS.autoMoveArmed]).toBeUndefined();
	});
	it("reject with chrome.runtime.lastError", async () => {
		fake.failNextWith("quota");
		await expect(chromeLocalSet(LOCAL_KEYS.installedAt, 1)).rejects.toThrow("quota");
	});
});

describe("tabsSendMessage", () => {
	it("resolves {success:false} when the API throws or sets lastError", async () => {
		const g = globalThis as unknown as { chrome: Record<string, unknown> };
		g.chrome.tabs = {
			sendMessage: () => {
				throw new Error("no tab");
			},
		};
		expect(await tabsSendMessage(1, { type: "x" })).toEqual({ success: false, error: "no tab" });
		g.chrome.tabs = {
			sendMessage: (_id: number, _m: unknown, cb: (r: unknown) => void) => {
				fake.failNextWith("Receiving end does not exist");
				(g.chrome.runtime as { lastError?: { message: string } }).lastError = {
					message: "Receiving end does not exist",
				};
				cb(undefined);
				(g.chrome.runtime as { lastError?: unknown }).lastError = undefined;
			},
		};
		const r = await tabsSendMessage(1, { type: "x" });
		expect(r.success).toBe(false);
		expect(r.error).toContain("Receiving end");
		g.chrome.tabs = { sendMessage: (_id: number, _m: unknown, cb: (r: unknown) => void) => cb("ok") };
		expect(await tabsSendMessage(1, { type: "x" })).toEqual({ success: true, response: "ok" });
	});
});
