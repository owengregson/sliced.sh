import { afterEach, expect, it } from "bun:test";
import { chromeLocalSet } from "@core/chrome/storage";
import { CDP } from "@core/constants/cdp";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { QUALITY_STATISTICS } from "@core/constants/telemetry";
import { qualityCohortKey } from "@core/strength/session-quality";
import { EMPTY_STATS, foldMove } from "@service/game-session/stats";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => h?.dispose());

it("drains the final accepted move before grading a game's 19-to-20 sample threshold", async () => {
	let checks = 0;
	h = await createGameHarness({
		gameId: "final-quality",
		timeControl: { baseMs: 180_000, incMs: 0 },
		settings: {
			automation: { autoMove: true },
			execution: { verifyMoves: true, previewSelectScale: 0 },
		},
		onCommand(cmd) {
			if (cmd.kind === "observeMove" && ++checks === 1) h.site.endGame("1-0");
		},
	});
	const targetElo = h.session().targetElo();
	const qualityContext = {
		gameId: "final-quality",
		targetElo,
		cohortKey: qualityCohortKey(targetElo, h.settings().strength, { baseMs: 180_000, incMs: 0 }),
	};
	let stats = { ...EMPTY_STATS };
	for (let i = 0; i < QUALITY_STATISTICS.minGameMoves - 1; i++)
		stats = foldMove(stats, { thinkMs: 1000, scored: true, top1: true, cpLoss: 0, qualityContext });
	await h.sw.run(() => chromeLocalSet(LOCAL_KEYS.sessionStats, stats));
	const executed: ExecutionReport[] = [];
	h.executor()?.on("executed", (report) => executed.push(report));
	await h.arrive();
	expect(await h.until(() => executed.length === 1, 60_000)).toBe(true);
	await h.advance(100);
	const snap = await h.snapshot();
	expect(snap.stats.games).toBe(1);
	expect(snap.stats.moves).toBe(20);
	expect(snap.stats.qualityCohorts?.[0]).toMatchObject({
		scoredMoves: 20,
		eligibleGames: 1,
		outOfBandStreak: 1,
	});
	expect(snap.stats.qualityGames).toEqual([]);
	expect(checks).toBe(2);
});

it("reports a landed move once when the position feed cancels its pending verification", async () => {
	let checks = 0;
	h = await createGameHarness({
		settings: {
			automation: { autoMove: true },
			execution: { verifyMoves: true, previewSelectScale: 0 },
		},
		onCommand(cmd) {
			if (cmd.kind !== "observeMove" || ++checks !== 1) return;
			// Real content posts the accepted board position before its observeMove reply.
			h.site.arrive(null, { w: 179_000, b: 180_000 });
		},
	});
	const executed: ExecutionReport[] = [];
	const failed: ExecutionReport[] = [];
	h.executor()?.on("executed", (report) => executed.push(report));
	h.executor()?.on("failed", (report) => failed.push(report));
	await h.arrive();
	expect(await h.until(() => executed.length > 0 || failed.length > 0, 60_000)).toBe(true);
	expect(failed).toEqual([]);
	expect(executed).toHaveLength(1);
	expect(executed[0]?.result).toMatchObject({ ok: true, outcome: "executed", attempts: 1 });
	expect(checks).toBe(2);
	expect(h.site.board.lastMove()?.uci).toBe(executed[0]?.rec.chosen.uci);
	expect(h.session().currentState()).toBe("live:opponent-turn");
	await h.advance(100);
	const panel = await h.snapshot();
	expect(panel.session.ply).toBe(1);
	expect(panel.session.lastExecution?.outcome).toBe("executed");
	expect(panel.stats.moves).toBe(1);
	const presses = h.sim.debugger.commands.filter(
		(cmd) => cmd.method === CDP.inputDispatchMouseEvent && cmd.params?.type === "mousePressed"
	);
	expect(presses).toHaveLength(1);
});
