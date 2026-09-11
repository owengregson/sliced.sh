// test/content/index.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FeedPort } from "@content/feed-port";
import { type ContentHandle, startContent } from "@content/index";
import { detectSite, hostOfMatchPattern } from "@content/site-detect";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { createTabDom, installWindowGlobals, type TabDom } from "@test/sim/dom/tab-dom";
import {
	BOARD_RECT,
	FakeBridge,
	type FixtureName,
	fire,
	installPollingObserver,
	loadFixture,
	loadFixtureInto,
	pageDocument,
	pageWindow,
	sleep,
	spyPageStorage,
	waitFor,
} from "./adapters/helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

interface FakeFeed extends FeedPort {
	posts: GamePortMessage[];
	command(cmd: GamePortCommand): void;
	of<K extends GamePortMessage["kind"]>(kind: K): Array<Extract<GamePortMessage, { kind: K }>>;
}

function fakeFeed(): {
	feed: FakeFeed;
	factory: (onCommand: (c: GamePortCommand) => void) => FeedPort;
} {
	let handler: (c: GamePortCommand) => void = () => {};
	const feed: FakeFeed = {
		posts: [],
		ready: Promise.resolve(),
		post(msg) {
			feed.posts.push(msg);
		},
		dispose() {},
		command(cmd) {
			handler(cmd);
		},
		of(kind) {
			return feed.posts.filter((m) => m.kind === kind) as never;
		},
	};
	return {
		feed,
		factory: (onCommand) => {
			handler = onCommand;
			return feed;
		},
	};
}

function boot(name: FixtureName, opts: { bridge?: FakeBridge } = {}) {
	const dom = loadFixture(name);
	cleanups.push(installWindowGlobals(dom.window));
	const { feed, factory } = fakeFeed();
	const bridge = opts.bridge ?? new FakeBridge();
	if (!bridge.responses.has("getState")) bridge.responses.set("getState", () => ({}));
	bridge.responses.set("draw", () => ({ keys: ["k1"] }));
	bridge.responses.set("clear", () => undefined);
	const handle = startContent({
		window: pageWindow(dom),
		document: pageDocument(dom),
		bridge,
		port: factory,
		adapterVersion: "t1",
	});
	if (!handle) throw new Error("startContent returned null");
	cleanups.push(() => handle.dispose());
	return { dom, feed, bridge, handle };
}

