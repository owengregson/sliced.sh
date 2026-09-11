// test/behavioral/content/position-feed.test.ts
/**
 * Content context + SW context in the simulator (Task 21 Step 4):
 *   fixture mutation → `position` on the game port → the SW receives the
 *   `PositionSnapshot`; SW `highlight` → the adapter draws through the real
 *   `PageBridgeClient` → the real `chesscom-bridge` program (evaluated in the
 *   tab's happy-dom with a fake `wc-chess-board.game`) draws the animated SVG overlay.
 *
 * The content script is the real bundle entry (`import("@content/index")`
 * auto-boots on the tab's `window`), the port is the real `connectPort`, and
 * the SW side is a minimal `acceptPorts(PORT_NAMES.game)`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ContentHandle } from "@content/index";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import { bindCode, emit } from "@pagescript";
import { createSimulator, type Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { chesscomBridge } from "../../../src/page/chesscom-bridge";
import { chesscomEntryArgs } from "../../../src/page/index";
import { installPollingObserver, loadFixtureInto, waitFor } from "../../content/adapters/helpers";
import { type FakeGame, fakeGame, runProgram } from "../../page/helpers";

const LIVE_FEN = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4";
const URL = "https://www.chess.com/game/live/173765478164";

const prevChrome = (globalThis as Record<string, unknown>).chrome;
let sim: Simulator;
let sw: SwContext | undefined;
let content: ContentContext | undefined;
let booted: ContentHandle | null = null;

afterEach(async () => {
	await content?.run(() => booted?.dispose());
	booted = null;
	await content?.teardown();
	await sw?.teardown();
	await sim.dispose();
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

describe("position feed — content ⇄ SW over the game port", () => {
	it("feeds hello/gameStarted/position, forwards a DOM move, and draws SW highlights through the page bridge", async () => {
		sim = createSimulator();
		const received: GamePortMessage[] = [];
		const ports: AcceptedPort<GamePortCommand, GamePortMessage>[] = [];
		sw = await bootSwContext(sim, {
			entry: () => {
				acceptPorts<GamePortCommand, GamePortMessage>(PORT_NAMES.game, (port) => {
					ports.push(port);
					port.onMessage((m) => received.push(m));
				});
			},
		});

		// The tab: the live fixture, the observer shim (see test/content/adapters/README.md), and
		// the real MAIN-world bridge with a fake board API, using the test build seed.
		const { tabId, dom } = sim.openTab(URL);
		loadFixtureInto(dom, "chesscom-live");
		installPollingObserver(dom);
		const game = fakeGame(LIVE_FEN);
		(dom.document.querySelector("wc-chess-board") as unknown as { game: FakeGame }).game = game;
		const seed = __SL_SPOOF_SEED__;
		const e = emit(chesscomBridge, { seed });
		runProgram(bindCode(e.code, e.params, chesscomEntryArgs({ seed })), dom.window, {
			customElements: { whenDefined: () => Promise.resolve() },
		});

		content = await bootContentContext(sim, tabId, {
			entry: async () => {
				// The bundle entry auto-boots at module evaluation; when the module is already
				// cached (shared test process) boot explicitly on the tab's globals.
				const mod = await import("@content/index");
				booted = mod.currentContent() ?? mod.startContent();
			},
		});
		expect(booted?.adapter()).not.toBeNull();
		const of = <K extends GamePortMessage["kind"]>(kind: K) =>
			received.filter((m) => m.kind === kind) as Array<Extract<GamePortMessage, { kind: K }>>;

		await waitFor(() => of("position").length >= 1 && ports.length === 1, 3_000);
		expect(received[0]).toEqual({
			kind: "hello",
			site: "chesscom",
			pageKind: "live-game",
			adapterVersion: __SL_VERSION__,
		});
		expect(of("gameStarted")[0]?.game.gameId).toBe("173765478164");
		const first = of("position")[0]?.snapshot;
		expect(first?.fen).toBe(LIVE_FEN);
		expect(first?.ply).toBe(6);
		expect(first?.site).toBe("chesscom");
		expect(typeof first?.capturedAt).toBe("number");

		// a move made in the page DOM (piece class flip, highlights, move-list node, clock turn)
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
		await waitFor(() => of("position").length >= 2, 3_000);
		const moved = of("position").at(-1)?.snapshot;
		expect(moved?.ply).toBe(7);
		expect(moved?.sideToMove).toBe("b");
		expect(moved?.lastMove).toEqual({ from: "d2", to: "d4", san: "d4" });
		expect(of("moveObserved").at(-1)?.san).toBe("d4");

		// SW → content: highlights only after settings enables them; the bridge owns the overlay.
		const overlay = () => doc.querySelector("wc-chess-board > svg:not(.coordinates)");
		const port = ports[0];
		if (!port) throw new Error("no port");
		port.post({ kind: "highlight", from: "d4", to: "d5", style: "both" });
		await new Promise((r) => setTimeout(r, 60));
		expect(game.markings.added).toHaveLength(0);
		expect(overlay()).toBeNull();
		port.post({ kind: "settings", highlightMoves: true });
		port.post({ kind: "highlight", from: "d4", to: "d5", style: "both" });
		await waitFor(() => overlay()?.querySelector("path") !== null && overlay() !== null, 3_000);
		expect(
			[...(overlay()?.querySelectorAll("rect") ?? [])].map((r) => [
				r.getAttribute("x"),
				r.getAttribute("y"),
			])
		).toEqual([
			["3", "4"],
			["3", "3"],
		]);
		expect(overlay()?.querySelectorAll("path")).toHaveLength(1);
		expect(game.markings.added).toHaveLength(0);
		port.post({ kind: "clearHighlight" });
		await waitFor(() => overlay() === null, 3_000);

		// the page realm has no inserted element of ours (the fixture's own coordinates svg stays)
		expect(dom.document.querySelectorAll("wc-chess-board svg:not(.coordinates)").length).toBe(0);
		expect(dom.document.querySelectorAll("wc-chess-board > svg").length).toBe(1);
	}, 15_000);
});
