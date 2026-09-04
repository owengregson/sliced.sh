// test/panel/components/banner.test.ts — Appendix F §5.17 / §6.5: one banner at a time, danger
// outranks warn outranks info, actions dismiss unless kept open, keyed banners update in place.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearBanners,
	currentBannerKind,
	mountBannerSlot,
	showBanner,
} from "@panel/components/banner";
import { COPY } from "@panel/copy";
import { bootPanelDom, click, mount, type PanelDom } from "../dom";

let dom: PanelDom;
let slot: HTMLElement;

beforeEach(async () => {
	dom = await bootPanelDom();
	slot = mount(document.createElement("div"));
	mountBannerSlot(slot);
});
afterEach(async () => {
	clearBanners();
	await dom.teardown();
});

const banners = (): HTMLElement[] => [...slot.querySelectorAll<HTMLElement>(".sl-banner")];

describe("showBanner", () => {
	it("shows one at a time with rank precedence and restores the outranked one afterwards", async () => {
		const info = showBanner("info", COPY.banner.handsOff, [], { key: "hands-off" });
		expect(banners()).toHaveLength(1);
		expect(currentBannerKind()).toBe("info");
		const warn = showBanner("warn", COPY.banner.detached, [
			{ label: COPY.banner.reattach, onClick: () => {} },
			{ label: COPY.banner.dismiss, onClick: () => {} },
		]);
		await dom.tick(0);
		expect(banners()).toHaveLength(1);
		expect(currentBannerKind()).toBe("warn");
		expect(banners()[0]?.querySelectorAll(".sl-button")).toHaveLength(2);
		expect(banners()[0]?.querySelector(".sl-banner__icon")?.getAttribute("data-icon")).toBe(
			"feedback.warning"
		);
		// A lower-ranked request waits.
		const late = showBanner("info", "later");
		await dom.tick(0);
		expect(currentBannerKind()).toBe("warn");
		expect(late.visible).toBe(false);
		// Danger jumps the queue; role=alert.
		showBanner("danger", COPY.banner.failures, [
			{ label: COPY.banner.openEngine, onClick: () => {} },
		]);
		await dom.tick(0);
		expect(currentBannerKind()).toBe("danger");
		expect(banners()[0]?.getAttribute("role")).toBe("alert");
		// Its action dismisses it; the warn returns, then the infos.
		const action = banners()[0]?.querySelector<HTMLElement>(".sl-button");
		if (action) click(action);
		await dom.tick(0);
		expect(currentBannerKind()).toBe("warn");
		warn.dismiss();
		await dom.tick(0);
		expect(currentBannerKind()).toBe("info");
		expect(info.visible || late.visible).toBe(true);
	});

	it("keyed banners update in place; keepOpen actions keep it; clearBanners empties", async () => {
		const a = showBanner("info", "v1", [], { key: "update" });
		const b = showBanner("info", "v2", [{ label: "Update", onClick: () => {}, keepOpen: true }], {
			key: "update",
		});
		expect(b).toBe(a);
		await dom.tick(0);
		expect(banners()).toHaveLength(1);
		expect(banners()[0]?.querySelector(".sl-banner__text")?.textContent).toBe("v2");
		const action = banners()[0]?.querySelector<HTMLElement>(".sl-button");
		if (action) click(action);
		await dom.tick(0);
		expect(a.visible).toBe(true);
		clearBanners();
		await dom.tick(0);
		expect(banners()).toHaveLength(0);
		expect(currentBannerKind()).toBeNull();
	});
});