/** Play d2-d4 on the live fixture the way chess.com's DOM does. */
function playD4(dom: TabDom): void {
	const doc = dom.document;
	doc.querySelector(".piece.square-42")?.setAttribute("class", "piece wp square-44");
	for (const h of doc.querySelectorAll(".highlight")) h.remove();
	dom
		.query("wc-chess-board")
		.insertAdjacentHTML(
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

/** The owner's live capture: WebGL board at `/game/174252022572`, after 1.e4 c6 2.d3 d5 3.f3 dxe4. */
const WEBGL_FEN = "rnbqkbnr/pp2pppp/2p5/8/4p3/3P1P2/PPP3PP/RNBQKBNR w KQkq - 0 4";
const WEBGL_BOARD = { x: 120, y: 80, width: 704, height: 704 };

describe("site-detect", () => {
	it("maps hostnames to Site through SITE_MATCHES", () => {
		expect(hostOfMatchPattern("*://*.chess.com/*")).toBe("chess.com");
		expect(hostOfMatchPattern("nonsense")).toBeNull();
		expect(detectSite("www.chess.com")).toBe("chesscom");
		expect(detectSite("chess.com")).toBe("chesscom");
		expect(detectSite("CHESS.com")).toBe("chesscom");
		expect(detectSite("notchess.com")).toBeNull();
		expect(detectSite("lichess.org")).toBeNull();
		expect(detectSite("example.test")).toBeNull();
	});
	it("startContent returns null off-site and boots nothing", () => {
		const dom = loadFixture("chesscom-live", "https://example.test/");
		cleanups.push(installWindowGlobals(dom.window));
		expect(startContent({ window: pageWindow(dom), document: pageDocument(dom) })).toBeNull();
	});
});

describe("content entry — feed", () => {
	it("sends hello (site, pageKind, adapterVersion), opponent, and starts the session with the current position", () => {
		const { feed, handle } = boot("chesscom-live");
		expect(handle.site).toBe("chesscom");
		expect(handle.pageKind()).toBe("live-game");
		expect(feed.posts[0]).toEqual({
			kind: "hello",
			site: "chesscom",
			pageKind: "live-game",
			adapterVersion: "t1",
		});
		expect(feed.of("opponent")[0]).toEqual({
			kind: "opponent",
			isBot: false,
			name: "MagnusFan99",
			ratingEstimate: 1850,
		});
		const started = feed.of("gameStarted");
		expect(started).toHaveLength(1);
		expect(started[0]?.game.gameId).toBe("173765478164");
		expect(started[0]?.game.myColor).toBe("w");
		const positions = feed.of("position");
		expect(positions).toHaveLength(1);
		expect(positions[0]?.snapshot.ply).toBe(6);
		expect(typeof positions[0]?.snapshot.capturedAt).toBe("number");
		// Deliberate change (2026-09-10): this used to assert the flag was *stripped*. The service
		// worker cannot otherwise tell a FEN the page gave us from one the adapter reconstructed from
		// the DOM, whose `fullmove` is derived from the move-list ply — and a first-move decision must
		// not trust that (§13.4, the 2026-09-10 ruling). The flag now travels, and this asserts its
		// value rather than its absence.
		expect(positions[0]?.snapshot.approximate).toBe(false);
		expect(feed.posts.findIndex((m) => m.kind === "gameStarted")).toBeLessThan(
			feed.posts.findIndex((m) => m.kind === "position")
		);
	});
	it("starts a session on the vs-computer page too (V2.1), with the bot opponent", () => {
		const { feed, handle } = boot("chesscom-computer");
		expect(handle.pageKind()).toBe("vs-computer");
		expect(feed.of("gameStarted")).toHaveLength(1);
		expect(feed.of("opponent")[0]?.isBot).toBe(true);
	});
	it("starts a session and answers geometry on a WebGL canvas board (no DOM pieces)", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ fen: WEBGL_FEN, mode: "playing", playingAs: 1 }));
		const { feed, dom, handle } = boot("chesscom-webgl", { bridge });
		await waitFor(() => feed.of("gameStarted").length === 1, 2_000);
		expect(handle.pageKind()).toBe("live-game");
		expect(feed.of("gameStarted")[0]?.game.gameId).toBe("174252022572");
		expect(feed.of("gameStarted")[0]?.game.myColor).toBe("w");
		expect(feed.of("position").at(-1)?.snapshot.fen).toBe(WEBGL_FEN);
		expect(feed.of("position").at(-1)?.snapshot.ply).toBe(6);
		// geometry and occupancy come from the rect and the published FEN, not from `.piece`
		dom.layout("wc-chess-board", WEBGL_BOARD);
		feed.command({ kind: "geometry", id: "wg" });
		const g = feed.of("geometryResult").at(-1);
		expect(g?.flipped).toBe(false);
		expect(Object.keys(g?.squares ?? {})).toHaveLength(64);
		expect(g?.squares?.a1).toMatchObject({ x: WEBGL_BOARD.x, y: WEBGL_BOARD.y + 7 * 88 });
		expect(g?.occupancy?.e1).toBe("own");
		expect(g?.occupancy?.e4).toBe("enemy");
		expect(g?.occupancy?.d5).toBe("empty");
	});
	it("reports the board rect when the page moves it, and not when it has not moved (§9.5)", async () => {
		const { dom, feed } = boot("chesscom-live");
		dom.layout("wc-chess-board", BOARD_RECT);
		fire(dom, "window", "resize");
		await waitFor(() => feed.of("boardRect").length > 0, 2_000);
		expect(feed.of("boardRect").at(-1)?.rect).toEqual({
			left: BOARD_RECT.x,
			top: BOARD_RECT.y,
			width: BOARD_RECT.width,
			height: BOARD_RECT.height,
		});
		const reported = feed.of("boardRect").length;

		// a resize that moved nothing is not a change: it must not rearm the settle window the
		// executor waits on after an attach
		fire(dom, "window", "resize");
		fire(dom, "window", "scroll");
		await sleep(20);
		expect(feed.of("boardRect")).toHaveLength(reported);

		// the debugger's infobar: the page — and the board with it — shifts down
		dom.layout("wc-chess-board", { ...BOARD_RECT, y: BOARD_RECT.y + 48 });
		fire(dom, "window", "resize");
		await waitFor(() => feed.of("boardRect").length > reported, 2_000);
		expect(feed.of("boardRect").at(-1)?.rect.top).toBe(BOARD_RECT.y + 48);
	});
	it("sends the site's own time control on the position, after `gameStarted` has gone without it", async () => {
		// §4.3 end to end through the real content script: the page's `{baseTime, increment}` is
		// what reaches the service worker, not a value a fixture put on the snapshot.
		//
		// And the ORDER is the production order, which is why `GameSession.reprofile()` is
		// load-bearing rather than the dead code the final review found it to be: the session is
		// started from the first readable snapshot, which is taken before the MAIN-world bridge has
		// answered anything, so `gameStarted` carries no time control at all. The first `position`
		// to carry one arrives afterwards, on a position that has not moved.
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({
			fen: WEBGL_FEN,
			mode: "playing",
			playingAs: 1,
			timeControl: { baseTime: 180_000, increment: 0 },
		}));
		const { feed } = boot("chesscom-webgl", { bridge });
		await waitFor(() => feed.of("gameStarted").length === 1, 2_000);
		expect(feed.of("gameStarted")[0]?.game.timeControl).toBeUndefined();
		await waitFor(() => feed.of("position").at(-1)?.snapshot.timeControl !== undefined, 2_000);
		expect(feed.of("position").at(-1)?.snapshot.timeControl).toEqual({
			baseMs: 180_000,
			incMs: 0,
		});
		// the same ply, republished — not a new position
		expect(feed.of("position").at(-1)?.snapshot.fen).toBe(WEBGL_FEN);
		expect(feed.of("position").at(0)?.snapshot.timeControl).toBeUndefined();
	});
	it("does not start a session on a non-live page, and re-detects the page kind on popstate", async () => {
		const { feed, handle, dom } = boot("chesscom-live");
		dom.window.history.pushState({}, "", "/analysis/game/live/1");
		fire(dom, "window", "popstate");
		await waitFor(() => handle.pageKind() === "analysis");
		expect(feed.of("hello").at(-1)?.pageKind).toBe("analysis");
		expect(feed.of("hello")).toHaveLength(2);
		dom.window.history.pushState({}, "", "/play/computer");
		fire(dom, "window", "popstate");
		await waitFor(() => handle.pageKind() === "vs-computer");
		expect(feed.of("hello")).toHaveLength(3);
		expect(feed.of("gameStarted")).toHaveLength(1); // same game id: no second start
	});
	it("forwards position snapshots (with capturedAt) and moveObserved when the board changes", async () => {
		const { feed, dom } = boot("chesscom-live");
		const before = Date.now();
		playD4(dom);
		await waitFor(() => feed.of("position").length === 2, 2_000);
		const snap = feed.of("position")[1]?.snapshot;
		expect(snap?.ply).toBe(7);
		expect(snap?.sideToMove).toBe("b");
		expect(snap?.capturedAt ?? 0).toBeGreaterThanOrEqual(before);
		const moved = feed.of("moveObserved").at(-1);
		expect(moved).toEqual({
			kind: "moveObserved",
			san: "d4",
			ply: 7,
			byMe: true,
			atMs: snap?.capturedAt ?? 0,
		});
	});
	it("forwards every focus / blur / visibilitychange edge as { kind: 'focus' } (§13.4)", () => {
		const { feed, dom } = boot("chesscom-live");
		// One edge is already there: `installFocusEdges` reports the state at install, so the service
		// worker knows whether the page has focus without waiting for the first edge (§13.4).
		expect(feed.of("focus")).toHaveLength(1);
		fire(dom, "window", "blur");
		fire(dom, "window", "focus");
		fire(dom, "document", "visibilitychange");
		const edges = feed.of("focus").slice(1);
		expect(edges).toHaveLength(3);
		for (const e of edges) {
			expect(typeof e.hasFocus).toBe("boolean");
			expect(e.visibility).toBe("visible");
			expect(typeof e.at).toBe("number");
		}
	});
});

