// test/content/adapters/chesscom-webgl.test.ts
/**
 * chess.com's live board is rendered in WebGL on a canvas (the owner's first
 * live test, 2026-09-09): `wc-chess-board#board-single.board.board-webgl-2d`
 * whose only child is a `<canvas>`, ZERO `.piece` elements, ZERO
 * `div.element-pool`. Every other adapter fixture has DOM pieces, which is why
 * the whole pipeline could be dead on a real live game with a green suite.
 *
 * These tests pin the canvas path end to end: a snapshot from the bridge FEN,
 * change detection across a move, the bridge *request* (never the unsolicited
 * broadcast) as the position source, geometry + occupancy, `observeMove`, and
 * orientation in all four playingAs × flipped combinations — the mirror that
 * would make the hand click the wrong squares when playing black.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AdapterPositionSnapshot, SiteAdapter } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { occupancyOf } from "@content/board-state";
import { TIMINGS } from "@core/constants";
import { CHESS_START_FEN } from "@core/constants/chess";
import { installWindowGlobals, type LayoutRect, type TabDom } from "@test/sim/dom/tab-dom";
import type { Color } from "@typedefs/game";
import { FakeBridge, loadFixture, pageDocument, pageWindow, sleep, waitFor } from "./helpers";

/** The capture's FEN: after 1.e4 c6 2.d3 d5 3.f3 dxe4, white to move, ply 6. */
const WEBGL_FEN = "rnbqkbnr/pp2pppp/2p5/8/4p3/3P1P2/PPP3PP/RNBQKBNR w KQkq - 0 4";
/** After white's 4.dxe4 (the move the fixture's next row plays). */
const AFTER_DXE4 = "rnbqkbnr/pp2pppp/2p5/8/4P3/5P2/PPP3PP/RNBQKBNR b KQkq - 0 4";
const GAME_ID = "174252022572";
const SETTLE = TIMINGS.adapterDebounceMs * 3;

/** The capture's board: 704 px of 8 × 88 px squares. */
const WEBGL_RECT: LayoutRect = { x: 120, y: 80, width: 704, height: 704 };
const SQ = WEBGL_RECT.width / 8;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

interface Booted {
	dom: TabDom;
	adapter: SiteAdapter;
	bridge: FakeBridge;
}

/** The canvas fixture with a bridge answering `getState` from `state()`. */
function boot(state: () => Record<string, unknown> | null = () => ({ fen: WEBGL_FEN })): Booted {
	const dom = loadFixture("chesscom-webgl");
	cleanups.push(installWindowGlobals(dom.window));
	const bridge = new FakeBridge();
	bridge.responses.set("getState", () => state() ?? {});
	const adapter = createChesscomAdapter({
		document: pageDocument(dom),
		window: pageWindow(dom),
		bridge,
	});
	cleanups.push(() => adapter.destroy());
	dom.layout("wc-chess-board", WEBGL_RECT);
	return { dom, adapter, bridge };
}

/** Append white's 4.dxe4 to the move list — the only DOM evidence a canvas board gives. */
function pushDxe4(dom: TabDom): void {
	dom.document.querySelector(".node-highlight-content.selected")?.classList.remove("selected");
	dom
		.query(".timestamps-with-base-time")
		.insertAdjacentHTML(
			"beforeend",
			'<div class="main-line-row move-list-row dark-row" data-whole-move-number="4">4.' +
				'<div data-node="0-6" class="node white-move main-line-ply">' +
				'<span class="node-highlight-content selected">dxe4 </span></div></div>'
		);
}

