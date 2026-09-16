// test/behavioral/game/max-strength.test.ts — max-strength mode on the simulator (owner,
// 2026-09-15: "when elo rating bar is 3800 … just play the absolute best possible move in every
// situation with the deepest thought we can"). Every scripted search answers only when it is
// stopped, so each one spends its whole movetime the way a real engine does: the move search runs
// first at its usual MultiPV frame, the timing model plans the move, one deep line runs until the
// hand must start its approach, and the move lands on the plan's own deadline. A 3799 target never
// issues the deep search.
import { afterEach, describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

/** A quiet middlegame, white to move, where the timing model plans a real think. */
const MIDDLEGAME = "r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 0 9";
const DEEP_GO = new RegExp(`^go depth ${MAX_STRENGTH.searchDepth} movetime (\\d+)$`);
const MOVE_GO = new RegExp(`^go depth ${automaticDepthForElo(LIMITS.eloMax)} movetime \\d+$`);

const deepGoes = (): string[] => h.transport.goLines.filter((line) => DEEP_GO.test(line));

async function start(targetElo: number): Promise<void> {
	h = await createGameHarness({
		fen: MIDDLEGAME,
		timeControl: { baseMs: 600_000, incMs: 0 },
		settings: {
			automation: { autoMove: true },
			strength: { targetElo, matchOpponentRating: false },
		},
	});
	await h.sw.run(() => h.session().command("armAutoMove"));
	expect(h.executor()?.isArmed()).toBe(true);
	h.transport.hold = true;
}

describe("max-strength mode (owner, 2026-09-15)", () => {
	it("3800: the deep single-line search runs to the hand's cut-off and the move lands on the planned deadline", async () => {
		await start(LIMITS.eloMax);
		await h.arrive();
		expect(await h.until(() => deepGoes().length > 0, 60_000)).toBe(true);
		const sent = h.transport.sent;
		const deepAt = sent.indexOf(deepGoes()[0] ?? "");
		const before = sent.slice(0, deepAt);
		// The move search ran first with its usual frame; the deep search asks for one line.
		expect(before.filter((line) => line.startsWith("go ")).at(-1)).toMatch(MOVE_GO);
		expect(before.filter((line) => line.startsWith("setoption name MultiPV")).at(-1)).toBe(
			`setoption name MultiPV value ${MAX_STRENGTH.multiPv}`
		);
		expect(sent).toContain(`setoption name Hash value ${MAX_STRENGTH.hashMb}`);

		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 120_000)).toBe(
			true
		);
		const rec = h.session().recommendation();
		expect(rec).not.toBeNull();
		if (!rec) return;
		const movetime = Number(DEEP_GO.exec(deepGoes()[0] ?? "")?.[1]);
		expect(movetime).toBeGreaterThanOrEqual(MAX_STRENGTH.minSearchMs);
		expect(movetime).toBeLessThanOrEqual(
			rec.plan.thinkMs - rec.plan.window.approachMs - MAX_STRENGTH.handReserveMs
		);
		// The engine's best move, from the deep frame, played — never before the plan's deadline.
		expect(rec.chosen.uci).toBe(h.transport.movesFor(MIDDLEGAME)[0] ?? "");
		expect(rec.lines[0]?.pvUci[0]).toBe(rec.chosen.uci);
		expect(h.site.board.lastMove()?.uci).toBe(rec.chosen.uci);
		expect(h.sim.now()).toBeGreaterThanOrEqual(rec.plan.deadlineMs - 1);
		expect(deepGoes()).toHaveLength(1);
	});

	it("3799: no deep search and no max-strength options — the move search's move is played", async () => {
		await start(LIMITS.eloMax - 1);
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 120_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
		expect(deepGoes()).toHaveLength(0);
		expect(h.transport.sent).not.toContain(`setoption name Hash value ${MAX_STRENGTH.hashMb}`);
	});

	it("3800: play-now during the deep search stops it and plays what it found at once", async () => {
		await start(LIMITS.eloMax);
		await h.arrive();
		expect(await h.until(() => deepGoes().length > 0, 60_000)).toBe(true);
		const deadline = h.session().recommendation()?.plan.deadlineMs ?? 0;
		const stops = (): number => h.transport.sent.filter((line) => line === "stop").length;
		const stopsBefore = stops();
		expect(await h.sw.run(() => h.session().playNowRequested())).toBe(true);
		expect(await h.until(() => stops() > stopsBefore, 1_000)).toBe(true);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 30_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
		expect(h.sim.now()).toBeLessThan(deadline - MAX_STRENGTH.handReserveMs);
		expect(deepGoes()).toHaveLength(1);
	});
});
