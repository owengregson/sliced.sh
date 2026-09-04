// test/content/adapters/lichess.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import type { AdapterPositionSnapshot, SiteAdapter } from "@content/adapters/adapter";
import { lichessSquareToPoint } from "@content/adapters/geometry";
import { createLichessAdapter } from "@content/adapters/lichess";
import { TIMINGS } from "@core/constants";
import { TOKENS } from "@design/tokens.generated";
import { installWindowGlobals, type TabDom } from "@test/sim/dom/tab-dom";
import {
	FakeBridge,
	type FixtureName,
	fire,
	lichessPiece,
	loadFixture,
	observerRegistry,
	pageDocument,
	pageWindow,
	sleep,
	spyPageStorage,
	waitFor,
} from "./helpers";

const CG_RECT = { x: 100, y: 100, width: 544, height: 544 };
const WHITE_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
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
	dom.layout("cg-board", CG_RECT);
	const adapter = createLichessAdapter({
		document: pageDocument(dom),
		window: pageWindow(dom),
		...(bridge ? { bridge } : {}),
	});
	cleanups.push(() => adapter.destroy());
	return { dom, adapter, bridge };
}

/** Play d2-d4 on the white fixture the way chessground + lila do it. */
function playD4(dom: TabDom): void {
	const pawn = lichessPiece(dom, 204, 408);
	pawn.setAttribute("style", "transform: translate(204px, 272px);");
	const squares = dom.document.querySelectorAll("cg-board square.last-move");
	squares[0]?.setAttribute("style", "transform: translate(204px, 408px);");
	squares[1]?.setAttribute("style", "transform: translate(204px, 272px);");
	dom.document.querySelector(".a1t")?.classList.remove("a1t");
	dom.query("app").insertAdjacentHTML("beforeend", '<qZM>3</qZM><Z7yx class="a1t">d4</Z7yx>');
	dom.query(".rclock-bottom").classList.remove("running");
	dom.query(".rclock-top").classList.add("running");
}

describe("LichessAdapter — page kind, colour and opponent (V2)", () => {
	it("classifies player / AI / spectator round pages", () => {
		const white = boot("lichess-round-white");
		expect(white.adapter.site).toBe("lichess");
		expect(white.adapter.detectPageKind()).toBe("live-game");
		expect(white.adapter.getMyColor()).toBe("w");
		expect(white.adapter.getOpponent()).toEqual({
			isBot: false,
			name: "Opponent",
			ratingEstimate: 1800,
		});
		const black = boot("lichess-round-black");
		expect(black.adapter.detectPageKind()).toBe("vs-computer");
		expect(black.adapter.getMyColor()).toBe("b");
		expect(black.adapter.getOpponent()).toEqual({
			isBot: true,
			name: "lichess AI level 5",
			ratingEstimate: 2000,
		});
		const tv = boot("lichess-tv");
		expect(tv.adapter.detectPageKind()).toBe("live-spectate");
		expect(tv.adapter.getMyColor()).toBeNull();
		expect(tv.adapter.isMyTurn()).toBe(false);
		expect(tv.adapter.isReady()).toBe(true);
	});
});

