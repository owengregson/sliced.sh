// test/page/chesscom-bridge.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { SELECTORS } from "@content/adapters/selectors";
import { bindCode, emit } from "@pagescript";
import { chesscomBridge } from "../../src/page/chesscom-bridge";
import { chesscomEntryArgs, OVERLAY_COLORS } from "../../src/page/index";
import {
	command,
	type FakeGame,
	fakeGame,
	forbiddenIn,
	makeWindow,
	type Posted,
	postsOf,
	recordPosts,
	runProgram,
	SEED,
	sendToPage,
	sleep,
	TOKENS_FOR_SEED,
	waitFor,
} from "./helpers";

const emitted = emit(chesscomBridge, { seed: SEED });
const bound = bindCode(emitted.code, emitted.params, chesscomEntryArgs({ seed: SEED }));
const { key, page } = TOKENS_FOR_SEED;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

interface Booted {
	win: ReturnType<typeof makeWindow>;
	game: FakeGame;
	posts: Posted[];
	keysBefore: string[];
}

async function boot(withBoard = true): Promise<Booted> {
	const win = makeWindow("https://www.chess.com/game/live/123");
	cleanups.push(() => win.happyDOM.close());
	const game = fakeGame();
	if (withBoard) {
		win.document.body.innerHTML =
			'<div id="layout"><wc-chess-board id="board-single" class="board"></wc-chess-board></div>';
		(win.document.querySelector("wc-chess-board") as unknown as { game: FakeGame }).game = game;
	}
	const rec = recordPosts(win);
	cleanups.push(rec.restore);
	const keysBefore = Object.keys(win);
	runProgram(bound, win, { customElements: { whenDefined: () => Promise.resolve() } });
	if (withBoard) await waitFor(() => postsOf(rec.posts, "ready").length > 0);
	return { win, game, posts: rec.posts, keysBefore };
}

function reply(posts: Posted[], id: string): Record<string, unknown> | undefined {
	return posts.find((p) => p.data[key] === page && p.data.i === id)?.data;
}

/** The `p` payload of one envelope, as a record (empty when absent). */
function payload(env: { data: Record<string, unknown> } | Record<string, unknown> | undefined) {
	const data = env && "data" in env ? (env as { data: Record<string, unknown> }).data : env;
	const p = data?.p;
	return (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
}

describe("chesscom-bridge — emitted code (§13.3)", () => {
	it("contains no forbidden substring, no literal selector, no window property write", () => {
		expect(forbiddenIn(emitted.code)).toEqual([]);
		expect(forbiddenIn(bound)).toEqual([]);
		for (const sel of SELECTORS.board) expect(emitted.code).not.toContain(sel);
		expect(emitted.code).not.toContain(SELECTORS.boardTag);
		expect(emitted.code).not.toMatch(/window\.\w+\s*=|window\[[^\]]+\]\s*=/);
		expect(emitted.code).not.toContain("defineProperty");
		expect(emitted.code).not.toMatch(/localStorage|sessionStorage|indexedDB|cookie/);
		expect(emitted.code).not.toContain("$$spoof");
		expect(bound).not.toContain("$$param");
	});
	it("posts envelopes with the spoofed key, the page token and single-letter fields only", async () => {
		const { posts } = await boot();
		expect(posts.length).toBeGreaterThan(0);
		for (const p of posts) {
			expect(p.origin).toBe("https://www.chess.com");
			const names = Object.keys(p.data);
			expect(names).toContain(key);
			for (const n of names.filter((x) => x !== key)) expect(n).toMatch(/^[a-z]$/);
			expect(p.data[key]).toBe(page);
			if (p.data.p && typeof p.data.p === "object") {
				for (const n of Object.keys(p.data.p as object)) expect(n).toMatch(/^[a-z]$/);
			}
		}
	});
});

