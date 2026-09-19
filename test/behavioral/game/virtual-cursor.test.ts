// test/behavioral/game/virtual-cursor.test.ts — Fix D, end to end on the simulator.
//
// The owner's request was "show a virtual mouse ... to display where the hand is currently located.
// it should always be updated", and the one property that makes it true rather than decorative is
// that the positions the page is shown are *exactly* the positions the page was told: the sequence
// the CDP backend dispatched, in order, nothing dropped and nothing invented. Between moves the
// mirror parks on the last dispatched point, because that is where the pointer actually is.
//
// The hide contract (owner, 2026-09-13: "ensure the virtual cursor doesnt disappear between games")
// is the other half. The arrow is where the pointer rests and it stays there — across a game
// boundary, a navigation, a disarm, the debugger detaching — for as long as the assistant is on and
// the session is alive. Exactly three things hide it: the switch going off (`Settings.enabled`, and
// `Shift+X` on this tab), `Settings.display.virtualCursor` going off, and the tab going away. And
// the next game's hand starts from the point the arrow is parked on, so the two never disagree.
import { afterEach, describe, expect, it } from "bun:test";
import type { PageBridge } from "@content/adapters/adapter";
import { createVirtualCursor, type Point } from "@content/virtual-cursor";
import { CDP } from "@core/constants/cdp";
import { CURSOR_UNLOCK } from "@core/constants/cursor";
import type { GamePortCommand } from "@core/constants/messages";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import type { Rect } from "@core/motor/types";
import { COMMAND_NAMES } from "@service/game-session/session";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

type CursorCmd = Extract<GamePortCommand, { kind: "cursorTo" } | { kind: "cursorHide" }>;

const mirror = (): CursorCmd[] =>
	h.commands().filter((c): c is CursorCmd => c.kind === "cursorTo" || c.kind === "cursorHide");

const hides = (): number => mirror().filter((c) => c.kind === "cursorHide").length;

const positions = (): Array<[number, number, boolean]> =>
	mirror()
		.filter((c): c is Extract<CursorCmd, { kind: "cursorTo" }> => c.kind === "cursorTo")
		.map((c) => [c.x, c.y, c.down]);

/** What the hand actually told the page, in order: `Input.dispatchMouseEvent` x/y + button state. */
const dispatched = (): Array<[number, number, boolean]> =>
	h.sim.debugger.commands
		.filter((c) => c.method === CDP.inputDispatchMouseEvent)
		.map((c) => {
			const p = (c.params ?? {}) as { x: number; y: number; buttons: number };
			return [p.x, p.y, (p.buttons & CDP.mouse.leftButtons) !== 0] as [number, number, boolean];
		});

const within = (p: [number, number, boolean] | undefined, r: Rect): boolean =>
	p !== undefined &&
	p[0] >= r.left &&
	p[0] <= r.left + r.width &&
	p[1] >= r.top &&
	p[1] <= r.top + r.height;

const distance = (a: [number, number, boolean], b: [number, number, boolean]): number =>
	Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Arm the hand and let it play the move it is given. */
async function playOneMove(): Promise<void> {
	await h.sw.run(() => h.session().command("armAutoMove"));
	await h.arrive();
	expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
		true
	);
	expect(h.site.board.lastMove()?.byMe).toBe(true);
}

/** The opponent replies and the hand plays our next move. */
async function playNextMove(reply: string): Promise<void> {
	const ply = h.session().view().ply;
	await h.arrive(reply);
	expect(await h.until(() => h.session().view().ply > ply, 10_000)).toBe(true);
	expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
		true
	);
	expect(h.site.board.lastMove()?.byMe).toBe(true);
}