describe("content entry — commands", () => {
	it("releases stale pointer isolation only when a safe restart control is ready, then acknowledges its click", () => {
		const { dom, feed, bridge } = boot("chesscom-gameover");
		dom.layout("button", { x: 200, y: 200, width: 150, height: 40 });
		const next = dom.query('[data-cy="game-over-modal-new-game-button"]');
		let clicked = 0;
		next.addEventListener("click", () => clicked++);
		feed.command({ kind: "cursorTo", x: 100, y: 100, down: false });
		feed.command({ kind: "startNewGame", id: "stale", gameId: "old-game" });
		expect(clicked).toBe(0);
		expect(bridge.notified.some((message) => message.kind === "cursorHide")).toBe(false);
		expect(feed.of("startNewGameResult").at(-1)?.status).toBe("in-game");
		feed.command({ kind: "startNewGame", id: "next", gameId: "173765478165" });
		expect(clicked).toBe(1);
		expect(bridge.notified.at(-1)?.kind).toBe("cursorHide");
		expect(feed.of("startNewGameResult").at(-1)).toEqual({
			kind: "startNewGameResult",
			id: "next",
			status: "started",
		});
	});

	it("acknowledges a delayed New Game control and never falls back to Rematch or cancels a search", () => {
		const { dom, feed } = boot("chesscom-gameover");
		for (const button of dom.document.querySelectorAll("button")) {
			if (!button.textContent?.includes("Rematch")) button.remove();
		}
		dom.layout("button", { x: 200, y: 200, width: 150, height: 40 });
		let rematches = 0;
		for (const button of dom.document.querySelectorAll("button"))
			button.addEventListener("click", () => rematches++);
		feed.command({ kind: "startNewGame", id: "waiting", gameId: null });
		expect(feed.of("startNewGameResult").at(-1)?.status).toBe("not-ready");
		expect(rematches).toBe(0);
		dom
			.query(".new-game-buttons-component")
			.insertAdjacentHTML("beforeend", '<button aria-label="New Game">New Game</button>');
		dom.layout('button[aria-label="New Game"]', { x: 200, y: 200, width: 150, height: 40 });
		const next = dom.query('button[aria-label="New Game"]');
		let started = 0;
		next.addEventListener("click", () => {
			started++;
			next.textContent = "Cancel";
		});
		feed.command({ kind: "startNewGame", id: "ready", gameId: null });
		feed.command({ kind: "startNewGame", id: "search", gameId: null });
		expect(started).toBe(1);
		expect(rematches).toBe(0);
		expect(feed.of("startNewGameResult").map((message) => message.status)).toEqual([
			"not-ready",
			"started",
			"searching",
		]);
	});

	it("highlight/arrow are not drawn while highlightMoves is off; drawn after settings turns it on; observeMove leaves the mark alone", async () => {
		const { feed, bridge, dom } = boot("chesscom-live");
		await waitFor(() => bridge.callsOf("getState").length > 0);
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		feed.command({ kind: "arrow", lines: [{ from: "g1", to: "f3", weight: 1 }] });
		await sleep(10);
		expect(bridge.callsOf("draw")).toHaveLength(0);
		feed.command({ kind: "settings", highlightMoves: true });
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		await sleep(10);
		expect(bridge.callsOf("draw")).toHaveLength(1);
		expect(bridge.callsOf("draw")[0]?.payload).toEqual({
			highlights: [
				{ square: "d2", color: expect.any(String) },
				{ square: "d4", color: expect.any(String) },
			],
			arrows: [{ from: "d2", to: "d4", color: expect.any(String) }],
			// The overlay branch draws from screen coordinates, so every draw carries the
			// orientation; nothing sent it before and an overlay mark was mirrored for black.
			orientation: "white",
		});
		// a second mark replaces the first rather than stacking on it: native `game.markings` only
		// ever *adds*, so a redraw without this clear left the old squares on the board for good
		feed.command({ kind: "arrow", lines: [{ from: "g1", to: "f3", weight: 1 }] });
		expect(bridge.callsOf("draw")).toHaveLength(2);
		expect(bridge.callsOf("clear")).toHaveLength(1);
		expect(bridge.calls.at(-2)?.kind).toBe("clear");

		// §13.3 rule 4 used to make this a clear ("no mark at move-submission time") and the two
		// assertions below were its inverse. The owner has overruled the rule for the mark of the
		// move being submitted (2026-09-10): `observeMove` is the *verifier*, `runWithRetry` issues
		// one after every attempt and before every retry, so a clear here left tier 2 — a whole
		// second visible action — running with nothing on the board. Completion is the only clear
		// now, and it comes from the service worker.
		const bridgeCallsBefore = bridge.calls.length;
		feed.command({
			kind: "observeMove",
			id: "m1",
			expected: { from: "d2", to: "d4" },
			timeoutMs: 300,
		});
		expect(bridge.calls.length).toBe(bridgeCallsBefore); // the verifier touches nothing
		expect(bridge.callsOf("clear")).toHaveLength(1);
		await sleep(10);
		expect(bridge.callsOf("clear")).toHaveLength(1); // …and nothing clears later either
		playD4(dom);
		await waitFor(() => feed.of("observeMoveResult").length === 1, 2_000);
		expect(feed.of("observeMoveResult")[0]).toEqual({
			kind: "observeMoveResult",
			id: "m1",
			ok: true,
		});

		// `highlightMoves` going off still clears — that is a different thing from the verifier.
		feed.command({ kind: "settings", highlightMoves: false });
		feed.command({ kind: "highlight", from: "e2", to: "e4", style: "squares" });
		expect(bridge.callsOf("draw")).toHaveLength(2);
		expect(bridge.callsOf("clear")).toHaveLength(2);
		feed.command({ kind: "clearHighlight" }); // nothing drawn: no extra bridge call
		expect(bridge.callsOf("clear")).toHaveLength(2);
	});
	// Fix A (the owner's live report, 2026-09-10): the mark of the move the hand is playing must be
	// ours, not one of the site's markings, so it survives the presses the action is made of.
	it("a highlight command carrying `overlay` asks the bridge for a forced-overlay draw", async () => {
		const { feed, bridge } = boot("chesscom-live");
		await waitFor(() => bridge.callsOf("getState").length > 0);
		feed.command({ kind: "settings", highlightMoves: true });
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		await sleep(10);
		// The ordinary recommendation mark is unchanged: native markings, no flag on the wire.
		expect(bridge.callsOf("draw")).toHaveLength(1);
		expect(bridge.callsOf("draw")[0]?.payload).not.toHaveProperty("forceOverlay");

		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "both", overlay: true });
		await sleep(10);
		expect(bridge.callsOf("draw")).toHaveLength(2);
		expect(bridge.callsOf("draw")[1]?.payload).toMatchObject({
			forceOverlay: true,
			orientation: "white",
			highlights: [
				{ square: "d2", color: expect.any(String) },
				{ square: "d4", color: expect.any(String) },
			],
		});
		// One bridge call, not two: the page program removes our native markings inside the same
		// `draw`, so the board is never unmarked for a frame — the hand is already acting by then.
		expect(bridge.calls.at(-1)?.kind).toBe("draw");
		expect(bridge.callsOf("clear")).toHaveLength(0);
	});
	// The page dropped its own record of the native keys inside that `draw` (it answers `{keys: []}`),
	// so this side has to drop it too. Otherwise the next `clear` names keys the page no longer
	// holds, and a keyless clear — which means "everything of ours" and is what actually heals a
	// draw that never arrived — never gets sent.
	it("a forced-overlay draw makes this side forget the native keys it replaced", async () => {
		const { feed, bridge } = boot("chesscom-live");
		// What the real page answers (`boot` installs a flat `{keys:["k1"]}`, so this replaces it):
		// keys for a native draw, none for a forced-overlay one — the page has just dropped them.
		bridge.responses.set("draw", (payload) =>
			(payload as { forceOverlay?: boolean })?.forceOverlay === true
				? { keys: [] }
				: { keys: ["highlight|d2", "highlight|d4"] }
		);
		await waitFor(() => bridge.callsOf("getState").length > 0);
		feed.command({ kind: "settings", highlightMoves: true });

		// A native draw: the page reports its keys and this side records them, so a clear names them.
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "squares" });
		await sleep(10);
		feed.command({ kind: "clearHighlight" });
		await sleep(10);
		expect(bridge.callsOf("clear").at(-1)?.payload).toEqual({
			keys: ["highlight|d2", "highlight|d4"],
		});

		// Draw natively again, then replace it with a forced-overlay draw: the keys are gone from
		// the page, so the next clear must be the keyless "everything of ours" form.
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "squares" });
		await sleep(10);
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "squares", overlay: true });
		await sleep(10);
		feed.command({ kind: "clearHighlight" });
		await sleep(10);
		expect(bridge.callsOf("clear").at(-1)?.payload).toEqual({});
	});
	it("the forced-overlay draw reports the orientation the board is actually in", async () => {
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({ flipped: true, playingAs: "b", turn: "w" }));
		const { feed } = boot("chesscom-live", { bridge });
		await waitFor(() => bridge.callsOf("getState").length > 0);
		feed.command({ kind: "settings", highlightMoves: true });
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "both", overlay: true });
		await sleep(10);
		expect(bridge.callsOf("draw").at(-1)?.payload).toMatchObject({
			forceOverlay: true,
			orientation: "black",
		});
	});
	// This test used to assert the opposite: `observeMove` cleared the mark first and did not start
	// watching until the page had acknowledged the clear. That contract is overruled (2026-09-10)
	// and its replacement is the stronger one — the verifier starts watching at once and never
	// touches the mark, so a page side that never answers a `clear` cannot hold the verifier up.
	it("observeMove starts watching at once, clears nothing, and is not held up by an unanswered clear", async () => {
		const { feed, bridge } = boot("chesscom-live");
		await waitFor(() => bridge.callsOf("getState").length > 0);
		// A `clear` that never resolves: nothing in the verifier path may await it.
		bridge.responses.set("clear", () => new Promise<void>(() => {}));
		feed.command({ kind: "settings", highlightMoves: true });
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		await sleep(10);
		const drawn = bridge.calls.length;
		feed.command({
			kind: "observeMove",
			id: "m3",
			expected: { from: "d5", to: "d6" }, // empty origin: the adapter answers at once IF watching
			timeoutMs: 400,
		});
		await waitFor(() => feed.of("observeMoveResult").length === 1, 2_000);
		expect(feed.of("observeMoveResult")[0]).toEqual({
			kind: "observeMoveResult",
			id: "m3",
			ok: false,
			reason: "not-landed",
		});
		expect(bridge.calls.length).toBe(drawn);
		expect(bridge.callsOf("clear")).toHaveLength(0);
	});
	it("cursorProbe answers from the bridge closure, else from the ISOLATED tracker, else null", async () => {
		const { feed, bridge, dom } = boot("chesscom-live");
		await waitFor(() => bridge.callsOf("getState").length > 0);
		feed.command({ kind: "cursorProbe", id: "c0" });
		await sleep(10);
		// the fake bridge has no `cursor` handler → rejected → tracker has nothing yet → null
		expect(feed.of("cursorProbeResult")[0]).toEqual({
			kind: "cursorProbeResult",
			id: "c0",
			position: null,
		});
		bridge.responses.set("cursor", () => ({ x: 11, y: 22, t: 33 }));
		feed.command({ kind: "cursorProbe", id: "c1" });
		await sleep(10);
		expect(feed.of("cursorProbeResult")[1]).toEqual({
			kind: "cursorProbeResult",
			id: "c1",
			position: { x: 11, y: 22, t: 33, real: true },
		});
		expect(bridge.callsOf("cursor")).toHaveLength(2); // c0 (rejected) and c1
		// bridge answers null (no trusted pointer seen in MAIN) → the tracker's last trusted sample
		bridge.responses.set("cursor", () => null);
		const ev = new dom.window.PointerEvent("pointermove", { clientX: 5, clientY: 6, bubbles: true });
		Object.defineProperty(ev, "isTrusted", { value: true });
		dom.document.body.dispatchEvent(ev);
		feed.command({ kind: "cursorProbe", id: "c2" });
		await sleep(10);
		expect(feed.of("cursorProbeResult")[2]?.position).toMatchObject({ x: 5, y: 6, real: true });
		// bridge unavailable → tracker directly, no bridge call
		bridge.available = false;
		feed.command({ kind: "cursorProbe", id: "c3" });
		await sleep(10);
		expect(feed.of("cursorProbeResult")[3]?.position).toMatchObject({ x: 5, y: 6, real: true });
		expect(bridge.callsOf("cursor")).toHaveLength(3); // c3 never reached the bridge
	});
	it("observeMove answers ok:false with a reason when the move never lands", async () => {
		const { feed } = boot("chesscom-live");
		feed.command({
			kind: "observeMove",
			id: "m2",
			expected: { from: "a2", to: "a3" },
			timeoutMs: 50,
		});
		await waitFor(() => feed.of("observeMoveResult").length === 1);
		expect(feed.of("observeMoveResult")[0]).toEqual({
			kind: "observeMoveResult",
			id: "m2",
			ok: false,
			reason: "not-landed",
		});
	});
	it("geometry answers with the board rect, all 64 squares and the orientation", () => {
		const { feed, dom } = boot("chesscom-live");
		feed.command({ kind: "geometry", id: "g0" });
		const empty = feed.of("geometryResult")[0];
		expect(empty?.boardRect.width).toBe(0);
		expect(empty?.squares).toBeUndefined();
		dom.layout("wc-chess-board", BOARD_RECT);
		feed.command({ kind: "geometry", id: "g1" });
		const g = feed.of("geometryResult")[1];
		expect(g?.id).toBe("g1");
		expect(g?.flipped).toBe(false);
		expect(g?.boardRect).toMatchObject({ x: 100, y: 100, width: 528, height: 528 });
		expect(Object.keys(g?.squares ?? {})).toHaveLength(64);
		expect(g?.squares?.a1).toMatchObject({ x: 100, y: 100 + 7 * 66, width: 66, height: 66 });
		expect(g?.promotion).toBeUndefined();
	});
	it("ignores speak (TTS lives in the SW), stores keybinds, and startNewGame clicks the site's button", () => {
		const { feed, dom } = boot("chesscom-gameover");
		dom.layout("button", { x: 200, y: 200, width: 150, height: 40 });
		const before = feed.posts.length;
		feed.command({ kind: "speak", text: "knight f3" });
		feed.command({
			kind: "keybinds",
			keybinds: {
				playMove: {
					key: "p",
					code: "KeyP",
					altKey: false,
					ctrlKey: false,
					metaKey: false,
					shiftKey: false,
				},
				toggleAutoMove: {
					key: "a",
					code: "KeyA",
					altKey: false,
					ctrlKey: false,
					metaKey: false,
					shiftKey: true,
				},
				disable: {
					key: "x",
					code: "KeyX",
					altKey: false,
					ctrlKey: false,
					metaKey: false,
					shiftKey: true,
				},
				speakMove: {
					key: "w",
					code: "KeyW",
					altKey: false,
					ctrlKey: false,
					metaKey: false,
					shiftKey: false,
				},
				global: false,
			},
		});
		feed.command({ kind: "startNewGame", id: "next", gameId: null });
		expect(feed.posts.length).toBe(before + 1);
		expect(feed.of("startNewGameResult")).toEqual([
			{ kind: "startNewGameResult", id: "next", status: "started" },
		]);
	});
	it("never touches page storage while booting and feeding", async () => {
		const dom = loadFixture("chesscom-live");
		cleanups.push(installWindowGlobals(dom.window));
		const spy = spyPageStorage(dom.window, dom.document);
		cleanups.push(spy.restore);
		const { factory, feed } = fakeFeed();
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({}));
		const handle = startContent({
			window: pageWindow(dom),
			document: pageDocument(dom),
			bridge,
			port: factory,
		});
		cleanups.push(() => handle?.dispose());
		playD4(dom);
		await waitFor(() => feed.of("position").length === 2, 2_000);
		expect(spy.hits()).toBe(0);
	});
	it("dispose stops feeding and releases listeners", async () => {
		const { feed, dom, handle } = boot("chesscom-live");
		handle.dispose();
		const n = feed.posts.length;
		fire(dom, "window", "blur");
		playD4(dom);
		await sleep(150);
		expect(feed.posts.length).toBe(n);
		handle.dispose(); // idempotent
	});
});

