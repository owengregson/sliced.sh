// test/content/adapters/chesscom.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import type { AdapterPositionSnapshot, SiteAdapter } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { squareToPoint } from "@content/adapters/geometry";
import { TIMINGS } from "@core/constants";
import { TOKENS } from "@design/tokens.generated";
import { installWindowGlobals, type TabDom } from "@test/sim/dom/tab-dom";
import {
	BOARD_RECT,
	FakeBridge,
	type FixtureName,
	fire,
	loadFixture,
	observerRegistry,
	pageDocument,
	pageWindow,
	sleep,
	spyPageStorage,
	waitFor,
} from "./helpers";

const LIVE_FEN = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
const SETTLE = TIMINGS.adapterDebounceMs * 3;

const cleanups: Array<() => void> = [];
afterEach(() => {
	// LIFO: spies restore before the globals they wrapped are put back
	for (const c of cleanups.splice(0).reverse()) c();
});

function boot(
	name: FixtureName,
	bridge?: FakeBridge
): { dom: TabDom; adapter: SiteAdapter; bridge: FakeBridge | undefined } {
	const dom = loadFixture(name);
	cleanups.push(installWindowGlobals(dom.window));
	const adapter = createChesscomAdapter({
		document: pageDocument(dom),
		window: pageWindow(dom),
		...(bridge ? { bridge } : {}),
	});
	cleanups.push(() => adapter.destroy());
	return { dom, adapter, bridge };
}

/** Play d2-d4 on the live fixture the way chess.com's DOM does (piece class, highlights, node, clocks). */
function playD4(dom: TabDom): void {
	const doc = dom.document;
	const pawn = doc.querySelector(".piece.square-42");
	pawn?.setAttribute("class", "piece wp square-44");
	for (const h of doc.querySelectorAll(".highlight")) h.remove();
	const board = dom.query("wc-chess-board");
	board.insertAdjacentHTML(
		"afterbegin",
		'<div class="highlight square-42"></div><div class="highlight square-44"></div>'
	);
	doc.querySelector(".node-highlight-content.selected")?.classList.remove("selected");
	dom
		.query(".timestamps-with-base-time")
		.insertAdjacentHTML(
			"beforeend",
			'<div class="main-line-row move-list-row dark-row" data-whole-move-number="4">4.' +
				'<div data-node="0-6" class="node white-move main-line-ply"><span class="node-highlight-content selected">d4 </span></div></div>'
		);
	dom.query(".clock-bottom").classList.remove("clock-player-turn");
	dom.query(".clock-top").classList.add("clock-player-turn");
}

describe("ChessComAdapter — page kind and opponent (V2)", () => {
	it("classifies the live game, the vs-computer page and the bot opponent", () => {
		const live = boot("chesscom-live");
		expect(live.adapter.site).toBe("chesscom");
		expect(live.adapter.detectPageKind()).toBe("live-game");
		expect(live.adapter.getOpponent()).toEqual({
			isBot: false,
			name: "MagnusFan99",
			ratingEstimate: 1850,
		});
		const bot = boot("chesscom-computer");
		expect(bot.adapter.detectPageKind()).toBe("vs-computer");
		expect(bot.adapter.getOpponent()).toEqual({ isBot: true, name: "Nelson", ratingEstimate: 2000 });
		expect(bot.adapter.isReady()).toBe(true);
	});
	it("refines the lobby to live-game / live-game to live-spectate from the bridge mode", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ fen: LIVE_FEN, mode: "observing", playingAs: null }));
		const { adapter } = boot("chesscom-live", bridge);
		await waitFor(() => bridge.callsOf("getState").length > 0);
		await sleep(10);
		expect(adapter.detectPageKind()).toBe("live-spectate");
		expect(adapter.getMyColor()).toBeNull();
	});
});