describe("chesscom-bridge — behaviour", () => {
	it("waits for the element, posts ready with the state, and defines nothing on window nor in the DOM", async () => {
		const { win, posts, keysBefore, game } = await boot();
		expect(Object.keys(win)).toEqual(keysBefore);
		expect(win.document.querySelectorAll("wc-chess-board *").length).toBe(0);
		expect(win.document.body.querySelectorAll("svg").length).toBe(0);
		const ready = postsOf(posts, "ready")[0]?.data.p as Record<string, unknown>;
		expect(ready.f).toBe(game.fen);
		expect(game.subscribed()).toEqual(
			expect.arrayContaining(["Move", "Load", "CreateGame", "ModeChanged", "GameOver"])
		);
	});
	it("keeps retrying until the board element exists, and installs pointer listeners only then", async () => {
		const booted = await boot(false);
		await sleep(30);
		expect(postsOf(booted.posts, "ready")).toHaveLength(0);
		const early = new booted.win.PointerEvent("pointermove", { clientX: 7, clientY: 8 });
		Object.defineProperty(early, "isTrusted", { value: true });
		booted.win.dispatchEvent(early); // no listener yet: must not be remembered
		booted.win.document.body.innerHTML = '<wc-chess-board id="board-single"></wc-chess-board>';
		(booted.win.document.querySelector("wc-chess-board") as unknown as { game: FakeGame }).game =
			booted.game;
		await waitFor(() => postsOf(booted.posts, "ready").length > 0, 3_000);
		sendToPage(booted.win, command("cursor", "c1"));
		expect(reply(booted.posts, "c1")?.p).toBeNull();
		const late = new booted.win.PointerEvent("pointermove", { clientX: 70, clientY: 80 });
		Object.defineProperty(late, "isTrusted", { value: true });
		booted.win.dispatchEvent(late);
		sendToPage(booted.win, command("cursor", "c2"));
		expect(reply(booted.posts, "c2")?.p).toMatchObject({ x: 70, y: 80 });
	});
	it("answers getState with { f, t, a, m, o, l, c, s, g, r } correlated by id", async () => {
		const { win, posts, game } = await boot();
		sendToPage(win, command("getState", "7"));
		const r = reply(posts, "7");
		expect(r?.k).toBe("state");
		expect(r?.p).toEqual({
			f: game.fen,
			t: 2,
			a: 1,
			m: "playing",
			o: false,
			l: { f: "e2", t: "e4", s: "e4" },
			c: { base: 180_000, inc: 2_000 },
			s: [1_800, 1_800],
			g: false,
			r: null,
		});
	});
	it("relays game.on('Move') as a move event carrying the position, and gameover when the game ended", async () => {
		const { posts, game } = await boot();
		game.fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2";
		game.emit("Move");
		const move = postsOf(posts, "move");
		expect(move).toHaveLength(1);
		expect(move[0]?.data.i).toBeUndefined();
		expect(payload(move[0]).f).toBe(game.fen);
		expect(postsOf(posts, "gameover")).toHaveLength(0);
		game.over = true;
		game.emit("Move");
		expect(postsOf(posts, "gameover")).toHaveLength(1);
		expect(payload(postsOf(posts, "gameover")[0]).r).toBe("1-0");
	});
	it("draw calls markings.addOne per highlight / arrow and returns the keys; clear removes only ours", async () => {
		const { win, posts, game } = await boot();
		sendToPage(
			win,
			command("draw", "1", {
				r: "w",
				h: [
					{ q: "e2", c: "rgb(1 2 3 / 0.3)" },
					{ q: "e4", c: "rgb(1 2 3 / 0.5)" },
				],
				a: [{ f: "e2", t: "e4", c: "rgb(1 2 3 / 0.6)" }],
			})
		);
		expect(game.markings.added).toEqual([
			{ type: "highlight", data: { square: "e2", color: "rgb(1 2 3 / 0.3)" } },
			{ type: "highlight", data: { square: "e4", color: "rgb(1 2 3 / 0.5)" } },
			{ type: "arrow", data: { from: "e2", to: "e4", color: "rgb(1 2 3 / 0.6)" } },
		]);
		expect(reply(posts, "1")?.p).toEqual({ y: ["highlight|e2", "highlight|e4", "arrow|e2e4"] });
		expect(win.document.querySelectorAll("svg").length).toBe(0); // native markings, no overlay

		// a foreign key (the user's own arrow) is never removed
		sendToPage(win, command("clear", "2", { y: ["highlight|e2", "arrow|user"] }));
		expect(game.markings.removed).toEqual(["highlight|e2"]);
		expect(reply(posts, "2")?.k).toBe("clear");
		// clear without keys removes the rest of ours only
		sendToPage(win, command("clear", "3"));
		expect(game.markings.removed).toEqual(["highlight|e2", "highlight|e4", "arrow|e2e4"]);
		sendToPage(win, command("clear", "4"));
		expect(game.markings.removed).toHaveLength(3);
	});
	// Fix A (the owner's live report, 2026-09-10): the mark of the move the hand is playing must
	// outlive the whole action, so it may not be one of the site's own markings — chess.com clears
	// those on a left press on the board, and the action is made of presses. `BRIDGE_WIRE.forceOverlay`
	// takes the overlay branch even where `game.markings` exists.
	it("forceOverlay draws the bridge's own svg even though game.markings exists, and addOne is never called", async () => {
		const { win, posts, game } = await boot();
		sendToPage(
			win,
			command("draw", "ov1", {
				r: "w",
				v: true,
				h: [
					{ q: "e2", c: "rgb(1 2 3 / 0.3)" },
					{ q: "e4", c: "rgb(1 2 3 / 0.5)" },
				],
				a: [{ f: "e2", t: "e4", c: "rgb(1 2 3 / 0.6)" }],
			})
		);
		expect(game.markings.added).toEqual([]);
		const svg = win.document.querySelector("wc-chess-board > svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("class")).toBe(TOKENS_FOR_SEED.overlayClass);
		expect(svg?.getAttribute("style")).toContain("pointer-events:none");
		expect(svg?.querySelectorAll("rect").length).toBe(2);
		expect(svg?.querySelectorAll("path").length).toBe(1);
		// No native key to report, so nothing of ours is registered for `clear` to remove by key.
		expect(reply(posts, "ov1")?.p).toEqual({ y: [] });

		// A clear removes it, and the next ordinary draw is native again (the default is unchanged).
		sendToPage(win, command("clear", "ov2"));
		expect(win.document.querySelector("wc-chess-board > svg")).toBeNull();
		sendToPage(win, command("draw", "ov3", { r: "w", h: [{ q: "a1", c: "red" }], a: [] }));
		expect(game.markings.added).toEqual([
			{ type: "highlight", data: { square: "a1", color: "red" } },
		]);
		expect(win.document.querySelector("wc-chess-board > svg")).toBeNull();
	});
	it("forceOverlay mirrors the board when the payload says black is at the bottom", async () => {
		const { win } = await boot();
		sendToPage(win, command("draw", "ov4", { r: "b", v: true, h: [{ q: "a1", c: "red" }], a: [] }));
		const rect = win.document.querySelector("wc-chess-board > svg > rect");
		// a1 for black at the bottom is the top-right cell: col 7, row 0
		expect(rect?.getAttribute("x")).toBe("7");
		expect(rect?.getAttribute("y")).toBe("0");
	});
	it("falls back to the overlay svg (pointer-events none, spoofed class) when markings are unavailable", async () => {
		const { win, posts, game } = await boot();
		(game as unknown as { markings: unknown }).markings = undefined;
		sendToPage(win, command("draw", "9", { r: "w", h: [{ q: "a1", c: "red" }, { q: "a2" }], a: [] }));
		const svg = win.document.querySelector("wc-chess-board > svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("class")).toBe(TOKENS_FOR_SEED.overlayClass);
		expect(svg?.getAttribute("style")).toContain("pointer-events:none");
		expect(svg?.querySelectorAll("rect").length).toBe(2);
		expect(svg?.querySelectorAll("rect")[1]?.getAttribute("fill")).toBe(OVERLAY_COLORS.to);
		expect(reply(posts, "9")?.p).toEqual({ y: [] });
		sendToPage(win, command("clear", "10"));
		expect(win.document.querySelector("wc-chess-board > svg")).toBeNull();
	});
	it("answers legalMoves with { f, t, p, s } entries and cursor with the last trusted pointer", async () => {
		const { win, posts } = await boot();
		sendToPage(win, command("legalMoves", "5"));
		expect(reply(posts, "5")?.p).toEqual([
			{ f: "e7", t: "e5", s: "e5" },
			{ f: "a7", t: "a8", p: "q", s: "a8=Q" },
		]);
		sendToPage(win, command("cursor", "6"));
		expect(reply(posts, "6")?.p).toBeNull();
		// untrusted pointer events are ignored (happy-dom events are untrusted)
		win.dispatchEvent(new win.PointerEvent("pointermove", { clientX: 5, clientY: 6 }));
		sendToPage(win, command("cursor", "8"));
		expect(reply(posts, "8")?.p).toBeNull();
	});
	it("ignores envelopes without the content token, from another origin, or from another source", async () => {
		const { win, posts } = await boot();
		const before = posts.length;
		sendToPage(win, { [key]: "nope", k: "getState", i: "x" });
		sendToPage(win, { k: "getState", i: "x" });
		win.dispatchEvent(
			new win.MessageEvent("message", {
				data: command("getState", "x"),
				source: null,
				origin: win.location.origin,
			})
		);
		win.dispatchEvent(
			new win.MessageEvent("message", {
				data: command("getState", "x"),
				source: win,
				origin: "https://evil.test",
			})
		);
		expect(posts.length).toBe(before);
	});
	// Fix D: the pointer mirror is embedded in the bridge, so the bridge is the channel the
	// service worker actually drives. Its own presence rules are covered in
	// `test/page/virtual-cursor.test.ts`; what matters here is that the bridge routes the two
	// commands and stays silent (the stream is fire-and-forget — a reply per point would double it).
	it("routes the pointer mirror's commands and answers neither", async () => {
		const { win, posts } = await boot();
		const cls = TOKENS_FOR_SEED.cursorClass;
		expect(win.document.querySelector(`.${cls}`)).toBeNull();
		const before = posts.length;
		const env = command("cursorTo", "0", { x: 120, y: 240, d: true });
		delete env.i;
		sendToPage(win, env);
		expect(win.document.querySelectorAll(`.${cls}`)).toHaveLength(1);
		expect(posts.length).toBe(before);
		const hide = command("cursorHide", "0");
		delete hide.i;
		sendToPage(win, hide);
		expect(win.document.querySelector(`.${cls}`)).toBeNull();
		expect(posts.length).toBe(before);
	});
	it("acknowledges an opened input aperture only while the virtual pointer exists", async () => {
		const { win, posts } = await boot();
		sendToPage(win, command("cursorPrepare", "closed", { x: 120, y: 240 }));
		expect(reply(posts, "closed")?.p).toBe(false);
		sendToPage(win, command("cursorTo", "to", { x: 120, y: 240, d: false }));
		sendToPage(win, command("cursorPrepare", "opened", { x: 125, y: 245 }));
		expect(reply(posts, "opened")?.p).toBe(true);
		const shield = win.document.querySelector(
			`.${TOKENS_FOR_SEED.cursorClass}h`
		) as HTMLElement | null;
		expect(shield?.style.clipPath).toContain("124px 244px");
	});
	it("re-attaches when the SPA replaces the board element and posts load", async () => {
		const { win, posts, game } = await boot();
		const fresh = fakeGame("8/8/8/8/8/8/8/K6k w - - 0 1");
		win.document.body.innerHTML = '<wc-chess-board id="board-single"></wc-chess-board>';
		(win.document.querySelector("wc-chess-board") as unknown as { game: FakeGame }).game = fresh;
		sendToPage(win, command("getState", "11"));
		expect(payload(reply(posts, "11")).f).toBe(fresh.fen);
		expect(game.fen).not.toBe(fresh.fen);
	});
});