describe("LichessAdapter — state readers", () => {
	it("reads placement, replay FEN, turn, clocks and ply on the white fixture", () => {
		const { adapter } = boot("lichess-round-white");
		expect(adapter.getPlacement()).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R");
		expect(adapter.getFen()).toBe(WHITE_FEN);
		expect(adapter.getPositionInfo()).toEqual({
			fen: WHITE_FEN,
			approximate: false,
			source: "replay",
		});
		expect(adapter.getSideToMove()).toBe("w");
		expect(adapter.getMoveList()).toEqual(["e4", "e5", "Nf3", "Nc6"]);
		expect(adapter.getPly()).toBe(4);
		expect(adapter.isAtLivePosition()).toBe(true);
		expect(adapter.getClock("w")).toEqual({ ms: 16_000, running: true, hasTenths: true });
		expect(adapter.getClock("b")).toEqual({ ms: 179_000, running: false, hasTenths: false });
		expect(adapter.isMyTurn()).toBe(true);
		expect(adapter.isGameOver()).toBe(false);
		expect(adapter.isFlipped()).toBe(false);
	});
	it("reads the black-orientation fixture", () => {
		const { adapter } = boot("lichess-round-black");
		expect(adapter.getPlacement()).toBe("rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR");
		expect(adapter.getFen()).toBe("rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2");
		expect(adapter.getSideToMove()).toBe("b");
		expect(adapter.getPly()).toBe(3);
		expect(adapter.isFlipped()).toBe(true);
		expect(adapter.isMyTurn()).toBe(true);
		expect(adapter.getClock("b")).toEqual({ ms: 3_600_000, running: true, hasTenths: false });
	});
	it("uses the bridge analysis FEN when present, else replay; approximate on mismatch", async () => {
		const bridge = new FakeBridge();
		const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w Kkq - 2 3";
		bridge.responses.set("getState", () => ({ hasLichessApi: true, fen }));
		const { dom, adapter } = boot("lichess-round-white", bridge);
		const children = dom.document.querySelectorAll("cg-container > *").length;
		await waitFor(() => adapter.getFen() === fen);
		expect(adapter.getPositionInfo()?.source).toBe("bridge");
		const plain = boot("lichess-round-white");
		lichessPiece(plain.dom, 476, 408).remove(); // h2 pawn
		const info = plain.adapter.getPositionInfo();
		expect(info?.approximate).toBe(true);
		expect(info?.fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PP1/RNBQKB1R w KQkq - 0 3");
		expect(dom.document.querySelectorAll("cg-container > *").length).toBe(children);
	});
	it("returns an approximate FEN from the DOM when the list starts mid-game", () => {
		const { adapter } = boot("lichess-promotion");
		const info = adapter.getPositionInfo();
		expect(info?.approximate).toBe(true);
		expect(info?.fen.split(" ")[0]).toBe("4P3/8/1k5p/8/8/8/8/6K1");
	});
	it("never touches page storage", () => {
		const dom = loadFixture("lichess-round-white");
		cleanups.push(installWindowGlobals(dom.window));
		const spy = spyPageStorage(dom.window, globalThis, dom.document);
		cleanups.push(() => spy.restore());
		dom.layout("cg-board", CG_RECT);
		const adapter = createLichessAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
		});
		cleanups.push(() => adapter.destroy());
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

describe("LichessAdapter — geometry and promotion", () => {
	it("maps squares by orientation", () => {
		const white = boot("lichess-round-white");
		expect(white.adapter.getBoardRect()).toMatchObject(CG_RECT);
		expect(white.adapter.squareToPoint("e2")).toEqual(lichessSquareToPoint("e2", CG_RECT, true));
		expect(white.adapter.pointToSquare(lichessSquareToPoint("h8", CG_RECT, true))).toBe("h8");
		const black = boot("lichess-round-black");
		expect(black.adapter.squareToPoint("e2")).toEqual(lichessSquareToPoint("e2", CG_RECT, false));
		expect(black.adapter.pointToSquare(lichessSquareToPoint("a1", CG_RECT, false))).toBe("a1");
		expect(black.adapter.squareRect("h1")).toMatchObject({ x: 100, y: 100, width: 68, height: 68 });
	});
	it("getPromotionTargetRect('e8','n') is the second square of #promotion-choice", () => {
		const { dom, adapter } = boot("lichess-promotion");
		const squares = dom.document.querySelectorAll("#promotion-choice square");
		squares.forEach((sq, i) => {
			dom.layoutElement(sq, { x: 372, y: 100 + i * 68, width: 68, height: 68 });
		});

		expect(adapter.getPromotionTargetRect("e8", "n")).toMatchObject({ x: 372, y: 168, width: 68 });
		expect(adapter.getPromotionTargetRect("e8", "q")).toMatchObject({ y: 100 });
		expect(adapter.getPromotionTargetRect("e8", "b")).toMatchObject({ y: 304 });
		dom.clearLayout();
		dom.layout("cg-board", CG_RECT);
		// without a laid-out dialog the rect is computed from the board geometry (top = i * 12.5 %)
		expect(adapter.getPromotionTargetRect("e8", "n")).toMatchObject({ x: 372, y: 168, width: 68 });
		const white = boot("lichess-round-white");
		expect(white.adapter.getPromotionTargetRect("e8", "n")).toBeNull();
	});
});

describe("LichessAdapter — focus edges", () => {
	it("reports every edge and unsubscribes", () => {
		const { dom, adapter } = boot("lichess-round-white");
		const edges: unknown[] = [];
		const off = adapter.onFocusEdge((e) => edges.push(e));
		fire(dom, "window", "blur");
		fire(dom, "document", "visibilitychange");
		fire(dom, "window", "focus");
		expect(edges.length).toBe(3);
		off();
		fire(dom, "window", "blur");
		expect(edges.length).toBe(3);
	});
});

describe("LichessAdapter — position changes", () => {
	it("fires exactly once per move (board transform + list + clock inside one debounce window)", async () => {
		const { dom, adapter } = boot("lichess-round-white");
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		await sleep(SETTLE);
		playD4(dom);
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 3");
		expect(seen[0]?.sideToMove).toBe("b");
		expect(seen[0]?.ply).toBe(5);
		expect(seen[0]?.lastMove).toEqual({ from: "d2", to: "d4", san: "d4" });
		expect(seen[0]?.gameId).toBe("abcdefgh");
		expect(seen[0]?.clocks.b.running).toBe(true);
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
	});
	it("stays silent while piece.anim / piece.dragging / #promotion-choice exist", async () => {
		const { dom, adapter } = boot("lichess-round-white");
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		const pawn = lichessPiece(dom, 204, 408);
		pawn.classList.add("anim");
		pawn.setAttribute("style", "transform: translate(204px, 340px);");
		await sleep(SETTLE);
		expect(seen.length).toBe(0);
		pawn.classList.remove("anim");
		pawn.classList.add("dragging");
		pawn.setAttribute("style", "transform: translate(204px, 272px);");
		await sleep(SETTLE);
		expect(seen.length).toBe(0);
		pawn.classList.remove("dragging");
		dom.query(".rclock-bottom").classList.remove("running");
		dom.query(".rclock-top").classList.add("running");
		dom
			.query(".main-board")
			.insertAdjacentHTML(
				"beforeend",
				'<div id="promotion-choice" class="top"><square></square></div>'
			);
		await sleep(SETTLE);
		expect(seen.length).toBe(0);
		dom.query("#promotion-choice").remove();
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.sideToMove).toBe("b");
	});
	it("re-evaluates on a bridge ply event", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ hasLichessApi: true }));
		const { dom, adapter } = boot("lichess-round-white", bridge);
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		await sleep(SETTLE);
		playD4(dom);
		bridge.emit("ply", { ply: 5 });
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
	});
});

