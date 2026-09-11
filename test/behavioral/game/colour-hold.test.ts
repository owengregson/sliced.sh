// test/behavioral/game/colour-hold.test.ts — §4.4's hold shape applied to the *colour* (the owner's
// first live test, 2026-09-09: the extension decided the owner was white when they were black, and
// predicted, highlighted and would have played for the opponent).
//
// The colour is three-valued exactly like `Settings.enabled`: mine, theirs, and *not known yet* —
// the MAIN-world bridge answers `getPlayingAs()` a moment after the board appears, and before that
// there is no colour evidence on the live page at all. Guessing is the bug: a snapshot whose
// `myColor` is null must be followed (ply, clocks, state machine, panel) and acted on in no way,
// then resumed from the moment a later reading supplies the colour.
import { afterEach, describe, expect, it } from "bun:test";
import { legalMoves } from "@core/chess/san";
import { CDP } from "@core/constants/cdp";
import type { GamePortCommand } from "@core/constants/messages";
import type { Color, PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

/** After 1.e4 — black to move, ply 1. */
const BLACK_TO_MOVE = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
/** The start position — white to move, ply 0: the owner's very first move of a game. */
const START_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GAME_ID = "harness-game";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

function position(myColor: Color | null, over: Partial<PositionSnapshot> = {}): PositionSnapshot {
	return {
		site: "chesscom",
		gameId: GAME_ID,
		fen: BLACK_TO_MOVE,
		ply: 1,
		sideToMove: "b",
		myColor,
		clocks: { w: { ms: 300_000, running: false }, b: { ms: 300_000, running: true } },
		timeControl: { baseMs: 300_000, incMs: 2_000 },
		capturedAt: h.sim.now(),
		...over,
	};
}

/** The owner's own first move, as the real content script delivers it: white, ply 0. */
const firstMove = (myColor: Color | null): PositionSnapshot =>
	position(myColor, { fen: START_POSITION, ply: 0, sideToMove: "w" });

const boardCommands = (): GamePortCommand[] =>
	h.commands().filter((c) => c.kind === "highlight" || c.kind === "clearHighlight");

describe("game session: an unknown colour holds (it is never guessed)", () => {
	it("holds a colourless position — no go, no recommendation, no highlight, nothing scheduled — and resumes as black", async () => {
		h = await createGameHarness({
			manualStart: true,
			myColor: "b",
			settings: { automation: { autoMove: true, highlightMoves: true } },
		});
		await h.drive(() => h.site.hello());
		// armed in the waiting view (§13.4): arming must not need the colour
		await h.sw.run(() => h.session().command("armAutoMove"));
		expect(h.executor()?.isArmed()).toBe(true);

		// The colour is not known yet. The position is followed and acted on in no way.
		await h.drive(() => h.site.post({ kind: "position", snapshot: position(null) }));
		await h.advance(2_000);
		const session = h.session();
		expect(session.view().ply).toBe(1);
		expect(session.view().sideToMove).toBe("b");
		expect(session.view().myColor).toBeNull();
		expect(session.recommendation()).toBeNull();
		expect(h.transport.goLines).toEqual([]);
		// nothing is drawn on the board (a clear is fine — holding means the board carries nothing)
		expect(boardCommands().filter((c) => c.kind === "highlight")).toEqual([]);
		expect(h.executor()?.pendingMove()).toBeNull();
		expect(h.executor()?.isRunning()).toBe(false);
		// Arming maintains page focus, but an unknown colour must never produce pointer input.
		expect(h.sim.debugger.commands.filter((c) => c.method !== CDP.focusEmulation)).toEqual([]);
		expect(h.site.board.lastMove()).toBeNull();

		// The bridge answers: the owner is black. The position has not moved, so this is the same
		// ply arriving again with the colour filled in — and it must be picked up.
		await h.drive(() => h.site.post({ kind: "position", snapshot: position("b") }));
		expect(await h.until(() => session.recommendation() !== null, 10_000)).toBe(true);
		expect(session.view().myColor).toBe("b");
		const rec = session.recommendation();
		if (!rec) throw new Error("no recommendation after the colour arrived");
		expect(rec.fen).toBe(BLACK_TO_MOVE);
		// the move recommended is one of *black's* legal moves, i.e. the owner's own move
		expect(legalMoves(BLACK_TO_MOVE)).toContain(rec.chosen.uci);
		expect(h.transport.goLines.length).toBeGreaterThan(0);
		expect(boardCommands()).toContainEqual({
			kind: "highlight",
			from: rec.chosen.from,
			to: rec.chosen.to,
			style: h.settings().automation.highlightStyle,
		});
	});

	it("releases the hold when the page sent gameStarted first — the production order", async () => {
		// The real content script posts `gameStarted` before the first `position`
		// (`src/content/index.ts`), so `startGame()` has already reset the feed dedupe by the time the
		// colourless ply arrives. The republished ply carries an identical `gameId|ply|fen`, so a
		// dedupe key that omits `myColor` drops it as the reconnect replay — and nothing else can
		// release the hold, because as white the position cannot change until the owner moves by hand.
		h = await createGameHarness({
			manualStart: true,
			myColor: "w",
			settings: { automation: { autoMove: true, highlightMoves: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame({ myColor: null });
		});
		await h.drive(() => h.site.post({ kind: "position", snapshot: firstMove(null) }));
		await h.advance(2_000);
		const session = h.session();
		expect(session.view().ply).toBe(0);
		expect(session.view().myColor).toBeNull();
		expect(session.recommendation()).toBeNull();
		expect(h.transport.goLines).toEqual([]);

		// The bridge answers. Same game, same ply, same FEN — only the colour is new.
		await h.drive(() => h.site.post({ kind: "position", snapshot: firstMove("w") }));
		expect(await h.until(() => session.recommendation() !== null, 10_000)).toBe(true);
		expect(session.view().myColor).toBe("w");
		expect(h.transport.goLines.length).toBeGreaterThan(0);
		expect(legalMoves(START_POSITION)).toContain(session.recommendation()?.chosen.uci ?? "");
	});

	it("never ponders or premoves for the opponent while the colour is unknown", async () => {
		h = await createGameHarness({ manualStart: true, myColor: "b" });
		await h.drive(() => h.site.hello());
		await h.drive(() => h.site.post({ kind: "position", snapshot: position(null) }));
		await h.advance(5_000);
		// `go infinite` is the ponder: with the colour unknown the session cannot know whose turn it
		// is, so it must not start one — it was the "not my turn ⇒ ponder" branch that ran here.
		expect(h.transport.goLines).toEqual([]);
		// §3.3 has no "colour unknown" state, so the label is `live:opponent-turn` even though this is
		// in fact the owner's move. `myColor` is the truthful signal and the panel reads that.
		expect(h.session().view().myColor).toBeNull();
		expect(h.session().recommendation()).toBeNull();
	});
});
