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
import type { GamePortCommand } from "@core/constants/messages";
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
	it("an ordinary highlight becomes chess.com markings; one carrying `overlay` becomes our own svg instead", async () => {
		const j = await joinChain();
		j.command({ kind: "settings", highlightMoves: true });

		// Default: the site's own markings, no DOM of ours.
		j.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		await waitFor(() => j.game.markings.added.length > 0, 2_000);
		expect(j.game.markings.added.map((m) => m.type)).toEqual(["highlight", "highlight", "arrow"]);
		expect(j.game.markings.added[0]?.data.square).toBe("d2");
		expect(j.svg()).toBeNull();
		const nativeDraws = j.game.markings.added.length;

		// The mark of a move the hand is acting on: our own `<svg>`, and not one more marking.
		j.command({ kind: "highlight", from: "d2", to: "d4", style: "both", overlay: true });
		const svg = await j.svgWithin();
		// The one hop everything else tests from both sides and never across: `encodePayload`'s
		// `forceOverlay` → `v`. Without it the page takes the native branch and there is no svg.
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("class")).toBe(TOKENS_FOR_SEED.overlayClass);
		expect(svg?.getAttribute("style")).toContain("pointer-events:none");
		expect(svg?.querySelectorAll("rect").length).toBe(2);
		expect(svg?.querySelectorAll("polygon").length).toBe(1);
		expect(j.game.markings.added.length).toBe(nativeDraws);
		// …and the markings it replaced are gone, so the two never stack.
		expect(j.game.markings.removed).toEqual(["highlight|d2", "highlight|d4", "arrow|d2d4"]);
	});

	// The verifier is what took the mark away mid-action, and it did so whichever kind of mark was
	// on the board — so this is asserted over a *native* mark too, where it is independent of
	// everything else in this lane. Pre-fix the content script's `observeMove` responder began with
	// `highlights.clearForExecution()`, so each of the calls below removed our markings from the
	// page; `runWithRetry` issues one after every attempt (`verify`) and one before every retry
	// (`recheck`), which is why tier 2 ran with nothing on the board.
	it("the verifier removes nothing from the page — native markings", async () => {
		const j = await joinChain();
		j.command({ kind: "settings", highlightMoves: true });
		j.command({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		await waitFor(() => j.game.markings.added.length === 3, 2_000);

		// verify (attempt 0), recheck (before the retry), verify (attempt 1 — tier 2).
		for (const id of ["v0", "r0", "v1"]) {
			j.command({ kind: "observeMove", id, expected: { from: "d2", to: "d4" }, timeoutMs: 40 });
		}
		await sleep(160);
		expect(j.game.markings.removed).toEqual([]);
		expect(j.game.markings.added.length).toBe(3);
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
