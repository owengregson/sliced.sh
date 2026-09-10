// test/content/page-bridge-client.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { BRIDGE_KINDS, type BridgeState } from "@content/adapters/adapter";
import {
	createPageBridgeClient,
	decodeState,
	encodePayload,
	type PageBridgeClient,
} from "@content/page-bridge-client";
import { bindCode, emit } from "@pagescript";
import { chesscomBridge } from "../../src/page/chesscom-bridge";
import { chesscomEntryArgs } from "../../src/page/index";
import {
	type FakeGame,
	fakeGame,
	makeWindow,
	type Posted,
	recordPosts,
	runProgram,
	SEED,
	sleep,
	TOKENS_FOR_SEED,
	waitFor,
} from "../page/helpers";

const { key, page, content } = TOKENS_FOR_SEED;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function makeClient(opts: { withBridge?: boolean; timeoutMs?: number } = {}) {
	const win = makeWindow("https://www.chess.com/game/live/9");
	cleanups.push(() => win.happyDOM.close());
	let game: FakeGame | undefined;
	if (opts.withBridge) {
		win.document.body.innerHTML = '<wc-chess-board id="board-single"></wc-chess-board>';
		game = fakeGame();
		(win.document.querySelector("wc-chess-board") as unknown as { game: FakeGame }).game = game;
		const e = emit(chesscomBridge, { seed: SEED });
		runProgram(bindCode(e.code, e.params, chesscomEntryArgs({ seed: SEED })), win, {
			customElements: { whenDefined: () => Promise.resolve() },
		});
	}
	const client: PageBridgeClient = createPageBridgeClient({
		window: win as unknown as Window,
		seed: SEED,
		...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
	});
	cleanups.push(() => client.dispose());
	return { win, client, game };
}

/** Deliver a page → content envelope. */
function fromPage(win: ReturnType<typeof makeWindow>, data: Record<string, unknown>, extra = {}) {
	win.dispatchEvent(
		new win.MessageEvent("message", {
			data,
			source: win,
			origin: win.location.origin,
			...extra,
		})
	);
}

describe("PageBridgeClient — wire", () => {
	it("posts { [spoofedKey]: contentToken, k, i, p } to location.origin and encodes draw/clear payloads with single letters", async () => {
		const { win, client } = makeClient({ timeoutMs: 30 });
		const rec = recordPosts(win);
		cleanups.push(rec.restore);
		const call = client.call(BRIDGE_KINDS.draw, {
			orientation: "black",
			highlights: [{ square: "e2", color: "c1" }],
			arrows: [{ from: "e2", to: "e4", color: "c2" }],
		});
		expect(rec.posts).toHaveLength(1);
		const post = rec.posts[0] as Posted;
		expect(post.origin).toBe("https://www.chess.com");
		expect(post.data[key]).toBe(content);
		expect(Object.keys(post.data).sort()).toEqual([key, "i", "k", "p"].sort());
		expect(post.data.k).toBe("draw");
		expect(post.data.p).toEqual({
			r: "b",
			h: [{ q: "e2", c: "c1" }],
			a: [{ f: "e2", t: "e4", c: "c2" }],
		});
		await expect(call).rejects.toThrow(/timed out/);
		client.call(BRIDGE_KINDS.clear, { keys: ["a", "b"] }).catch(() => {});
		expect(rec.posts[1]?.data.p).toEqual({ y: ["a", "b"] });
		client.call(BRIDGE_KINDS.getState).catch(() => {});
		expect("p" in (rec.posts[2]?.data ?? {})).toBe(false);
		for (const p of rec.posts) {
			expect(JSON.stringify(p.data)).not.toMatch(/sliced|engine|bestmove|fen|analysis/);
		}
	});
	it("isAvailable() is false until the page posts ready; ready payload is decoded and delivered to on('ready')", () => {
		const { win, client } = makeClient();
		const seen: unknown[] = [];
		client.on(BRIDGE_KINDS.ready, (p) => seen.push(p));
		expect(client.isAvailable()).toBe(false);
		fromPage(win, { [key]: page, k: "ready", p: { f: "8/8/8/8/8/8/8/K6k w - - 0 1", t: 1 } });
		expect(client.isAvailable()).toBe(true);
		expect(seen).toEqual([{ fen: "8/8/8/8/8/8/8/K6k w - - 0 1", turn: 1 }]);
		fromPage(win, { [key]: page, k: "ready", p: {} });
		expect(seen).toHaveLength(1); // ready is edge-triggered
	});
	it("ignores envelopes from another source, another origin, without the key, or with the wrong token", () => {
		const { win, client } = makeClient();
		const seen: unknown[] = [];
		client.on(BRIDGE_KINDS.move, (p) => seen.push(p));
		fromPage(win, { [key]: page, k: "move", p: { f: "x" } }, { source: null });
		fromPage(win, { [key]: page, k: "move", p: { f: "x" } }, { origin: "https://evil.test" });
		fromPage(win, { k: "move", p: { f: "x" } });
		fromPage(win, { [key]: content, k: "move", p: { f: "x" } }); // our own outgoing token
		fromPage(win, { [key]: "other", k: "move", p: { f: "x" } });
		expect(seen).toEqual([]);
		expect(client.isAvailable()).toBe(false);
		fromPage(win, { [key]: page, k: "move", p: { f: "x" } });
		expect(seen).toEqual([{ fen: "x" }]);
	});
	it("decodes events by kind: move/state/load/gameover → BridgeState, legalMoves, cursor", () => {
		const { win, client } = makeClient();
		const seen: Array<[string, unknown]> = [];
		for (const k of ["state", "load", "gameover", "legalMoves", "cursor", "ply"])
			client.on(k, (p) => seen.push([k, p]));
		fromPage(win, {
			[key]: page,
			k: "state",
			p: {
				f: "F",
				t: 2,
				a: null,
				m: "playing",
				o: true,
				l: { f: "e2", t: "e4", s: "e4" },
				g: false,
				r: null,
				c: { base: 1 },
				s: [1, 2],
			},
		});
		fromPage(win, { [key]: page, k: "load", p: { f: "L" } });
		fromPage(win, { [key]: page, k: "gameover", p: { g: true, r: "1-0" } });
		fromPage(win, {
			[key]: page,
			k: "legalMoves",
			p: [{ f: "e7", t: "e5", s: "e5" }, { f: "a7", t: "a8", p: "q" }, { bad: 1 }],
		});
		fromPage(win, { [key]: page, k: "cursor", p: { x: 1, y: 2, t: 3 } });
		fromPage(win, { [key]: page, k: "ply" });
		expect(seen).toEqual([
			[
				"state",
				{
					fen: "F",
					turn: 2,
					playingAs: null,
					mode: "playing",
					flipped: true,
					lastMove: { from: "e2", to: "e4", san: "e4" },
					gameOver: false,
					timeControl: { base: 1 },
					timestamps: [1, 2],
				} satisfies BridgeState,
			],
			["load", { fen: "L" }],
			["gameover", { gameOver: true, result: "1-0" }],
			[
				"legalMoves",
				[
					{ from: "e7", to: "e5", san: "e5" },
					{ from: "a7", to: "a8", promotion: "q" },
				],
			],
			["cursor", { x: 1, y: 2, t: 3 }],
			["ply", undefined],
		]);
	});
	it("codec helpers: decodeState rejects non-objects; encodePayload passes unknown kinds through", () => {
		expect(decodeState(null)).toBeNull();
		expect(decodeState("x")).toBeNull();
		expect(encodePayload("cursor", undefined)).toBeUndefined();
		expect(encodePayload("clear", undefined)).toBeUndefined();
		expect(encodePayload("other", { a: 1 })).toEqual({ a: 1 });
	});
});

