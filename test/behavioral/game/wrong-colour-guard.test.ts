// test/behavioral/game/wrong-colour-guard.test.ts — Fix B: never recommend a move for the side we
// are not playing (owner's live blitz game, 2026-09-10: "still displays white's recommended first
// move (first move of the game) when you are playing black — your timer is frozen but whites is
// ticking").
//
// The session's own layer of that invariant. `myTurn` is derived from `snapshot.sideToMove`, which
// the adapter builds on a different ladder from `snapshot.fen`, and the engine answers for whoever
// the **FEN** says is to move. So a snapshot whose `fen` turn is not `myColor` must be held exactly
// as a colourless one is: no search, no recommendation, no highlight, nothing scheduled — whatever
// `sideToMove` claims. A recommendation for the wrong colour makes the assistant visibly play the
// opponent's side, which is strictly worse than no recommendation at all.
import { afterEach, describe, expect, it } from "bun:test";
import { legalMoves } from "@core/chess/san";
import type { GamePortCommand } from "@core/constants/messages";
import type { Color, PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

/** The start position — white to move, ply 0: the owner's very first move of a game. */
const START_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** After 1.e4 — black to move, ply 1. */
const BLACK_TO_MOVE = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const GAME_ID = "harness-game";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

function position(over: Partial<PositionSnapshot> = {}): PositionSnapshot {
	return {
		site: "chesscom",
		gameId: GAME_ID,
		fen: START_POSITION,
		ply: 0,
		sideToMove: "w",
		myColor: "b",
		clocks: { w: { ms: 180_000, running: true }, b: { ms: 180_000, running: false } },
		timeControl: { baseMs: 180_000, incMs: 0 },
		capturedAt: h.sim.now(),
		...over,
	};
}

const highlights = (): GamePortCommand[] => h.commands().filter((c) => c.kind === "highlight");

async function boot(myColor: Color): Promise<void> {
	h = await createGameHarness({
		manualStart: true,
		myColor,
		settings: { automation: { autoMove: true, highlightMoves: true } },
	});
	await h.drive(() => h.site.hello());
	await h.drive(() => h.site.startGame({ myColor }));
}

describe("game session: a recommendation is only ever for the side we are playing", () => {
	it("holds the opponent's first move (ply 0, playing black) and recommends once it is our turn", async () => {
		await boot("b");
		await h.drive(() => h.site.post({ kind: "position", snapshot: position() }));
		await h.advance(5_000);
		const session = h.session();
		// the position is followed…
		expect(session.view().ply).toBe(0);
		expect(session.view().myColor).toBe("b");
		// …and acted on in no way: white's first move is not ours to play
		expect(session.recommendation()).toBeNull();
		expect(highlights()).toEqual([]);
		expect(h.executor()?.pendingMove()).toBeNull();

		// our turn: now there is a recommendation, and it is one of *black's* legal moves
		await h.drive(() =>
			h.site.post({
				kind: "position",
				snapshot: position({ fen: BLACK_TO_MOVE, ply: 1, sideToMove: "b" }),
			})
		);
		expect(await h.until(() => session.recommendation() !== null, 10_000)).toBe(true);
		const rec = session.recommendation();
		if (!rec) throw new Error("no recommendation on our own turn");
		expect(legalMoves(BLACK_TO_MOVE)).toContain(rec.chosen.uci);
	});

	it("holds a snapshot whose sideToMove contradicts its own FEN — the pipeline never runs", async () => {
		await boot("b");
		// The owner's symptom, as a snapshot: `sideToMove` says it is black's turn (so `myTurn` is
		// true) while the FEN says white. The engine answers the FEN, so the recommendation would be
		// a move for WHITE — the opponent's side — at ply 0.
		await h.drive(() => h.site.post({ kind: "position", snapshot: position({ sideToMove: "b" }) }));
		await h.advance(10_000);
		const session = h.session();
		expect(session.view().ply).toBe(0);
		expect(session.recommendation()).toBeNull();
		expect(h.transport.goLines).toEqual([]);
		expect(highlights()).toEqual([]);
		expect(h.executor()?.pendingMove()).toBeNull();
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("holds the mirror contradiction too: our colour, the FEN's turn, and sideToMove all disagree", async () => {
		await boot("w");
		// `sideToMove` "w" === myColor "w" ⇒ `myTurn`, but the FEN is black to move: the engine would
		// answer for black.
		await h.drive(() =>
			h.site.post({
				kind: "position",
				snapshot: position({ fen: BLACK_TO_MOVE, ply: 1, sideToMove: "w", myColor: "w" }),
			})
		);
		await h.advance(10_000);
		expect(h.session().recommendation()).toBeNull();
		expect(h.transport.goLines).toEqual([]);
		expect(highlights()).toEqual([]);
	});
});
