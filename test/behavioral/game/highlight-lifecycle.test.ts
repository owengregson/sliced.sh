// test/behavioral/game/highlight-lifecycle.test.ts — the board mark's one invariant (the owner's
// live test, 2026-09-09: "old move highlights are not erased after the move is made").
//
// A highlight is only ever drawn for the recommendation that is current *now*, and it disappears
// the moment that recommendation stops being current — the move was played (by the hand or by the
// owner), the position moved on, the game ended. Nothing drew the clear before: the session posted
// `clearHighlight` only from the master switch going off and from `Shift+X`, so the mark for the
// move just played stayed on the board for the whole of the opponent's turn.
import { afterEach, describe, expect, it } from "bun:test";
import type { GamePortCommand } from "@core/constants/messages";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

type BoardMark = Extract<GamePortCommand, { kind: "highlight" } | { kind: "clearHighlight" }>;

const marks = (): BoardMark[] =>
	h.commands().filter((c): c is BoardMark => c.kind === "highlight" || c.kind === "clearHighlight");

describe("game session: the board mark follows the current recommendation", () => {
	it("the mark for a move the hand played is cleared when the move lands", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true, highlightMoves: true } },
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => marks().some((c) => c.kind === "highlight"), 10_000)).toBe(true);
		const drawn = marks().filter((c) => c.kind === "highlight").length;

		// The hand plays the move.
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.byMe).toBe(true);

		// The move is on the board: the prediction is spent and its mark must be gone.
		expect(marks().at(-1)).toEqual({ kind: "clearHighlight" });
		expect(marks().filter((c) => c.kind === "highlight").length).toBe(drawn);

		// The opponent replies: our turn again, a fresh recommendation, a fresh mark — and the clear
		// stands between them, so the two are never on the board together.
		await h.arrive("e7e5");
		expect(
			await h.until(() => marks().filter((c) => c.kind === "highlight").length > drawn, 10_000)
		).toBe(true);
		const kinds = marks().map((c) => c.kind);
		expect(kinds.indexOf("clearHighlight")).toBeLessThan(kinds.lastIndexOf("highlight"));
	});

	it("the mark is cleared when the owner plays the move themselves (panel-only mode)", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: false, highlightMoves: true } },
		});
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		if (!rec) throw new Error("no recommendation");
		expect(marks().at(-1)).toEqual({
			kind: "highlight",
			from: rec.chosen.from,
			to: rec.chosen.to,
			style: h.settings().automation.highlightStyle,
		});

		// The owner makes the move with their own hand, and the page publishes the new position.
		await h.drive(() => {
			h.site.board.submit(rec.chosen.from, rec.chosen.to);
		});
		await h.arrive();
		expect(await h.until(() => h.session().view().ply > 0, 5_000)).toBe(true);
		expect(h.session().recommendation()).toBeNull();
		// It is the opponent's turn now: nothing of ours belongs on the board.
		expect(marks().at(-1)).toEqual({ kind: "clearHighlight" });
	});
});