describe("ChessComAdapter — state readers", () => {
	it("reads placement, FEN (replay), turn, colour, clocks, ply and turn ownership", () => {
		const { adapter } = boot("chesscom-live");
		expect(adapter.getPlacement()).toBe(LIVE_FEN.split(" ")[0] ?? "");
		expect(adapter.getFen()).toBe(LIVE_FEN);
		expect(adapter.getPositionInfo()).toEqual({
			fen: LIVE_FEN,
			approximate: false,
			source: "replay",
		});
		expect(adapter.getSideToMove()).toBe("w");
		expect(adapter.getMyColor()).toBe("w");
		expect(adapter.getMoveList()).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
		expect(adapter.getPly()).toBe(6);
		expect(adapter.isAtLivePosition()).toBe(true);
		expect(adapter.getClock("w")).toEqual({ ms: 16_000, running: true, hasTenths: true });
		expect(adapter.getClock("b")).toEqual({ ms: 179_000, running: false, hasTenths: false });
		expect(adapter.isMyTurn()).toBe(true);
		expect(adapter.isGameOver()).toBe(false);
		expect(adapter.isFlipped()).toBe(false);
	});
	it("vs computer: no clocks → turn from move-list parity", () => {
		const { adapter } = boot("chesscom-computer");
		expect(adapter.getClock("w")).toBeNull();
		expect(adapter.getSideToMove()).toBe("w");
		expect(adapter.getPly()).toBe(2);
		expect(adapter.isMyTurn()).toBe(true);
	});
	it("prefers the bridge FEN when present and consistent with the DOM", async () => {
		const bridge = new FakeBridge();
		const bridgeFen = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQ - 3 4";
		bridge.responses.set("getState", () => ({
			fen: bridgeFen,
			turn: "w",
			playingAs: "w",
			mode: "playing",
			flipped: false,
		}));
		const { adapter } = boot("chesscom-live", bridge);
		await waitFor(() => adapter.getFen() === bridgeFen);
		expect(adapter.getPositionInfo()).toEqual({
			fen: bridgeFen,
			approximate: false,
			source: "bridge",
		});
		// a stale bridge FEN (placement differs from the DOM) is ignored in favour of replay
		bridge.emit("move", { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" });
		expect(adapter.getFen()).toBe(LIVE_FEN);
	});
	it("falls back to the DOM placement with approximate=true when replay and DOM disagree", () => {
		const { dom, adapter } = boot("chesscom-live");
		dom.query(".piece.square-82").remove(); // h2 pawn vanishes from the DOM only
		const info = adapter.getPositionInfo();
		expect(info?.approximate).toBe(true);
		expect(info?.source).toBe("dom");
		expect(info?.fen).toBe("r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PP1/RNBQK2R w KQkq - 0 4");
	});
	it("never touches page storage", () => {
		const dom = loadFixture("chesscom-live");
		cleanups.push(installWindowGlobals(dom.window));
		const spy = spyPageStorage(dom.window, globalThis, dom.document);
		cleanups.push(() => spy.restore());
		const adapter = createChesscomAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
		});
		cleanups.push(() => adapter.destroy());
		dom.layout("wc-chess-board", BOARD_RECT);
		adapter.detectPageKind();
		adapter.getOpponent();
		adapter.getFen();
		adapter.getClock("w");
		adapter.getMoveList();
		adapter.squareToPoint("e2");
		adapter.probe();
		adapter.tryStartNewGame("new");
		expect(spy.hits()).toBe(0);
	});
});

