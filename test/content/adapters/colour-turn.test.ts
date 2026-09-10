// test/content/adapters/colour-turn.test.ts — Fix B: the adapter must never publish a position
// whose colour or side to move is one the session will act on for the wrong side (owner's live
// blitz game, 2026-09-10: "still displays white's recommended first move (first move of the game)
// when you are playing black — your timer is frozen but whites is ticking").
//
// Two distinct defects of the same class, both on the live WebGL board:
//
//  1. A colour *correction* was silently dropped. `AdapterBase.apply` republished an unmoved
//     position only when the colour went `null → known`, and its dedupe key is
//     `placement|sideToMove` — which at ply 0 is the same string for every reading. So the first
//     reading that answered "white" (the live page's clocks before the board is turned round, a
//     lobby board, or the bridge cache still holding the previous game's `playingAs`) froze
//     `myColor: "w"` into the session for the whole of white's first move.
//
//  2. `sideToMove` could contradict the turn field of the `fen` published beside it. The two come
//     from different ladders (`positionInfoFor` vs `sideToMoveFor`), and the engine answers
//     whichever side the **FEN** says is to move — so `sideToMove: "b"` + `fen: "… w …"` makes
//     `GameSession.myTurn` true for a black player and the recommendation a move for WHITE.

import { afterEach, describe, expect, it } from "bun:test";
import type { AdapterPositionSnapshot } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { sideToMove } from "@core/chess/fen";
import { LIMITS } from "@core/constants/limits";
import { installWindowGlobals, type LayoutRect, type TabDom } from "@test/sim/dom/tab-dom";
import { FakeBridge, loadFixture, pageDocument, pageWindow, sleep, waitFor } from "./helpers";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const WEBGL_RECT: LayoutRect = { x: 120, y: 80, width: 704, height: 704 };
const LOBBY_URL = "https://www.chess.com/play/online";
const SETTLE = 160;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

/** Which colour the page shows at the bottom, and whose clock carries the turn class. */
function setClocks(dom: TabDom, bottom: "w" | "b", active: "w" | "b"): void {
	const top = bottom === "w" ? "b" : "w";
	const cls = (side: "w" | "b", place: "bottom" | "top"): string =>
		`clock-component clock-${place} clock-${side === "w" ? "white" : "black"}${
			active === side ? " clock-player-turn" : ""
		}`;
	dom.query(".clock-bottom").setAttribute("class", cls(bottom, "bottom"));
	dom.query(".clock-top").setAttribute("class", cls(top, "top"));
}

interface BootOptions {
	url?: string;
	/** Remove the move list entirely — the live board grows it only after the first move. */
	ply0?: boolean;
	bottom?: "w" | "b";
	active?: "w" | "b";
}

function boot(state: () => Record<string, unknown> | null, options: BootOptions = {}) {
	const dom = loadFixture("chesscom-webgl", options.url);
	if (options.ply0) dom.document.querySelector("wc-simple-move-list")?.remove();
	setClocks(dom, options.bottom ?? "w", options.active ?? "w");
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

describe("ChessComAdapter — a corrected colour reaches the session", () => {
	it("republishes the unmoved ply-0 position when the colour changes from white to black", async () => {
		// The owner's situation. The bridge answers a FEN but neither `getMode()` nor
		// `getPlayingAs()` (three independent `safe(...)` reads), so the colour comes from the DOM —
		// and the page still shows white at the bottom. Measured reading: `myColor: "w"`.
		let state: Record<string, unknown> | null = { fen: START };
		const { dom, adapter } = boot(() => state, { ply0: true, bottom: "w", active: "w" });
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.readSnapshot()?.myColor).toBe("w");
		expect(adapter.readSnapshot()?.ply).toBe(0);

		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));

		// The bridge answers and the page turns the board round: we are black. The position has not
		// moved — same placement, same side to move — so nothing but the colour has changed, and the
		// session has a recommendation for WHITE standing until it is told.
		state = { fen: START, mode: "playing", playingAs: 2, flipped: true };
		setClocks(dom, "b", "w");
		await waitFor(() => adapter.getMyColor() === "b");
		await waitFor(() => seen.length > 0, 2_000);
		expect(seen.at(-1)?.myColor).toBe("b");
		expect(seen.at(-1)?.fen).toBe(START);
		expect(seen.at(-1)?.ply).toBe(0);
	});

	it("delivers the corrected colour on the reading that starts a new game, key unchanged", async () => {
		// `/play/online`: the lobby board reads as white at ply 0, then the game starts on a fresh
		// board element — a new `gameKey`, and a dedupe key (`placement|sideToMove`) identical to the
		// lobby's, because both are the start position with white to move. The game change used to
		// suppress the colour republish outright (`!gameChanged`), so the one reading that could have
		// told the session it is black was the one reading guaranteed to be dropped.
		let state: Record<string, unknown> | null = { fen: START, mode: "playing", playingAs: 1 };
		const { dom, adapter } = boot(() => state, {
			url: LOBBY_URL,
			ply0: true,
			bottom: "w",
			active: "w",
		});
		await waitFor(() => adapter.readSnapshot() !== null);
		const lobbyGameId = adapter.readSnapshot()?.gameId;
		expect(adapter.readSnapshot()?.myColor).toBe("w");

		const seen: AdapterPositionSnapshot[] = [];
		const starts: number[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		adapter.onGameStart(() => starts.push(1));

		// The paired game: a fresh board element, and we are black.
		const old = dom.query("wc-chess-board");
		old.replaceWith(old.cloneNode(false));
		state = { fen: START, mode: "playing", playingAs: 2, flipped: true };
		setClocks(dom, "b", "w");
		await waitFor(() => starts.length === 1, 2_000);
		await waitFor(() => seen.length > 0, 2_000);
		expect(seen.at(-1)?.gameId).not.toBe(lobbyGameId);
		expect(seen.at(-1)?.myColor).toBe("b");
	});
});

