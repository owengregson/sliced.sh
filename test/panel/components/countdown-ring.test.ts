// test/panel/components/countdown-ring.test.ts — Appendix F §5.10: stroke-dashoffset ∝ remaining
// time; reduced motion replaces the ring with "in 3.1s".
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type CountdownRingHandle,
	createCountdownRing,
	RING_CIRCUMFERENCE,
} from "@panel/components/countdown-ring";
import { bootPanelDom, mount, type PanelDom } from "../dom";

let dom: PanelDom;
let handle: CountdownRingHandle | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	handle?.dispose();
	handle = null;
	await dom.teardown();
});

const progress = (): SVGCircleElement => {
	const c = handle?.el.querySelector<SVGCircleElement>(".sl-ring__progress");
	if (!c) throw new Error("no progress circle");
	return c;
};

describe("createCountdownRing", () => {
	it("drains clockwise: offset 0 when full, the circumference when empty", () => {
		const el = mount(document.createElement("span"));
		handle = createCountdownRing(el);
		expect(handle.el.getAttribute("aria-hidden")).toBe("true");
		expect(handle.el.querySelector(".sl-ring__track")).not.toBeNull();
		expect(progress().getAttribute("stroke-dasharray")).toBe(String(RING_CIRCUMFERENCE));
		handle.update(4200, 4200);
		expect(Number(progress().getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 6);
		handle.update(2100, 4200);
		expect(Number(progress().getAttribute("stroke-dashoffset"))).toBeCloseTo(
			RING_CIRCUMFERENCE / 2,
			6
		);
		handle.update(1050, 4200);
		expect(Number(progress().getAttribute("stroke-dashoffset"))).toBeCloseTo(
			RING_CIRCUMFERENCE * 0.75,
			6
		);
		handle.update(0, 4200);
		expect(Number(progress().getAttribute("stroke-dashoffset"))).toBeCloseTo(RING_CIRCUMFERENCE, 6);
		handle.update(-500, 4200); // clamped
		expect(Number(progress().getAttribute("stroke-dashoffset"))).toBeCloseTo(RING_CIRCUMFERENCE, 6);
		expect(handle.el.querySelector(".sl-ring__text")?.hasAttribute("hidden")).toBe(true);
	});

	it("pause() freezes the visual; resume() re-syncs", () => {
		const el = mount(document.createElement("span"));
		handle = createCountdownRing(el);
		handle.update(4000, 4000);
		handle.pause();
		expect(handle.el.classList.contains("sl-ring--paused")).toBe(true);
		handle.update(2000, 4000);
		expect(Number(progress().getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 6);
		handle.resume();
		expect(handle.el.classList.contains("sl-ring--paused")).toBe(false);
		expect(Number(progress().getAttribute("stroke-dashoffset"))).toBeCloseTo(
			RING_CIRCUMFERENCE / 2,
			6
		);
	});

	it("reduced motion: the ring is replaced by the numeric countdown text", () => {
		document.body.dataset.reducedMotion = "true";
		const el = mount(document.createElement("span"));
		handle = createCountdownRing(el);
		handle.update(3140, 4200);
		expect(handle.el.classList.contains("sl-ring--text")).toBe(true);
		expect(handle.el.querySelector(".sl-ring__svg")?.hasAttribute("hidden")).toBe(true);
		const text = handle.el.querySelector(".sl-ring__text");
		expect(text?.hasAttribute("hidden")).toBe(false);
		expect(text?.textContent).toBe("in 3.1s");
		handle.update(900, 4200);
		expect(text?.textContent).toBe("in 0.9s");
	});
});
