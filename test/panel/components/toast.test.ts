// test/panel/components/toast.test.ts — Appendix F §5.11: one visible, newer replaces, 2.4 s for
// success/info, 6 s for warn/danger (with action), role status/alert.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { UI_TIMINGS } from "@core/constants";
import { clearToasts, mountToastLayer, showToast } from "@panel/components/toast";
import { COPY } from "@panel/copy";
import { bootPanelDom, click, mount, type PanelDom } from "../dom";

let dom: PanelDom;
let layer: HTMLElement;

beforeEach(async () => {
	dom = await bootPanelDom();
	layer = mount(document.createElement("div"));
	mountToastLayer(layer);
});
afterEach(async () => {
	clearToasts();
	await dom.teardown();
});

const toasts = (): HTMLElement[] => [...layer.querySelectorAll<HTMLElement>(".sl-toast")];

describe("showToast", () => {
	it("shows one toast at a time and the newer one replaces the older", async () => {
		showToast("info", COPY.toast.settingsSaved);
		expect(toasts()).toHaveLength(1);
		expect(toasts()[0]?.getAttribute("role")).toBe("status");
		expect(toasts()[0]?.classList.contains("sl-toast--info")).toBe(true);
		expect(toasts()[0]?.querySelector(".sl-toast__text")?.textContent).toBe(COPY.toast.settingsSaved);
		expect(toasts()[0]?.querySelector(".sl-toast__icon")?.getAttribute("data-icon")).toBe(
			"feedback.info"
		);
		showToast("success", COPY.toast.played("Nf3", "3.9", "drag"));
		await dom.tick(0);
		expect(toasts()).toHaveLength(1);
		expect(toasts()[0]?.classList.contains("sl-toast--success")).toBe(true);
	});

	it("success/info last 2.4 s; warn/danger 6 s with an action and role=alert", async () => {
		showToast("info", "a");
		await dom.tick(UI_TIMINGS.toastShortMs - 1);
		expect(toasts()).toHaveLength(1);
		await dom.tick(1);
		await dom.tick(0);
		expect(toasts()).toHaveLength(0);

		const clicks: string[] = [];
		const handle = showToast("danger", COPY.toast.playFailed, {
			label: "Open Engine",
			onClick: () => clicks.push("x"),
		});
		const t = toasts()[0];
		expect(t?.getAttribute("role")).toBe("alert");
		expect(t?.classList.contains("sl-toast--danger")).toBe(true);
		const action = t?.querySelector<HTMLElement>(".sl-toast__action");
		expect(action?.hasAttribute("hidden")).toBe(false);
		expect(action?.querySelector(".sl-button__label")?.textContent).toBe("Open Engine");
		await dom.tick(UI_TIMINGS.toastShortMs + 1);
		expect(toasts()).toHaveLength(1); // still there past the short duration
		await dom.tick(UI_TIMINGS.toastLongMs - UI_TIMINGS.toastShortMs);
		await dom.tick(0);
		expect(toasts()).toHaveLength(0);
		expect(handle.visible).toBe(false);

		showToast("warn", "w", { label: "Reattach", onClick: () => clicks.push("re") });
		const button = toasts()[0]?.querySelector<HTMLElement>(".sl-toast__action .sl-button");
		if (button) click(button);
		await dom.tick(0);
		expect(clicks).toEqual(["re"]);
		expect(toasts()).toHaveLength(0); // the action dismisses
	});

	it("clearToasts empties the layer (view change) and dismiss() is idempotent", async () => {
		const h = showToast("info", "a");
		clearToasts();
		await dom.tick(0);
		expect(toasts()).toHaveLength(0);
		h.dismiss();
		h.dismiss();
		showToast("info", "b");
		await dom.tick(UI_TIMINGS.toastLongMs);
		await dom.tick(0);
		expect(toasts()).toHaveLength(0);
	});
});