describe("ChessComAdapter — sideToMove never contradicts its own FEN", () => {
	it("bridge FEN: the FEN wins over a stale active clock", async () => {
		const { adapter } = boot(() => ({ fen: START, mode: "playing", playingAs: 2, flipped: true }), {
			ply0: true,
			bottom: "b",
			active: "b",
		});
		await waitFor(() => adapter.readSnapshot() !== null);
		const snapshot = adapter.readSnapshot();
		expect(snapshot?.fen).toBe(START);
		expect(sideToMove(snapshot?.fen ?? "")).toBe("w");
		expect(snapshot?.sideToMove).toBe("w");
	});

	it("replay FEN: the FEN wins over a contradicting active clock", async () => {
		// The move list is the position source while the bridge FEN is momentarily absent. Its replay
		// is white to move (after 1.e4 c6 2.d3 d5 3.f3 dxe4); the clocks still mark black's.
		const { adapter } = boot(() => ({}), { bottom: "b", active: "b" });
		await waitFor(() => adapter.readSnapshot() !== null);
		const snapshot = adapter.readSnapshot();
		expect(adapter.getPositionInfo()?.source).toBe("replay");
		expect(sideToMove(snapshot?.fen ?? "")).toBe("w");
		expect(snapshot?.sideToMove).toBe("w");
		expect(snapshot?.myColor).toBe("b");
	});

	it("DOM approximation: the published turn is the FEN's own", async () => {
		// The third source. `chesscom-live` renders `.piece` elements, and a piece removed from the
		// DOM alone makes the replay disagree with the placement — which is what drops the ladder to
		// the approximate FEN. That FEN's turn is built from the same `sideToMoveFor` the snapshot
		// publishes, so the two cannot disagree here; the assertion pins that they do not.
		const dom = loadFixture("chesscom-live");
		cleanups.push(installWindowGlobals(dom.window));
		const adapter = createChesscomAdapter({
			document: pageDocument(dom),
			window: pageWindow(dom),
		});
		cleanups.push(() => adapter.destroy());
		dom.query(".piece.square-82").remove(); // h2 pawn vanishes from the DOM only
		// the clocks mark black's turn; the move list's parity says white
		setClocks(dom, "b", "b");
		await sleep(SETTLE);
		const snapshot = adapter.readSnapshot();
		expect(snapshot).not.toBeNull();
		if (!snapshot) return;
		expect(adapter.getPositionInfo()?.source).toBe("dom");
		expect(snapshot.approximate).toBe(true);
		expect(sideToMove(snapshot.fen)).not.toBeNull();
		expect(snapshot.sideToMove).toBe(sideToMove(snapshot.fen) ?? "w");
	});
});

