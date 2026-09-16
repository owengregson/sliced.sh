import { afterEach, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => h?.dispose());

async function move(
	ownClockMs: number,
	seed: string,
	headSeconds = 0.001
): Promise<ExecutionReport> {
	await h?.dispose();
	h = await createGameHarness({
		seed,
		gameId: seed,
		timeControl: { baseMs: 180_000, incMs: 0 },
		settings: {
			automation: { autoMove: true },
			execution: { previewSelectScale: 0 },
		},
		head: {
			id: "v1-parametric",
			median: () => 2,
			sample: () => ({ tSec: headSeconds, mode: "normal", includesExecution: true, why: [] }),
		},
	});
	const reports: ExecutionReport[] = [];
	h.executor()?.on("executed", (report) => reports.push(report));
	await h.arrive(null, { w: ownClockMs, b: 1000 });
	expect(await h.until(() => reports.length === 1, 5000)).toBe(true);
	return reports[0]!;
}

it("preserves thinking and normal hand motion under opponent-only pressure through real input", async () => {
	const policy = clockRacePolicy({
		ownClockMs: 60_000,
		opponentClockMs: 1000,
		baseMs: 180_000,
		incrementMs: 0,
	})!;
	const totals: number[] = [];
	for (let seed = 0; seed < 6; seed++) {
		const report = await move(60_000, `opponent-tempo-${seed}`, 4);
		const commands = h.sim.debugger.commands.filter((c) => c.method === CDP.inputDispatchMouseEvent);
		const presses = commands.filter((c) => c.params?.type === "mousePressed");
		const releases = commands.filter((c) => c.params?.type === "mouseReleased");
		expect(presses).toHaveLength(1);
		expect(releases).toHaveLength(1);
		const held = commands.filter((c) => c.params?.type === "mouseMoved" && c.params.buttons === 1);
		const free = commands.filter((c) => c.params?.type === "mouseMoved" && c.params.buttons === 0);
		expect(held.length).toBeGreaterThan(2);
		expect(free.length).toBeGreaterThan(2);
		expect(held[0]!.at).toBeGreaterThanOrEqual(presses[0]!.at);
		expect(held.at(-1)!.at).toBeLessThanOrEqual(releases[0]!.at);
		const total = releases[0]!.at - report.rec.computedAt;
		expect(total).toBeGreaterThan(policy.maxMoveMs);
		// Summed pointer-frame timestamps at epoch scale have sub-millisecond rounding.
		expect(total).toBeCloseTo(report.rec.plan.thinkMs, 0);
		expect(report.rec.plan.thinkMs).toBeGreaterThan(report.rec.plan.window.approachMs);
		expect(report.rec.plan.features.clockRace).toBe(0);
		expect(report.rec.plan.features.opponentOnlyRace).toBe(0);
		expect(report.rec.plan.features.opponentPressure).toBeGreaterThan(0);
		expect(h.site.board.lastMove()?.uci).toBe(report.rec.chosen.uci);
		expect(h.timingLog.entries()[0]?.actualMs).toBeCloseTo(total, 2);
		totals.push(total);
	}
	expect(new Set(totals.map(Math.round)).size).toBeGreaterThan(4);
	expect(Math.max(...totals) - Math.min(...totals)).toBeGreaterThan(100);
});

it("does not impose the opponent-only delay when our own clock is in emergency", async () => {
	const report = await move(1000, "own-clock-emergency");
	const total = report.result.submittedAt! - report.rec.computedAt;
	expect(report.rec.plan.features.opponentOnlyRace).toBe(0);
	expect(report.rec.plan.features.emergency).toBe(1);
	expect(total).toBeLessThan(250);
	expect(h.site.board.lastMove()?.uci).toBe(report.rec.chosen.uci);
});