describe("ChessComAdapter — WebGL canvas board (no DOM pieces)", () => {
	it("reads a snapshot from the bridge with zero pieces and zero element pool", async () => {
		const { dom, adapter } = boot();
		// the fixture is the captured shape, not a DOM board
		const board = dom.query("wc-chess-board#board-single");
		expect(board.classList.contains("board-webgl-2d")).toBe(true);
		expect(board.querySelectorAll(".piece").length).toBe(0);
		expect(board.querySelectorAll(".element-pool").length).toBe(0);
		expect(board.querySelectorAll("canvas").length).toBe(1);
		expect(adapter.getPlacement()).toBeNull();

		await waitFor(() => adapter.getFen() === WEBGL_FEN);
		expect(adapter.getPositionInfo()).toEqual({
			fen: WEBGL_FEN,
			approximate: false,
			source: "bridge",
		});
		const snapshot = adapter.readSnapshot();
		expect(snapshot).not.toBeNull();
		expect(snapshot?.fen).toBe(WEBGL_FEN);
		expect(snapshot?.ply).toBe(6);
		expect(snapshot?.sideToMove).toBe("w");
		expect(snapshot?.approximate).toBe(false);
		// `/game/<digits>` is the live game URL chess.com actually uses
		expect(snapshot?.gameId).toBe(GAME_ID);
	});

	it("an empty move list never proves the start position while the bridge is unanswered", () => {
		// Canvas board + bridge not yet ready + a rendered but empty move list. Requiring only
		// that the list element exists would publish the start position as a confident reading on
		// a mid-game board, and with highlights now on by default, draw on the wrong squares.
		const { dom, adapter } = boot(() => null);
		const list = dom.window.document.querySelector(".timestamps-with-base-time");
		if (list) list.innerHTML = "";
		expect(adapter.getPlacement()).toBeNull();
		expect(adapter.getPositionInfo()).toBeNull();
		expect(adapter.readSnapshot()).toBeNull();
	});

	it("detects a position change across a move with no piece elements", async () => {
		let fen = WEBGL_FEN;
		const { dom, adapter, bridge } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		await sleep(SETTLE);
		expect(seen.length).toBe(0);

		fen = AFTER_DXE4;
		bridge.emit("move", { fen });
		pushDxe4(dom);
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.fen).toBe(AFTER_DXE4);
		expect(seen[0]?.sideToMove).toBe("b");
		expect(seen[0]?.ply).toBe(7);
		expect(seen[0]?.myColor).toBe("w");
		expect(seen[0]?.lastMove).toEqual({ from: "d3", to: "e4", san: "dxe4" });
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
	});

	it("takes the position from the bridge request, not from an unsolicited broadcast", async () => {
		let fen = WEBGL_FEN;
		const { adapter, bridge } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		await sleep(SETTLE);

		// the page side announces a move but carries no FEN: the adapter must ask
		fen = AFTER_DXE4;
		bridge.emit("move", {});
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.fen).toBe(AFTER_DXE4);
		expect(bridge.callsOf("getState").length).toBeGreaterThan(1);
	});

	it("resolves geometry and occupancy for the position it publishes", async () => {
		const { adapter } = boot(() => ({ fen: WEBGL_FEN, mode: "playing", playingAs: 1 }));
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.readSnapshot()?.fen).toBe(WEBGL_FEN);
		expect(adapter.getBoardRect()).toMatchObject(WEBGL_RECT);
		expect(adapter.squareRect("a8")).toMatchObject({
			x: WEBGL_RECT.x,
			y: WEBGL_RECT.y,
			width: SQ,
			height: SQ,
		});
		expect(adapter.pointToSquare({ x: WEBGL_RECT.x + SQ / 2, y: WEBGL_RECT.y + SQ / 2 })).toBe("a8");
		// occupancy comes from the published FEN, not from `.piece` elements
		expect(occupancyOf(adapter, ["e1", "e4", "d5", "e8"])).toEqual({
			e1: "own",
			e4: "enemy",
			d5: "empty",
			e8: "enemy",
		});
	});

	it("observeMove confirms a landed move from the move list alone", async () => {
		const { dom, adapter } = boot(() => ({ fen: WEBGL_FEN, mode: "playing", playingAs: 1 }));
		await waitFor(() => adapter.getFen() === WEBGL_FEN);
		const landed = adapter.observeMove({ from: "d3", to: "e4" }, 800);
		await sleep(20);
		pushDxe4(dom);
		expect(await landed).toBe(true);
	});
	it("a fresh verification confirms an already completed capture from the current move list", async () => {
		let fen = WEBGL_FEN;
		const { dom, adapter } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
		await waitFor(() => adapter.getFen() === WEBGL_FEN);
		pushDxe4(dom);
		fen = AFTER_DXE4;
		expect(await adapter.observeMove({ from: "d3", to: "e4", beforeFen: WEBGL_FEN }, 100)).toBe(true);
	});
	it("rejects a prior game's stale move list and cached position when a fresh canvas reading says the move never happened", async () => {
		const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
		let fen = afterE4;
		const { dom, adapter, bridge } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
		dom.query(".timestamps-with-base-time").innerHTML =
			'<div class="main-line-row move-list-row" data-whole-move-number="1"><div data-node="0-0" class="node white-move main-line-ply"><span class="node-highlight-content selected">e4</span></div></div>';
		await waitFor(() => adapter.getFen() === afterE4);
		fen = CHESS_START_FEN;
		const reads = bridge.calls.filter((c) => c.kind === "getState").length;
		expect(await adapter.observeMove({ from: "e2", to: "e4", beforeFen: CHESS_START_FEN }, 100)).toBe(
			false
		);
		expect(bridge.calls.filter((c) => c.kind === "getState").length).toBeGreaterThan(reads);
	});
	it.each([
		{ label: "prior-game", fen: CHESS_START_FEN, accepted: false },
		{
			label: "current",
			fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3",
			accepted: true,
		},
	])(
		"compares full fresh FEN against $label knight-repetition history",
		async ({ fen, accepted }) => {
			const { dom, adapter } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
			dom.query(".timestamps-with-base-time").innerHTML =
				'<div class="main-line-row move-list-row" data-whole-move-number="1"><div data-node="0-0" class="node white-move main-line-ply"><span class="node-highlight-content">Nf3</span></div><div data-node="0-1" class="node black-move main-line-ply"><span class="node-highlight-content">Nf6</span></div></div><div class="main-line-row move-list-row" data-whole-move-number="2"><div data-node="0-2" class="node white-move main-line-ply"><span class="node-highlight-content">Ng1</span></div><div data-node="0-3" class="node black-move main-line-ply"><span class="node-highlight-content selected">Ng8</span></div></div>';
			await waitFor(() => adapter.getFen() === fen);
			expect(
				await adapter.observeMove({ from: "g1", to: "f3", beforeFen: CHESS_START_FEN }, 100)
			).toBe(accepted);
		}
	);
	it.each(["empty", "missing"])(
		"refreshes canvas bridge state to confirm an already completed move with a %s move list",
		async (list) => {
			let fen = WEBGL_FEN;
			const { dom, adapter } = boot(() => ({ fen, mode: "playing", playingAs: 1 }));
			dom.query(list === "empty" ? ".timestamps-with-base-time" : "wc-simple-move-list").remove();
			await waitFor(() => adapter.getFen() === WEBGL_FEN);
			fen = AFTER_DXE4;
			expect(await adapter.observeMove({ from: "d3", to: "e4", beforeFen: WEBGL_FEN }, 200)).toBe(
				true
			);
		}
	);
});

