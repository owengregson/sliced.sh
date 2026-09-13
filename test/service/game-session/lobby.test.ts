// test/service/game-session/lobby.test.ts — the lobby hold's detector (owner, 2026-09-13: "dont
// lock the mouse on …/play/online/ (no other url) if both timers are locked at 3:00 or some other
// time and arent moving"). Pure: the URL flag, the ply, the opponent rating, the clock readings and
// the wall clock in; a verdict out. The session's wiring is `test/behavioral/game/lobby-hold.test.ts`.
import { describe, expect, it } from "bun:test";
import { LOBBY } from "@core/constants/lobby";
import {
	clockTicked,
	credibleClocks,
	isLobbyHold,
	type LobbyInput,
	LobbyTracker,
	lobbyVerdict,
} from "@service/game-session/lobby";

const T0 = 1_000_000;
const THREE = 180_000;

function input(over: Partial<LobbyInput> = {}): LobbyInput {
	return {
		lobby: true,
		clocks: { w: THREE, b: THREE },
		now: T0,
		...over,
	};
}

describe("lobbyVerdict (pure)", () => {
	const first = { w: THREE, b: THREE, at: T0 };

	it("is `none` only off the lobby path — a clock that runs is the sole other way out", () => {
		expect(lobbyVerdict(input({ lobby: false }), first)).toBe("none");
		expect(lobbyVerdict(input({ lobby: false, now: T0 + 10_000 }), first)).toBe("none");
		// Neither an opponent nor a board with moves on it is evidence of play (owner, 2026-09-14):
		// the queue screen carries both — the previous opponent's card and the previous game's
		// position — so the detector takes neither as input at all.
		expect(Object.keys(input())).not.toContain("opponentRating");
		expect(Object.keys(input())).not.toContain("ply");
	});

	it("is `suspected` until the clocks have proven anything", () => {
		// no baseline yet
		expect(lobbyVerdict(input(), null)).toBe("suspected");
		// no position yet
		expect(lobbyVerdict(input({ clocks: null }), first)).toBe("suspected");
		// a clock component that has not rendered is not a reading
		expect(lobbyVerdict(input({ clocks: { w: 0, b: THREE } }), first)).toBe("suspected");
		expect(lobbyVerdict(input({ clocks: { w: THREE, b: 0 } }), first)).toBe("suspected");
		// inside the stillness window
		expect(lobbyVerdict(input({ now: T0 + LOBBY.clockStillMs - 1 }), first)).toBe("suspected");
	});

	it("is `held` once both clocks have stayed put for `LOBBY.clockStillMs`", () => {
		expect(lobbyVerdict(input({ now: T0 + LOBBY.clockStillMs }), first)).toBe("held");
		expect(lobbyVerdict(input({ now: T0 + 60_000 }), first)).toBe("held");
		// the window is a parameter
		expect(lobbyVerdict(input({ now: T0 + 500 }), first, 500)).toBe("held");
	});

	it("is `released` on a tick: one clock down, the other unchanged — either side", () => {
		expect(lobbyVerdict(input({ clocks: { w: THREE - 100, b: THREE } }), first)).toBe("released");
		expect(lobbyVerdict(input({ clocks: { w: THREE, b: THREE - 100 } }), first)).toBe("released");
		// a tick releases at once, stillness window or not
		expect(
			lobbyVerdict(input({ clocks: { w: THREE - 100, b: THREE }, now: T0 + 60_000 }), first)
		).toBe("released");
	});

	it("does not release on the lobby's own time-control selector (both clocks change, or one goes up)", () => {
		const five = { w: 300_000, b: 300_000 };
		expect(lobbyVerdict(input({ clocks: five, now: T0 + 60_000 }), first)).toBe("suspected");
		const one = { w: 60_000, b: 60_000 };
		expect(lobbyVerdict(input({ clocks: one, now: T0 + 60_000 }), first)).toBe("suspected");
		expect(lobbyVerdict(input({ clocks: { w: THREE + 1, b: THREE } }), first)).toBe("suspected");
	});

	it("names the hold verdicts", () => {
		expect(isLobbyHold("suspected")).toBe(true);
		expect(isLobbyHold("held")).toBe(true);
		expect(isLobbyHold("none")).toBe(false);
		expect(isLobbyHold("released")).toBe(false);
	});

	it("helpers: credible readings and ticks", () => {
		expect(credibleClocks(null)).toBe(false);
		expect(credibleClocks({ w: 0, b: 0 })).toBe(false);
		expect(credibleClocks({ w: 1, b: 1 })).toBe(true);
		expect(clockTicked(first, { w: THREE - 1, b: THREE })).toBe(true);
		expect(clockTicked(first, { w: THREE, b: THREE })).toBe(false);
		// both down together is a selector, not a running clock
		expect(clockTicked(first, { w: THREE - 1, b: THREE - 1 })).toBe(false);
	});
});