describe("ChessComAdapter — geometry", () => {
	it("maps squares through the board rect and honours .flipped", () => {
		const { dom, adapter } = boot("chesscom-live");
		dom.layout("wc-chess-board", BOARD_RECT);
		expect(adapter.getBoardRect()).toMatchObject(BOARD_RECT);
		expect(adapter.squareToPoint("e2")).toEqual(squareToPoint("e2", BOARD_RECT, false));
		expect(adapter.pointToSquare({ x: 397, y: 529 })).toBe("e2");
		expect(adapter.squareRect("a8")).toMatchObject({ x: 100, y: 100, width: 66, height: 66 });
		dom.query("wc-chess-board").classList.add("flipped");
		expect(adapter.isFlipped()).toBe(true);
		expect(adapter.squareToPoint("e2")).toEqual(squareToPoint("e2", BOARD_RECT, true));
	});
	it("returns the promotion piece rect from the promotion window", () => {
		const { dom, adapter } = boot("chesscom-live");
		expect(adapter.getPromotionTargetRect("e8", "n")).toBeNull();
		dom
			.query("wc-chess-board")
			.insertAdjacentHTML(
				"beforeend",
				'<div class="promotion-window top"><div class="promotion-pieces">' +
					'<div class="promotion-piece wq"></div><div class="promotion-piece wn"></div>' +
					'<div class="promotion-piece wr"></div><div class="promotion-piece wb"></div></div></div>'
			);
		dom.layout(".promotion-piece.wn", { x: 364, y: 166, width: 66, height: 66 });
		expect(adapter.getPromotionTargetRect("e8", "n")).toMatchObject({ x: 364, y: 166, width: 66 });
	});
});

describe("ChessComAdapter — focus edges (V2 §13.4)", () => {
	it("reports window blur/focus and visibilitychange", () => {
		const { dom, adapter } = boot("chesscom-live");
		const edges: Array<{ hasFocus: boolean; visibility: string; at: number }> = [];
		const off = adapter.onFocusEdge((e) => edges.push(e));
		fire(dom, "window", "blur");
		fire(dom, "window", "focus");
		fire(dom, "document", "visibilitychange");
		expect(edges.length).toBe(3);
		expect(edges[0]).toMatchObject({ visibility: "visible" });
		expect(typeof edges[0]?.hasFocus).toBe("boolean");
		expect(edges[0]?.at).toBeGreaterThan(0);
		off();
		fire(dom, "window", "blur");
		expect(edges.length).toBe(3);
	});
});

describe("ChessComAdapter — position changes", () => {
	it("fires exactly once per move when board, list and clocks mutate inside one debounce window", async () => {
		const { dom, adapter } = boot("chesscom-live");
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		await sleep(SETTLE);
		expect(seen.length).toBe(0);
		playD4(dom);
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.fen).toBe("r1bqkbnr/1ppp1ppp/p1n5/1B2p3/3PP3/5N2/PPP2PPP/RNBQK2R b KQkq - 0 4");
		expect(seen[0]?.sideToMove).toBe("b");
		expect(seen[0]?.ply).toBe(7);
		expect(seen[0]?.lastMove).toEqual({ from: "d2", to: "d4", san: "d4" });
		expect(seen[0]?.site).toBe("chesscom");
		expect(seen[0]?.gameId).toBe("173765478164");
		expect(seen[0]?.myColor).toBe("w");
		expect(seen[0]?.clocks.b.running).toBe(true);
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
	});
	it("does not fire while a piece is dragging, then fires once the drag ends", async () => {
		const { dom, adapter } = boot("chesscom-live");
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		const pawn = dom.query(".piece.square-42");
		pawn.classList.add("dragging");
		pawn.setAttribute("class", "piece wp square-44 dragging");
		await sleep(SETTLE);
		expect(seen.length).toBe(0);
		pawn.classList.remove("dragging");
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
	});
	it("fires on a bridge move event too (deduped against the DOM)", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ fen: LIVE_FEN, mode: "playing", playingAs: "w" }));
		const { dom, adapter } = boot("chesscom-live", bridge);
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		await sleep(SETTLE);
		playD4(dom);
		const after = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/3PP3/5N2/PPP2PPP/RNBQK2R b KQkq - 0 4";
		bridge.responses.set("getState", () => ({ fen: after, mode: "playing", playingAs: "w" }));
		bridge.emit("move", { fen: after });
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.fen).toBe(after);
	});
});

