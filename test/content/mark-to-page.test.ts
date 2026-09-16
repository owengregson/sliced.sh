// test/content/mark-to-page.test.ts — Fix A: the whole mark-drawing chain, joined, in one window.
//
// Everything else tests this chain from one side or the other and the join is where the bug hides:
// the content tests read the *decoded* adapter payload out of `FakeBridge` (which never calls
// `encodePayload`), and the page tests inject the already-encoded `{ v: true }` by hand. Between
// them sits one spread in `encodePayload` — the single hop all of Step 2 depends on — which the
// reviewer deleted without a single test failing.
//
// So this file runs the *real* parts together in one happy-dom window: `startContent` with the real
// `ChessComAdapter` and the real `createPageBridgeClient`, the **emitted** bridge program (the same
// text `gen:pagescript` ships) evaluated in that window, and real `window.postMessage` between
// them. The assertions are what the page ends up holding: chess.com markings, or our own `<svg>`.
//
// The fixture is `chesscom-webgl` — the owner's real live game: a canvas board with no `.piece`
// elements, which is where the bug was reported.
import { afterEach, describe, expect, it } from "bun:test";
import type { FeedPort } from "@content/feed-port";
import { startContent } from "@content/index";
import { createPageBridgeClient } from "@content/page-bridge-client";
import { type GamePortCommand, MSG } from "@core/constants/messages";
import { chesscomBridge } from "@page/chesscom-bridge";
import { chesscomEntryArgs } from "@page/index";
import { bindCode, emit } from "@pagescript";
import { createTabDom, installWindowGlobals, type TabDom } from "@test/sim/dom/tab-dom";
import { type FakeGame, fakeGame, SEED, TOKENS_FOR_SEED } from "../page/helpers";
import {
	FIXTURE_URLS,
	loadFixtureInto,
	pageDocument,
	pageWindow,
	sleep,
	waitFor,
} from "./adapters/helpers";

const emitted = emit(chesscomBridge, { seed: SEED });
const bound = bindCode(emitted.code, emitted.params, chesscomEntryArgs({ seed: SEED }));

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

interface Joined {
	dom: TabDom;
	game: FakeGame;
	command(cmd: GamePortCommand): void;
	/** The overlay `<svg>` the bridge owns, if it is in the DOM. */
	svg(): Element | null;
	/** The overlay `<svg>`, waiting up to `ms` for the two `postMessage` hops; `null` if it never came. */
	svgWithin(ms?: number): Promise<Element | null>;
}

/** One window: the emitted page program, the real content script, real `postMessage` between them. */
async function joinChain(): Promise<Joined> {
	const dom = createTabDom(FIXTURE_URLS["chesscom-webgl"]);
	loadFixtureInto(dom, "chesscom-webgl");
	const board = dom.document.querySelector("wc-chess-board");
	if (!board) throw new Error("the webgl fixture has no board element");
	const game = fakeGame();
	(board as unknown as { game: FakeGame }).game = game;
	cleanups.push(installWindowGlobals(dom.window));
	cleanups.push(() => dom.window.happyDOM?.close());

	// The MAIN-world half: the program text the build actually ships.
	new Function("window", "document", "location", "MutationObserver", "customElements", bound)(
		dom.window,
		dom.document,
		dom.window.location,
		dom.window.MutationObserver,
		{
			whenDefined: () => Promise.resolve(),
		}
	);

	// The ISOLATED half: the real adapter and the real codec.
	let handler: (c: GamePortCommand) => void = () => {};
	const feed: FeedPort = {
		ready: Promise.resolve(),
		post: () => {},
		dispose: () => {},
	} as unknown as FeedPort;
	const bridge = createPageBridgeClient({ window: pageWindow(dom), seed: SEED });
	cleanups.push(() => bridge.dispose());
	const handle = startContent({
		window: pageWindow(dom),
		document: pageDocument(dom),
		bridge,
		port: (onCommand: (c: GamePortCommand) => void) => {
			handler = onCommand;
			return feed;
		},
		adapterVersion: "joined",
	});
	if (!handle) throw new Error("startContent returned null");
	cleanups.push(() => handle.dispose());

	// The page program posts `ready` once it has the board; the client turns available on it.
	await waitFor(() => bridge.isAvailable(), 2_000);
	const svg = (): Element | null =>
		dom.document.querySelector("wc-chess-board > svg") as unknown as Element | null;
	return {
		dom,
		game,
		command: (cmd) => handler(cmd),
		svg,
		async svgWithin(ms = 500) {
			const end = Date.now() + ms;
			while (svg() === null && Date.now() < end) await sleep(5);
			return svg();
		},
	};
}