describe("game session: the pointer mirror follows what the hand dispatched", () => {
	it("posts exactly the dispatched sequence and parks on the last point", async () => {
		// Every committed move is a drag (click-to-move was removed), so the press/release
		// pair below is the drag's and needs no setting to pin it.
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();

		const sent = positions();
		expect(sent.length).toBeGreaterThan(8);
		// not a plan and not a sample: every point the page was told, in order
		expect(sent).toEqual(dispatched());
		// the press and release are reflected, so the mirror dips exactly while the piece is held
		expect(sent.some(([, , down]) => down)).toBe(true);
		expect(sent.at(-1)?.[2]).toBe(false);
		// it parks where the pointer is: the last post is the last dispatch, and nothing hid it
		expect(sent.at(-1)).toEqual(dispatched().at(-1));
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		// Viewport CSS px end to end, and that is checkable rather than assertable: the page reports
		// its rects from `getBoundingClientRect()`, the hand aims at the centre of those rects, and
		// the mirror carries the coordinate the CDP command carried. So the press must land inside
		// the from-square the *page itself* reports and the release inside the to-square — which it
		// could not if anything in the chain converted between spaces.
		const last = h.site.board.lastMove();
		if (!last) throw new Error("no move was played");
		const lastDown = sent.reduce((acc, p, i) => (p[2] ? i : acc), -1);
		expect(lastDown).toBeGreaterThan(0);
		expect(
			within(
				sent.find(([, , down]) => down),
				h.site.board.squareRect(last.from)
			)
		).toBe(true);
		expect(within(sent[lastDown + 1], h.site.board.squareRect(last.to))).toBe(true);
	});

	/**
	 * The owner's 2026-09-13 request, end to end: the game ends, the debugger goes (it may detach
	 * between games — the auto-queue and the panel both do that), a new game starts, and the arrow
	 * was never hidden. And the two halves agree: the next game's first dispatched point continues
	 * from the point the arrow is parked on — within one hand step (`TELEMETRY_BANDS.pointer`), the
	 * same continuity the telemetry suite holds *inside* a game — because `HandOwnership.position`
	 * survives the boundary and `MoveExecutor.arm` starts from it while the mirror is up.
	 */
	it("keeps the mirror parked across a game boundary, and the next hand starts where it is parked", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		const parked = positions().at(-1);
		if (!parked) throw new Error("nothing was mirrored");
		const before = positions().length;

		await h.drive(() => h.site.endGame("1-0"));
		expect(await h.until(() => h.session().currentState() === "game-over", 5_000)).toBe(true);
		expect(hides()).toBe(0);
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		// A routine detach preserves saved intent; an explicit user cancel turns auto-play off.
		await h.drive(() => h.debuggerManager.detach(h.tabId));
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
		expect(hides()).toBe(0);
		// a quiet stretch: still parked
		await h.advance(5_000);
		expect(hides()).toBe(0);
		expect(positions().length).toBe(before);

		// the next game: `automation.autoMove` re-arms (re-attaches) before its first position
		await h.drive(() => h.site.startGame({ gameId: "second-game" }));
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		await playNextMove("e7e5");

		expect(hides()).toBe(0);
		const next = positions();
		expect(next.length).toBeGreaterThan(before + 8);
		// the whole stream is still exactly what was dispatched, game boundary included
		expect(next).toEqual(dispatched());
		// and the first point of the new game continues from the parked one
		const first = next[before];
		if (!first) throw new Error("the new game dispatched nothing");
		expect(distance(first, parked)).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.maxStepPx);
	});

	/**
	 * The disarm half of the same agreement. The arrow stays after a disarm, and a re-arm starts the
	 * hand from it — not from a real pointer sample that arrived in between, which is what `arm()`
	 * used to prefer. While the mirror is on the page the shield keeps the real pointer off it, so
	 * the arrow *is* the pointer the owner sees; a hand that started anywhere else would teleport.
	 */
	it("after a disarm the arrow stays, and a re-arm starts from it rather than from a real sample", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		const parked = positions().at(-1);
		if (!parked) throw new Error("nothing was mirrored");
		const before = positions().length;

		await h.sw.run(() => h.session().command("disarm"));
		expect(h.executor()?.isArmed()).toBe(false);
		expect(hides()).toBe(0);
		expect(mirror().at(-1)?.kind).toBe("cursorTo");

		// a fresh real pointer sample, far from the arrow, while the hand is not armed
		const far: [number, number, boolean] = [parked[0] > 400 ? 5 : 1200, 5, false];
		await h.drive(() =>
			h.site.post({ kind: "cursor", x: far[0], y: far[1], t: h.sim.now(), real: true })
		);
		await h.sw.run(() => h.session().command("armAutoMove"));
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		await playNextMove("e7e5");

		expect(hides()).toBe(0);
		const first = positions()[before];
		if (!first) throw new Error("the re-armed hand dispatched nothing");
		expect(distance(first, parked)).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.maxStepPx);
		expect(distance(first, far)).toBeGreaterThan(TELEMETRY_BANDS.pointer.maxStepPx);
	});

	it("keeps the mirror when the hand is disarmed", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");

		await h.sw.run(() => h.session().command("disarm"));
		expect(hides()).toBe(0);
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
	});

	/**
	 * The property that matters, and the one an earlier revision of this file got wrong by asserting
	 * "and only once": the hide must NOT depend on what this service worker believes is on screen.
	 * The element lives in the page and the content script's own `drawn` flag outlives the worker,
	 * so a session that has drawn nothing — a fresh session after the worker was suspended and
	 * woken — is precisely the case that has to erase what a previous one left. Deduplication
	 * belongs one layer down, in the relay, where the flag and the element share a lifetime
	 * (`test/content/virtual-cursor.test.ts`, "hides only what it drew, and only once").
	 *
	 * 2026-09-13: and it is posted on the three hide reasons *only*. A disarm, a navigation and a
	 * game ending post nothing — the arrow stays parked through all of them.
	 */
	it("posts a hide on each of the three hide reasons — and on nothing else — even though this session drew nothing", async () => {
		h = await createGameHarness();
		expect(positions()).toEqual([]);
		let n = hides();
		const stopped = async (label: string, gesture: () => Promise<unknown>): Promise<void> => {
			await gesture();
			if (hides() <= n) throw new Error(`no cursorHide posted after ${label}`);
			n = hides();
		};
		const kept = async (label: string, gesture: () => Promise<unknown>): Promise<void> => {
			await gesture();
			if (hides() !== n) throw new Error(`a cursorHide was posted after ${label}`);
		};
		await kept("disarm", () => h.sw.run(() => h.session().command("disarm")));
		await kept("a navigation", () => h.drive(() => h.session().onTabEvent("navigated")));
		// Above the `apply("gameEnded")` guard once, for the hide; now there is no hide to guard.
		await kept("game over", () => h.drive(() => h.session().onGameEnded("1-0")));
		await stopped("Shift+X", () => h.drive(() => h.session().command("disable")));
		await stopped("the setting going off", () => h.patch({ display: { virtualCursor: false } }));
		await stopped("the switch going off", () => h.patch({ enabled: false }));
		expect(n).toBe(3);
	});

	it("a session that replaced an evicted one still erases the arrow the old one drew", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		const drawn = positions().length;
		expect(drawn).toBeGreaterThan(0);

		// Chrome suspending the worker does not call `dispose()`: the session object simply goes,
		// and the tab's content script (which reconnects rather than reboots) still has the element.
		const evicted = h.session();
		await h.sw.run(() => {
			(h.registry as unknown as { sessions: Map<number, unknown> }).sessions.delete(h.tabId);
			h.registry.ensure(h.tabId);
		});
		expect(h.session()).not.toBe(evicted);
		expect(hides()).toBe(0);

		await h.drive(() => h.session().command("disable"));
		expect(hides()).toBeGreaterThan(0);
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});

	it("`Shift+X` — the owner's only in-game stop gesture (§13.4) — hides the mirror", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		// through the real `chrome.commands` name, the way the shortcut arrives
		await h.drive(() => h.session().onCommand(COMMAND_NAMES.disableAssistant));
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});

	it("disposing the session (the tab going away) hides the mirror", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.drive(() => h.session().dispose());
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});

	/**
	 * The infobar's Cancel. §13.4 forbids re-attaching mid-game, so after a Cancel the hand owns no
	 * pointer until explicitly re-armed. The single auto-play switch also clears the saved
	 * preference. The arrow stays; a detach is not one of the three hide reasons.
	 */
	it("a user-cancelled debugger leaves the mirror parked", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
		await h.drive(() => h.sim.debugger.detachByUser(h.tabId));
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
		expect(h.settings().automation.autoMove).toBe(false);
		expect(hides()).toBe(0);
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
	});

	it("hides the mirror when the assistant is switched off (§4.4)", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.patch({ enabled: false });
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});

	it("hides an already-drawn mirror the moment the setting goes off", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		const drawn = positions().length;
		expect(drawn).toBeGreaterThan(0);

		await h.patch({ display: { virtualCursor: false } });
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
		// and nothing of it comes back on the next move
		await h.arrive("e7e5");
		expect(await h.until(() => h.session().view().ply >= 2, 10_000)).toBe(true);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(positions().length).toBe(drawn);
	});

	it("posts nothing at all while the setting is off, though the hand still plays", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true }, display: { virtualCursor: false } },
		});
		await playOneMove();
		expect(dispatched().length).toBeGreaterThan(8);
		expect(mirror()).toEqual([]);
	});

	it("keeps the mirror when the game ends", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.drive(() => h.session().onGameEnded("1-0"));
		expect(hides()).toBe(0);
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
	});

	it("keeps the mirror when the tab navigates (the route changes between every two games)", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.drive(() => h.session().onTabEvent("navigated"));
		expect(hides()).toBe(0);
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
	});

	it("hides the mirror when the tab is removed", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.drive(() => h.session().onTabEvent("tabRemoved"));
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});
});