describe("ChessComAdapter — game over and new game", () => {
	it("detects the game-over modal and the result", () => {
		const { adapter } = boot("chesscom-gameover");
		expect(adapter.isGameOver()).toBe(true);
		expect(adapter.isMyTurn()).toBe(false);
		expect(adapter.getSideToMove()).toBe("b");
	});
	it("fires onGameEnd once when the modal and result row appear", async () => {
		const { dom, adapter } = boot("chesscom-live");
		const results: string[] = [];
		adapter.onGameEnd((r) => results.push(r));
		await sleep(SETTLE);
		dom
			.query("#board-layout-chessboard")
			.insertAdjacentHTML(
				"beforeend",
				'<div class="game-over-modal-shell-content"><div class="game-over-modal-header-component game-over-modal-header-userWon"></div></div>'
			);
		dom
			.query(".timestamps-with-base-time")
			.insertAdjacentHTML(
				"beforeend",
				'<div class="main-line-row move-list-row result-row"><span class="game-result">1-0 </span></div>'
			);
		await sleep(SETTLE);
		expect(results).toEqual(["1-0"]);
		expect(adapter.isGameOver()).toBe(true);
	});
	it("tryStartNewGame clicks the first matching ladder entry only", () => {
		const { dom, adapter } = boot("chesscom-gameover");
		const clicked: string[] = [];
		for (const b of dom.document.querySelectorAll("button"))
			b.addEventListener("click", () =>
				clicked.push(b.getAttribute("data-cy") ?? b.textContent ?? "")
			);
		expect(adapter.tryStartNewGame("new")).toBe(true);
		expect(clicked).toEqual(["game-over-modal-new-game-button"]);
		expect(adapter.tryStartNewGame("rematch")).toBe(true);
		expect(clicked).toEqual(["game-over-modal-new-game-button", "game-over-modal-rematch-button"]);
		const live = boot("chesscom-live");
		expect(live.adapter.tryStartNewGame("new")).toBe(false);
	});
});

describe("ChessComAdapter — highlights via the bridge", () => {
	it("draws with token colours, keeps the returned keys and clears them", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ fen: LIVE_FEN }));
		bridge.responses.set("draw", () => ({ keys: ["arrow|e2e4", "highlight|e2", "highlight|e4"] }));
		bridge.responses.set("clear", () => ({ ok: true }));
		const { dom, adapter } = boot("chesscom-live", bridge);
		const before = dom.document.body.querySelectorAll("*").length;
		adapter.highlight("e2", "e4", "both");
		await waitFor(() => bridge.callsOf("draw").length === 1);
		const draw = bridge.callsOf("draw")[0]?.payload as {
			arrows: Array<{ from: string; to: string; color: string }>;
			highlights: Array<{ square: string; color: string }>;
		};
		expect(draw.arrows).toEqual([{ from: "e2", to: "e4", color: TOKENS.color.dark.hlArrow }]);
		expect(draw.highlights).toEqual([
			{ square: "e2", color: TOKENS.color.dark.hlFrom },
			{ square: "e4", color: TOKENS.color.dark.hlTo },
		]);
		adapter.clearHighlights();
		await waitFor(() => bridge.callsOf("clear").length === 1);
		expect(bridge.callsOf("clear")[0]?.payload).toEqual({
			keys: ["arrow|e2e4", "highlight|e2", "highlight|e4"],
		});
		expect(dom.document.body.querySelectorAll("*").length).toBe(before);
	});
	it("does nothing without a bridge (no DOM insertion) and arrows() weights lines", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ fen: LIVE_FEN }));
		bridge.responses.set("draw", () => ({ keys: ["k"] }));
		const { adapter } = boot("chesscom-live", bridge);
		adapter.arrows([
			{ from: "e2", to: "e4", weight: 1 },
			{ from: "d2", to: "d4", weight: 0.5 },
		]);
		await waitFor(() => bridge.callsOf("draw").length === 1);
		const draw = bridge.callsOf("draw")[0]?.payload as { arrows: Array<{ color: string }> };
		expect(draw.arrows.map((a) => a.color)).toEqual([
			TOKENS.color.dark.hlArrow,
			TOKENS.color.dark.hlArrow2,
		]);
		const plain = boot("chesscom-live");
		const count = plain.dom.document.body.querySelectorAll("*").length;
		plain.adapter.highlight("e2", "e4", "squares");
		expect(plain.dom.document.body.querySelectorAll("*").length).toBe(count);
	});
});

