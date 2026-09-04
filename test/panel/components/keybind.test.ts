// test/panel/components/keybind.test.ts — Appendix F §5.4 / §6.4 capture flow: capture, Esc
// cancels, Backspace clears, conflicts (Enter swaps), global scope needs Ctrl or Alt.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_KEYBINDS } from "@core/constants";
import { createKeybindCapture, formatKeybind, type KeybindHandle } from "@panel/components/keybind";
import { COPY } from "@panel/copy";
import type { Keybind } from "@typedefs/settings";
import { bootPanelDom, click, key, mount, type PanelDom } from "../dom";

let dom: PanelDom;
let handle: KeybindHandle | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	handle?.dispose();
	handle = null;
	await dom.teardown();
});

const chip = (): HTMLElement => {
	const el = handle?.el.querySelector<HTMLElement>(".sl-keybind__key");
	if (!el) throw new Error("no chip");
	return el;
};
const hint = (): string => handle?.el.querySelector(".sl-keybind__hint")?.textContent ?? "";

describe("formatKeybind", () => {
	it("prints keys as on a keyboard", () => {
		expect(formatKeybind(DEFAULT_KEYBINDS.playMove)).toBe("Space");
		expect(formatKeybind(DEFAULT_KEYBINDS.toggleAutoMove)).toBe("Shift+A");
		expect(
			formatKeybind({
				key: "p",
				code: "KeyP",
				ctrlKey: true,
				shiftKey: true,
				altKey: false,
				metaKey: false,
			})
		).toBe("Ctrl+Shift+P");
		expect(
			formatKeybind({
				key: "ArrowUp",
				code: "ArrowUp",
				ctrlKey: false,
				shiftKey: false,
				altKey: true,
				metaKey: false,
			})
		).toBe("Alt+↑");
		expect(
			formatKeybind({
				key: "1",
				code: "Digit1",
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
				metaKey: true,
			})
		).toBe("Cmd+1");
		expect(formatKeybind(null)).toBe(COPY.keybind.notSet);
	});
});

