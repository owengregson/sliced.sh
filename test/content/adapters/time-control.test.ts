// test/content/adapters/time-control.test.ts
/**
 * §4.3: the game's own time control, read from the page.
 *
 * This is the seam every harness used to supply for free: no adapter ever set
 * `PositionSnapshot.timeControl`, so every game in production conditioned as
 * `untimed` while every test injected a class the adapters could not produce.
 * These cases assert against what the **page** supplies — chess.com's own
 * `{baseTime, increment}` object, as the MAIN-world bridge hands it over — and
 * never against a value the test puts on the snapshot.
 *
 * Ground truth (owner's live capture, 2026-09-09): a 3-minute game answers
 * `{"baseTime":180000,"increment":0}`, so `baseTime` is in MILLISECONDS, and the
 * whole object is `null` until the game actually starts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AdapterPositionSnapshot, SiteAdapter } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { timeControlFromBridge } from "@content/adapters/time-control";
import { TIMINGS } from "@core/constants";
import { installWindowGlobals, type LayoutRect } from "@test/sim/dom/tab-dom";
import { FakeBridge, loadFixture, pageDocument, pageWindow, sleep, waitFor } from "./helpers";

/** The owner's live capture: a WebGL board, `/game/<digits>`, clocks rendered. */
const WEBGL_FEN = "rnbqkbnr/pp2pppp/2p5/8/4p3/3P1P2/PPP3PP/RNBQKBNR w KQkq - 0 4";
const WEBGL_RECT: LayoutRect = { x: 120, y: 80, width: 704, height: 704 };
const SETTLE = TIMINGS.adapterDebounceMs * 3;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

interface Booted {
	adapter: SiteAdapter;
	bridge: FakeBridge;
	positions: AdapterPositionSnapshot[];
}

function boot(state: () => Record<string, unknown>): Booted {
	const dom = loadFixture("chesscom-webgl");
	cleanups.push(installWindowGlobals(dom.window));
	const bridge = new FakeBridge();
	bridge.responses.set("getState", () => state());
	const adapter = createChesscomAdapter({
		document: pageDocument(dom),
		window: pageWindow(dom),
		bridge,
	});
	cleanups.push(() => adapter.destroy());
	dom.layout("wc-chess-board", WEBGL_RECT);
	const positions: AdapterPositionSnapshot[] = [];
	adapter.onPositionChange((s) => positions.push(s));
	return { adapter, bridge, positions };
}