describe("content entry — document_start (no <body> yet)", () => {
	it("boots without throwing on a body-less document, defers the adapter, and completes once the body appears", async () => {
		const dom = createTabDom("https://www.chess.com/game/live/173765478164");
		cleanups.push(installWindowGlobals(dom.window));
		dom.document.documentElement.innerHTML = "<head></head>";
		dom.document.body?.remove(); // happy-dom synthesises a body; the parser has not reached it yet
		expect(dom.document.body).toBeNull();
		const { feed, factory } = fakeFeed();
		const bridge = new FakeBridge();
		bridge.responses.set("getState", () => ({}));
		const handle = startContent({
			window: pageWindow(dom),
			document: pageDocument(dom),
			bridge,
			port: factory,
			adapterVersion: "t1",
		});
		if (!handle) throw new Error("null handle");
		cleanups.push(() => handle.dispose());
		expect(handle.site).toBe("chesscom");
		expect(handle.pageKind()).toBe("live-game"); // from the URL alone
		expect(handle.adapter()).toBeNull();
		expect(feed.posts).toEqual([]);
		// the parser reaches <body> and the page renders the board
		loadFixtureInto(dom, "chesscom-live");
		installPollingObserver(dom);
		expect(dom.document.body).not.toBeNull();
		fire(dom, "document", "DOMContentLoaded");
		expect(handle.adapter()).not.toBeNull();
		expect(feed.posts[0]).toMatchObject({ kind: "hello", site: "chesscom", pageKind: "live-game" });
		expect(feed.of("gameStarted")).toHaveLength(1);
		expect(feed.of("position")[0]?.snapshot.ply).toBe(6);
	});
	it("completes the deferred boot from the readiness poll when no DOMContentLoaded arrives", async () => {
		const dom = createTabDom("https://www.chess.com/game/174252022572");
		cleanups.push(installWindowGlobals(dom.window));
		dom.document.documentElement.innerHTML = "<head></head>";
		dom.document.body?.remove();
		const { feed, factory } = fakeFeed();
		const handle = startContent({
			window: pageWindow(dom),
			document: pageDocument(dom),
			bridge: new FakeBridge(),
			port: factory,
		});
		if (!handle) throw new Error("null handle");
		cleanups.push(() => handle.dispose());
		expect(handle.adapter()).toBeNull();
		loadFixtureInto(dom, "chesscom-live");
		await waitFor(() => handle.adapter() !== null, TIMINGS.contentReadyPollMs * 4);
		expect(feed.posts[0]).toMatchObject({ kind: "hello", site: "chesscom" });
	});
});

