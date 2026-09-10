// test/behavioral/game/mark-survives-the-hand.test.ts — Fix A (the owner's live blitz game,
// 2026-09-10): "the move highlight disappears when the mouse starts its action (even if its going
// to touch other pieces etc.) rather than when it finishes it".
//
// This file is the *service worker's* half: which board commands the session sends, and when,
// relative to what the hand is doing. What the page then renders is `test/content/mark-to-page.test.ts`,
// which runs the real content script and the emitted bridge program against a real DOM — that is
// where "the mark is our own `<svg>` and the verifier does not remove it" is proved, with no
// assumption about chess.com in it.
//
// Read the two together, because one assertion here does rest on an assumption and the rest do not:
//
//   ASSUMPTION-FREE (red against the pre-lane tree for an observable reason):
//     - the session instructs the page to draw the execution's mark *before* the first press;
//     - between that instruction and the move landing it sends nothing else;
//     - a move that lands clears, and so does an attempt that finally failed;
//     - a position republished for the same ply while the hand is running neither clears nor
//       cancels (chess.com's DOM renderer does exactly this when a piece is lifted).
//
//   RESTS ON AN ASSUMPTION (`pressWipesTheSitesMarkings`, recorded in `test/sim/assumptions.md`):
//     - the "still marked at every press / through the drag / at every release" samples in the
//       last test. chess.com clearing its own user markings on a left press is unprovable site
//       behaviour; only `docs/qa-checklist.md` B0.8-B0.9 can answer it. It is asserted here
//       because it is the owner's symptom, not because it is the proof.
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
	/** Marks sampled at each `mousedown` *after* the modelled site wipe — the first press's real test. */
	afterPress: Mark[];
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
		afterPress: [],
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
				// Sampled again after the wipe: `atPress` alone cannot fail on a single-press action,
				// because the wipe happens after its sample (the reviewer's Minor 5).
				marks.afterPress.push(mark);
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

/**
 * Committed and preview presses the hand has dispatched so far. `0` before the harness finishes
 * booting — `onGameStarted` sends a `clearHighlight` from inside `createGameHarness`, so the
 * command hook runs before `h` is assigned.
 */
const presses = (): number =>
	(h as GameHarness | undefined)?.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	).length ?? 0;

