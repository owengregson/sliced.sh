// test/behavioral/game/tablebase.test.ts — endgame tablebases on the simulator (2026-09-23). At max
// strength a ≤ 7-man position is played from the tables: no deep search runs (the tables are
// already perfect), the move still lands on the timing plan's own deadline (C7), and its board
// rating is opened as a tablebase move (Book). Without an answer the max-strength engine path is unchanged.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import type { TablebasePort } from "@core/tablebase/client";
import { parseProbe, type TablebaseProbe } from "@core/tablebase/probe";
import type { BoardEffectsReporter, PlannedMove } from "@service/game-session/board-effects";
import { apiAnswer, apiMove } from "../../core/tablebase/fixtures";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const KRK = "8/8/8/4k3/8/8/2K5/7R w - - 0 1";
const DEEP_GO = new RegExp(`^go depth ${MAX_STRENGTH.searchDepth} movetime (\\d+)$`);
const deepGoes = (): string[] => h.transport.goLines.filter((line) => DEEP_GO.test(line));

const reporter = (): BoardEffectsReporter =>
	(h.session() as unknown as { boardEffects: BoardEffectsReporter }).boardEffects;

/** Only h1h7 keeps the win in this (made-up) answer, so the tables' move is unambiguous. */
function answer(): TablebaseProbe {
	const probe = parseProbe(
		apiAnswer("win", [
			apiMove("h1h5", "draw", 0),
			apiMove("h1h7", "loss", -20, { dtm: -20 }),
			apiMove("c2c3", "draw", 0),
		])
	);
	if (!probe) throw new Error("fixture does not parse");
	return probe;
}

async function start(tablebase: TablebasePort): Promise<void> {
	h = await createGameHarness({
		fen: KRK,
		timeControl: { baseMs: 600_000, incMs: 0 },
		tablebase,
		settings: {
			automation: { autoMove: true, boardEffects: true, moveQualityChips: true },
			strength: { targetElo: LIMITS.eloMax, matchOpponentRating: false },
		},
	});
	await h.sw.run(() => h.session().command("armAutoMove"));
	expect(h.executor()?.isArmed()).toBe(true);
}

describe("endgame tablebase at max strength (2026-09-23)", () => {
	it("plays the tables' move on the planned deadline, with no deep search, rated Book", async () => {
		const asked: string[] = [];
		await start({
			probe: async (fen) => {
				asked.push(fen);
				return answer();
			},
		});
		const prepared: PlannedMove[] = [];
		const prepare = spyOn(reporter(), "prepare").mockImplementation((move) => {
			prepared.push(move);
		});
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 120_000)).toBe(
			true
		);
		prepare.mockRestore();
		const rec = h.session().recommendation();
		expect(rec?.chosen.source).toBe("tablebase");
		expect(rec?.chosen.uci).toBe("h1h7");
		expect(h.site.board.lastMove()?.uci).toBe("h1h7");
		expect(h.sim.now()).toBeGreaterThanOrEqual((rec?.plan.deadlineMs ?? 0) - 1);
		expect(deepGoes()).toHaveLength(0);
		expect(asked).toEqual([KRK]);
		// The rating was opened as a tablebase move: Book on landing (board-effects-chips.test.ts
		// covers the chip itself; this harness game starts from a FEN, so it has no SAN history).
		expect(prepared).toContainEqual(expect.objectContaining({ uci: "h1h7", tablebase: true }));
	});

	it("falls back to the max-strength engine path when the tables do not answer", async () => {
		await start({ probe: async () => null });
		h.transport.hold = true;
		await h.arrive();
		expect(await h.until(() => deepGoes().length > 0, 60_000)).toBe(true);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 120_000)).toBe(
			true
		);
		expect(h.session().recommendation()?.chosen.source).not.toBe("tablebase");
		expect(h.site.board.lastMove()?.byMe).toBe(true);
	});
});