describe("content sources (§13.3 rule 2, §9)", () => {
	const ROOT = path.resolve(import.meta.dir, "../..");
	const FORBIDDEN =
		/localStorage|sessionStorage|indexedDB|document\.cookie|dispatchEvent|new PointerEvent|new MouseEvent|speechSynthesis/;
	function walk(dir: string, out: string[]): string[] {
		for (const e of readdirSync(dir)) {
			const p = path.join(dir, e);
			if (statSync(p).isDirectory()) walk(p, out);
			else if (p.endsWith(".ts")) out.push(p);
		}
		return out;
	}
	it("src/content/** and src/page/** contain no page-storage, synthetic-event or speech API usage", () => {
		const files = [
			...walk(path.join(ROOT, "src/content"), []),
			...walk(path.join(ROOT, "src/page"), []),
		];
		expect(files.length).toBeGreaterThan(10);
		const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));
		expect(offenders).toEqual([]);
	});
	it("the built content bundle, when present, is clean too", () => {
		const bundle = path.join(ROOT, "dist/js/content.js");
		try {
			statSync(bundle);
		} catch {
			return; // no build in this checkout
		}
		expect(FORBIDDEN.test(readFileSync(bundle, "utf8"))).toBe(false);
	});
});

type _Handle = ContentHandle;

