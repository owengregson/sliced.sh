// test/content/virtual-cursor.test.ts — Fix D: the ISOLATED-world relay.
//
// The content script neither decides nor draws: it forwards the service worker's `cursorTo` /
// `cursorHide` to the MAIN-world bridge (the only world allowed to insert the element, §13.3) and
// remembers nothing but whether something is on screen, so a hide is not posted when nothing is.
// It must never read a pointer event to feed this — CDP-dispatched events are trusted, so the
// owner's real mouse is indistinguishable from the hand's and would drive the mirror.
import { describe, expect, it } from "bun:test";
import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/adapter";
import { createVirtualCursor, glidePoints, type Point } from "@content/virtual-cursor";
import { CURSOR_UNLOCK } from "@core/constants/cursor";
import type { GamePortCommand } from "@core/constants/messages";
import type { Scheduler } from "@core/util/scheduler";

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

/** A hand-rolled timer queue: `run(ms)` fires everything due within the next `ms`. */
function fakeScheduler(): Scheduler & { run(ms: number): number; pending(): number } {
	let now = 0;
	let serial = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimeout(fn, ms) {
			const id = ++serial;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		run(ms) {
			const until = now + ms;
			let fired = 0;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= until)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				fired += 1;
			}
			now = until;
			return fired;
		},
		pending: () => timers.size,
	};
}

const STEPS = Math.ceil(CURSOR_UNLOCK.glideMs / CURSOR_UNLOCK.stepMs);

const sentTo = (bridge: { sent: Sent[] }): Point[] =>
	bridge.sent
		.filter((s) => s.kind === BRIDGE_KINDS.cursorTo)
		.map((s) => {
			const p = s.payload as { x: number; y: number };
			return { x: p.x, y: p.y };
		});

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
		expect(mirror.apply({ kind: "startNewGame", id: "queue", gameId: null })).toBe(false);
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

	/**
	 * 2026-09-13: the relay has no notion of a game. Between two games no command arrives at all,
	 * and the mirror it drew stays drawn; only an explicit `cursorHide` (the service worker's three
	 * reasons) or `dispose()` (the content script going away) erases it. Whatever the service
	 * worker's own lifecycle does in between — a worker rebuilt, a session replaced — reaches this
	 * side as nothing, and nothing changes nothing.
	 */
	it("keeps the mirror drawn through a quiet stretch: only a hide command or dispose erases it", () => {
		const bridge = fakeBridge();
		const mirror = createVirtualCursor(bridge);
		mirror.apply(to(300, 400));
		expect(mirror.shown()).toBe(true);
		// the quiet stretch: the pointer-admission handshake still runs against the drawn mirror
		bridge.call = <T>() => Promise.resolve(true as T);
		const sent = bridge.sent.length;
		mirror.apply({ kind: "clearHighlight" });
		mirror.apply({ kind: "settings", highlightMoves: false });
		expect(mirror.shown()).toBe(true);
		expect(bridge.sent).toHaveLength(sent);
		expect(bridge.sent.some((s) => s.kind === BRIDGE_KINDS.cursorHide)).toBe(false);
		// the next game's first point continues the same element (no hide in between)
		mirror.apply(to(302, 401));
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(0);
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorTo)).toHaveLength(2);
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

/**
 * 2026-09-13, the owner's first request: "when on a page that isnt a game page … we shouldnt lock
 * cursor/disable input on the page". The relay's half of that gate: with `allowed()` false a
 * `cursorTo` is still claimed (it is the mirror's command) but draws nothing, so the first draw —
 * the thing that raises the shield — never happens.
 */
describe("content virtual-cursor relay — the page-kind gate", () => {
	it("claims but drops every point while the page is not a game page, and draws once it is", () => {
		const bridge = fakeBridge();
		let gamePage = false;
		const shown: boolean[] = [];
		const mirror = createVirtualCursor(bridge, {
			allowed: () => gamePage,
			onVisibilityChange: (s) => shown.push(s),
		});
		expect(mirror.apply(to(10, 20))).toBe(true);
		expect(mirror.apply(to(11, 21, true))).toBe(true);
		expect(bridge.sent).toEqual([]);
		expect(mirror.shown()).toBe(false);
		expect(shown).toEqual([]);
		// a hide on nothing drawn stays nothing
		mirror.apply(hide);
		expect(bridge.sent).toEqual([]);
		// the route changes to a game page: the next point draws
		gamePage = true;
		mirror.apply(to(12, 22));
		expect(sentTo(bridge)).toEqual([{ x: 12, y: 22 }]);
		expect(mirror.shown()).toBe(true);
		expect(shown).toEqual([true]);
	});
});

