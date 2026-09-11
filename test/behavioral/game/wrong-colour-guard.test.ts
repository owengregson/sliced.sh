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
import { sideToMove, turnFieldOf } from "@core/chess/fen";
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
const clears = (): GamePortCommand[] => h.commands().filter((c) => c.kind === "clearHighlight");

/**
 * `GameMeta.myColor` — the session's per-game copy of the colour, which `view()` falls back to only
 * when there is no snapshot. Nothing else reads it today, so there is no public surface to assert it
 * through; this reaches the private field deliberately, because the alternative is leaving the
 * field's staleness untested (see the report's Fix round 1 notes).
 */
const gameMetaColor = (): Color | null | undefined =>
	(h.session() as unknown as { game: { myColor: Color | null } | null }).game?.myColor;

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

describe("game session: a colour correction withdraws what the wrong colour produced", () => {
	it("withdraws the standing recommendation and its mark when the corrected colour arrives", async () => {
		// The owner's bug, end to end from the session's side: the adapter's first reading of the live
		// page answered WHITE (the clocks before the board was turned round), so the session planned
		// white's first move and marked it. The bridge then answers `getPlayingAs() → 2` and the
		// adapter republishes the *same* ply with the colour corrected — the only thing that can
		// release this, because as black the position cannot move until white plays.
		await boot("b");
		await h.drive(() => h.site.post({ kind: "position", snapshot: position({ myColor: "w" }) }));
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const wrong = h.session().recommendation();
		if (!wrong) throw new Error("no recommendation to withdraw");
		// a move for WHITE, on the snapshot's own FEN — `rec.fen === snapshot.fen` is the invariant
		// `postHighlight` used to re-test for itself
		expect(legalMoves(START_POSITION)).toContain(wrong.chosen.uci);
		expect(wrong.fen).toBe(START_POSITION);
		expect(highlights().length).toBe(1);
		expect(h.session().view().myColor).toBe("w");
		expect(gameMetaColor()).toBe("w");
		const marks = highlights().length;
		const clearsBefore = clears().length;

		// The correction: same game, same ply, same FEN, only the colour is new.
		await h.drive(() => h.site.post({ kind: "position", snapshot: position({ myColor: "b" }) }));
		await h.advance(5_000);
		expect(h.session().recommendation()).toBeNull();
		expect(h.session().view().myColor).toBe("b");
		// the game's own copy is corrected too, so nothing downstream reads the colour we are not playing
		expect(gameMetaColor()).toBe("b");
		// the mark is erased and no new one is drawn
		expect(clears().length).toBeGreaterThan(clearsBefore);
		expect(highlights().length).toBe(marks);
		expect(h.executor()?.pendingMove()).toBeNull();
		expect(h.site.board.lastMove()).toBeNull();
	});
});

