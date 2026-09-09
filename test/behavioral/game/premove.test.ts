// test/behavioral/game/premove.test.ts — Task 30 Step 2 (c): §7.4. During the opponent's turn the
// session pre-computes a premove conditioned on their expected reply; when that reply actually
// lands the move is played straight away (`t_premove ~ U(0, TIMING_CONSTANTS.premove.maxS)` =
// within 120 ms), with no fresh search. Any other reply falls back to the normal pipeline.
import { afterEach, describe, expect, it } from "bun:test";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const PREMOVE_WINDOW_MS = TIMING_CONSTANTS.premove.maxS * 1000;
/** Seeds tried until one draws a premove — §7.4's probability is a per-game draw. */
const SEEDS = 6;

interface PremoveOptions {
	gameId: string;
	/** Play a reply other than the one the premove is conditioned on. */
	wrongReply?: boolean;
}

/** Play one move, publish the opponent-turn position, then let them reply. */
async function playThenReply(o: PremoveOptions): Promise<{
	expected: string;
	played: string;
	searchesBeforeReply: number;
	arrivedAt: number;
}> {
	await h.arrive();
	expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
		true
	);
	// The position after our move: the opponent is to move, so the session ponders and arms.
	await h.arrive();
	await h.advance(500);

	const fen = h.site.board.fen();
	const moves = h.transport.movesFor(fen);
	const expected = moves[0] as string;
	const played = o.wrongReply ? ((moves[1] ?? moves[0]) as string) : expected;
	const searchesBeforeReply = h.transport.goLines.length;
	const arrivedAt = h.sim.now();
	await h.arrive(played);
	return { expected, played, searchesBeforeReply, arrivedAt };
}

describe("game session: premove (Step 2c)", () => {
	it("fires the armed premove within the §7.4 window when the opponent plays the expected reply", async () => {
		let fired = false;
		for (let seed = 0; seed < SEEDS && !fired; seed++) {
			await h?.dispose();
			h = await createGameHarness({
				settings: {
					automation: { autoMove: true },
					strength: { matchOpponentRating: false, targetElo: 3000 },
				},
				timeControl: { baseMs: 180_000, incMs: 0 }, // blitz: the only speeds §7.4 premoves in
				script: { bestCp: 900, stepCp: 900 }, // a forced-looking position (loss_2nd ≥ 0.25)
				gameId: `premove-${seed}`,
			});
			const { expected, played, searchesBeforeReply, arrivedAt } = await playThenReply({
				gameId: `premove-${seed}`,
			});
			expect(played).toBe(expected);
			const rec = h.session().recommendation();
			if (rec?.chosen.source !== "premove") continue;
			fired = true;

			// It is a premove plan, due inside the §7.4 window, and no search produced it.
			expect(rec.plan.mode).toBe("premove");
			expect(rec.plan.deadlineMs - arrivedAt).toBeLessThanOrEqual(PREMOVE_WINDOW_MS);
			expect(rec.plan.thinkMs).toBeLessThanOrEqual(PREMOVE_WINDOW_MS);
			expect(h.transport.goLines.length).toBe(searchesBeforeReply);
			expect(rec.chosen.rationale.join(" ")).toContain("premove:");
			// The hand starts on it inside the same window — no think time is spent.
			expect(await h.until(() => h.executor()?.runningMove() !== null, 1_000)).toBe(true);
			expect(h.sim.now() - arrivedAt).toBeLessThanOrEqual(PREMOVE_WINDOW_MS + 20);
			expect(h.executor()?.runningMove()?.rec.chosen.uci).toBe(rec.chosen.uci);
		}
		// §7.4's premove probability is a per-game draw; if no seed drew one the test is inert.
		expect(fired).toBe(true);
	}, 120_000);

	it("an unexpected reply is analysed normally — no premove is played", async () => {
		h = await createGameHarness({
			settings: {
				automation: { autoMove: true },
				strength: { matchOpponentRating: false, targetElo: 3000 },
			},
			timeControl: { baseMs: 180_000, incMs: 0 },
			script: { bestCp: 900, stepCp: 900 },
			gameId: "premove-wrong",
		});
		const { expected, played, searchesBeforeReply } = await playThenReply({
			gameId: "premove-wrong",
			wrongReply: true,
		});
		expect(played).not.toBe(expected);
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		expect(rec?.chosen.source).not.toBe("premove");
		expect(rec?.plan.mode).not.toBe("premove");
		// A fresh search ran for the position the opponent actually reached.
		expect(h.transport.goLines.length).toBeGreaterThan(searchesBeforeReply);
	}, 60_000);
});
