// test/sim/cdp-input.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { createCdpInputBridge } from "@test/sim/bridges/cdp-input";
import { createTabDom, type TabDom } from "@test/sim/dom/tab-dom";

let dom: TabDom;
let bridge: ReturnType<typeof createCdpInputBridge>;
let clock: number;
const seen: string[] = [];

beforeEach(() => {
	clock = 0;
	seen.length = 0;
	dom = createTabDom("https://www.chess.com/play/online");
	dom.setHTML("<div id='board'><div id='e2'></div><div id='e4'></div></div>");
	dom.layout("#board", { x: 0, y: 0, width: 800, height: 800 });
	dom.layout("#e2", { x: 400, y: 600, width: 100, height: 100 });
	dom.layout("#e4", { x: 400, y: 400, width: 100, height: 100 });
	for (const id of ["board", "e2", "e4"]) {
		const el = dom.query(`#${id}`);
		for (const type of [
			"pointerdown",
			"mousedown",
			"pointerup",
			"mouseup",
			"click",
			"pointermove",
			"pointerover",
			"pointerout",
		]) {
			el.addEventListener(type, (e) => {
				if (e.target !== el) return; // only log at the target, not bubbled copies
				const me = e as unknown as {
					clientX: number;
					clientY: number;
					buttons: number;
					isTrusted: boolean;
				};
				seen.push(
					`${id}:${type}@${me.clientX},${me.clientY}:b${me.buttons}:${me.isTrusted ? "T" : "F"}`
				);
			});
		}
	}
	bridge = createCdpInputBridge(() => clock);
	bridge.registerTab(1, dom);
});

const mouse = (params: Record<string, unknown>) =>
	bridge.send(1, "Input.dispatchMouseEvent", params);

describe("CDP input bridge", () => {
	it("turns a press/drag/release sequence into trusted-equivalent pointer and mouse events at the hit element", async () => {
		await mouse({ type: "mouseMoved", x: 450, y: 650, button: "none", buttons: 0 });
		await mouse({ type: "mousePressed", x: 450, y: 650, button: "left", buttons: 1, clickCount: 1 });
		clock = 8;
		await mouse({ type: "mouseMoved", x: 450, y: 520, button: "left", buttons: 1 });
		clock = 16;
		await mouse({ type: "mouseMoved", x: 450, y: 450, button: "left", buttons: 1 });
		await mouse({ type: "mouseReleased", x: 450, y: 450, button: "left", buttons: 0, clickCount: 1 });
		expect(seen).toEqual([
			"e2:pointerover@450,650:b0:T",
			"e2:pointermove@450,650:b0:T",
			"e2:pointerdown@450,650:b1:T",
			"e2:mousedown@450,650:b1:T",
			"e2:pointerout@450,520:b1:T",
			"board:pointerover@450,520:b1:T",
			"board:pointermove@450,520:b1:T",
			"board:pointerout@450,450:b1:T",
			"e4:pointerover@450,450:b1:T",
			"e4:pointermove@450,450:b1:T",
			"e4:pointerup@450,450:b0:T",
			"e4:mouseup@450,450:b0:T",
		]);
		// no click: press and release landed on different elements
		expect(bridge.events.filter((e) => e.type === "click")).toEqual([]);
		expect(bridge.events.map((e) => e.at).slice(-2)).toEqual([16, 16]);
		expect(bridge.pointer(1)).toMatchObject({ x: 450, y: 450, buttons: 0 });
	});

	it("fires click when press and release hit the same element; records events with timestamps", async () => {
		clock = 100;
		await mouse({ type: "mousePressed", x: 450, y: 450, button: "left", buttons: 1, clickCount: 1 });
		clock = 140;
		await mouse({ type: "mouseReleased", x: 450, y: 450, button: "left", buttons: 0, clickCount: 1 });
		expect(seen.filter((s) => s.includes("click"))).toEqual(["e4:click@450,450:b0:T"]);
		expect(bridge.events.map((e) => [e.type, e.target, e.at])).toEqual([
			["pointerdown", "e4", 100],
			["mousedown", "e4", 100],
			["pointerup", "e4", 140],
			["mouseup", "e4", 140],
			["click", "e4", 140],
		]);
		bridge.clear();
		expect(bridge.events).toEqual([]);
	});

	it("events bubble to ancestors and default to body outside any recorded rectangle", async () => {
		let bubbled = 0;
		dom.document.body.addEventListener("mousedown", () => void bubbled++);
		await mouse({ type: "mousePressed", x: 450, y: 450, button: "left", buttons: 1 });
		await mouse({ type: "mouseReleased", x: 450, y: 450, button: "left", buttons: 0 });
		await mouse({ type: "mousePressed", x: 900, y: 900, button: "left", buttons: 1 });
		expect(bubbled).toBe(2);
		expect(bridge.events.at(-1)?.target).toBe("body");
	});

	it("infers buttons from the button when omitted, applies modifiers, handles wheel", async () => {
		let modifierSeen = "";
		dom.query("#e4").addEventListener("pointerdown", (e) => {
			const ke = e as unknown as {
				shiftKey: boolean;
				ctrlKey: boolean;
				altKey: boolean;
				metaKey: boolean;
			};
			modifierSeen = `${ke.altKey}${ke.ctrlKey}${ke.metaKey}${ke.shiftKey}`;
		});
		await mouse({ type: "mousePressed", x: 450, y: 450, button: "left", modifiers: 8 | 2 });
		expect(bridge.pointer(1)?.buttons).toBe(1);
		expect(modifierSeen).toBe("falsetruefalsetrue");
		await mouse({ type: "mouseReleased", x: 450, y: 450, button: "left" });
		expect(bridge.pointer(1)?.buttons).toBe(0);
		await mouse({ type: "mouseWheel", x: 450, y: 450, deltaY: 120 });
		expect(bridge.events.at(-1)?.type).toBe("wheel");
	});

	it("rejects malformed mouse params, ignores key events, and answers Runtime.evaluate with undefined", async () => {
		await expect(mouse({ type: "mouseMoved" })).rejects.toThrow("Invalid parameters");
		await expect(
			bridge.send(2, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })
		).rejects.toThrow();
		expect(await bridge.send(1, "Input.dispatchKeyEvent", { type: "keyDown", key: "a" })).toEqual({});
		expect(await bridge.send(1, "Runtime.evaluate", { expression: "1" })).toEqual({
			result: { type: "undefined" },
		});
		expect(await bridge.send(1, "Page.enable")).toEqual({});
		bridge.unregisterTab(1);
		expect(bridge.pointer(1)).toBeUndefined();
	});
});