describe("game session: the contradiction hold is symmetric", () => {
	it("does not ponder or arm a premove when the FEN says it is our turn and sideToMove says otherwise", async () => {
		// The mirror of the owner's case, and the direction the first round let through: `myTurn` is
		// false (`sideToMove "b"` ≠ `myColor "w"`) while the FEN says white. That reached
		// `onOpponentTurn`, which starts `go infinite` on our *own* position and arms a premove
		// conditioned on one of our own moves as if it were the opponent's reply.
		await boot("w");
		await h.drive(() =>
			h.site.post({ kind: "position", snapshot: position({ myColor: "w", sideToMove: "b" }) })
		);
		await h.advance(10_000);
		expect(h.session().view().ply).toBe(0);
		// no ponder, no premove gate search — nothing was searched at all
		expect(h.transport.goLines).toEqual([]);
		expect(h.session().recommendation()).toBeNull();
		expect(highlights()).toEqual([]);
		expect(h.executor()?.pendingMove()).toBeNull();
	});

	it("holds on resume too: the switch coming back on is not new evidence about whose turn it is", async () => {
		// `resumeEnabled` resumes the stored position directly, so it needs the same invariant: the
		// position was already held once, and turning the assistant off and on again must not talk the
		// session into answering for the other side.
		await boot("b");
		await h.patch({ enabled: false });
		await h.drive(() => h.site.post({ kind: "position", snapshot: position({ sideToMove: "b" }) }));
		await h.advance(2_000);
		expect(h.session().recommendation()).toBeNull();

		await h.patch({ enabled: true });
		await h.advance(10_000);
		expect(h.session().recommendation()).toBeNull();
		expect(h.transport.goLines).toEqual([]);
		expect(highlights()).toEqual([]);
	});

	it("a FEN with no turn field is not a hold: the position is still played from sideToMove", async () => {
		// `turnFieldOf` is lenient, so reaching this means the site answered something with no turn
		// field at all. A permanent, open-ended hold is the wrong answer to that — it would silently
		// stop the assistant for the whole game — so the adapter's own reading decides, and the
		// recommendation is still for our colour.
		await boot("b");
		const placementOnly = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR";
		await h.drive(() =>
			h.site.post({
				kind: "position",
				snapshot: position({ fen: placementOnly, ply: 1, sideToMove: "b", myColor: "b" }),
			})
		);
		await h.advance(10_000);
		// the engine cannot use a FEN like this, so what matters is that the session did not hold: it
		// ran the pipeline for the side the snapshot says is to move
		expect(h.transport.goLines.length).toBeGreaterThan(0);
	});
});

describe("game session: the contradiction is read from the FEN's turn field, not from a full parse", () => {
	it("holds a five-field FEN whose stated turn contradicts sideToMove", async () => {
		// The case that separates `turnFieldOf` from `sideToMove`. chess.js rejects a FEN with five
		// fields, so a strict parse answers `null` — "no turn stated" — and the contradiction passes
		// through vacuously. The turn *is* stated; whose move it is does not depend on the rest of the
		// position validating. So the lenient read catches contradictions the strict one cannot, which
		// is the direction that matters here (the round-1 report had this backwards).
		await boot("b");
		const fiveFields = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3";
		expect(sideToMove(fiveFields)).toBeNull(); // the strict parse: no opinion
		expect(turnFieldOf(fiveFields)).toBe("b"); // the field itself: black
		await h.drive(() =>
			h.site.post({
				kind: "position",
				// `sideToMove: "w"` === `myColor`… except the FEN it is published beside says black, so
				// the engine would answer for black while the session calls it our move.
				snapshot: position({ fen: fiveFields, ply: 1, sideToMove: "w", myColor: "w" }),
			})
		);
		await h.advance(10_000);
		expect(h.session().recommendation()).toBeNull();
		expect(h.transport.goLines).toEqual([]);
		expect(highlights()).toEqual([]);
	});
});

describe("game session: a withdrawn colour is withdrawn from the panel too", () => {
	it("reports no colour after a withdrawal, instead of the one the site contradicted", async () => {
		// The adapter withholds the colour once a game has spent its corrections and the site
		// contradicts it again (`LIMITS.colourCorrectionsPerGame`): the snapshot then carries
		// `myColor: null` and `mayActOn` holds on it, so the assistant does nothing. What the *panel*
		// says has to follow, and `view()` falls back to the session's per-game copy — so a copy that
		// kept the old value left the owner reading "Your move · white", the colour the site had just
		// contradicted, beside an assistant that had gone quiet (review R2-1).
		await boot("b");
		await h.drive(() => h.site.post({ kind: "position", snapshot: position({ myColor: "w" }) }));
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		expect(h.session().view().myColor).toBe("w");
		expect(gameMetaColor()).toBe("w");

		// the withheld reading: same game, same ply, same FEN, no colour
		await h.drive(() => h.site.post({ kind: "position", snapshot: position({ myColor: null }) }));
		await h.advance(5_000);
		expect(h.session().view().myColor).toBeNull();
		expect(gameMetaColor()).toBeNull();
		// …and it really is a hold, not a colour swap
		expect(h.session().recommendation()).toBeNull();
		expect((await h.snapshot()).session.myColor).toBeNull();
	});
});