/**
 * The simulated site runs the tracker and the keybinds but not the relay, so the page side here is
 * the real `createVirtualCursor` fed from the harness's command hook, drawing into a recording
 * bridge and running on the simulator's clock. What it draws is what the page would see.
 */
interface RecordingBridge extends PageBridge {
	sent: Array<{ kind: string; payload: unknown }>;
}
function recordingBridge(): RecordingBridge {
	const sent: RecordingBridge["sent"] = [];
	return {
		sent,
		isAvailable: () => true,
		call: <T>() => Promise.resolve(true as T),
		on: () => () => {},
		notify: (kind, payload) => {
			sent.push({ kind, payload });
		},
	};
}
const drawnPoints = (bridge: RecordingBridge): Point[] =>
	bridge.sent
		.filter((s) => s.kind === "cursorTo")
		.map((s) => {
			const p = s.payload as { x: number; y: number };
			return { x: p.x, y: p.y };
		});
const GLIDE_STEPS = Math.ceil(CURSOR_UNLOCK.glideMs / CURSOR_UNLOCK.stepMs);

/**
 * The owner's 2026-09-13 requests, end to end. Locked → unlocked is a *motion*: the worker's
 * `cursorHide` reaches the page as a glide of the arrow to the real mouse — drawing only, no CDP
 * dispatch — and the element goes only when it gets there. And a tab that is not on a game page is
 * never handed the pointer: the worker announces no ownership to it, and the content gate (held in
 * `test/content/index.test.ts`) would refuse one anyway.
 */