/**
 * 2026-09-13, the owner's second request: "when the mouse goes from virtual mouse locked ->
 * unlocked, we want to smoothly move the cursor from its current position to the actual user's
 * cursor position THEN unlock". A hide of a drawn mirror is therefore a glide first: interpolated
 * `cursorTo` points down the same draw path, over `CURSOR_UNLOCK.glideMs` at `stepMs`, ending
 * exactly on the real pointer, and only then the `cursorHide`. The mirror is shown for the whole
 * glide — the shield does not drop until the two cursors coincide.
 */
describe("content virtual-cursor relay — the unlock glide", () => {
	it("glides from the arrow to the real pointer, then hides: point count, monotone path, exact end", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const shown: boolean[] = [];
		const real: Point = { x: 700, y: 140 };
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => real,
			onVisibilityChange: (s) => shown.push(s),
		});
		mirror.apply(to(100, 500));
		expect(shown).toEqual([true]);

		mirror.apply(hide);
		// nothing erased yet: the glide is not a hide until it ends
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(0);
		expect(mirror.shown()).toBe(true);
		expect(mirror.gliding()).toBe(true);
		expect(shown).toEqual([true]);

		// one point per step, none before the first step elapses
		expect(timers.run(CURSOR_UNLOCK.stepMs - 1)).toBe(0);
		expect(timers.run(1)).toBe(1);
		expect(sentTo(bridge)).toHaveLength(2);
		timers.run(CURSOR_UNLOCK.glideMs);
		const points = sentTo(bridge).slice(1);
		expect(points).toHaveLength(STEPS);
		expect(points).toEqual(glidePoints({ x: 100, y: 500 }, real));
		// monotone in both axes, strictly towards the real pointer, landing exactly on it
		for (let i = 1; i < points.length; i += 1) {
			const a = points[i - 1];
			const b = points[i];
			if (!a || !b) throw new Error("missing point");
			expect(b.x).toBeGreaterThanOrEqual(a.x);
			expect(b.y).toBeLessThanOrEqual(a.y);
		}
		expect(points.at(-1)).toEqual(real);
		// every interpolated point is a released, drawing-only point
		for (const s of bridge.sent.slice(1, -1))
			expect((s.payload as { down: boolean }).down).toBe(false);
		// and then — only then — the hide, once
		expect(bridge.sent.at(-1)).toEqual({ kind: BRIDGE_KINDS.cursorHide, payload: undefined });
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(1);
		expect(mirror.shown()).toBe(false);
		expect(mirror.gliding()).toBe(false);
		expect(shown).toEqual([true, false]);
		expect(timers.pending()).toBe(0);
		// the glide's points never counted as a round trip
		expect(bridge.calls).toEqual([]);
	});

	it("takes the whole of glideMs, not a step longer", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => ({ x: 0, y: 0 }),
		});
		mirror.apply(to(320, 320));
		mirror.apply(hide);
		timers.run(STEPS * CURSOR_UNLOCK.stepMs - 1);
		expect(mirror.shown()).toBe(true);
		timers.run(1);
		expect(mirror.shown()).toBe(false);
		expect(sentTo(bridge)).toHaveLength(1 + STEPS);
	});

	it("a new lock mid-glide cancels the glide: the arrow continues from where it is, nothing hides", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const shown: boolean[] = [];
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => ({ x: 0, y: 0 }),
			onVisibilityChange: (s) => shown.push(s),
		});
		mirror.apply(to(400, 400));
		mirror.apply(hide);
		timers.run(CURSOR_UNLOCK.stepMs * 5);
		const midway = sentTo(bridge).length;
		expect(midway).toBe(1 + 5);
		expect(mirror.gliding()).toBe(true);

		// the hand's next point (a new game armed while the arrow was on its way back)
		mirror.apply(to(390, 395, true));
		expect(mirror.gliding()).toBe(false);
		expect(mirror.shown()).toBe(true);
		expect(timers.pending()).toBe(0);
		timers.run(CURSOR_UNLOCK.glideMs * 2);
		// no further interpolated points, no hide, no visibility edge: the mirror never went away
		expect(sentTo(bridge)).toHaveLength(midway + 1);
		expect(sentTo(bridge).at(-1)).toEqual({ x: 390, y: 395 });
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(0);
		expect(shown).toEqual([true]);
	});

	it("a second hide mid-glide does not restart or double the glide", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => ({ x: 0, y: 0 }),
		});
		mirror.apply(to(400, 400));
		mirror.apply(hide);
		timers.run(CURSOR_UNLOCK.stepMs * 3);
		mirror.apply(hide);
		mirror.apply(hide);
		expect(timers.pending()).toBe(1);
		timers.run(CURSOR_UNLOCK.glideMs);
		expect(sentTo(bridge)).toHaveLength(1 + STEPS);
		expect(bridge.sent.filter((s) => s.kind === BRIDGE_KINDS.cursorHide)).toHaveLength(1);
	});

	it("with no real position known the glide is skipped and the mirror hides at once", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const mirror = createVirtualCursor(bridge, { scheduler: timers, realPosition: () => null });
		mirror.apply(to(50, 60));
		mirror.apply(hide);
		expect(mirror.shown()).toBe(false);
		expect(bridge.sent.at(-1)).toEqual({ kind: BRIDGE_KINDS.cursorHide, payload: undefined });
		expect(sentTo(bridge)).toHaveLength(1);
		expect(timers.pending()).toBe(0);
		// no `realPosition` at all behaves the same (the relay's other callers)
		const plain = createVirtualCursor(bridge, { scheduler: timers });
		plain.apply(to(1, 1));
		plain.apply(hide);
		expect(plain.shown()).toBe(false);
		expect(timers.pending()).toBe(0);
	});

	it("an arrow already on the real pointer hides at once", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => ({ x: 50, y: 60 }),
		});
		mirror.apply(to(50, 60));
		mirror.apply(hide);
		expect(mirror.shown()).toBe(false);
		expect(timers.pending()).toBe(0);
	});

	it("the admission handshake still runs against the mirror during the glide (it is still drawn)", async () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		bridge.call = <T>(kind: string) => {
			bridge.calls.push(kind);
			return Promise.resolve(true as T);
		};
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => ({ x: 0, y: 0 }),
		});
		mirror.apply(to(300, 300));
		mirror.apply(hide);
		timers.run(CURSOR_UNLOCK.stepMs);
		const pointer = { type: "mouseMoved" as const, x: 1, y: 2, buttons: 0, timestampMs: 1 };
		expect(await mirror.prepare(pointer)).toBe(true);
		expect(bridge.calls).toEqual([BRIDGE_KINDS.cursorPrepare]);
	});

	it("dispose mid-glide erases at once — the tab is going, there is nothing to glide for", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => ({ x: 0, y: 0 }),
		});
		mirror.apply(to(300, 300));
		mirror.apply(hide);
		timers.run(CURSOR_UNLOCK.stepMs * 2);
		mirror.dispose();
		expect(bridge.sent.at(-1)).toEqual({ kind: BRIDGE_KINDS.cursorHide, payload: undefined });
		expect(mirror.shown()).toBe(false);
		expect(timers.pending()).toBe(0);
		expect(sentTo(bridge)).toHaveLength(1 + 2);
	});

	it("a page side that vanishes mid-glide ends the glide; the hide stays pending, as before", () => {
		const bridge = fakeBridge();
		const timers = fakeScheduler();
		const mirror = createVirtualCursor(bridge, {
			scheduler: timers,
			realPosition: () => ({ x: 0, y: 0 }),
		});
		mirror.apply(to(300, 300));
		mirror.apply(hide);
		timers.run(CURSOR_UNLOCK.stepMs * 2);
		bridge.available = false;
		timers.run(CURSOR_UNLOCK.glideMs);
		expect(timers.pending()).toBe(0);
		expect(mirror.gliding()).toBe(false);
		// "does not forget a hide it could not send": still drawn until a hide can leave
		expect(mirror.shown()).toBe(true);
		bridge.available = true;
		mirror.apply(hide); // the arrow is not on the real pointer, but the point of a dead bridge
		timers.run(CURSOR_UNLOCK.glideMs);
		expect(mirror.shown()).toBe(false);
		expect(bridge.sent.at(-1)).toEqual({ kind: BRIDGE_KINDS.cursorHide, payload: undefined });
	});
});
