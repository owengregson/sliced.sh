// test/sim/bridges/cdp-input.ts
/**
 * Applies CDP `Input.dispatchMouseEvent` commands to a tab's happy-dom so
 * executor tests can observe what the page would see. Chrome routes these
 * through the real input pipeline and the page receives *trusted*
 * `pointer*` / `mouse*` events; here each command dispatches the equivalent
 * DOM events (bubbling, cancelable, `isTrusted: true` defined on the event)
 * at the element `TabDom.elementAt(x, y)` reports — i.e. the rectangles the
 * test recorded with `dom.layout(...)` — falling back to `document.body`.
 *
 *   mouseMoved    → pointerout/mouseout + pointerover/mouseover on a target
 *                   change, then pointermove + mousemove
 *   mousePressed  → pointerdown + mousedown
 *   mouseReleased → pointerup + mouseup, then click when the press and the
 *                   release hit the same element with the left button
 *   mouseWheel    → wheel
 *
 * `Input.dispatchKeyEvent` is not modelled (the executor never types);
 * `Runtime.evaluate` answers `{ result: { type: "undefined" } }` unless a
 * test scripts it with `sim.debugger.respond`. Everything else resolves `{}`.
 */

import type { TabDom } from "@test/sim/dom/tab-dom";
import type { DispatchedPointerEvent } from "@test/sim/types";
import type { Element } from "happy-dom";

export interface MouseEventParams {
	type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
	x: number;
	y: number;
	button?: "none" | "left" | "middle" | "right" | "back" | "forward";
	buttons?: number;
	clickCount?: number;
	modifiers?: number;
	deltaX?: number;
	deltaY?: number;
	pointerType?: "mouse" | "pen";
}

export interface PointerState {
	x: number;
	y: number;
	buttons: number;
	target: Element | null;
	pressTarget: Element | null;
}

export interface CdpInputBridge {
	registerTab(tabId: number, dom: TabDom): void;
	unregisterTab(tabId: number): void;
	send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
	/** Every DOM event dispatched, in order. */
	readonly events: DispatchedPointerEvent[];
	pointer(tabId: number): PointerState | undefined;
	clear(): void;
}

const BUTTON_CODE: Record<NonNullable<MouseEventParams["button"]>, number> = {
	none: 0,
	left: 0,
	middle: 1,
	right: 2,
	back: 3,
	forward: 4,
};
const BUTTON_BIT: Record<NonNullable<MouseEventParams["button"]>, number> = {
	none: 0,
	left: 1,
	right: 2,
	middle: 4,
	back: 8,
	forward: 16,
};

const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

const describe = (el: Element): string => (el.id ? el.id : el.tagName.toLowerCase());