describe("PageBridgeClient — against the real chesscom-bridge program", () => {
	it("call() resolves the id-correlated reply, decoded to BridgeState; isAvailable after ready", async () => {
		const { client, game } = makeClient({ withBridge: true });
		await waitFor(() => client.isAvailable());
		const state = await client.call<BridgeState>(BRIDGE_KINDS.getState);
		expect(state.fen).toBe(game?.fen ?? "");
		expect(state.turn).toBe(2);
		expect(state.playingAs).toBe(1);
		expect(state.mode).toBe("playing");
		expect(state.flipped).toBe(false);
		expect(state.lastMove).toEqual({ from: "e2", to: "e4", san: "e4" });
		const draw = await client.call<{ keys: string[] }>(BRIDGE_KINDS.draw, {
			highlights: [{ square: "d2", color: "c" }],
			arrows: [],
		});
		expect(draw.keys).toEqual(["highlight|d2"]);
		await client.call(BRIDGE_KINDS.clear, { keys: draw.keys });
		expect(game?.markings.removed).toEqual(["highlight|d2"]);
		const moves = await client.call<unknown[]>(BRIDGE_KINDS.legalMoves);
		expect(moves).toHaveLength(2);
	});
	it("delivers unsolicited move events and rejects pending calls on dispose", async () => {
		const { client, game } = makeClient({ withBridge: true });
		await waitFor(() => client.isAvailable());
		const moves: BridgeState[] = [];
		client.on(BRIDGE_KINDS.move, (p) => moves.push(p as BridgeState));
		game?.emit("Move");
		await waitFor(() => moves.length === 1);
		expect(moves[0]?.fen).toBe(game?.fen ?? "");
		const pending = client.call(BRIDGE_KINDS.getState, undefined, 5_000);
		client.dispose();
		await expect(pending).rejects.toThrow(/disposed/);
		expect(client.isAvailable()).toBe(false);
		await expect(client.call(BRIDGE_KINDS.getState)).rejects.toThrow(/disposed/);
		game?.emit("Move");
		await sleep(20);
		expect(moves).toHaveLength(1); // listener removed
	});
	it("discovers a bridge that posted ready before the client existed (probe reply)", async () => {
		const { win, client } = makeClient({ withBridge: true });
		await waitFor(() => client.isAvailable());
		client.dispose();
		// a second client created later never sees the original `ready`, yet becomes available
		const late = createPageBridgeClient({ window: win as unknown as Window, seed: SEED });
		cleanups.push(() => late.dispose());
		expect(late.isAvailable()).toBe(false);
		await waitFor(() => late.isAvailable());
	});
});