describe("LobbyTracker (the baseline)", () => {
	it("takes the first credible reading as the baseline and confirms after the window", () => {
		const t = new LobbyTracker();
		expect(t.stillDueIn(T0)).toBeNull();
		expect(t.observe(input({ clocks: null }))).toBe("suspected");
		expect(t.stillDueIn(T0)).toBeNull(); // nothing credible yet
		expect(t.observe(input({ clocks: { w: 0, b: 0 } }))).toBe("suspected");
		expect(t.stillDueIn(T0)).toBeNull();
		expect(t.observe(input())).toBe("suspected");
		expect(t.stillDueIn(T0)).toBe(LOBBY.clockStillMs);
		expect(t.stillDueIn(T0 + 400)).toBe(LOBBY.clockStillMs - 400);
		expect(t.verdict(input({ now: T0 + LOBBY.clockStillMs - 1 }))).toBe("suspected");
		expect(t.verdict(input({ now: T0 + LOBBY.clockStillMs }))).toBe("held");
		expect(t.stillDueIn(T0 + 60_000)).toBe(0);
	});

	it("`verdict` records nothing; `observe` does", () => {
		const t = new LobbyTracker();
		expect(t.verdict(input())).toBe("suspected");
		expect(t.stillDueIn(T0)).toBeNull();
		t.observe(input());
		expect(t.stillDueIn(T0)).toBe(LOBBY.clockStillMs);
	});

	it("a selector change moves the baseline; a tick releases against it", () => {
		const t = new LobbyTracker(1_000);
		t.observe(input());
		// 3 min → 5 min at +800 ms: not a tick, and the stillness starts over from here
		const five = { w: 300_000, b: 300_000 };
		expect(t.observe(input({ clocks: five, now: T0 + 800 }))).toBe("suspected");
		expect(t.verdict(input({ clocks: five, now: T0 + 1_000 }))).toBe("suspected");
		expect(t.verdict(input({ clocks: five, now: T0 + 1_800 }))).toBe("held");
		// the game starts on 5 min: white's clock runs
		expect(t.observe(input({ clocks: { w: 299_900, b: 300_000 }, now: T0 + 2_000 }))).toBe(
			"released"
		);
	});

	it("`reset` forgets the baseline for the next board", () => {
		const t = new LobbyTracker();
		t.observe(input());
		t.reset();
		expect(t.stillDueIn(T0 + 60_000)).toBeNull();
		expect(t.verdict(input({ now: T0 + 60_000 }))).toBe("suspected");
	});

	it("another URL is `none` whatever the baseline says", () => {
		const t = new LobbyTracker();
		t.observe(input());
		expect(t.observe(input({ lobby: false, now: T0 + 60_000 }))).toBe("none");
	});

	it("measures the stillness on the lobby path only: off it the baseline is dropped", () => {
		const t = new LobbyTracker();
		// a real game's unmoved ply 0, for a long time
		expect(t.observe(input({ lobby: false }))).toBe("none");
		expect(t.stillDueIn(T0)).toBeNull();
		// the URL becomes the lobby: the clocks have to prove still from *here*
		expect(t.observe(input({ now: T0 + 60_000 }))).toBe("suspected");
		expect(t.verdict(input({ now: T0 + 60_000 + LOBBY.clockStillMs - 1 }))).toBe("suspected");
		expect(t.verdict(input({ now: T0 + 60_000 + LOBBY.clockStillMs }))).toBe("held");
	});
});