describe("createKeybindCapture", () => {
	it("shows the current key, captures a new one on key up, and pulses on save", async () => {
		const changes: Array<Keybind | null> = [];
		const el = mount(document.createElement("div"));
		handle = createKeybindCapture(el, {
			label: COPY.keybind.actions.playMove,
			value: DEFAULT_KEYBINDS.playMove,
			global: false,
			onChange: (kb) => changes.push(kb),
		});
		expect(chip().textContent).toBe("Space");
		expect(handle.el.querySelector(".sl-keybind__label")?.textContent).toBe(
			COPY.keybind.actions.playMove
		);
		click(chip());
		expect(handle.capturing).toBe(true);
		expect(handle.el.dataset.state).toBe("capturing");
		expect(chip().textContent).toBe(COPY.keybind.capturing);
		expect(handle.el.getAttribute("aria-live")).toBe("polite");
		// Modifiers alone do not complete; the chip shows the combo live.
		key(document, "keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true });
		expect(chip().textContent).toBe("Shift+…");
		expect(handle.capturing).toBe(true);
		key(document, "keydown", { key: "A", code: "KeyA", shiftKey: true });
		expect(chip().textContent).toBe("Shift+A");
		expect(changes).toEqual([]);
		key(document, "keyup", { key: "A", code: "KeyA", shiftKey: true });
		expect(handle.capturing).toBe(false);
		expect(changes).toEqual([
			{ key: "a", code: "KeyA", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false },
		]);
		expect(chip().textContent).toBe("Shift+A");
		expect(handle.el.classList.contains("sl-keybind--saved")).toBe(true);
		expect(handle.el.dataset.state).toBe("set");
	});

	it("Esc cancels (keeps the old key); Backspace and Delete clear; the clear button clears", () => {
		const changes: Array<Keybind | null> = [];
		const el = mount(document.createElement("div"));
		handle = createKeybindCapture(el, {
			label: "x",
			value: DEFAULT_KEYBINDS.playMove,
			global: false,
			onChange: (kb) => changes.push(kb),
		});
		click(chip());
		key(document, "keydown", { key: "Escape", code: "Escape" });
		expect(handle.capturing).toBe(false);
		expect(chip().textContent).toBe("Space");
		expect(changes).toEqual([]);
		click(chip());
		key(document, "keydown", { key: "Backspace", code: "Backspace" });
		expect(handle.capturing).toBe(false);
		expect(chip().textContent).toBe(COPY.keybind.notSet);
		expect(handle.el.dataset.state).toBe("empty");
		expect(changes).toEqual([null]);
		handle.update({ value: DEFAULT_KEYBINDS.speakMove });
		expect(chip().textContent).toBe("W");
		const clear = handle.el.querySelector<HTMLElement>(".sl-keybind__clear");
		if (!clear) throw new Error("no clear");
		click(clear);
		expect(changes).toEqual([null, null]);
		expect(chip().textContent).toBe(COPY.keybind.notSet);
	});

	it("conflicts: the chip enters conflict with the hint; another key retries; Enter swaps", () => {
		const changes: Array<Keybind | null> = [];
		const swaps: string[] = [];
		const el = mount(document.createElement("div"));
		handle = createKeybindCapture(el, {
			label: COPY.keybind.actions.playMove,
			value: DEFAULT_KEYBINDS.playMove,
			global: false,
			conflicts: (kb) => (kb.code === "KeyW" ? COPY.keybind.actions.speakMove : null),
			onChange: (kb) => changes.push(kb),
			onSwap: (kb, other) => swaps.push(`${kb.code}<->${other}`),
		});
		click(chip());
		key(document, "keydown", { key: "w", code: "KeyW" });
		key(document, "keyup", { key: "w", code: "KeyW" });
		expect(handle.el.dataset.state).toBe("conflict");
		expect(hint()).toBe(COPY.keybind.conflict(COPY.keybind.actions.speakMove));
		expect(changes).toEqual([]);
		expect(handle.capturing).toBe(true);
		// Another key resolves the conflict.
		key(document, "keydown", { key: "p", code: "KeyP" });
		key(document, "keyup", { key: "p", code: "KeyP" });
		expect(changes.map((c) => c?.code)).toEqual(["KeyP"]);
		expect(hint()).toBe("");
		// Enter swaps.
		click(chip());
		key(document, "keydown", { key: "w", code: "KeyW" });
		key(document, "keyup", { key: "w", code: "KeyW" });
		expect(handle.el.dataset.state).toBe("conflict");
		key(document, "keydown", { key: "Enter", code: "Enter" });
		expect(swaps).toEqual([`KeyW<->${COPY.keybind.actions.speakMove}`]);
		expect(handle.capturing).toBe(false);
		expect(chip().textContent).toBe("W");
	});

	it("global scope requires Ctrl or Alt; validate() re-checks the current key", () => {
		const changes: Array<Keybind | null> = [];
		const el = mount(document.createElement("div"));
		handle = createKeybindCapture(el, {
			label: "x",
			value: DEFAULT_KEYBINDS.playMove,
			global: true,
			onChange: (kb) => changes.push(kb),
		});
		expect(hint()).toBe(COPY.keybind.global); // Space alone is flagged at mount
		expect(handle.el.dataset.invalid).toBe("true");
		click(chip());
		key(document, "keydown", { key: "p", code: "KeyP" });
		key(document, "keyup", { key: "p", code: "KeyP" });
		expect(handle.capturing).toBe(true);
		expect(hint()).toBe(COPY.keybind.global);
		expect(changes).toEqual([]);
		key(document, "keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
		key(document, "keydown", { key: "p", code: "KeyP", ctrlKey: true });
		key(document, "keyup", { key: "p", code: "KeyP", ctrlKey: true });
		expect(handle.capturing).toBe(false);
		expect(changes.map((c) => formatKeybind(c))).toEqual(["Ctrl+P"]);
		expect(hint()).toBe("");
		expect(handle.el.dataset.invalid).toBeUndefined();
		// Scope switch back to in-page then to global re-validates.
		handle.update({ global: false, value: DEFAULT_KEYBINDS.speakMove });
		expect(hint()).toBe("");
		handle.update({ global: true });
		expect(hint()).toBe(COPY.keybind.global);
	});

	it("dispose stops listening", () => {
		const changes: Array<Keybind | null> = [];
		const el = mount(document.createElement("div"));
		handle = createKeybindCapture(el, {
			label: "x",
			value: null,
			global: false,
			onChange: (kb) => changes.push(kb),
		});
		click(chip());
		handle.dispose();
		handle = null;
		key(document, "keydown", { key: "p", code: "KeyP" });
		key(document, "keyup", { key: "p", code: "KeyP" });
		expect(changes).toEqual([]);
	});
});