describe("content entry — executor responders (Task 30)", () => {
	it("geometry carries colour-aware occupancy for the whole board", () => {
		const { feed, dom } = boot("chesscom-live");
		dom.layout("wc-chess-board", BOARD_RECT);
		feed.command({ kind: "geometry", id: "occ" });
		const g = feed.of("geometryResult").at(-1);
		const occ = g?.occupancy;
		expect(occ).toBeDefined();
		// The fixture is a live chess.com game played as White after 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6.
		expect(occ?.e1).toBe("own");
		expect(occ?.e8).toBe("enemy");
		expect(occ?.d5).toBe("empty");
	});

	it("boardCheck answers exactly the squares asked, own/enemy relative to my colour", () => {
		const { feed } = boot("chesscom-live");
		feed.command({ kind: "boardCheck", id: "b1", squares: ["e1", "e8", "d4"] });
		const reply = feed.of("boardCheckResult")[0];
		expect(reply?.id).toBe("b1");
		expect(Object.keys(reply?.occupancy ?? {}).sort()).toEqual(["d4", "e1", "e8"]);
		expect(reply?.occupancy.e1).toBe("own");
		expect(reply?.occupancy.e8).toBe("enemy");
		expect(reply?.occupancy.d4).toBe("empty");
	});

	it("geometry { promotion, to } waits for the picker and reports null when it never appears", async () => {
		const { feed, dom } = boot("chesscom-live");
		dom.layout("wc-chess-board", BOARD_RECT);
		const before = feed.of("geometryResult").length;
		feed.command({ kind: "geometry", id: "p1", promotion: "q", to: "e8", timeoutMs: 30 });
		await waitFor(() => feed.of("geometryResult").length > before, 500);
		const reply = feed.of("geometryResult").at(-1);
		expect(reply?.id).toBe("p1");
		expect(reply?.promotion).toBeNull();
	});

	it("geometry { promotion, to } answers with the picker rect once it is up", async () => {
		const { feed, dom } = boot("chesscom-live");
		dom.layout("wc-chess-board", BOARD_RECT);
		const before = feed.of("geometryResult").length;
		feed.command({ kind: "geometry", id: "p2", promotion: "q", to: "e8", timeoutMs: 400 });
		dom
			.query("wc-chess-board")
			.insertAdjacentHTML(
				"afterbegin",
				'<div class="promotion-window"><div class="promotion-piece wq"></div>' +
					'<div class="promotion-piece wr"></div><div class="promotion-piece wb"></div>' +
					'<div class="promotion-piece wn"></div></div>'
			);
		dom.layout(".promotion-piece.wq", { x: 300, y: 100, width: 66, height: 66 });
		await waitFor(() => (feed.of("geometryResult").at(-1)?.promotion ?? null) !== null, 800);
		const reply = feed.of("geometryResult").at(-1);
		expect(reply?.id).toBe("p2");
		expect(reply?.promotion).toMatchObject({ x: 300, y: 100, width: 66, height: 66 });
	});
});