describe("LichessAdapter — game over, new game, highlights", () => {
	it("detects .result-wrap / .follow-up, fires onGameEnd once, and clicks the follow-up buttons", async () => {
		const { dom, adapter } = boot("lichess-tv");
		expect(adapter.isGameOver()).toBe(false);
		expect(adapter.tryStartNewGame("new")).toBe(false);
		const results: string[] = [];
		adapter.onGameEnd((r) => results.push(r));
		await sleep(SETTLE);
		dom
			.query("i5d")
			.insertAdjacentHTML(
				"beforeend",
				'<div class="result-wrap"><p class="result">1-0</p><p class="status">White wins by checkmate</p></div>'
			);
		dom
			.query(".rcontrols")
			.insertAdjacentHTML(
				"beforeend",
				'<div class="follow-up"><button class="fbt rematch white">Rematch</button><button class="fbt new-opponent">New opponent</button><a class="fbt analysis">Analysis</a></div>'
			);
		dom.query(".rclock-bottom").classList.remove("running");
		await sleep(SETTLE);
		expect(results).toEqual(["1-0"]);
		expect(adapter.isGameOver()).toBe(true);
		const clicked: string[] = [];
		for (const b of dom.document.querySelectorAll(".follow-up button"))
			b.addEventListener("click", () => clicked.push(b.className));
		expect(adapter.tryStartNewGame("new")).toBe(true);
		expect(adapter.tryStartNewGame("rematch")).toBe(true);
		expect(clicked).toEqual(["fbt new-opponent", "fbt rematch white"]);
	});
	it("highlights through the bridge overlay with token colours and never inserts DOM itself", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ hasLichessApi: false }));
		bridge.responses.set("draw", () => ({ ok: true }));
		bridge.responses.set("clear", () => ({ ok: true }));
		const { dom, adapter } = boot("lichess-round-black", bridge);
		const before = dom.document.body.querySelectorAll("*").length;
		adapter.highlight("e7", "e5", "both");
		await waitFor(() => bridge.callsOf("draw").length === 1);
		expect(bridge.callsOf("draw")[0]?.payload).toEqual({
			orientation: "black",
			highlights: [
				{ square: "e7", color: TOKENS.color.dark.hlFrom },
				{ square: "e5", color: TOKENS.color.dark.hlTo },
			],
			arrows: [{ from: "e7", to: "e5", color: TOKENS.color.dark.hlArrow }],
		});
		adapter.clearHighlights();
		await waitFor(() => bridge.callsOf("clear").length === 1);
		expect(dom.document.body.querySelectorAll("*").length).toBe(before);
		const plain = boot("lichess-round-white");
		const count = plain.dom.document.body.querySelectorAll("*").length;
		plain.adapter.highlight("e2", "e4", "arrows");
		plain.adapter.clearHighlights();
		expect(plain.dom.document.body.querySelectorAll("*").length).toBe(count);
	});
});

