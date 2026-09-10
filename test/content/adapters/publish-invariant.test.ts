// test/content/adapters/publish-invariant.test.ts — Fix B, round 1 (review M-2).
/**
 * The brief states the turn invariant as a property of **every published `PositionSnapshot`**, not of
 * one adapter's reading: `sideToMove` is the turn field of the `fen` beside it. `ChessComAdapter`
 * settles it as it reads (where the dedupe key is built from the same value), but the place every
 * snapshot actually passes through is `AdapterBase` — `readSnapshot()`, `prime()` and `apply()` — so
 * that is where an adapter which gets it wrong has to be stopped.
 *
 * This drives the base through a subclass that deliberately publishes the contradiction, which is
 * exactly the shape the invariant exists to catch: the two fields come from different ladders, and
 * `GameSession.myTurn` reads one while every search, plan and mark downstream reads the other.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AdapterPositionSnapshot, AdapterReading } from "@content/adapters/adapter";
import { ChessComAdapter } from "@content/adapters/chesscom";
import { turnFieldOf } from "@core/chess/fen";
import { installWindowGlobals, type LayoutRect } from "@test/sim/dom/tab-dom";
import type { Color } from "@typedefs/game";
import { FakeBridge, loadFixture, pageDocument, pageWindow, sleep, waitFor } from "./helpers";

/** After 1.e4 c6 2.d3 d5 3.f3 dxe4 — white to move (the capture's own FEN). */
const WEBGL_FEN = "rnbqkbnr/pp2pppp/2p5/8/4p3/3P1P2/PPP3PP/RNBQKBNR w KQkq - 0 4";
/** After 4.dxe4 — black to move. */
const AFTER_DXE4 = "rnbqkbnr/pp2pppp/2p5/8/4P3/5P2/PPP3PP/RNBQKBNR b KQkq - 0 4";
const WEBGL_RECT: LayoutRect = { x: 120, y: 80, width: 704, height: 704 };

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

/** An adapter whose two ladders disagree: it publishes the opposite of its own FEN's turn. */
class ContradictingAdapter extends ChessComAdapter {
	protected override read(): AdapterReading | null {
		const reading = super.read();
		if (reading === null) return null;
		const sideToMove: Color = reading.snapshot.sideToMove === "w" ? "b" : "w";
		return {
			...reading,
			key: `${reading.key}-lying`,
			snapshot: { ...reading.snapshot, sideToMove },
		};
	}
}

function boot(state: () => Record<string, unknown>) {
	const dom = loadFixture("chesscom-webgl");
	cleanups.push(installWindowGlobals(dom.window));
	const bridge = new FakeBridge();
	bridge.responses.set("getState", () => state());
	const adapter = new ContradictingAdapter({
		document: pageDocument(dom),
		window: pageWindow(dom),
		bridge,
	});
	cleanups.push(() => adapter.destroy());
	dom.layout("wc-chess-board", WEBGL_RECT);
	return { dom, adapter, bridge };
}

describe("AdapterBase — no adapter can publish a sideToMove that contradicts its own FEN", () => {
	it("corrects the reading handed to readSnapshot()", async () => {
		let fen = WEBGL_FEN;
		const { adapter, bridge } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.readSnapshot()?.fen).toBe(WEBGL_FEN);
		expect(turnFieldOf(WEBGL_FEN)).toBe("w");
		expect(adapter.readSnapshot()?.sideToMove).toBe("w");
		// and the other way round, so the assertion is not passing by coincidence of the fixture
		fen = AFTER_DXE4;
		bridge.emit("move", { fen });
		await waitFor(() => adapter.readSnapshot()?.fen === AFTER_DXE4);
		expect(adapter.readSnapshot()?.sideToMove).toBe("b");
	});

	it("corrects what onPositionChange delivers, and the key still separates two positions", async () => {
		let fen = WEBGL_FEN;
		const { adapter, bridge } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
		await waitFor(() => adapter.readSnapshot() !== null);
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));

		fen = AFTER_DXE4;
		bridge.emit("move", { fen });
		await waitFor(() => seen.length > 0, 2_000);
		expect(seen.at(-1)?.fen).toBe(AFTER_DXE4);
		expect(seen.at(-1)?.sideToMove).toBe("b");
		// the corrected turn is appended to the subclass's key, so a position change is still a change
		fen = WEBGL_FEN;
		bridge.emit("move", { fen });
		await waitFor(() => seen.length > 1, 2_000);
		expect(seen.at(-1)?.fen).toBe(WEBGL_FEN);
		expect(seen.at(-1)?.sideToMove).toBe("w");
		await sleep(120);
	});
});