describe("content entry — the pointer mirror (Fix D)", () => {
	it("acknowledges cold and display-disabled input without waiting for a mirror that is not drawn", async () => {
		const { feed, bridge } = boot("chesscom-live");
		const pointer = {
			type: "mousePressed" as const,
			x: 120,
			y: 240,
			buttons: 1,
			timestampMs: Date.now(),
		};
		feed.command({ kind: "cursorPrepare", id: "cold", pointer });
		await waitFor(() => feed.of("cursorPrepared").length === 1);
		expect(bridge.callsOf("cursorPrepare")).toHaveLength(0);
		feed.command({ kind: "cursorHide" });
		feed.command({ kind: "cursorPrepare", id: "display-off", pointer });
		await waitFor(() => feed.of("cursorPrepared").length === 2);
		expect(bridge.callsOf("cursorPrepare")).toHaveLength(0);
		expect(bridge.notified).toHaveLength(0);
	});
	it("waits for the page hit-test aperture before acknowledging pointer admission", async () => {
		const { feed, bridge } = boot("chesscom-live");
		let finish: (value: boolean) => void = () => {};
		bridge.responses.set(
			"cursorPrepare",
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				})
		);
		feed.command({ kind: "cursorTo", x: 100, y: 200, down: false });
		const pointer = {
			type: "mouseMoved" as const,
			x: 120,
			y: 240,
			buttons: 0,
			timestampMs: Date.now(),
		};
		feed.command({ kind: "cursorPrepare", id: "pointer-one", pointer });
		expect(feed.of("cursorPrepared")).toHaveLength(0);
		expect(bridge.callsOf("cursorPrepare")[0]?.payload).toEqual({ x: 120, y: 240 });
		finish(true);
		await waitFor(() => feed.of("cursorPrepared").length === 1);
		feed.command({ kind: "cursorPrepare", id: "pointer-late", pointer });
		feed.command({ kind: "cursorHide" });
		finish(true);
		await sleep(0);
		expect(feed.of("cursorPrepared")).toEqual([{ kind: "cursorPrepared", id: "pointer-one" }]);
	});
	it("relays `cursorTo` / `cursorHide` to the bridge without a round trip, and erases it on dispose", () => {
		const { feed, bridge, handle } = boot("chesscom-live");
		expect(bridge.notified).toHaveLength(0);
		feed.command({ kind: "cursorTo", x: 410, y: 320, down: false });
		feed.command({ kind: "cursorTo", x: 412, y: 318, down: true });
		expect(bridge.notified).toEqual([
			{ kind: "cursorTo", payload: { x: 410, y: 320, down: false } },
			{ kind: "cursorTo", payload: { x: 412, y: 318, down: true } },
		]);
		// never a correlated call: the stream is one command per dispatched point
		expect(bridge.callsOf("cursorTo")).toHaveLength(0);
		// and the mirror is not a position report back to the service worker
		expect(feed.of("cursor")).toHaveLength(0);

		feed.command({ kind: "cursorHide" });
		expect(bridge.notified.at(-1)).toEqual({ kind: "cursorHide", payload: undefined });
		handle.dispose();
		// already hidden: dispose adds nothing
		expect(bridge.notified.filter((n) => n.kind === "cursorHide")).toHaveLength(1);
	});

	it("erases a drawn mirror when the content script is disposed", () => {
		const { feed, bridge, handle } = boot("chesscom-live");
		feed.command({ kind: "cursorTo", x: 1, y: 2, down: false });
		handle.dispose();
		expect(bridge.notified.at(-1)).toEqual({ kind: "cursorHide", payload: undefined });
	});
});