describe("ChessComAdapter — observeMove", () => {
	it("resolves true when the piece lands and the move list confirms", async () => {
		const { dom, adapter } = boot("chesscom-live");
		const p = adapter.observeMove({ from: "d2", to: "d4" }, 800);
		await sleep(20);
		playD4(dom);
		expect(await p).toBe(true);
	});
	it("resolves false when the piece snaps back, and on timeout", async () => {
		const { dom, adapter } = boot("chesscom-live");
		const p = adapter.observeMove({ from: "d2", to: "d4" }, 800);
		await sleep(20);
		const pawn = dom.query(".piece.square-42");
		pawn.setAttribute("class", "piece wp square-44");
		await sleep(SETTLE);
		pawn.setAttribute("class", "piece wp square-42");
		expect(await p).toBe(false);
		expect(await adapter.observeMove({ from: "d2", to: "d4" }, 100)).toBe(false);
	});
});

describe("ChessComAdapter — probe and lifecycle", () => {
	it("reports matched candidate indexes per concern and the misses", () => {
		const { adapter } = boot("chesscom-computer");
		const report = adapter.probe();
		expect(report.site).toBe("chesscom");
		expect(report.matched).toContainEqual({
			concern: "board",
			index: 1,
			selector: "wc-chess-board#board-play-computer",
		});
		expect(report.matched).toContainEqual({
			concern: "moveList",
			index: 0,
			selector: "wc-simple-move-list",
		});
		expect(report.misses).toContain("clockTime");
		expect(report.misses).toContain("gameOver");
		expect(report.checks.find((c) => c.name === "boardSanity")?.ok).toBe(true);
		expect(report.checks.find((c) => c.name === "placementConsistency")?.ok).toBe(true);
	});
	it("destroy() stops observers and timers", async () => {
		const { dom, adapter } = boot("chesscom-live");
		const seen: unknown[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		adapter.destroy();
		playD4(dom);
		await sleep(SETTLE);
		expect(seen.length).toBe(0);
	});
});

/** Rewrite the fixture's board and move list to the start position (ply 0), keeping the element. */
function resetToStart(dom: TabDom): void {
	const board = dom.query("wc-chess-board");
	for (const p of board.querySelectorAll(".piece, .highlight")) p.remove();
	const files = "12345678";
	const back = "rnbqkbnr";
	const html: string[] = [];
	for (let f = 0; f < 8; f++) {
		html.push(`<div class="piece w${back[f]} square-${files[f]}1"></div>`);
		html.push(`<div class="piece wp square-${files[f]}2"></div>`);
		html.push(`<div class="piece bp square-${files[f]}7"></div>`);
		html.push(`<div class="piece b${back[f]} square-${files[f]}8"></div>`);
	}
	board.insertAdjacentHTML("beforeend", html.join(""));
	dom.query(".timestamps-with-base-time").innerHTML = "";
}

function pushMove(dom: TabDom, from: string, to: string, san: string, ply: number): void {
	dom.query(`.piece.square-${from}`).setAttribute("class", `piece wp square-${to}`);
	dom.document.querySelector(".node-highlight-content.selected")?.classList.remove("selected");
	const color = ply % 2 === 1 ? "white-move" : "black-move";
	dom
		.query(".timestamps-with-base-time")
		.insertAdjacentHTML(
			"beforeend",
			`<div class="main-line-row"><div data-node="0-${ply - 1}" class="node ${color} main-line-ply"><span class="node-highlight-content selected">${san} </span></div></div>`
		);
}

describe("ChessComAdapter — game start keying (fix round 1)", () => {
	it("fires once per game: not on ply 1→2, once when a fresh board replaces the old one", async () => {
		const dom = loadFixture("chesscom-computer");
		cleanups.push(installWindowGlobals(dom.window));
		resetToStart(dom);
		const adapter = createChesscomAdapter({ document: pageDocument(dom), window: pageWindow(dom) });
		cleanups.push(() => adapter.destroy());
		const starts: number[] = [];
		const positions: AdapterPositionSnapshot[] = [];
		adapter.onGameStart(() => starts.push(Date.now()));
		adapter.onPositionChange((s) => positions.push(s));
		expect(adapter.getPly()).toBe(0);
		pushMove(dom, "52", "54", "e4", 1);
		await sleep(SETTLE);
		pushMove(dom, "57", "55", "e5", 2);
		await sleep(SETTLE);
		expect(positions.map((p) => p.ply)).toEqual([1, 2]);
		expect(starts.length).toBe(0);
		expect(new Set(positions.map((p) => p.gameId)).size).toBe(1);
		// a fresh board (new element, start position, empty list) is a new game
		const old = dom.query("wc-chess-board");
		const fresh = old.cloneNode(false) as typeof old;
		old.replaceWith(fresh);
		resetToStart(dom);
		await sleep(SETTLE);
		expect(starts.length).toBe(1);
		expect(positions.at(-1)?.ply).toBe(0);
		expect(positions.at(-1)?.gameId).not.toBe(positions[0]?.gameId);
		await sleep(SETTLE);
		expect(starts.length).toBe(1);
	});
	it("fires once on a rematch that reuses the board element (ply reset, same <wc-chess-board>)", async () => {
		// `/play/computer` and `/play/online` have no URL game id, and chess.com's rematch reuses the
		// board element — so the only signal is `gameIdentity`'s ply-reset branch (ply 0 after ≥ 2).
		const dom = loadFixture("chesscom-computer");
		cleanups.push(installWindowGlobals(dom.window));
		resetToStart(dom);
		const adapter = createChesscomAdapter({ document: pageDocument(dom), window: pageWindow(dom) });
		cleanups.push(() => adapter.destroy());
		const board = dom.query("wc-chess-board");
		const starts: number[] = [];
		const positions: AdapterPositionSnapshot[] = [];
		adapter.onGameStart(() => starts.push(1));
		adapter.onPositionChange((sn) => positions.push(sn));
		pushMove(dom, "52", "54", "e4", 1);
		await sleep(SETTLE);
		pushMove(dom, "57", "55", "e5", 2);
		await sleep(SETTLE);
		expect(adapter.getPly()).toBe(2);
		expect(starts.length).toBe(0);
		const firstGameId = positions.at(-1)?.gameId;
		// the rematch: back to the start position with an empty move list, same board element
		resetToStart(dom);
		await sleep(SETTLE);
		expect(dom.query("wc-chess-board")).toBe(board); // the element really was not replaced
		expect(adapter.getPly()).toBe(0);
		expect(starts.length).toBe(1);
		expect(positions.at(-1)?.gameId).not.toBe(firstGameId);
		await sleep(SETTLE);
		expect(starts.length).toBe(1);
	});
	it("with a URL game id, plies never start a game; a new id does", async () => {
		const { dom, adapter } = boot("chesscom-live");
		const starts: number[] = [];
		adapter.onGameStart(() => starts.push(1));
		playD4(dom);
		await sleep(SETTLE);
		expect(starts.length).toBe(0);
		dom.window.history.pushState({}, "", "/game/live/173765478999");
		resetToStart(dom);
		await sleep(SETTLE);
		expect(starts.length).toBe(1);
	});
});

describe("ChessComAdapter — late bridge readiness (fix round 1)", () => {
	it("picks the bridge up when it becomes available after construction", async () => {
		const bridge = new FakeBridge();
		bridge.available = false;
		const bridgeFen = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQ - 3 4";
		bridge.responses.set("getState", () => ({ fen: bridgeFen, mode: "playing", playingAs: "w" }));
		bridge.responses.set("draw", () => ({ keys: ["k1"] }));
		const { adapter } = boot("chesscom-live", bridge);
		await sleep(SETTLE);
		expect(bridge.callsOf("getState").length).toBe(0);
		expect(adapter.getPositionInfo()?.source).toBe("replay");
		adapter.highlight("e2", "e4", "both");
		await sleep(10);
		expect(bridge.callsOf("draw").length).toBe(0);
		bridge.available = true;
		bridge.emit("ready", {});
		await waitFor(() => adapter.getFen() === bridgeFen);
		expect(adapter.getPositionInfo()?.source).toBe("bridge");
		adapter.highlight("e2", "e4", "both");
		await waitFor(() => bridge.callsOf("draw").length === 1);
	});
	it("does not let a bridge in `playing` mode turn /puzzles or /analysis into a live game", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ mode: "playing", playingAs: "w" }));
		const dom = loadFixture("chesscom-live", "https://www.chess.com/puzzles/rated");
		cleanups.push(installWindowGlobals(dom.window));
		const adapter = createChesscomAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
			bridge,
		});
		cleanups.push(() => adapter.destroy());
		await waitFor(() => bridge.callsOf("getState").length > 0);
		await sleep(10);
		expect(adapter.detectPageKind()).toBe("puzzles");
		dom.window.history.pushState({}, "", "/analysis/game/live/1");
		expect(adapter.detectPageKind()).toBe("analysis");
		dom.window.history.pushState({}, "", "/play/online");
		expect(adapter.detectPageKind()).toBe("live-game");
	});
});