export function createCdpInputBridge(now: () => number): CdpInputBridge {
	const tabs = new Map<number, TabDom>();
	const pointers = new Map<number, PointerState>();
	const events: DispatchedPointerEvent[] = [];

	const stateFor = (tabId: number): PointerState => {
		let s = pointers.get(tabId);
		if (!s) {
			s = { x: 0, y: 0, buttons: 0, target: null, pressTarget: null };
			pointers.set(tabId, s);
		}
		return s;
	};

	function dispatch(
		tabId: number,
		dom: TabDom,
		target: Element,
		type: string,
		p: MouseEventParams,
		button: number,
		buttons: number,
		relatedTarget: Element | null
	): void {
		const modifiers = p.modifiers ?? 0;
		const init = {
			bubbles: true,
			cancelable: type !== "pointerout" && type !== "mouseout",
			composed: true,
			clientX: p.x,
			clientY: p.y,
			screenX: p.x,
			screenY: p.y,
			button,
			buttons,
			altKey: (modifiers & MOD_ALT) !== 0,
			ctrlKey: (modifiers & MOD_CTRL) !== 0,
			metaKey: (modifiers & MOD_META) !== 0,
			shiftKey: (modifiers & MOD_SHIFT) !== 0,
			detail: type === "click" ? (p.clickCount ?? 1) : 0,
			...(relatedTarget ? { relatedTarget } : {}),
		};
		const win = dom.window;
		const event = type.startsWith("pointer")
			? new win.PointerEvent(type, {
					...init,
					pointerId: 1,
					pointerType: p.pointerType ?? "mouse",
					isPrimary: true,
					width: 1,
					height: 1,
					pressure: buttons === 0 ? 0 : 0.5,
				})
			: type === "wheel"
				? new win.WheelEvent(type, { ...init, deltaX: p.deltaX ?? 0, deltaY: p.deltaY ?? 0 })
				: new win.MouseEvent(type, init);
		Object.defineProperty(event, "isTrusted", { value: true, configurable: true });
		events.push({
			tabId,
			type,
			x: p.x,
			y: p.y,
			button,
			buttons,
			target: describe(target),
			at: now(),
		});
		target.dispatchEvent(event);
	}

	function applyMouse(tabId: number, dom: TabDom, p: MouseEventParams): void {
		const state = stateFor(tabId);
		const body = dom.document.body as unknown as Element;
		const target = dom.elementAt(p.x, p.y) ?? body;
		const buttonName = p.button ?? "none";
		const button = BUTTON_CODE[buttonName];
		state.x = p.x;
		state.y = p.y;

		if (p.type === "mouseMoved") {
			const buttons = p.buttons ?? state.buttons;
			state.buttons = buttons;
			if (state.target !== target) {
				if (state.target?.isConnected) {
					dispatch(tabId, dom, state.target, "pointerout", p, button, buttons, target);
					dispatch(tabId, dom, state.target, "mouseout", p, button, buttons, target);
				}
				dispatch(tabId, dom, target, "pointerover", p, button, buttons, state.target);
				dispatch(tabId, dom, target, "mouseover", p, button, buttons, state.target);
				state.target = target;
			}
			dispatch(tabId, dom, target, "pointermove", p, button, buttons, null);
			dispatch(tabId, dom, target, "mousemove", p, button, buttons, null);
			return;
		}
		if (p.type === "mousePressed") {
			const buttons = p.buttons ?? state.buttons | BUTTON_BIT[buttonName];
			state.buttons = buttons;
			state.target = target;
			state.pressTarget = target;
			dispatch(tabId, dom, target, "pointerdown", p, button, buttons, null);
			dispatch(tabId, dom, target, "mousedown", p, button, buttons, null);
			return;
		}
		if (p.type === "mouseReleased") {
			const buttons = p.buttons ?? state.buttons & ~BUTTON_BIT[buttonName];
			state.buttons = buttons;
			state.target = target;
			dispatch(tabId, dom, target, "pointerup", p, button, buttons, null);
			dispatch(tabId, dom, target, "mouseup", p, button, buttons, null);
			if (buttonName === "left" && state.pressTarget === target) {
				dispatch(tabId, dom, target, "click", p, button, buttons, null);
			}
			state.pressTarget = null;
			return;
		}
		if (p.type === "mouseWheel") {
			dispatch(tabId, dom, target, "wheel", p, button, state.buttons, null);
		}
	}

	return {
		events,
		registerTab(tabId, dom) {
			tabs.set(tabId, dom);
		},
		unregisterTab(tabId) {
			tabs.delete(tabId);
			pointers.delete(tabId);
		},
		send(tabId, method, params) {
			if (method === "Input.dispatchMouseEvent") {
				const dom = tabs.get(tabId);
				const p = params as unknown as MouseEventParams | undefined;
				if (!dom || !p || typeof p.x !== "number" || typeof p.y !== "number") {
					return Promise.reject(new Error("Invalid parameters"));
				}
				applyMouse(tabId, dom, p);
				return Promise.resolve({});
			}
			if (method === "Runtime.evaluate") return Promise.resolve({ result: { type: "undefined" } });
			return Promise.resolve({});
		},
		pointer: (tabId) => {
			const s = pointers.get(tabId);
			return s ? { ...s } : undefined;
		},
		clear() {
			events.length = 0;
		},
	};
}