describe("game session: the unlock glide and the page-kind gate (2026-09-13)", () => {
	it("an unlock glides the arrow from its parked point to the real mouse before the hide", async () => {
		const bridge = recordingBridge();
		let real: Point | null = null;
		const relay = createVirtualCursor(bridge, { realPosition: () => real });
		h = await createGameHarness({
			settings: { automation: { autoMove: true } },
			onCommand: (cmd) => void relay.apply(cmd),
		});
		await playOneMove();
		const parked = positions().at(-1);
		if (!parked) throw new Error("nothing was mirrored");
		// the relay drew exactly the dispatched stream
		expect(drawnPoints(bridge)).toEqual(positions().map(([x, y]) => ({ x, y })));
		expect(relay.shown()).toBe(true);
		const drawnBefore = drawnPoints(bridge).length;
		const dispatchedBefore = dispatched().length;

		// the owner's real mouse is far from the arrow (under the shield, it moved freely)
		real = { x: parked[0] > 400 ? 5 : 1200, y: 5 };
		// the switch goes off: one of the three hide reasons
		await h.patch({ enabled: false });
		expect(hides()).toBe(1);
		// the page has not erased anything yet: the arrow is on its way to the mouse
		expect(relay.shown()).toBe(true);
		expect(relay.gliding()).toBe(true);
		expect(bridge.sent.some((s) => s.kind === "cursorHide")).toBe(false);

		expect(await h.until(() => !relay.shown(), CURSOR_UNLOCK.glideMs * 4, CURSOR_UNLOCK.stepMs)).toBe(
			true
		);
		const glide = drawnPoints(bridge).slice(drawnBefore);
		expect(glide).toHaveLength(GLIDE_STEPS);
		expect(glide[0]).not.toEqual({ x: parked[0], y: parked[1] });
		expect(glide.at(-1)).toEqual(real);
		// every glide point lies between the parked point and the mouse, in order
		for (let i = 1; i < glide.length; i += 1) {
			const a = glide[i - 1];
			const b = glide[i];
			if (!a || !b) throw new Error("missing point");
			expect(Math.hypot(real.x - b.x, real.y - b.y)).toBeLessThanOrEqual(
				Math.hypot(real.x - a.x, real.y - a.y)
			);
		}
		// then, and only then, the element goes
		expect(bridge.sent.at(-1)?.kind).toBe("cursorHide");
		expect(bridge.sent.filter((s) => s.kind === "cursorHide")).toHaveLength(1);
		// drawing only: the glide dispatched no input and the worker sent no further point
		expect(dispatched()).toHaveLength(dispatchedBefore);
		expect(positions()).toHaveLength(drawnBefore);
		relay.dispose();
	});

	it("a tab that is not on a game page is never handed the pointer", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		const owned = (): boolean | undefined =>
			h
				.commands()
				.filter(
					(c): c is Extract<GamePortCommand, { kind: "inputOwnership" }> => c.kind === "inputOwnership"
				)
				.at(-1)?.owned;
		expect(owned()).toBe(true);

		// the tab moves to the analysis board (SPA navigation: the content script re-sends hello)
		await h.drive(() => h.site.hello("analysis"));
		expect(owned()).toBe(false);
		// the hand is released outright there (page admission is part of `mayAct`), and an arm
		// request on that page is refused: nothing is armed, nothing is announced
		expect(h.executor()?.isArmed()).toBe(false);
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.advance(1_000);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(owned()).toBe(false);
		// and the tab coming back to a game page gets the standing arm back, announced again
		await h.drive(() => h.site.hello("live-game"));
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(owned()).toBe(true);
	});
});
