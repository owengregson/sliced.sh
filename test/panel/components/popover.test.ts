// test/panel/components/popover.test.ts — Appendix F §5.12: anchored dialog, focus trapped,
// Esc closes (§8.3 priority), click outside closes, tooltip variant.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { attachTooltip, openPopover, type PopoverHandle } from "@panel/components/popover";
import { bootPanelDom, click, key, mount, type PanelDom, pointer } from "../dom";

let dom: PanelDom;
let handle: PopoverHandle | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	handle?.close();
	handle = null;
	await dom.teardown();
});

function content(): { root: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
	const root = document.createElement("div");
	const first = document.createElement("button");
	first.type = "button";
	first.textContent = "one";
	const middle = document.createElement("input");
	const last = document.createElement("button");
	last.type = "button";
	last.textContent = "two";
	root.append(first, middle, last);
	return { root, first, last };
}

describe("openPopover", () => {
	it("mounts a dialog anchored to the trigger with title/body/footer and traps Tab", async () => {
		const anchor = mount(document.createElement("button"));
		const c = content();
		const closed: string[] = [];
		handle = openPopover(anchor, c.root, {
			title: "Strength",
			footer: "Applies from next move",
			onClose: () => closed.push("closed"),
		});
		const pop = document.querySelector<HTMLElement>(".sl-popover");
		expect(pop).not.toBeNull();
		expect(pop?.getAttribute("role")).toBe("dialog");
		expect(pop?.querySelector(".sl-popover__title")?.textContent).toBe("Strength");
		expect(pop?.querySelector(".sl-popover__footer")?.textContent).toBe("Applies from next move");
		expect(pop?.querySelector(".sl-popover__body")?.contains(c.first)).toBe(true);
		expect(anchor.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).not.toBe(pop); // never steals focus on open

		// Tab from the last focusable wraps to the first (the header's close button); Shift+Tab
		// from the first wraps back to the last. Focus only moves in response to the user's Tab.
		const close = pop?.querySelector<HTMLElement>(".sl-popover__close") ?? null;
		c.last.focus();
		key(c.last, "keydown", { key: "Tab", code: "Tab" });
		expect(document.activeElement).toBe(close);
		key(close ?? c.first, "keydown", { key: "Tab", code: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(c.last);
		c.first.focus();
		key(c.first, "keydown", { key: "Tab", code: "Tab" });
		expect(document.activeElement).toBe(c.first); // not at an edge: left to the browser

		// Esc closes and reports.
		key(document, "keydown", { key: "Escape", code: "Escape" });
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).toBeNull();
		expect(closed).toEqual(["closed"]);
		expect(anchor.getAttribute("aria-expanded")).toBe("false");
		expect(handle.open).toBe(false);
	});

	it("click outside closes; click inside does not; the close button closes", async () => {
		const anchor = mount(document.createElement("button"));
		const c = content();
		handle = openPopover(anchor, c.root, { title: "t" });
		pointer(c.first, "pointerdown");
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).not.toBeNull();
		pointer(document.body, "pointerdown");
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).toBeNull();

		handle = openPopover(anchor, content().root, { title: "t" });
		const close = document.querySelector<HTMLElement>(".sl-popover__close");
		if (close) click(close);
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).toBeNull();
	});

	it("opening a second popover closes the first; close() is idempotent", async () => {
		const anchor = mount(document.createElement("button"));
		const a = openPopover(anchor, content().root, { title: "a" });
		const b = openPopover(anchor, content().root, { title: "b" });
		await dom.tick(0);
		expect(document.querySelectorAll(".sl-popover")).toHaveLength(1);
		expect(a.open).toBe(false);
		b.close();
		b.close();
		await dom.tick(0);
		expect(document.querySelectorAll(".sl-popover")).toHaveLength(0);
	});

	it("tooltip variant: 300 ms hover delay, instant on focus, closes on leave", async () => {
		const anchor = mount(document.createElement("button"));
		const dispose = attachTooltip(anchor, "Turns on when a game starts");
		anchor.dispatchEvent(new MouseEvent("pointerenter", { bubbles: false }));
		await dom.tick(299);
		expect(document.querySelector(".sl-popover--tooltip")).toBeNull();
		await dom.tick(1);
		const tip = document.querySelector<HTMLElement>(".sl-popover--tooltip");
		expect(tip?.textContent).toBe("Turns on when a game starts");
		expect(tip?.getAttribute("role")).toBe("tooltip");
		expect(anchor.getAttribute("aria-describedby")).toBe(tip?.id ?? "");
		anchor.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
		await dom.tick(0);
		expect(document.querySelector(".sl-popover--tooltip")).toBeNull();
		anchor.dispatchEvent(new Event("focus"));
		expect(document.querySelector(".sl-popover--tooltip")).not.toBeNull();
		dispose();
		await dom.tick(0);
		expect(document.querySelector(".sl-popover--tooltip")).toBeNull();
	});
});