it("installs pointer capture before the deferred board boot and restores input on dispose", async () => {
	const dom = createTabDom("https://www.chess.com/game/live/173765478164");
	cleanups.push(installWindowGlobals(dom.window));
	dom.document.documentElement.innerHTML = "<head></head>";
	dom.document.body?.remove();
	const { feed, factory } = fakeFeed();
	const bridge = new FakeBridge();
	bridge.responses.set("getState", () => ({}));
	const handle = startContent({
		window: pageWindow(dom),
		document: pageDocument(dom),
		bridge,
		port: factory,
	});
	cleanups.push(() => handle?.dispose());
	let reachedPage = 0;
	dom.window.addEventListener(
		"pointerdown",
		() => {
			reachedPage += 1;
		},
		true
	);
	const body = dom.document.createElement("body");
	dom.document.documentElement.appendChild(body);
	dom.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
	await waitFor(() => feed.of("hello").length === 1, 1000);
	feed.command({ kind: "cursorTo", x: 50, y: 60, down: false });
	const move = () => {
		const event = new dom.window.PointerEvent("pointerdown", {
			clientX: 200,
			clientY: 300,
			buttons: 1,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(event, "isTrusted", { value: true });
		body.dispatchEvent(event);
		return event;
	};
	expect(move().defaultPrevented).toBe(true);
	expect(reachedPage).toBe(0);
	handle?.dispose();
	expect(move().defaultPrevented).toBe(false);
	expect(reachedPage).toBe(1);
});