interface OrientationCase {
	playingAs: Color;
	/** `getOptions().flipped` — chess.com's own "black is at the bottom" flag. */
	flipped: boolean;
	note: string;
}

/**
 * Measured on live games: playing white is `playingAs 1 / flipped false`, playing
 * black is `playingAs 2 / flipped true` — so `flipped` means "the board is turned
 * round from white-at-bottom", exactly what `geometry.ts` means by it, and it
 * moves WITH a manual board flip rather than against it. `playingAs` must not
 * enter the orientation at all: combining them would mirror every square for the
 * side that is actually playing black.
 */
const ORIENTATIONS: OrientationCase[] = [
	{ playingAs: "w", flipped: false, note: "live capture, playing white" },
	{ playingAs: "b", flipped: true, note: "live capture, playing black" },
	{ playingAs: "w", flipped: true, note: "turned round while playing white" },
	{ playingAs: "b", flipped: false, note: "turned round while playing black" },
];

describe("ChessComAdapter — orientation on a canvas board", () => {
	for (const c of ORIENTATIONS) {
		it(`playingAs=${c.playingAs} flipped=${c.flipped} (${c.note})`, async () => {
			const { adapter } = boot(() => ({
				fen: WEBGL_FEN,
				mode: "playing",
				playingAs: c.playingAs === "w" ? 1 : 2,
				flipped: c.flipped,
			}));
			await waitFor(() => adapter.getFen() === WEBGL_FEN);
			expect(adapter.getMyColor()).toBe(c.playingAs);
			expect(adapter.isFlipped()).toBe(c.flipped);

			const topRight = { x: WEBGL_RECT.x + 7 * SQ, y: WEBGL_RECT.y };
			const bottomLeft = { x: WEBGL_RECT.x, y: WEBGL_RECT.y + 7 * SQ };
			// black at the bottom ⇒ a1 top-right, h8 bottom-left; white at the bottom ⇒ the reverse
			const a1 = c.flipped ? topRight : bottomLeft;
			const h8 = c.flipped ? bottomLeft : topRight;
			expect(adapter.squareRect("a1")).toMatchObject({ ...a1, width: SQ, height: SQ });
			expect(adapter.squareRect("h8")).toMatchObject({ ...h8, width: SQ, height: SQ });
			// the pixel the hand would aim at resolves back to the same square
			expect(adapter.squareToPoint("a1")).toEqual({ x: a1.x + SQ / 2, y: a1.y + SQ / 2 });
			expect(adapter.pointToSquare({ x: a1.x + SQ / 2, y: a1.y + SQ / 2 })).toBe("a1");
			expect(adapter.pointToSquare({ x: h8.x + SQ / 2, y: h8.y + SQ / 2 })).toBe("h8");
		});
	}

	/**
	 * `getFEN`, `getPlayingAs` and `getOptions().flipped` are three *independent* `safe(...)` reads of
	 * the same page object in the bridge, and `safe` answers `null` when one throws. So
	 * `getOptions()` failing while `getPlayingAs()` answers is a real shape: the colour is known and
	 * `flipped` is absent. Deriving the orientation from "white at the bottom" there mirrors every
	 * square — for the mark and for the hand — on exactly the side that is playing black.
	 */
	it("derives the orientation from the colour when the bridge reports no flipped flag", async () => {
		const dom = loadFixture("chesscom-webgl");
		for (const clock of dom.document.querySelectorAll(".clock-component")) clock.remove();
		cleanups.push(installWindowGlobals(dom.window));
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ fen: WEBGL_FEN, mode: "playing", playingAs: 2 }));
		const adapter = createChesscomAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
			bridge,
		});
		cleanups.push(() => adapter.destroy());
		dom.layout("wc-chess-board", WEBGL_RECT);
		await waitFor(() => adapter.getMyColor() === "b");
		expect(adapter.isFlipped()).toBe(true);
		// black at the bottom ⇒ a1 is top-right
		expect(adapter.squareRect("a1")).toMatchObject({
			x: WEBGL_RECT.x + 7 * SQ,
			y: WEBGL_RECT.y,
		});
		expect(
			adapter.pointToSquare({ x: WEBGL_RECT.x + 7 * SQ + SQ / 2, y: WEBGL_RECT.y + SQ / 2 })
		).toBe("a1");
	});

	it("falls back to the bottom clock's colour: the live panels carry none, the board no class", () => {
		const dom = loadFixture("chesscom-webgl");
		cleanups.push(installWindowGlobals(dom.window));
		const adapter = createChesscomAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
		});
		cleanups.push(() => adapter.destroy());
		// as captured: no `cc-user-block-white`/`-black` anywhere, no `flipped` class on the board
		expect(dom.document.querySelectorAll(".cc-user-block-white, .cc-user-block-black").length).toBe(
			0
		);
		expect(dom.query("wc-chess-board").classList.contains("flipped")).toBe(false);
		expect(adapter.isFlipped()).toBe(false);
		expect(adapter.getMyColor()).toBe("w");
		// playing black: the board is turned round and the clocks swap with it
		dom.query(".clock-bottom").setAttribute("class", "clock-component clock-bottom clock-black");
		dom.query(".clock-top").setAttribute("class", "clock-component clock-top clock-white");
		expect(adapter.isFlipped()).toBe(true);
		expect(adapter.getMyColor()).toBe("b");
	});
});

