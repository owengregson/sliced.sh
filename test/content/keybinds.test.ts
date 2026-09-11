// test/content/keybinds.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { installKeybinds, isEditableTarget, type KeybindAction } from "@content/keybinds";
import { TIMINGS } from "@core/constants/timings";
import { DEFAULT_KEYBINDS, type Keybinds } from "@typedefs/settings";
import { Window as HappyWindow } from "happy-dom";

type Target = { dispatchEvent(ev: never): boolean };

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function setup(binds: Partial<Keybinds> = {}) {
	const win = new HappyWindow({ url: "https://www.chess.com/play/online" });
	cleanups.push(() => win.happyDOM.close());
	win.document.body.innerHTML =
		'<div id="board"></div><input id="in"><textarea id="ta"></textarea><div id="ce" contenteditable="true"><span id="inner"></span></div>';
	let now = 1_000;
	const actions: KeybindAction[] = [];
	const keybinds: Keybinds = { ...DEFAULT_KEYBINDS, global: false, ...binds };
	const off = installKeybinds(
		() => keybinds,
		(a) => actions.push(a),
		{
			window: win as unknown as Window,
			now: () => now,
		}
	);
	cleanups.push(off);
	const press = (
		init: Record<string, unknown> & { key: string; code: string },
		target: Target = win.document.body as unknown as Target
	): boolean => {
		const ev = new win.KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			...init,
		} as never);
		return target.dispatchEvent(ev as never);
	};
	return {
		win,
		actions,
		keybinds,
		press,
		advance: (ms: number) => {
			now += ms;
		},
		off,
	};
}

describe("installKeybinds", () => {
	it("Space plays, Shift+X disables, Shift+A arms/disarms, W speaks — and the default is prevented", () => {
		const { actions, press, advance } = setup();
		expect(press({ key: " ", code: "Space" })).toBe(false);
		advance(TIMINGS.keybindDebounceMs);
		press({ key: "X", code: "KeyX", shiftKey: true });
		advance(TIMINGS.keybindDebounceMs);
		press({ key: "A", code: "KeyA", shiftKey: true });
		advance(TIMINGS.keybindDebounceMs);
		press({ key: "w", code: "KeyW" });
		expect(actions).toEqual(["playMove", "disable", "toggleAutoMove", "speakMove"]);
	});
	it("does not fire when a modifier differs, on key auto-repeat, or for unrelated keys", () => {
		const { actions, press } = setup();
		press({ key: "x", code: "KeyX" }); // no shift
		press({ key: " ", code: "Space", ctrlKey: true });
		press({ key: " ", code: "Space", repeat: true });
		press({ key: "q", code: "KeyQ" });
		expect(actions).toEqual([]);
	});
	it("ignores editable targets: input, textarea, contenteditable (including descendants)", () => {
		const { win, actions, press } = setup();
		for (const id of ["in", "ta", "ce", "inner"]) {
			const el = win.document.getElementById(id);
			if (!el) throw new Error(id);
			press({ key: " ", code: "Space" }, el as unknown as Target);
		}
		expect(actions).toEqual([]);
		press({ key: " ", code: "Space" }, win.document.getElementById("board") as unknown as Target);
		expect(actions).toEqual(["playMove"]);
		expect(isEditableTarget(null)).toBe(false);
		expect(isEditableTarget({} as EventTarget)).toBe(false);
	});
	it("fires in the capture phase even when the page stops propagation in the bubble phase", () => {
		const { win, actions, press } = setup();
		const swallow = ((ev: Event): void => ev.stopPropagation()) as never;
		win.document.addEventListener("keydown", swallow); // bubble-phase page handler
		win.document.body.addEventListener("keydown", swallow);
		cleanups.push(() => win.document.removeEventListener("keydown", swallow));
		press({ key: " ", code: "Space" }, win.document.getElementById("board") as unknown as Target);
		expect(actions).toEqual(["playMove"]);
	});
	it("debounces repeats of the same action within TIMINGS.keybindDebounceMs", () => {
		const { actions, press, advance } = setup();
		press({ key: " ", code: "Space" });
		press({ key: " ", code: "Space" });
		advance(TIMINGS.keybindDebounceMs - 1);
		press({ key: " ", code: "Space" });
		expect(actions).toEqual(["playMove"]);
		advance(1);
		press({ key: " ", code: "Space" });
		expect(actions).toEqual(["playMove", "playMove"]);
	});
	it("reads the current keybinds on every press, is inert while `global` (chrome.commands) is on, and uninstalls", () => {
		const { actions, press, keybinds, off } = setup();
		keybinds.playMove = {
			key: "p",
			code: "KeyP",
			altKey: true,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
		};
		press({ key: " ", code: "Space" });
		press({ key: "p", code: "KeyP", altKey: true });
		expect(actions).toEqual(["playMove"]);
		keybinds.global = true;
		press({ key: "X", code: "KeyX", shiftKey: true });
		expect(actions).toEqual(["playMove"]);
		keybinds.global = false;
		off();
		press({ key: "X", code: "KeyX", shiftKey: true });
		expect(actions).toEqual(["playMove"]);
	});
	it("keeps bare Space available with global shortcuts, consumes it, and leaves editing alone", () => {
		const { win, actions, press } = setup({ global: true });
		let pageHandled = 0;
		win.document.addEventListener("keydown", () => pageHandled++);
		expect(press({ key: " ", code: "Space" })).toBe(false);
		expect(press({ key: " ", code: "Space" })).toBe(false);
		expect(actions).toEqual(["playMove"]);
		expect(pageHandled).toBe(0);
		press({ key: " ", code: "Space" }, win.document.getElementById("in") as unknown as Target);
		expect(actions).toEqual(["playMove"]);
		expect(pageHandled).toBe(1);
	});
});