describe("ChessComAdapter — a mode the adapter cannot read never yields a spectator's colour", () => {
	/**
	 * `getPlayingAs()` is the one reading only a player has. Once the bridge has answered a mode at
	 * all, the ladder must end there: falling through to the render hands the owner the *bottom
	 * player's* colour for a game they are only watching, and the snapshot is then internally
	 * consistent, so every session guard passes and the assistant recommends, marks and schedules a
	 * move in someone else's game.
	 */
	it("an unrecognised mode with no playingAs answers null, not the bottom clock's colour", async () => {
		const { dom, adapter } = boot(() => ({ fen: START, mode: "spectating" }), {
			ply0: true,
			bottom: "w",
			active: "w",
		});
		await waitFor(() => adapter.readSnapshot() !== null);
		// the clocks are right there and say white is at the bottom…
		expect(dom.query(".clock-bottom").classList.contains("clock-white")).toBe(true);
		// …and it is not ours to take
		expect(adapter.getMyColor()).toBeNull();
		expect(adapter.readSnapshot()?.myColor).toBeNull();
	});

	it("an unrecognised mode WITH playingAs still answers the site's own colour", async () => {
		// The other half: a renamed mode must not strand a live game colourless for its whole length
		// either, because `GameSession.mayActOn` holds on a null colour with nothing to release it.
		const { adapter } = boot(() => ({ fen: START, mode: "spectating", playingAs: 2 }), {
			ply0: true,
			bottom: "b",
			active: "w",
		});
		await waitFor(() => adapter.getMyColor() === "b");
		expect(adapter.readSnapshot()?.myColor).toBe("b");
	});

	it("mode 'observing' during a game of our own no longer strands the session colourless", async () => {
		// The case the brief names. `detectPageKind()` answers `live-spectate` here, so the old rung 1
		// returned `null` for the whole game; `getPlayingAs()` still names our colour.
		const { adapter } = boot(() => ({ fen: START, mode: "observing", playingAs: 2 }), {
			ply0: true,
			bottom: "b",
			active: "w",
		});
		await waitFor(() => adapter.getMyColor() === "b");
		expect(adapter.detectPageKind()).toBe("live-spectate");
		expect(adapter.readSnapshot()?.myColor).toBe("b");
	});

	it("a real spectator is still colourless: mode 'observing' with no playingAs", async () => {
		const { adapter } = boot(() => ({ fen: START, mode: "observing" }), {
			ply0: true,
			bottom: "w",
			active: "w",
		});
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.getMyColor()).toBeNull();
		expect(adapter.readSnapshot()?.myColor).toBeNull();
	});
});

describe("ChessComAdapter — only the site may correct a colour we already know", () => {
	it("a board flip cannot invert a known colour: the render may introduce one, never overturn it", async () => {
		// Mid-game canvas board with the move list present (the replay supplies the FEN) and the bridge
		// answering nothing, so the colour is render-sourced: the bottom clock. The owner then presses
		// "flip board" — or the clocks re-render — and the bottom colour swaps on an unmoved position.
		// Delivering that would make the session recommend and draw the opponent's moves for the rest
		// of the game, which is the very defect this lane closes, entered from the other end.
		const { dom, adapter } = boot(() => ({}), { bottom: "w", active: "w" });
		await waitFor(() => adapter.readSnapshot() !== null);
		expect(adapter.readSnapshot()?.myColor).toBe("w");
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));

		setClocks(dom, "b", "w");
		await waitFor(() => adapter.getMyColor() === "b");
		await sleep(SETTLE);
		// the adapter's own reading follows the render (it is the orientation source), the session is
		// never told
		expect(seen).toEqual([]);
	});

	it("the site's own getPlayingAs() does correct it, and a bounded number of times", async () => {
		// Each alternation is an authoritative answer, so each is a legitimate correction — until the
		// per-game cap, which exists because this is the only republish trigger that is not
		// structurally one-shot.
		let as: 1 | 2 = 1;
		const { adapter, bridge } = boot(() => ({ fen: START, mode: "playing", playingAs: as }), {
			ply0: true,
			bottom: "w",
			active: "w",
		});
		await waitFor(() => adapter.getMyColor() === "w");
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));
		for (let i = 0; i < LIMITS.colourCorrectionsPerGame + 3; i++) {
			as = as === 1 ? 2 : 1;
			bridge.emit("state", {});
			await sleep(SETTLE);
		}
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.length).toBe(LIMITS.colourCorrectionsPerGame);
	});
});

describe("ChessComAdapter — reconciling as it reads keeps the dedupe key stable", () => {
	it("a flapping active-clock class republishes nothing while the position stands still", async () => {
		// Why the reconcile belongs in `read()` and not only in `AdapterBase`: the dedupe key is
		// `placement|sideToMove`, built from the same value the snapshot publishes. Settling the
		// disagreement before the key is built keeps one position keyed one way; settling it afterwards
		// leaves the key naming the turn that was *rejected*, so the class moving back and forth
		// between the clocks republishes an unmoved position every time.
		//
		// Mid-game canvas board, bridge silent, so the replay supplies a FEN that is white to move
		// throughout. Only the clocks' turn class moves.
		const { dom, adapter } = boot(() => ({}), { bottom: "b", active: "b" });
		await waitFor(() => adapter.readSnapshot() !== null);
		const fen = adapter.readSnapshot()?.fen ?? "";
		expect(sideToMove(fen)).toBe("w");
		const seen: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((s) => seen.push(s));

		for (const active of ["w", "b", "w", "b"] as const) {
			setClocks(dom, "b", active);
			await sleep(SETTLE);
		}
		// the position never moved, and the turn it publishes never moved either
		expect(adapter.readSnapshot()?.fen).toBe(fen);
		expect(adapter.readSnapshot()?.sideToMove).toBe("w");
		expect(seen).toEqual([]);
	});
});