describe("game session: the mark survives the hand's whole action", () => {
	it("the execution's mark is drawn before the first press, and nothing else touches the board until the move lands", async () => {
		const seen: Array<{ cmd: GamePortCommand; pressesSoFar: number }> = [];
		h = await createGameHarness({
			settings: {
				automation: { autoMove: true, highlightMoves: true },
				execution: { style: "drag" },
			},
			// Every board command, stamped with how many presses the hand had dispatched by then:
			// the ordering is read off the CDP stream, not off a field of ours.
			onCommand: (cmd) => {
				if (cmd.kind === "highlight" || cmd.kind === "clearHighlight")
					seen.push({ cmd, pressesSoFar: presses() });
			},
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
		expect(presses()).toBeGreaterThan(0);

		// The instruction that makes the mark ours arrives while the hand has pressed nothing yet.
		// What it makes the page do is `test/content/mark-to-page.test.ts`'s business.
		const drawn = seen.findIndex((e) => e.cmd.kind === "highlight" && e.cmd.overlay === true);
		expect(drawn).toBeGreaterThanOrEqual(0);
		expect(seen[drawn]?.pressesSoFar).toBe(0);

		// From there to the move landing, the session sends exactly one thing: the clear at the end.
		expect(seen.slice(drawn + 1).map((e) => e.cmd.kind)).toEqual(["clearHighlight"]);
		expect(seen.at(-1)?.pressesSoFar).toBe(presses());
	});

	it("an attempt that finally failed clears the mark too — the action is complete either way", async () => {
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
		expect(await h.until(() => marks.current() !== null, 10_000)).toBe(true);
		expect(await h.until(() => h.executor()?.runningMove() !== null, 20_000)).toBe(true);

		// The hand is disarmed mid-move with the switch left on. `disarm`, unlike `disable`, does not
		// clear the board itself, so the only thing that can is the `aborted` event — a completion
		// with no move on the board. Before this lane nothing cleared there and the mark for a move
		// that never happened stayed put; now it is an overlay `<svg>` of ours, which (unlike the
		// native marking it used to be) nothing on the page would ever wipe. The known promotion
		// gap (QA B0.7) reaches this same event on every live game.
		await h.sw.run(() => h.session().command("disarm"));
		expect(await h.until(() => h.executor()?.isRunning() === false, 20_000)).toBe(true);
		expect(h.site.board.lastMove()).toBeNull();
		expect(marks.current()).toBeNull();
		expect(highlights().at(-1)).toEqual({ kind: "clearHighlight" });
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

	// `clearBoardMarks` must forget the overlay mark, or a second execution of the *same*
	// recommendation finds `markedOverlayFor === rec` and never redraws (the reviewer's M4, which
	// survived the whole suite in round 0). The reachable path: an attempt that did not land clears
	// the mark but keeps the recommendation, and re-arming schedules that same object again.
	it("a clear forgets the overlay mark, so a second run of the same recommendation redraws it", async () => {
		const overlayPosts: GamePortCommand[] = [];
		h = await createGameHarness({
			settings: {
				automation: { autoMove: true, highlightMoves: true },
				execution: { style: "drag" },
			},
			onCommand: (cmd) => {
				if (cmd.kind === "highlight" && cmd.overlay === true) overlayPosts.push(cmd);
			},
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => overlayPosts.length === 1, 30_000)).toBe(true);
		const rec = h.session().recommendation();
		if (!rec) throw new Error("no recommendation");

		// The attempt does not land: `aborted` → the mark is cleared, the recommendation is kept.
		await h.sw.run(() => h.session().command("disarm"));
		expect(await h.until(() => h.executor()?.isRunning() === false, 20_000)).toBe(true);
		expect(h.session().recommendation()).toBe(rec);
		expect(highlights().at(-1)).toEqual({ kind: "clearHighlight" });

		// Arming again reschedules that very object; its mark has to be drawn again.
		await h.sw.run(() => h.session().command("armAutoMove"));
		expect(await h.until(() => overlayPosts.length === 2, 30_000)).toBe(true);
		expect(overlayPosts[1]).toMatchObject({ from: rec.chosen.from, to: rec.chosen.to });
	});

	it("the redraw is only for the recommendation the hand is actually running", async () => {
		const overlayPosts: GamePortCommand[] = [];
		h = await createGameHarness({
			settings: {
				automation: { autoMove: true, highlightMoves: true },
				execution: { style: "drag" },
			},
			onCommand: (cmd) => {
				if (cmd.kind === "highlight" && cmd.overlay === true) overlayPosts.push(cmd);
			},
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		const played = h.site.board.lastMove();
		expect(played?.byMe).toBe(true);
		// Exactly one redraw for the one move the hand ran, and it names that move's squares.
		expect(overlayPosts).toHaveLength(1);
		expect(overlayPosts[0]).toMatchObject({ from: played?.from, to: played?.to });
	});

	/**
	 * The owner's symptom, stated as the owner stated it. **This is the one test in the lane whose
	 * discriminating power rests on an assumption** — `pressWipesTheSitesMarkings`, i.e. that
	 * chess.com clears its own user markings on a left press on the board. That is unprovable site
	 * behaviour (`test/sim/assumptions.md`, answered by `docs/qa-checklist.md` B0.8-B0.9), so read
	 * it as the shape of the bug rather than as the proof that it is fixed; the proof is the three
	 * tests above plus `test/content/mark-to-page.test.ts`.
	 */
	it("with a site that wipes its own markings on a press, the mark still survives every press, the drag and every release", async () => {
		const marks = boardMarks(true);
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
		expect(await h.until(() => presses() > 0, 30_000)).toBe(true);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.byMe).toBe(true);

		// Every sample the page took while the hand was acting saw a mark — `afterPress` included,
		// which is the one the modelled wipe has already been applied to.
		expect(marks.atPress.length).toBeGreaterThan(0);
		expect(marks.atPress.filter((m) => m === null)).toEqual([]);
		expect(marks.afterPress.filter((m) => m === null)).toEqual([]);
		expect(marks.duringDrag.length).toBeGreaterThan(0);
		expect(marks.duringDrag.filter((m) => m === null)).toEqual([]);
		expect(marks.atRelease.length).toBeGreaterThan(0);
		expect(marks.atRelease.filter((m) => m === null)).toEqual([]);

		// And the action being complete is what erases it.
		expect(marks.current()).toBeNull();
		expect(highlights().at(-1)).toEqual({ kind: "clearHighlight" });
	});
});