describe("LichessAdapter — observeMove and probe", () => {
	it("resolves true when the piece lands (and the list confirms), false when it snaps back", async () => {
		const { dom, adapter } = boot("lichess-round-white");
		const ok = adapter.observeMove({ from: "d2", to: "d4" }, 800);
		await sleep(20);
		playD4(dom);
		expect(await ok).toBe(true);
		const again = boot("lichess-round-white");
		const back = again.adapter.observeMove({ from: "d2", to: "d4" }, 800);
		await sleep(20);
		const pawn = lichessPiece(again.dom, 204, 408);
		pawn.setAttribute("style", "transform: translate(204px, 272px);");
		await sleep(SETTLE);
		pawn.setAttribute("style", "transform: translate(204px, 408px);");
		expect(await back).toBe(false);
	});
	it("probe reports ladders, the tag-rotation detector and misses", () => {
		const white = boot("lichess-round-white").adapter.probe();
		expect(white.site).toBe("lichess");
		expect(white.matched).toContainEqual({
			concern: "wrap",
			index: 0,
			selector: ".round__app .cg-wrap",
		});
		expect(white.matched).toContainEqual({ concern: "moves", index: 0, selector: "aPp" });
		expect(white.misses).toContain("result");
		const black = boot("lichess-round-black").adapter.probe();
		expect(black.misses).toContain("moves");
		expect(black.misses).toContain("move");
		const rotation = black.checks.find((c) => c.name === "tagRotation");
		expect(rotation?.ok).toBe(true);
		expect(rotation?.detail).toContain("M3ZK");
		expect(black.checks.find((c) => c.name === "boardSanity")?.ok).toBe(true);
		expect(black.checks.find((c) => c.name === "orientation")?.ok).toBe(true);
		expect(black.checks.find((c) => c.name === "geometry")?.ok).toBe(true);
	});
});

