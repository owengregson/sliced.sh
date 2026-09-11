import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KEYBIND_ACTIONS } from "@content/keybinds";
import { MSG, type PanelSnapshot } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import type { TypedMessage } from "@core/messaging/typed-messages";
import { createKeybindCapture } from "@panel/components/keybind";
import { bootShell, type PanelShell } from "@panel/shell";
import type { PanelStore } from "@panel/store";
import { bootPanelDom, click, key, type PanelDom } from "./dom";
import { makeSnapshot } from "./fixtures";

let dom: PanelDom;
let shell: PanelShell;
let current: PanelSnapshot;
let store: PanelStore;
let calls: TypedMessage[];
let tabId: number;

beforeEach(async () => {
	dom = await bootPanelDom();
	tabId = dom.sim.openTab("https://www.chess.com/game/live/1", { active: true }).tabId;
	current = makeSnapshot({ state: "live:my-turn:recommended", armed: true });
	calls = [];
	store = {
		get snapshot() {
			return current;
		},
		connected: true,
		subscribe(fn) {
			fn(current);
			return () => {};
		},
		onPortMessage: () => () => {},
		dispatch: async (message) => {
			calls.push(message);
			return undefined as never;
		},
		refresh() {},
		dispose() {},
	};
	shell = bootShell(document.getElementById("app")!, { store });
	await dom.tick();
});
afterEach(async () => {
	shell?.dispose();
	await dom.teardown();
});

describe("sidebar shortcuts", () => {
	it("captures Space across live, settings and engine views and prevents scrolling", async () => {
		for (const tab of ["game", "settings", "engine"] as const) {
			shell.setTab(tab);
			await dom.tick(TIMINGS.keybindDebounceMs);
			const target = document.querySelector(".sl-app__content")!;
			expect(key(target, "keydown", { key: " ", code: "Space" })).toBe(false);
			await dom.tick();
			expect(calls.at(-1)).toEqual({ type: MSG.PANEL_KEYBIND, tabId, action: "playMove" });
		}
		expect(calls.filter((call) => call.type === MSG.PANEL_KEYBIND)).toHaveLength(3);
	});

	it("dispatches toggle, stop and speak through the same session actions as the page", async () => {
		for (const action of KEYBIND_ACTIONS) {
			const binding = current.settings.keybinds[action];
			key(document, "keydown", binding);
			await dom.tick(TIMINGS.keybindDebounceMs);
			expect(calls.at(-1)).toEqual({ type: MSG.PANEL_KEYBIND, tabId, action });
		}
		expect(calls).toHaveLength(4);
	});

	it("preserves text editing, composition and shortcut recording while capturing Space on controls", async () => {
		const input = document.createElement("input");
		document.body.append(input);
		expect(key(input, "keydown", { key: " ", code: "Space" })).toBe(true);
		expect(key(document, "keydown", { key: " ", code: "Space", isComposing: true })).toBe(true);
		await dom.tick();
		expect(calls).toEqual([]);
		input.type = "range";
		expect(key(input, "keydown", { key: " ", code: "Space" })).toBe(false);
		await dom.tick();
		expect(calls).toHaveLength(1);
		const saved: unknown[] = [];
		const capture = createKeybindCapture(document.body, {
			label: "Shortcut",
			value: null,
			global: false,
			onChange: (binding) => saved.push(binding),
		});
		click(capture.el.querySelector(".sl-keybind__key")!);
		expect(capture.capturing).toBe(true);
		await dom.tick(TIMINGS.keybindDebounceMs);
		key(document, "keydown", { key: " ", code: "Space" });
		key(document, "keyup", { key: " ", code: "Space" });
		await dom.tick();
		expect(saved).toHaveLength(1);
		expect(calls).toHaveLength(1);
		capture.dispose();
	});

	it("reads changed bindings, suppresses repeated keys and removes capture on disposal", async () => {
		current.settings.keybinds = {
			...current.settings.keybinds,
			playMove: { ...current.settings.keybinds.playMove, key: "p", code: "KeyP" },
		};
		expect(key(document, "keydown", { key: " ", code: "Space" })).toBe(true);
		key(document, "keydown", { key: "p", code: "KeyP" });
		key(document, "keydown", { key: "p", code: "KeyP", repeat: true });
		await dom.tick();
		expect(calls).toHaveLength(1);
		shell.dispose();
		await dom.tick(TIMINGS.keybindDebounceMs);
		expect(key(document, "keydown", { key: "p", code: "KeyP" })).toBe(true);
		await dom.tick();
		expect(calls).toHaveLength(1);
	});
});
