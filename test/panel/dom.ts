// test/panel/dom.ts — boot a simulator + panel context (happy-dom window as `document`) with
// fake timers installed, for component and shell tests.
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";

export interface PanelDom {
	sim: Simulator;
	panel: PanelContext;
	/** Advance the fake clock (drains microtasks). */
	tick(ms?: number): Promise<void>;
	teardown(): Promise<void>;
}

export async function bootPanelDom(html?: string): Promise<PanelDom> {
	const sim = createSimulator();
	sim.time.install();
	const panel = await bootPanelContext(sim, html === undefined ? {} : { html });
	return {
		sim,
		panel,
		tick: (ms = 0) => sim.time.advance(ms),
		async teardown() {
			await panel.teardown();
			await sim.dispose();
		},
	};
}

export function key(
	target: EventTarget,
	type: "keydown" | "keyup",
	init: KeyboardEventInit & { key: string }
): boolean {
	const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
	return target.dispatchEvent(ev);
}

export function pointer(target: EventTarget, type: string, init: PointerEventInit = {}): boolean {
	const ev = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
	return target.dispatchEvent(ev);
}

export function click(target: EventTarget): boolean {
	return target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

export function mount(el: HTMLElement): HTMLElement {
	document.body.append(el);
	return el;
}
