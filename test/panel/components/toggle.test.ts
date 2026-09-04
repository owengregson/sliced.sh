// test/panel/components/toggle.test.ts — Appendix F §5.2 / §6.1: role="switch", click toggles,
// the armed variant needs a 600 ms hold to arm and one click to disarm.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { UI_TIMINGS } from "@core/constants";
import { createToggle, type ToggleHandle } from "@panel/components/toggle";
import { COPY } from "@panel/copy";
import { bootPanelDom, click, key, mount, type PanelDom, pointer } from "../dom";

let dom: PanelDom;
let handle: ToggleHandle | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	handle?.dispose();
	handle = null;
	await dom.teardown();
});

describe("createToggle", () => {
	it("renders a switch with label/icon/hint, toggles on click and Space, and reports changes", () => {
		const changes: boolean[] = [];
		const el = mount(document.createElement("div"));
		handle = createToggle(el, {
			label: COPY.toggle.highlight,
			icon: "toggle.highlight",
			hint: "hint",
			checked: false,
			onChange: (v) => changes.push(v),
		});
		const root = handle.el;
		expect(root.getAttribute("role")).toBe("switch");
		expect(root.getAttribute("aria-checked")).toBe("false");
		expect(root.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.highlight);
		expect(root.querySelector(".sl-toggle__icon")?.getAttribute("data-icon")).toBe(
			"toggle.highlight"
		);
		expect(root.querySelector(".sl-toggle__icon")?.className).toContain("fa-fw");
		expect(root.querySelector(".sl-toggle__hint")?.textContent).toBe("hint");
		expect(root.querySelector(".sl-toggle__track")).not.toBeNull();
		expect(root.querySelector(".sl-toggle__thumb")).not.toBeNull();
		click(root);
		expect(root.getAttribute("aria-checked")).toBe("true");
		expect(handle.checked).toBe(true);
		key(root, "keydown", { key: " ", code: "Space" });
		key(root, "keyup", { key: " ", code: "Space" });
		expect(root.getAttribute("aria-checked")).toBe("false");
		expect(changes).toEqual([true, false]);
		handle.update({ checked: true });
		expect(root.getAttribute("aria-checked")).toBe("true");
		expect(changes).toHaveLength(2); // programmatic updates do not echo
	});

	it("disabled and locked variants ignore input", () => {
		const changes: boolean[] = [];
		const el = mount(document.createElement("div"));
		handle = createToggle(el, {
			label: "x",
			checked: false,
			disabled: true,
			onChange: (v) => changes.push(v),
		});
		expect(handle.el.getAttribute("aria-disabled")).toBe("true");
		click(handle.el);
		expect(changes).toEqual([]);
		handle.update({ disabled: false, locked: true });
		expect(handle.el.classList.contains("sl-toggle--locked")).toBe(true);
		expect(handle.el.querySelector(".sl-toggle__lock")?.hasAttribute("hidden")).toBe(false);
		click(handle.el);
		expect(changes).toEqual([]);
	});

	it("armed variant: a 600 ms hold arms, release at 400 ms does not, one click disarms", async () => {
		const events: string[] = [];
		const el = mount(document.createElement("div"));
		handle = createToggle(el, {
			label: COPY.toggle.autoplay,
			checked: false,
			armed: true,
			onChange: (v) => events.push(v ? "arm" : "disarm"),
		});
		const root = handle.el;
		expect(root.getAttribute("aria-describedby")).toBeTruthy();
		expect(document.getElementById(root.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
			COPY.a11y.toggleHoldHint
		);

		// Release too early: nothing arms, the fill drains.
		pointer(root, "pointerdown", { pointerId: 1, isPrimary: true });
		expect(root.dataset.state).toBe("arming");
		expect(root.classList.contains("sl-toggle--arming")).toBe(true);
		expect(root.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.arming);
		expect(root.style.getPropertyValue("--sl-hold-ms")).toBe(`${UI_TIMINGS.armHoldMs}ms`);
		await dom.tick(400);
		pointer(root, "pointerup", { pointerId: 1, isPrimary: true });
		click(root); // the browser fires click after pointerup — must not arm or toggle
		expect(root.dataset.state).toBe("off");
		expect(root.getAttribute("aria-checked")).toBe("false");
		expect(events).toEqual([]);

		// A full hold arms.
		pointer(root, "pointerdown", { pointerId: 1, isPrimary: true });
		await dom.tick(UI_TIMINGS.armHoldMs);
		expect(root.dataset.state).toBe("armed");
		expect(root.classList.contains("sl-toggle--armed")).toBe(true);
		expect(root.getAttribute("aria-checked")).toBe("true");
		expect(root.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.armed);
		expect(events).toEqual(["arm"]);
		pointer(root, "pointerup", { pointerId: 1, isPrimary: true });
		click(root); // the click that ends the arming gesture is swallowed
		expect(root.dataset.state).toBe("armed");

		// One click disarms instantly; the label says so (§6.1 step 4).
		click(root);
		expect(root.dataset.state).toBe("off");
		expect(root.getAttribute("aria-checked")).toBe("false");
		expect(root.querySelector(".sl-toggle__label")?.textContent).toBe(COPY.toggle.off);
		expect(events).toEqual(["arm", "disarm"]);

		// Keyboard: holding Space arms; a short press does not.
		key(root, "keydown", { key: " ", code: "Space" });
		await dom.tick(400);
		key(root, "keyup", { key: " ", code: "Space" });
		expect(root.dataset.state).toBe("off");
		key(root, "keydown", { key: " ", code: "Space" });
		key(root, "keydown", { key: " ", code: "Space", repeat: true });
		await dom.tick(UI_TIMINGS.armHoldMs);
		expect(root.dataset.state).toBe("armed");
		key(root, "keyup", { key: " ", code: "Space" });
		key(root, "keydown", { key: " ", code: "Space" });
		key(root, "keyup", { key: " ", code: "Space" });
		expect(root.dataset.state).toBe("off");
		expect(events).toEqual(["arm", "disarm", "arm", "disarm"]);

		// Pointer leaving the toggle mid-hold cancels the hold.
		pointer(root, "pointerdown", { pointerId: 1, isPrimary: true });
		await dom.tick(200);
		pointer(root, "pointercancel", { pointerId: 1 });
		await dom.tick(UI_TIMINGS.armHoldMs);
		expect(root.dataset.state).toBe("off");
		expect(events).toHaveLength(4);
	});

	it("custom holdMs is honoured", async () => {
		const events: boolean[] = [];
		const el = mount(document.createElement("div"));
		handle = createToggle(el, {
			label: "x",
			checked: false,
			armed: true,
			holdMs: 200,
			onChange: (v) => events.push(v),
		});
		pointer(handle.el, "pointerdown", { pointerId: 1, isPrimary: true });
		await dom.tick(199);
		expect(events).toEqual([]);
		await dom.tick(1);
		expect(events).toEqual([true]);
	});
});