describe("LichessAdapter — game start keying (fix round 1)", () => {
	it("does not fire on plies; fires once on a new game id with a fresh board", async () => {
		const { dom, adapter } = boot("lichess-round-white");
		const starts: number[] = [];
		adapter.onGameStart(() => starts.push(1));
		playD4(dom);
		await sleep(SETTLE);
		expect(starts.length).toBe(0);
		// rematch: lila redirects to /{rematchId}/{color}; a fresh round app follows
		dom.window.history.pushState({}, "", "/zyxwvuts5678/white");
		const app = dom.query("app");
		app.innerHTML = "";
		for (const sq of dom.document.querySelectorAll("cg-board square")) sq.remove();
		await sleep(SETTLE);
		expect(starts.length).toBe(1);
		await sleep(SETTLE);
		expect(starts.length).toBe(1);
	});
	it("without a URL id (TV), a ply reset after ≥ 2 plies starts a new game", async () => {
		const { dom, adapter } = boot("lichess-tv");
		const starts: number[] = [];
		adapter.onGameStart(() => starts.push(1));
		const app = dom.query("app");
		app.innerHTML = "";
		for (const sq of dom.document.querySelectorAll("cg-board square")) sq.remove();
		await sleep(SETTLE);
		expect(starts.length).toBe(1);
	});
});

describe("LichessAdapter — late bridge readiness (fix round 1)", () => {
	it("uses the bridge for FEN and highlights once it reports ready", async () => {
		const bridge = new FakeBridge();
		bridge.available = false;
		const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w Kkq - 2 3";
		bridge.responses.set("getState", () => ({ hasLichessApi: true, fen }));
		bridge.responses.set("draw", () => ({ ok: true }));
		const { adapter } = boot("lichess-round-white", bridge);
		await sleep(SETTLE);
		expect(adapter.getPositionInfo()?.source).toBe("replay");
		adapter.highlight("e2", "e4", "both");
		await sleep(10);
		expect(bridge.callsOf("draw").length).toBe(0);
		bridge.available = true;
		bridge.emit("ready", {});
		await waitFor(() => adapter.getFen() === fen);
		adapter.highlight("e2", "e4", "both");
		await waitFor(() => bridge.callsOf("draw").length === 1);
	});
});

describe("LichessAdapter — observer wiring (fix round 1)", () => {
	it("fires exactly once through happy-dom's genuine MutationObserver (first-batch case)", async () => {
		const dom = loadFixture("lichess-round-white", undefined, { observer: "native" });
		cleanups.push(installWindowGlobals(dom.window));
		dom.layout("cg-board", CG_RECT);
		const adapter = createLichessAdapter({ document: pageDocument(dom), window: pageWindow(dom) });
		cleanups.push(() => adapter.destroy());
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		lichessPiece(dom, 204, 408).setAttribute("style", "transform: translate(204px, 272px);");
		await sleep(SETTLE);
		expect(seen.length).toBe(1);
		expect(seen[0]?.fen.split(" ")[0]).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R");
	});
	it("registers the documented observers with their init options and re-installs without leaking", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({}));
		const dom = loadFixture("lichess-round-white", undefined, { observer: "recording" });
		cleanups.push(installWindowGlobals(dom.window));
		dom.layout("cg-board", CG_RECT);
		const registry = observerRegistry(dom);
		const adapter = createLichessAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
			bridge,
		});
		cleanups.push(() => adapter.destroy());
		expect(registry.on("cg-board").map((r) => r.init)).toEqual([
			{ childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] },
		]);
		expect(registry.on(".cg-wrap").map((r) => r.init)).toEqual([
			{ attributes: true, attributeFilter: ["class"] },
		]);
		expect(registry.on(".rclock").map((r) => r.init)).toEqual([
			{ attributes: true, attributeFilter: ["class"] },
			{ attributes: true, attributeFilter: ["class"] },
		]);
		expect(registry.on("app").map((r) => r.init)).toEqual([
			{ childList: true, subtree: true, attributes: true, attributeFilter: ["class"] },
		]);
		expect(registry.on("body").map((r) => r.init)).toEqual([{ childList: true, subtree: true }]);
		const initial = registry.active().length;
		expect(initial).toBe(6);
		for (let i = 0; i < 2; i++) {
			const old = dom.query("app");
			old.replaceWith(old.cloneNode(true)); // moves container replaced (re-render / tag rotation)
			bridge.emit("ply", {});
			await sleep(SETTLE);
			expect(registry.active().length).toBe(initial);
			expect(registry.on("app")[0]?.target).toBe(dom.query("app") as never);
		}
		expect(registry.entries.length).toBe(initial * 3);
		adapter.destroy();
		expect(registry.active().length).toBe(0);
	});
});
