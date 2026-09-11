// test/content/virtual-cursor.test.ts — Fix D: the ISOLATED-world relay.
//
// The content script neither decides nor draws: it forwards the service worker's `cursorTo` /
// `cursorHide` to the MAIN-world bridge (the only world allowed to insert the element, §13.3) and
// remembers nothing but whether something is on screen, so a hide is not posted when nothing is.
// It must never read a pointer event to feed this — CDP-dispatched events are trusted, so the
// owner's real mouse is indistinguishable from the hand's and would drive the mirror.
import { describe, expect, it } from "bun:test";
import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/adapter";
import { createVirtualCursor } from "@content/virtual-cursor";
import type { GamePortCommand } from "@core/constants/messages";

interface Sent {
	kind: string;
	payload: unknown;
}

function fakeBridge(
	available = true
): PageBridge & { sent: Sent[]; calls: string[]; available: boolean } {
	const sent: Sent[] = [];
	const calls: string[] = [];
	return {
		sent,
		calls,
		available,
		isAvailable(): boolean {
			return this.available;
		},
		call<T>(kind: string): Promise<T> {
			calls.push(kind);
			return Promise.resolve(undefined as T);
		},
		on: () => () => {},
		notify: (kind, payload) => {
			sent.push({ kind, payload });
		},
	};
}

const to = (x: number, y: number, down = false): GamePortCommand => ({
	kind: "cursorTo",
	x,
	y,
	down,
});
const hide: GamePortCommand = { kind: "cursorHide" };

describe("content virtual-cursor relay", () => {
	it("admits input without a mirror, waits for its active aperture, and rejects late replies after hiding", async () => {
		const bridge = fakeBridge();
		let finish: (value: boolean) => void = () => {};
		bridge.call = <T>() =>
			new Promise<T>((resolve) => {
				finish = (value) => resolve(value as T);
			});
		const mirror = createVirtualCursor(bridge);
		const pointer = {
			type: "mouseMoved" as const,
			x: 10,
			y: 20,
			buttons: 0,
			timestampMs: Date.now(),
		};
		expect(await mirror.prepare(pointer)).toBe(true);
		mirror.apply(to(10, 20));
		const admitted = mirror.prepare(pointer);
		finish(true);
		expect(await admitted).toBe(true);
		const stale = mirror.prepare(pointer);
		mirror.apply(hide);
		finish(true);
		expect(await stale).toBe(false);
		mirror.apply(to(10, 20));
		bridge.call = () => Promise.reject(new Error("missing bridge"));
		expect(await mirror.prepare(pointer)).toBe(false);
		mirror.dispose();
		expect(await mirror.prepare(pointer)).toBe(false);
	});
	it("claims the two commands and nothing else", () => {
		const bridge = fakeBridge();
		const mirror = createVirtualCursor(bridge);
		expect(mirror.apply(to(1, 2))).toBe(true);
		expect(mirror.apply(hide)).toBe(true);
		expect(mirror.apply({ kind: "clearHighlight" })).toBe(false);
		expect(mirror.apply({ kind: "startNewGame" })).toBe(false);
	});

	it("forwards every position to the bridge, never through a round trip", () => {
		const bridge = fakeBridge();
		const mirror = createVirtualCursor(bridge);
		mirror.apply(to(10, 20));
		mirror.apply(to(11, 21, true));
		expect(bridge.sent).toEqual([
			{ kind: BRIDGE_KINDS.cursorTo, payload: { x: 10, y: 20, down: false } },
			{ kind: BRIDGE_KINDS.cursorTo, payload: { x: 11, y: 21, down: true } },
		]);
		// a reply per point would double the traffic: nothing is `call`ed
		expect(bridge.calls).toEqual([]);
	});

	it("hides only what it drew, and only once", () => {
		const bridge = fakeBridge();
		const mirror = createVirtualCursor(bridge);
		mirror.apply(hide);
		expect(bridge.sent).toEqual([]); // nothing was drawn: nothing to erase
		mirror.apply(to(5, 5));
		mirror.apply(hide);
		mirror.apply(hide);
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(1);
		// and it draws again afterwards
		mirror.apply(to(6, 6));
		mirror.apply(hide);
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(2);
	});

	it("drops positions while the page side is absent, so nothing is queued for a dead bridge", () => {
		const bridge = fakeBridge(false);
		const mirror = createVirtualCursor(bridge);
		mirror.apply(to(1, 1));
		mirror.apply(hide);
		expect(bridge.sent).toEqual([]);
	});

	it("does not forget a hide it could not send", () => {
		const bridge = fakeBridge();
		const mirror = createVirtualCursor(bridge);
		mirror.apply(to(5, 5));
		expect(mirror.shown()).toBe(true);

		// The page side went away between the draw and the hide: the message cannot leave, so the
		// element is still there and `drawn` must not be cleared — or nothing would ever erase it.
		bridge.available = false;
		mirror.apply(hide);
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(0);
		expect(mirror.shown()).toBe(true);

		bridge.available = true;
		mirror.apply(hide);
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(1);
		expect(mirror.shown()).toBe(false);
	});

	it("erases the mirror on dispose (the tab is going away with it on screen)", () => {
		const bridge = fakeBridge();
		const mirror = createVirtualCursor(bridge);
		mirror.apply(to(3, 4));
		mirror.dispose();
		expect(bridge.sent.at(-1)).toEqual({ kind: BRIDGE_KINDS.cursorHide, payload: undefined });
		// disposing twice posts nothing more, and a late command is ignored
		mirror.dispose();
		mirror.apply(to(9, 9));
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(1);
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorTo)).toHaveLength(1);
	});
});