/**
 * The window the owner's first live game opened in: the MAIN-world bridge has
 * not answered yet AND the clock components are not in the DOM yet, so there is
 * no colour evidence at all. The live player panel carries no colour class
 * (asserted above), the WebGL board carries no `flipped` class, and the clocks
 * are the only DOM source there is — so the honest answer is `null`.
 *
 * Guessing white here is what made the extension predict for the opponent on a
 * real account (owner's live test, 2026-09-09): predicting for the wrong side is
 * strictly worse than predicting nothing.
 */
describe("ChessComAdapter — the colour is never guessed", () => {
	/** The live page before the clock components render: no colour evidence anywhere. */
	function bootWithoutColourEvidence(state: () => Record<string, unknown> | null = () => null): {
		dom: TabDom;
		adapter: SiteAdapter;
		bridge: FakeBridge;
	} {
		const dom = loadFixture("chesscom-webgl");
		for (const clock of dom.document.querySelectorAll(".clock-component")) clock.remove();
		cleanups.push(installWindowGlobals(dom.window));
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => state() ?? {});
		const adapter = createChesscomAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
			bridge,
		});
		cleanups.push(() => adapter.destroy());
		dom.layout("wc-chess-board", WEBGL_RECT);
		return { dom, adapter, bridge };
	}

	it("no bridge answer and no clocks: getMyColor() is null, not white", async () => {
		const { dom, adapter } = bootWithoutColourEvidence();
		// exactly the live page's evidence: no panel colour class, no board class, no clocks
		expect(dom.document.querySelectorAll(".cc-user-block-white, .cc-user-block-black").length).toBe(
			0
		);
		expect(dom.query("wc-chess-board").classList.contains("flipped")).toBe(false);
		expect(dom.document.querySelectorAll(".clock-component").length).toBe(0);

		expect(adapter.getMyColor()).toBeNull();
		// and the snapshot it publishes says so too — the session must hold, not predict
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.readSnapshot()?.myColor).toBeNull();
	});

	it("republishes the same position once the bridge says black (playingAs 2)", async () => {
		let state: Record<string, unknown> | null = null;
		const { adapter, bridge } = bootWithoutColourEvidence(() => state);
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.readSnapshot()?.myColor).toBeNull();

		// The bridge answers: the owner is black. The position itself has not moved, so the colour
		// must be part of what the feed is keyed on or the session never learns it.
		state = { fen: WEBGL_FEN, mode: "playing", playingAs: 2, flipped: true };
		bridge.emit("state", state);
		await waitFor(() => seen.length > 0, 2_000);
		expect(seen.at(-1)?.myColor).toBe("b");
		expect(adapter.getMyColor()).toBe("b");
		expect(adapter.isFlipped()).toBe(true);
	});

	it("prefers the rendered bottom colour over our own colour, so a hand flip is not mirrored", async () => {
		// Partial bridge failure: `playingAs` answers, `flipped` does not. The owner has then turned
		// the board round by hand, so the page shows WHITE at the bottom while we play black.
		// Answering the orientation from the colour would mirror every square, for the mark and for
		// the hand alike, so the render has to win.
		const { dom, adapter } = boot(() => ({ fen: WEBGL_FEN, mode: "playing", playingAs: 2 }));
		await waitFor(() => adapter.getMyColor() === "b");
		const bottom = dom.document.querySelector(".clock-component.clock-bottom");
		bottom?.classList.remove("clock-black");
		bottom?.classList.add("clock-white");
		// The colour is still ours; the orientation now follows the page, not the colour.
		expect(adapter.getMyColor()).toBe("b");
		expect(adapter.isFlipped()).toBe(false);
	});
});
