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
	bridge.responses.set("getState", () => ({}));
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

describe("site-detect", () => {
	it("maps hostnames to Site through SITE_MATCHES", () => {
		expect(hostOfMatchPattern("*://*.chess.com/*")).toBe("chess.com");
		expect(hostOfMatchPattern("nonsense")).toBeNull();
		expect(detectSite("www.chess.com")).toBe("chesscom");
		expect(detectSite("chess.com")).toBe("chesscom");
		expect(detectSite("LICHESS.org")).toBe("lichess");
		expect(detectSite("lichess.org")).toBe("lichess");
		expect(detectSite("notchess.com")).toBeNull();
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
		expect("approximate" in (positions[0]?.snapshot ?? {})).toBe(false);
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
		fire(dom, "window", "blur");
		fire(dom, "window", "focus");
		fire(dom, "document", "visibilitychange");
		const edges = feed.of("focus");
		expect(edges).toHaveLength(3);
		for (const e of edges) {
			expect(typeof e.hasFocus).toBe("boolean");
			expect(e.visibility).toBe("visible");
			expect(typeof e.at).toBe("number");
		}
	});
});

describe("content entry — commands", () => {
	it("highlight/arrow are not drawn while highlightMoves is off; drawn after settings turns it on; cleared before observeMove", async () => {
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
		});
		feed.command({ kind: "arrow", lines: [{ from: "g1", to: "f3", weight: 1 }] });
		expect(bridge.callsOf("draw")).toHaveLength(2);
		expect(bridge.callsOf("clear")).toHaveLength(0);

		feed.command({
			kind: "observeMove",
			id: "m1",
			expected: { from: "d2", to: "d4" },
			timeoutMs: 300,
		});
		expect(bridge.calls.at(-1)?.kind).toBe("clear"); // cleared before the hand moves
		await sleep(10); // the clear is acknowledged, the watch is armed
		playD4(dom);
		await waitFor(() => feed.of("observeMoveResult").length === 1, 2_000);
		expect(feed.of("observeMoveResult")[0]).toEqual({
			kind: "observeMoveResult",
			id: "m1",
			ok: true,
		});

		feed.command({ kind: "settings", highlightMoves: false });
		feed.command({ kind: "highlight", from: "e2", to: "e4", style: "squares" });
		expect(bridge.callsOf("draw")).toHaveLength(2);
		feed.command({ kind: "clearHighlight" }); // nothing drawn: no extra bridge call
		expect(bridge.callsOf("clear")).toHaveLength(1);
	});
	it("observeMove waits for the page side to acknowledge the clear before watching the board", async () => {
		const { feed, bridge, dom } = boot("chesscom-live");
		await waitFor(() => bridge.callsOf("getState").length > 0);
		let ackClear: () => void = () => {};
		bridge.responses.set(
			"clear",
			() =>
				new Promise<void>((r) => {
					ackClear = r;
				})
		);
		feed.command({ kind: "settings", highlightMoves: true });
		feed.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		await sleep(10);
		feed.command({
			kind: "observeMove",
			id: "m3",
			expected: { from: "d5", to: "d6" }, // empty origin: the adapter answers at once IF watching
			timeoutMs: 400,
		});
		await sleep(10);
		expect(bridge.calls.at(-1)?.kind).toBe("clear");
		await sleep(100);
		expect(feed.of("observeMoveResult")).toHaveLength(0); // still waiting for the clear ack
		ackClear();
		await waitFor(() => feed.of("observeMoveResult").length === 1, 2_000);
		expect(feed.of("observeMoveResult")[0]).toEqual({
			kind: "observeMoveResult",
			id: "m3",
			ok: false,
			reason: "not-landed",
		});
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
		const { feed } = boot("chesscom-gameover");
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
		feed.command({ kind: "startNewGame" });
		expect(feed.posts.length).toBe(before);
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
		const dom = createTabDom("https://lichess.org/abcdefgh1234");
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
		loadFixtureInto(dom, "lichess-round-white");
		await waitFor(() => handle.adapter() !== null, TIMINGS.contentReadyPollMs * 4);
		expect(feed.posts[0]).toMatchObject({ kind: "hello", site: "lichess" });
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