describe("the mark reaches the page: port command → wire → emitted bridge program → DOM", () => {
	it("requests sound only after the real bridge draws a new rating, and stops on disable", async () => {
		const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
		const sounds: unknown[] = [];
		Object.defineProperty(globalThis, "chrome", {
			configurable: true,
			value: {
				runtime: {
					sendMessage(message: { type: string; quality?: unknown }, reply: (value: unknown) => void) {
						if (message.type === MSG.OFFSCREEN_MOVE_RATING_SOUND) sounds.push(message.quality);
						reply(true);
					},
				},
			},
		});
		cleanups.push(() => {
			if (previous) Object.defineProperty(globalThis, "chrome", previous);
			else Reflect.deleteProperty(globalThis, "chrome");
		});
		const j = await joinChain();
		j.command({
			kind: "settings",
			highlightMoves: false,
			boardEffects: true,
			moveRatings: true,
			moveRatingSounds: true,
		});
		const verdict: GamePortCommand = {
			kind: "effects",
			effects: [],
			mine: true,
			quality: { square: "e4", quality: "great" },
		};
		j.command({ kind: "effects", effects: [], mine: true });
		await sleep(20);
		expect(sounds).toEqual([]);
		j.command(verdict);
		await waitFor(() => sounds.length === 1);
		expect(j.dom.document.querySelector(`svg.${TOKENS_FOR_SEED.effectsClass} path`)).not.toBeNull();
		expect(sounds).toEqual(["great"]);
		j.command(verdict);
		await sleep(20);
		expect(sounds).toEqual(["great"]);
		j.command({ ...verdict, mine: false });
		await waitFor(() => sounds.length === 2);
		expect(sounds).toEqual(["great", "great"]);
		j.command({
			kind: "settings",
			highlightMoves: false,
			boardEffects: true,
			moveRatings: true,
			moveRatingSounds: false,
		});
		expect(sounds).toEqual(["great", "great", null]);
		j.command({ ...verdict, quality: { square: "e5", quality: "brilliant" } });
		await sleep(20);
		expect(sounds).toEqual(["great", "great", null]);
	});
	it("a forced-mate chip reaches the page and requests its pitch as a number, only while its own switch is on", async () => {
		const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
		const requests: unknown[] = [];
		Object.defineProperty(globalThis, "chrome", {
			configurable: true,
			value: {
				runtime: {
					sendMessage(message: { type: string }, reply: (value: unknown) => void) {
						if (message.type === MSG.OFFSCREEN_MOVE_RATING_SOUND) requests.push(message);
						reply(true);
					},
				},
			},
		});
		cleanups.push(() => {
			if (previous) Object.defineProperty(globalThis, "chrome", previous);
			else Reflect.deleteProperty(globalThis, "chrome");
		});
		const j = await joinChain();
		const gates = (forcedMateSounds: boolean): GamePortCommand => ({
			kind: "settings",
			highlightMoves: false,
			boardEffects: true,
			moveRatings: true,
			moveRatingSounds: true,
			forcedMateSounds,
		});
		j.command(gates(true));
		j.command({
			kind: "effects",
			effects: [],
			mine: true,
			quality: { square: "f7", quality: "mate", mateSemitones: 1.5 },
		});
		await waitFor(() => requests.length === 1);
		expect(requests).toEqual([
			{ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "mate", mateSemitones: 1.5 },
		]);
		const fills = [
			...j.dom.document.querySelectorAll(`svg.${TOKENS_FOR_SEED.effectsClass} path`),
		].map((p) => p.getAttribute("fill"));
		expect(fills).toContain("#E3AA24");
		j.command(gates(false));
		expect(requests.at(-1)).toEqual({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: null });
		j.command({
			kind: "effects",
			effects: [],
			mine: false,
			quality: { square: "g8", quality: "mate", mateSemitones: 3 },
		});
		await sleep(20);
		expect(requests).toHaveLength(2);
		// A rating chip still sounds with the forced-mate switch off.
		j.command({
			kind: "effects",
			effects: [],
			mine: true,
			quality: { square: "e4", quality: "great" },
		});
		await waitFor(() => requests.length === 3);
		expect(requests.at(-1)).toEqual({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "great" });
	});
	// Owner, 2026-09-15: the rays and the chip are gated separately, and the join is where a batch
	// could arrive with a half the page must not draw.
	it("draws the chip alone with board effects off, and the rays alone with move ratings off", async () => {
		const j = await joinChain();
		const layerPaths = () => [
			...j.dom.document.querySelectorAll(`svg.${TOKENS_FOR_SEED.effectsClass} path`),
		];
		/** A ray is painted through a per-group gradient; the chip's own paths carry literal fills. */
		const rays = () => layerPaths().filter((p) => (p.getAttribute("fill") ?? "").startsWith("url("));
		const chips = () =>
			[...j.dom.document.querySelectorAll(`svg.${TOKENS_FOR_SEED.effectsClass} g`)].filter((g) =>
				(g.getAttribute("transform") ?? "").includes("scale(")
			);
		const batch: GamePortCommand = {
			kind: "effects",
			effects: [{ kind: "check", from: "f8", to: "e8" }],
			mine: false,
			quality: { square: "f8", quality: "blunder" },
		};

		j.command({ kind: "settings", highlightMoves: false, boardEffects: false, moveRatings: true });
		j.command(batch);
		await waitFor(() => chips().length === 1);
		expect(rays()).toHaveLength(0);

		// The gate flip erases the layer; the rays come back on the next batch, without the chip.
		j.command({ kind: "settings", highlightMoves: false, boardEffects: true, moveRatings: false });
		await waitFor(() => chips().length === 0);
		j.command(batch);
		await waitFor(() => rays().length > 0);
		expect(chips()).toHaveLength(0);
	});

	it("ordinary recommendations reach our SVG and an identical execution mark retains the same nodes", async () => {
		const j = await joinChain();
		j.command({ kind: "settings", highlightMoves: true });
		j.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		const svg = await j.svgWithin();
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("class")).toBe(TOKENS_FOR_SEED.overlayClass);
		expect(svg?.getAttribute("style")).toContain("pointer-events:none");
		expect(svg?.querySelectorAll("rect").length).toBe(2);
		expect(svg?.querySelectorAll("path").length).toBe(1);
		const head = svg?.querySelector("path");
		j.command({ kind: "highlight", from: "d2", to: "d4", style: "both", overlay: true });
		await sleep(20);
		expect(j.svg()?.querySelector("path")).toBe(head);
		expect(j.game.markings.added).toEqual([]);
		j.command({ kind: "arrow", lines: [{ from: "g1", to: "f3", weight: 1 }] });
		await waitFor(() => j.svg()?.querySelectorAll("rect").length === 0);
		expect(j.svg()?.querySelectorAll("path").length).toBe(1);
		expect(j.game.markings.added).toEqual([]);
	});

	it("the verifier removes nothing from the page — the overlay mark, and completion's clear does", async () => {
		const j = await joinChain();
		j.command({ kind: "settings", highlightMoves: true });
		j.command({ kind: "highlight", from: "d2", to: "d4", style: "both", overlay: true });
		expect(await j.svgWithin()).not.toBeNull();
		const rects = j.svg()?.querySelectorAll("rect").length;

		for (const id of ["v0", "r0", "v1"]) {
			j.command({ kind: "observeMove", id, expected: { from: "d2", to: "d4" }, timeoutMs: 40 });
		}
		await sleep(160);
		expect(j.svg()).not.toBeNull();
		expect(j.svg()?.querySelectorAll("rect").length).toBe(rects);

		// Completion — `GameSession.onExecuted` / `onNotExecuted` — is the only thing that clears.
		j.command({ kind: "clearHighlight" });
		await waitFor(() => j.svg() === null, 2_000);
		expect(j.svg()).toBeNull();
	});

	// `highlightMoves` going off is a different thing from the verifier, and it must still clear.
	it("turning highlightMoves off removes the overlay mark", async () => {
		const j = await joinChain();
		j.command({ kind: "settings", highlightMoves: true });
		j.command({ kind: "highlight", from: "d2", to: "d4", style: "both", overlay: true });
		expect(await j.svgWithin()).not.toBeNull();
		j.command({ kind: "settings", highlightMoves: false });
		await waitFor(() => j.svg() === null, 2_000);
		expect(j.svg()).toBeNull();
	});
});
