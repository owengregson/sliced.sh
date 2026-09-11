import { afterEach, describe, expect, it } from "bun:test";
import { type CursorSample, createCursorTracker } from "@content/cursor-tracker";
import { POINTER_CONTROL, type PreparedPointer } from "@core/constants/cdp";
import { Window as HappyWindow } from "happy-dom";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanups.splice(0).reverse()) dispose();
});

function setup() {
	const win = new HappyWindow();
	let now = win.performance.timeOrigin + 1000;
	let wallShift = 0;
	Object.defineProperty(win.performance, "now", {
		value: () => now - wallShift - win.performance.timeOrigin,
	});
	const samples: CursorSample[] = [];
	const seen: string[] = [];
	const tracker = createCursorTracker({
		window: win as unknown as Window,
		now: () => now,
		onSample: (p) => samples.push(p),
	});
	cleanups.push(() => win.happyDOM.close(), tracker.dispose);
	const types = [
		"pointermove",
		"pointerdown",
		"pointerup",
		"mousemove",
		"mousedown",
		"mouseup",
		"click",
		"auxclick",
		"contextmenu",
		"wheel",
		"keydown",
	];
	for (const type of types) win.addEventListener(type, () => seen.push(type));
	const pointer = (type: PreparedPointer["type"] = "mouseMoved", buttons = 0): PreparedPointer => ({
		type,
		x: 60,
		y: 70,
		buttons,
		timestampMs: now,
	});
	const fire = (
		type: string,
		params: {
			buttons?: number;
			x?: number;
			stamp?: number;
			detail?: number;
			pointerType?: string;
		} = {}
	) => {
		const ev = new win.PointerEvent(type, {
			clientX: params.x ?? 60,
			clientY: 70,
			buttons: params.buttons ?? 0,
			detail: params.detail ?? 1,
			pointerType: params.pointerType ?? "mouse",
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperties(ev, {
			isTrusted: { value: true },
			timeStamp: { value: (params.stamp ?? now) - wallShift - win.performance.timeOrigin },
		});
		win.document.body.dispatchEvent(ev);
		return ev;
	};
	return {
		win,
		tracker,
		samples,
		seen,
		fire,
		pointer,
		shiftClock: (ms: number) => {
			now += ms;
			wallShift += ms;
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("virtual page pointer ownership", () => {
	it("recalibrates event timestamps after a wall-clock jump without needing a page reload", () => {
		const { tracker, fire, pointer, shiftClock } = setup();
		tracker.setVirtualActive(true);
		for (const change of [0, 30000, -45000]) {
			shiftClock(change);
			const press = pointer("mousePressed", 1);
			tracker.prepareVirtualPointer(press);
			expect(fire("pointerdown", { buttons: 1 }).defaultPrevented).toBe(false);
			expect(fire("mousedown", { buttons: 1 }).defaultPrevented).toBe(false);
			expect(tracker.virtualPointerDelivered(press)).toBe(true);
		}
	});

	it("accepts quantized press coordinates/timestamps and reports actual delivery only", () => {
		const { tracker, fire, pointer, seen } = setup();
		tracker.setVirtualActive(true);
		const press = pointer("mousePressed", 1);
		tracker.prepareVirtualPointer(press);
		expect(tracker.virtualPointerDelivered(press)).toBe(false);
		expect(
			fire("pointerdown", { buttons: 1, x: 60.4, stamp: press.timestampMs + 1.2 }).defaultPrevented
		).toBe(false);
		expect(tracker.virtualPointerDelivered(press)).toBe(true);
		fire("mousedown", { buttons: 1, stamp: press.timestampMs + 1 });
		expect(seen).toEqual(["pointerdown", "mousedown"]);
		const release = pointer("mouseReleased");
		tracker.prepareVirtualPointer(release);
		expect(tracker.virtualPointerDelivered(release)).toBe(false);
		expect(fire("pointerup", { x: 63 }).defaultPrevented).toBe(true);
		expect(tracker.virtualPointerDelivered(release)).toBe(false);
	});

	it("blocks physical mouse moves, presses, releases, wheel and context actions without moving the stored cursor", () => {
		const { tracker, fire, seen, samples } = setup();
		fire("pointermove", { x: 10 });
		const original = tracker.report();
		seen.length = 0;
		samples.length = 0;
		tracker.setVirtualActive(true);
		for (const type of [
			"pointermove",
			"mousemove",
			"pointerdown",
			"mousedown",
			"pointerup",
			"mouseup",
			"click",
			"auxclick",
			"contextmenu",
			"wheel",
		]) {
			expect(fire(type).defaultPrevented).toBe(true);
		}
		expect(seen).toEqual([]);
		expect(tracker.report()).toEqual(original);
		expect(samples).toHaveLength(3);
	});

	it("admits exactly the announced virtual move and compatibility event, never subsequent physical motion at the same point", () => {
		const { tracker, fire, seen, samples, pointer, advance } = setup();
		tracker.setVirtualActive(true);
		tracker.prepareVirtualPointer(pointer());
		// Matching position alone does not identify a browser-dispatched event.
		advance(10);
		expect(fire("pointermove").defaultPrevented).toBe(true);
		tracker.prepareVirtualPointer(pointer());
		expect(fire("pointermove").defaultPrevented).toBe(false);
		expect(fire("mousemove").defaultPrevented).toBe(false);
		expect(fire("pointermove").defaultPrevented).toBe(true);
		expect(seen).toEqual(["pointermove", "mousemove"]);
		// The virtual sample is never counted as physical interference.
		expect(samples).toHaveLength(2);
	});

	it("admits the prepared press/release/click sequence with its correct button state", () => {
		const { tracker, pointer, fire, seen, samples } = setup();
		tracker.setVirtualActive(true);
		tracker.prepareVirtualPointer(pointer("mousePressed", 1));
		expect(fire("pointerdown").defaultPrevented).toBe(true);
		fire("pointerdown", { buttons: 1 });
		fire("mousedown", { buttons: 1 });
		tracker.prepareVirtualPointer(pointer("mouseReleased"));
		fire("pointerup");
		fire("mouseup");
		fire("click");
		expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
		expect(samples).toHaveLength(1);
	});

	it("expires unused admissions and clears them on deactivation", () => {
		const { tracker, fire, pointer, advance } = setup();
		tracker.setVirtualActive(true);
		const stale = pointer();
		tracker.prepareVirtualPointer(stale);
		advance(POINTER_CONTROL.expiresMs + 1);
		expect(fire("pointermove", { stamp: stale.timestampMs }).defaultPrevented).toBe(true);
		tracker.prepareVirtualPointer(pointer());
		tracker.setVirtualActive(false);
		expect(fire("pointermove").defaultPrevented).toBe(false);
		tracker.setVirtualActive(true);
		expect(fire("pointermove").defaultPrevented).toBe(true);
	});

	it("preserves keyboard events and keyboard-generated activation, and restores mouse input on disposal", () => {
		const { tracker, fire, seen } = setup();
		tracker.setVirtualActive(true);
		expect(fire("keydown").defaultPrevented).toBe(false);
		expect(fire("click", { detail: 0, pointerType: "" }).defaultPrevented).toBe(false);
		tracker.dispose();
		expect(fire("pointerdown").defaultPrevented).toBe(false);
		expect(seen).toEqual(["keydown", "click", "pointerdown"]);
	});
});