describe("timeControlFromBridge", () => {
	it("reads chess.com's millisecond pair", () => {
		// the owner's capture, verbatim
		expect(timeControlFromBridge({ baseTime: 180_000, increment: 0 })).toEqual({
			baseMs: 180_000,
			incMs: 0,
		});
		expect(timeControlFromBridge({ baseTime: 600_000, increment: 5_000 })).toEqual({
			baseMs: 600_000,
			incMs: 5_000,
		});
		expect(timeControlFromBridge({ baseTime: 60_000, increment: 1_000 })).toEqual({
			baseMs: 60_000,
			incMs: 1_000,
		});
	});

	it("is null before the game starts, and on anything unusable", () => {
		// `timeControl.get()` answers null until the game actually starts
		expect(timeControlFromBridge(null)).toBeNull();
		expect(timeControlFromBridge(undefined)).toBeNull();
		expect(timeControlFromBridge({})).toBeNull();
		expect(timeControlFromBridge({ baseTime: 0, increment: 0 })).toBeNull();
		expect(timeControlFromBridge({ baseTime: "180000" })).toBeNull();
		expect(timeControlFromBridge({ baseTime: Number.NaN })).toBeNull();
		expect(timeControlFromBridge({ baseTime: -1 })).toBeNull();
		// beyond a day it is not a clock in either unit
		expect(timeControlFromBridge({ baseTime: 99_999_999_999 })).toBeNull();
	});

	it("catches a seconds-reported base the magnitude test cannot see, using the page's clock", () => {
		// A 30-minute game reported in seconds is `1800`, which clears `minPlausibleMs` and would
		// read as a 1.8 s base: `base_eff` 1.8 s, every cap at 0.9 s, every move in the §8.5
		// emergency regime. The clock the page is showing is what gives it away.
		expect(timeControlFromBridge({ baseTime: 1_800, increment: 0 }, 1_800_000)).toEqual({
			baseMs: 1_800_000,
			incMs: 0,
		});
		// A seconds-reported pair *with* an increment is caught by the pair witness, which needs no
		// clock at all: no real control starts with less time than it hands back per move, so a base
		// below the rescaled increment proves both fields are seconds. 20+10 and 30+30 both land.
		expect(timeControlFromBridge({ baseTime: 1_200, increment: 10 }, 1_200_000)).toEqual({
			baseMs: 1_200_000,
			incMs: 10_000,
		});
		expect(timeControlFromBridge({ baseTime: 1_200, increment: 10 })).toEqual({
			baseMs: 1_200_000,
			incMs: 10_000,
		});
		expect(timeControlFromBridge({ baseTime: 1_800, increment: 30 })).toEqual({
			baseMs: 1_800_000,
			incMs: 30_000,
		});
		// …and it cannot fire on a genuine mixed pair: 3+2 reported as ms base + s increment has a
		// base far above the rescaled increment, so only the increment is touched.
		expect(timeControlFromBridge({ baseTime: 180_000, increment: 2 })).toEqual({
			baseMs: 180_000,
			incMs: 2_000,
		});
		// …and with no increment the same game is caught outright
		expect(timeControlFromBridge({ baseTime: 1_200, increment: 0 }, 1_200_000)).toEqual({
			baseMs: 1_200_000,
			incMs: 0,
		});
		// A stale clock from the previous game is not admissible evidence: at >= 100x a no-increment
		// base it would reproduce the very failure this witness exists to prevent.
		expect(timeControlFromBridge({ baseTime: 60_000, increment: 0 }, 7_200_000)).toEqual({
			baseMs: 60_000,
			incMs: 0,
		});
		expect(timeControlFromBridge({ baseTime: 600_000, increment: 0 }, 86_400_000)).toEqual({
			baseMs: 600_000,
			incMs: 0,
		});
		// The increment-heavy controls that made the first version of this check WORSE than the bug
		// it fixed: with an increment, a clock can outgrow any multiple of its base by being played,
		// so the clock carries no information about the unit and must not be consulted at all.
		// `{60_000, 60_000}` with a 601 s clock used to read as 16.7 HOURS — a one-minute game,
		// under `maxPlausibleMs` so nothing dropped it, with `tcClass` flipping to classical.
		expect(timeControlFromBridge({ baseTime: 60_000, increment: 60_000 }, 601_000)).toEqual({
			baseMs: 60_000,
			incMs: 60_000,
		});
		expect(timeControlFromBridge({ baseTime: 60_000, increment: 30_000 }, 900_000)).toEqual({
			baseMs: 60_000,
			incMs: 30_000,
		});
		// …and the same pair at the start of the game, where the clock is the base
		expect(timeControlFromBridge({ baseTime: 60_000, increment: 60_000 }, 60_000)).toEqual({
			baseMs: 60_000,
			incMs: 60_000,
		});
		// …and with no clock showing, or a clock consistent with the base, the reading stands as ms.
		expect(timeControlFromBridge({ baseTime: 1_800, increment: 0 })).toEqual({
			baseMs: 1_800,
			incMs: 0,
		});
		expect(timeControlFromBridge({ baseTime: 180_000, increment: 0 }, 180_000)).toEqual({
			baseMs: 180_000,
			incMs: 0,
		});
		// a mid-game clock is far *smaller* than the base: that must never trip the guard
		expect(timeControlFromBridge({ baseTime: 180_000, increment: 0 }, 4_000)).toEqual({
			baseMs: 180_000,
			incMs: 0,
		});
	});

	it("guards the implausible unit rather than planning with a 2 ms increment", () => {
		// The increment's unit is UNCONFIRMED (0 in the only sample). chess.com's increments are
		// whole seconds, so a nonzero value under a second cannot be milliseconds: read as seconds.
		expect(timeControlFromBridge({ baseTime: 180_000, increment: 2 })).toEqual({
			baseMs: 180_000,
			incMs: 2_000,
		});
		// …and the same guard on the base, so a unit change cannot turn 3 minutes into 180 ms
		// (which would be a 0.18 s `base_eff`: every move in the emergency regime).
		expect(timeControlFromBridge({ baseTime: 180, increment: 0 })).toEqual({
			baseMs: 180_000,
			incMs: 0,
		});
	});
});

describe("ChessComAdapter — the time control comes from the page", () => {
	it("maps the site's own pair onto the snapshot", async () => {
		const { adapter, positions } = boot(() => ({
			fen: WEBGL_FEN,
			playingAs: 1,
			mode: "playing",
			timeControl: { baseTime: 180_000, increment: 0 },
		}));
		await waitFor(() => adapter.getTimeControl() !== null);
		expect(adapter.getTimeControl()).toEqual({ baseMs: 180_000, incMs: 0 });
		const snapshot = adapter.readSnapshot();
		expect(snapshot?.timeControl).toEqual({ baseMs: 180_000, incMs: 0 });
		void positions;
	});

	it("has none while the game has not started, and republishes the unmoved position when it arrives", async () => {
		// The live capture: a game "not yet started" answers `null` while its clocks already read
		// the full base time. The position does not move while we wait for it — as white it cannot
		// — so the republish is the only way the first move is ever planned with a clock.
		let started = false;
		const { adapter, positions } = boot(() => ({
			fen: WEBGL_FEN,
			playingAs: 1,
			mode: "playing",
			...(started ? { timeControl: { baseTime: 60_000, increment: 0 } } : {}),
		}));
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.getTimeControl()).toBeNull();
		expect(adapter.readSnapshot()?.timeControl).toBeUndefined();
		const before = positions.length;

		started = true;
		// No DOM mutation and no bridge event: the adapter's own bounded re-ask is what notices.
		await waitFor(() => positions.length > before, 10_000);
		await sleep(SETTLE);
		const last = positions[positions.length - 1];
		expect(last?.timeControl).toEqual({ baseMs: 60_000, incMs: 0 });
		// …and the republished position is the same one, not a new ply.
		expect(last?.fen).toBe(WEBGL_FEN);
	});
});
