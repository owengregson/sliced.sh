// test/behavioral/game/mark-survives-the-hand.test.ts — Fix A (the owner's live blitz game,
// 2026-09-10): "the move highlight disappears when the mouse starts its action (even if its going
// to touch other pieces etc.) rather than when it finishes it".
//
// The mark for the move we are about to play must stay on the board for the whole of the hand's
// action — the approach, every preview touch of another piece, the press, the drag, the release —
// and be erased only once the action is complete. Two things can take it away:
//
//   (1) the *site*: chess.com clears its own user markings on a left press on the board, and the
//       hand's action is made of presses. That is site behaviour and cannot be proved from this
//       repository, so it is modelled here as an assumption (`pressWipesTheSitesMarkings`) and the
//       fix does not depend on it being true: the mark of a move being executed is drawn through
//       the bridge's own SVG overlay, which is ours and not the site's.
//   (2) *us*: a position republished while the hand is mid-move. chess.com's DOM renderer mutates
//       the `.piece` elements while a piece is off its square, and when the markup carries no
//       `.piece.dragging` the adapter publishes an approximate position for the same ply — which
//       used to cancel the execution and erase the mark (measured: see `ownHandsDoing` in
//       `src/service/game-session/session.ts`).
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import type { GamePortCommand } from "@core/constants/messages";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

/** What is on the board, as the page would see it. */
type Mark = "native" | "overlay" | null;

interface BoardMarks {
	/** The command hook to hand `createGameHarness`. */
	onCommand(cmd: GamePortCommand): void;
	/** The mark on the board right now. */
	current(): Mark;
	/** Marks sampled at each `mousedown`, before the modelled site wipe. */
	atPress: Mark[];
	/** Marks sampled at each `mousemove` with the button held. */
	duringDrag: Mark[];
	/** Marks sampled at each `mouseup`. */
	atRelease: Mark[];
	/** Listen to the page's own pointer events (call after the harness exists). */
	watch(h: GameHarness): void;
}

/**
 * The board's marks as the page holds them, driven by the game-port commands the service worker
 * sends and by the pointer events the hand dispatches through CDP.
 *
 * The one assumption is `pressWipesTheSitesMarkings`: a left press on the board removes a *native*
 * marking (the site's own object) and leaves an overlay mark (ours) alone. Chrome is the only place
 * that can confirm it — see `docs/qa-checklist.md`.
 */
function boardMarks(pressWipesTheSitesMarkings = true): BoardMarks {
	let mark: Mark = null;
	let enabled = false;
	let held = false;
	const marks: BoardMarks = {
		atPress: [],
		duringDrag: [],
		atRelease: [],
		current: () => mark,
		onCommand(cmd) {
			if (cmd.kind === "settings") {
				enabled = cmd.highlightMoves;
				if (!enabled) mark = null;
				return;
			}
			if (cmd.kind === "clearHighlight") {
				mark = null;
				return;
			}
			// A draw replaces whatever was drawn (the content script clears first), so one mark only.
			if (cmd.kind === "highlight" && enabled) mark = cmd.overlay === true ? "overlay" : "native";
		},
		watch(harness) {
			const doc = harness.site.dom.document as unknown as Document;
			doc.addEventListener("mousedown", () => {
				marks.atPress.push(mark);
				held = true;
				if (pressWipesTheSitesMarkings && mark === "native") mark = null;
			});
			doc.addEventListener("mousemove", () => {
				if (held) marks.duringDrag.push(mark);
			});
			doc.addEventListener("mouseup", () => {
				marks.atRelease.push(mark);
				held = false;
			});
		},
	};
	return marks;
}

const highlights = (): GamePortCommand[] =>
	h.commands().filter((c) => c.kind === "highlight" || c.kind === "clearHighlight");

const presses = (): unknown[] =>
	h.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);

describe("game session: the mark survives the hand's whole action", () => {
	it("is on the board at every press, through the drag and at the release, and gone once the move lands", async () => {
		const marks = boardMarks();
		h = await createGameHarness({
			settings: {
				automation: { autoMove: true, highlightMoves: true },
				execution: { style: "drag" },
			},
			onCommand: (cmd) => marks.onCommand(cmd),
		});
		marks.watch(h);
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => marks.current() !== null, 10_000)).toBe(true);

		// The hand starts acting: from here the mark must be one the site's own press cannot remove.
		expect(await h.until(() => h.executor()?.handState() !== "rest", 30_000)).toBe(true);
		const whenTheHandStarted = marks.current();

		expect(await h.until(() => presses().length > 0, 30_000)).toBe(true);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.byMe).toBe(true);

		// Every sample the page took while the hand was acting saw a mark.
		expect(marks.atPress.length).toBeGreaterThan(0);
		expect(marks.atPress.filter((m) => m === null)).toEqual([]);
		expect(marks.duringDrag.length).toBeGreaterThan(0);
		expect(marks.duringDrag.filter((m) => m === null)).toEqual([]);
		expect(marks.atRelease.length).toBeGreaterThan(0);
		expect(marks.atRelease.filter((m) => m === null)).toEqual([]);
		// …because it was ours, not the site's.
		expect(whenTheHandStarted).toBe("overlay");

		// And the action being complete is what erases it.
		expect(marks.current()).toBeNull();
		expect(highlights().at(-1)).toEqual({ kind: "clearHighlight" });
	});

	it("the only board command after the mark is drawn for the execution is the clear that ends it", async () => {
		h = await createGameHarness({
			settings: {
				automation: { autoMove: true, highlightMoves: true },
				execution: { style: "drag" },
			},
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		const all = highlights();
		const drawn = all.findIndex((c) => c.kind === "highlight" && c.overlay === true);
		expect(drawn).toBeGreaterThanOrEqual(0);
		// Nothing of ours touches the board between the hand taking over and the move landing.
		expect(all.slice(drawn + 1).map((c) => c.kind)).toEqual(["clearHighlight"]);
	});

	it("a lifted piece republished on the same ply neither clears the mark nor cancels the move", async () => {
		const marks = boardMarks();
		h = await createGameHarness({
			settings: {
				automation: { autoMove: true, highlightMoves: true },
				execution: { style: "drag" },
			},
			onCommand: (cmd) => marks.onCommand(cmd),
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 20_000)).toBe(true);
		const rec = h.session().recommendation();
		if (!rec) throw new Error("no recommendation");
		expect(marks.current()).not.toBeNull();
		const before = highlights().length;

		// The DOM renderer's mid-drag reading: same game, same ply, same side to move, an
		// approximate FEN with the a1 rook lifted off its square.
		const lifted = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w KQkq - 0 1";
		await h.drive(() =>
			h.site.post({
				kind: "position",
				snapshot: {
					site: "chesscom",
					gameId: h.site.gameId,
					fen: lifted,
					ply: 0,
					sideToMove: "w",
					myColor: "w",
					clocks: { w: { ms: 300_000, running: true }, b: { ms: 300_000, running: false } },
					timeControl: { baseMs: 300_000, incMs: 2_000 },
					capturedAt: h.sim.now(),
				},
			})
		);
		await h.advance(50);
		// Nothing was erased and nothing was re-analysed: the reading was our own hand.
		expect(highlights().slice(before)).toEqual([]);
		expect(marks.current()).not.toBeNull();
		expect(h.session().recommendation()).toBe(rec);

		// The move the board is marked for is the move that lands.
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.uci).toBe(rec.chosen.uci);
		expect(marks.current()).toBeNull();
	});
});
