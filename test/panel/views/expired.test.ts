// test/panel/views/expired.test.ts — Appendix F §4.9: expired vs revoked (vs device-limit) copy,
// Renew / Enter a different key (PANEL_LOGOUT) / Check again (PANEL_RECHECK_LICENSE), masked key.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LIMITS, LOCAL_KEYS, MSG } from "@core/constants";
import { COPY } from "@panel/copy";
import { maskLicenseKey } from "@panel/format";
import { expiredView } from "@panel/views/expired";
import type { LicenseState } from "@typedefs/settings";
import { bootPanelDom, click, mount, type PanelDom } from "../dom";
import { makeSnapshot } from "../fixtures";
import { type FakeStore, fakeStore, makeContext } from "./fake-store";

let dom: PanelDom;
let cleanup: (() => void) | null = null;
let store: FakeStore;
let container: HTMLElement;

beforeEach(async () => {
	dom = await bootPanelDom();
	container = mount(document.createElement("main"));
});
afterEach(async () => {
	cleanup?.();
	cleanup = null;
	await dom.teardown();
});

async function mountExpired(status: LicenseState["status"], extra: Partial<LicenseState> = {}) {
	const snapshot = makeSnapshot({ license: status });
	snapshot.license = { ...snapshot.license, ...extra };
	store = fakeStore(snapshot);
	cleanup = await expiredView.mount(makeContext(container, store));
	await dom.tick(0);
}

const text = (selector: string): string =>
	container.querySelector(selector)?.textContent?.trim() ?? "";
const buttons = (): HTMLButtonElement[] => [
	...container.querySelectorAll<HTMLButtonElement>(".sl-button"),
];

describe("expiredView", () => {
	it("expired: title, dated body, Renew (open-url) and Enter a different key (PANEL_LOGOUT)", async () => {
		await dom.panel.chrome.storage.local.set({ [LOCAL_KEYS.licenseKey]: "SL-7F3K-AB12-CD34" });
		await mountExpired("expired", { expiresAt: Date.UTC(2026, 7, 12, 12) });
		expect(container.querySelector("[data-view=expired]")).not.toBeNull();
		expect(container.querySelector(".sl-empty__icon")?.getAttribute("data-icon")).toBe(
			"feedback.locked"
		);
		expect(text(".sl-empty__title")).toBe(COPY.expired.title);
		expect(text(".sl-empty__body")).toBe(COPY.expired.body("12 Aug 2026"));
		const [renew, different] = buttons();
		expect(renew?.textContent?.trim()).toBe(COPY.expired.renew);
		expect(renew?.classList.contains("sl-button--primary")).toBe(true);
		expect(renew?.dataset.action).toBe("open-url");
		expect(renew?.dataset.url).toBe("website");
		expect(different?.textContent?.trim()).toBe(COPY.expired.differentKey);
		expect(different?.classList.contains("sl-button--ghost")).toBe(true);
		if (different) click(different);
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_LOGOUT }]);
		expect(text(".sl-expired__signed-in")).toBe(
			COPY.expiredView.signedIn(maskLicenseKey("SL-7F3K-AB12-CD34"))
		);
		expect(maskLicenseKey("SL-7F3K-AB12-CD34")).toBe("SL-7F3K-••••-••••");
		expect(document.activeElement).toBe(document.body);
	});

	it("Check again dispatches PANEL_RECHECK_LICENSE; no stored key hides the signed-in row", async () => {
		await mountExpired("expired");
		expect(text(".sl-empty__body")).toBe(COPY.expiredView.bodyNoDate);
		const recheck = container.querySelector<HTMLButtonElement>(".sl-expired__recheck .sl-button");
		expect(recheck?.textContent?.trim()).toBe(COPY.expiredView.recheck);
		if (recheck) click(recheck);
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_RECHECK_LICENSE }]);
		expect(container.querySelector<HTMLElement>(".sl-expired__signed-in")?.hidden).toBe(true);
	});

	it("revoked (invalid) shows the revoked copy with the same buttons", async () => {
		await mountExpired("invalid");
		expect(text(".sl-empty__title")).toBe(COPY.expired.revokedTitle);
		expect(text(".sl-empty__body")).toBe(COPY.expired.revokedBody);
		expect(buttons().map((b) => b.textContent?.trim())).toContain(COPY.expired.renew);
		expect(buttons().map((b) => b.textContent?.trim())).toContain(COPY.expired.differentKey);
	});

	it("ip_limit shows the device-limit copy and follows snapshot changes", async () => {
		await mountExpired("ip_limit");
		expect(text(".sl-empty__title")).toBe(COPY.expired.ipLimitTitle);
		expect(text(".sl-empty__body")).toBe(COPY.login.deviceLimit(LIMITS.licenseMaxDevices));
		store.emit(makeSnapshot({ license: "invalid" }));
		expect(text(".sl-empty__title")).toBe(COPY.expired.revokedTitle);
		cleanup?.();
		cleanup = null;
		expect(container.children).toHaveLength(0);
	});
});