describe("ChessComAdapter — observer wiring (fix round 1)", () => {
	it("fires exactly once through happy-dom's genuine MutationObserver (first-batch case)", async () => {
		const dom = loadFixture("chesscom-live", undefined, { observer: "native" });
		cleanups.push(installWindowGlobals(dom.window));
		const adapter = createChesscomAdapter({ document: pageDocument(dom), window: pageWindow(dom) });
		cleanups.push(() => adapter.destroy());
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		// synchronously after construction: the one delivery happy-dom supports
		dom.query(".piece.square-42").setAttribute("class", "piece wp square-44");
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.fen.split(" ")[0]).toBe("r1bqkbnr/1ppp1ppp/p1n5/1B2p3/3PP3/5N2/PPP2PPP/RNBQK2R");
	});
	it("registers the documented observers with their init options and re-installs without leaking", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({}));
		const dom = loadFixture("chesscom-live", undefined, { observer: "recording" });
		cleanups.push(installWindowGlobals(dom.window));
		const registry = observerRegistry(dom);
		const adapter = createChesscomAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
			bridge,
		});
		cleanups.push(() => adapter.destroy());
		expect(registry.on("wc-chess-board").map((r) => r.init)).toEqual([
			{ childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] },
		]);
		expect(registry.on("wc-simple-move-list").map((r) => r.init)).toEqual([
			{
				childList: true,
				subtree: true,
				characterData: true,
				attributes: true,
				attributeFilter: ["class"],
			},
		]);
		expect(registry.on(".clock-component").map((r) => r.init)).toEqual([
			{ attributes: true, attributeFilter: ["class"] },
			{ attributes: true, attributeFilter: ["class"] },
		]);
		expect(registry.on("body").map((r) => r.init)).toEqual([{ childList: true, subtree: true }]);
		const initial = registry.active().length;
		expect(initial).toBe(5);
		for (let i = 0; i < 2; i++) {
			const old = dom.query("wc-chess-board");
			old.replaceWith(old.cloneNode(true));
			bridge.emit("ply", {}); // the recording observer never delivers; re-evaluate explicitly
			await sleep(SETTLE);
			expect(registry.active().length).toBe(initial);
			expect(registry.on("wc-chess-board")[0]?.target).toBe(dom.query("wc-chess-board") as never);
		}
		expect(registry.entries.length).toBe(initial * 3);
		adapter.destroy();
		expect(registry.active().length).toBe(0);
	});
});
