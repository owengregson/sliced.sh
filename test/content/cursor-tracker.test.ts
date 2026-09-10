// test/content/cursor-tracker.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { type CursorSample, createCursorTracker } from "@content/cursor-tracker";
import { Window as HappyWindow } from "happy-dom";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function setup(minIntervalMs = 100) {
	const win = new HappyWindow({ url: "https://www.chess.com/game/174252011111" });
	cleanups.push(() => win.happyDOM.close());
	let now = 5_000;
	const samples: CursorSample[] = [];
	const tracker = createCursorTracker({
		window: win as unknown as Window,
		onSample: (s) => samples.push(s),
		minIntervalMs,
		now: () => now,
	});
	cleanups.push(() => tracker.dispose());
	const fire = (type: string, x: number, y: number, trusted: boolean): void => {
		const ev = new win.PointerEvent(type, { clientX: x, clientY: y, bubbles: true });
		if (trusted) Object.defineProperty(ev, "isTrusted", { value: true });
		win.document.body.dispatchEvent(ev);
	};
	return {
		tracker,
		samples,
		fire,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("CursorTracker", () => {
	it("records only trusted pointer events and reports them as { x, y, t, real: true }", () => {
		const { tracker, samples, fire } = setup();
		expect(tracker.report()).toBeNull();
		fire("pointermove", 10, 20, false);
		fire("pointerdown", 11, 21, false);
		expect(tracker.report()).toBeNull();
		expect(samples).toEqual([]);
		fire("pointermove", 30, 40, true);
		expect(tracker.report()).toEqual({ x: 30, y: 40, t: 5_000, real: true });
		expect(samples).toEqual([{ x: 30, y: 40, t: 5_000, real: true }]);
	});
	it("throttles pointermove samples to the minimum interval but always posts presses and releases", () => {
		const { samples, fire, advance } = setup(100);
		fire("pointermove", 1, 1, true);
		fire("pointermove", 2, 2, true);
		advance(50);
		fire("pointermove", 3, 3, true);
		fire("pointerdown", 4, 4, true);
		fire("pointerup", 5, 5, true);
		advance(50);
		fire("pointermove", 6, 6, true); // 50 ms after the release: still throttled
		advance(50);
		fire("pointermove", 7, 7, true);
		expect(samples.map((s) => s.x)).toEqual([1, 4, 5, 7]);
	});
	it("posts every trusted event unthrottled while the hand is active, and counts them", () => {
		const { tracker, samples, fire } = setup(100);
		tracker.beginHand();
		fire("pointermove", 1, 1, true);
		fire("pointermove", 2, 2, true);
		fire("pointermove", 3, 3, false);
		fire("pointermove", 4, 4, true);
		expect(samples.map((s) => s.x)).toEqual([1, 2, 4]);
		expect(tracker.endHand()).toBe(3);
		fire("pointermove", 5, 5, true); // idle again: throttled
		expect(samples.map((s) => s.x)).toEqual([1, 2, 4]);
	});
	it("counts real pointer events while the hand is active", () => {
		const { tracker, fire } = setup();
		fire("pointermove", 1, 1, true);
		expect(tracker.handActive()).toBe(false);
		tracker.beginHand();
		expect(tracker.handActive()).toBe(true);
		fire("pointermove", 2, 2, true);
		fire("pointermove", 3, 3, false); // synthetic: not counted
		fire("pointerdown", 4, 4, true);
		expect(tracker.endHand()).toBe(2);
		expect(tracker.handActive()).toBe(false);
		fire("pointermove", 5, 5, true);
		tracker.beginHand();
		expect(tracker.endHand()).toBe(0);
	});
	it("dispose removes the listeners", () => {
		const { tracker, samples, fire } = setup();
		tracker.dispose();
		fire("pointermove", 1, 1, true);
		expect(samples).toEqual([]);
		expect(tracker.report()).toBeNull();
	});
});
