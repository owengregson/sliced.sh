/** A missed sampled deadline remains observable; search latency must not become learned thinking. */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { CDP, EXECUTOR } from "@core/constants/cdp";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingPlan } from "@core/timing/types";
import type { ExecutionReport } from "@service/move-executor";
import type { PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness | undefined;
let restore: () => void;
const sampled: TimingPlan[] = [];
const observed: Array<{
	before: number;
	after: number;
	actual: number;
	adapt?: boolean | undefined;
}> = [];

beforeEach(() => {
	sampled.length = 0;
	observed.length = 0;
	const originalPlan = TimingModel.prototype.planMove;
	const planSpy = spyOn(TimingModel.prototype, "planMove").mockImplementation(function (
		this: TimingModel,
		context
	) {
		const plan = originalPlan.call(this, context);
		sampled.push(structuredClone(plan));
		return plan;
	});
	const originalObserve = TimingModel.prototype.observe;
	const observeSpy = spyOn(TimingModel.prototype, "observe").mockImplementation(function (
		this: TimingModel,
		actual,
		plan,
		attribution
	) {
		const before = this.state.eps;
		originalObserve.call(this, actual, plan, attribution);
		observed.push({ before, after: this.state.eps, actual, adapt: attribution?.adaptPace });
	});
	restore = () => {
		planSpy.mockRestore();
		observeSpy.mockRestore();
	};
});

afterEach(async () => {
	restore();
	await h?.dispose();
	h = undefined;
});

async function slowSearch() {
	h = await createGameHarness({
		manualStart: true,
		seed: "slow-search-release",
		gameId: "slow-search-release",
		// The class allows a 1.5-second search; holding it for 1.4 seconds is deliberate latency,
		// not a timeout/retry or emergency clock condition.
		timeControl: { baseMs: 1_800_000, incMs: 0 },
		settings: {
			automation: { autoMove: true },
			execution: { previewSelectScale: 0 },
		},
		head: {
			id: "chessmimic",
			median: () => 0.8,
			mean: () => 0.8,
			sample: () => ({
				tSec: 0.8,
				mode: "normal",
				includesExecution: true,
				why: ["elapsed-time fixture"],
			}),
		},
	});
	const harness = h;
	const reports: ExecutionReport[] = [];
	harness.transport.hold = true;
	await harness.drive(() => {
		harness.site.hello();
		harness.site.startGame();
	});
	expect(await harness.until(() => harness.executor()?.isArmed() === true, 2_000)).toBe(true);
	harness.executor()?.on("executed", (report) => reports.push(report));
	const capturedAt = harness.sim.now();
	const snapshot: PositionSnapshot = {
		site: "chesscom",
		gameId: harness.site.gameId,
		fen: harness.site.board.fen(),
		ply: harness.site.board.ply(),
		sideToMove: "w",
		myColor: "w",
		approximate: false,
		timeControl: { baseMs: 1_800_000, incMs: 0 },
		clocks: { w: { ms: 1_800_000, running: true }, b: { ms: 1_800_000, running: false } },
		capturedAt,
	};
	// Capture precedes worker processing. Reading `now()` in runPipeline would erase this
	// delay from the deadline and the actual arrival-to-release observation.
	await harness.advance(300);
	await harness.drive(() => harness.site.post({ kind: "position", snapshot }));
	expect(await harness.until(() => harness.transport.goLines.length > 0, 2_000)).toBe(true);
	const searches = [...harness.transport.goLines];
	await harness.advance(500);
	const clockTickAt = harness.sim.now();
	const clockSnapshot: PositionSnapshot = {
		...snapshot,
		clocks: {
			w: { ms: 1_800_000 - (clockTickAt - capturedAt), running: true },
			b: { ms: 1_800_000, running: false },
		},
		capturedAt: clockTickAt,
	};
	// Clock readings legitimately refresh the stored snapshot while search is held. They
	// must not replace the first arrival timestamp or restart this position's preparation.
	await harness.drive(() => harness.site.post({ kind: "position", snapshot: clockSnapshot }));
	const panel = await harness.snapshot();
	expect(clockTickAt).toBeGreaterThan(capturedAt);
	expect(panel.session.clocksAt).toBe(clockTickAt);
	expect(panel.session.clocks).toEqual(clockSnapshot.clocks);
	expect(harness.session().recommendation()).toBeNull();
	expect(harness.transport.goLines).toEqual(searches);
	await harness.advance(900);
	expect(reports).toHaveLength(0);
	const searchDoneAt = harness.sim.now();
	harness.transport.hold = false;
	await harness.drive(() => harness.transport.release());
	expect(await harness.until(() => reports.length === 1 && observed.length === 1, 10_000)).toBe(
		true
	);
	const report = reports[0]!;
	const original = sampled[0]!;
	const commands = harness.sim.debugger.commands.filter(
		(c) => c.method === CDP.inputDispatchMouseEvent
	);
	const presses = commands.filter((c) => c.params?.type === "mousePressed");
	const releases = commands.filter((c) => c.params?.type === "mouseReleased");
	expect(presses).toHaveLength(1);
	expect(releases).toHaveLength(1);
	const press = presses[0]!;
	const release = releases[0]!;
	expect(original.mode).toBe("normal");
	expect(original.window.approachMs).toBeGreaterThan(EXECUTOR.minExecutionMs);
	expect(original.deadlineMs).toBeLessThan(searchDoneAt);
	expect(press.at).toBeGreaterThanOrEqual(searchDoneAt);
	expect(report.result.outcome).toBe("executed");
	return { harness, report, original, commands, press, release, searchDoneAt, capturedAt };
}

it("keeps first arrival and the sampled deadline across held-search clock ticks, observing time through release", async () => {
	const { harness, report, original, release, capturedAt } = await slowSearch();
	const totalMs = release.at - report.rec.computedAt;
	expect(report.rec.computedAt).toBe(capturedAt);
	expect(original.deadlineMs).toBeCloseTo(capturedAt + original.thinkMs, 2);
	expect(report.rec.plan.thinkMs).toBe(original.thinkMs);
	expect(report.rec.plan.deadlineMs).toBe(original.deadlineMs);
	expect(report.rec.plan.window).toEqual(original.window);
	expect(report.rec.plan.features.preparationMs).toBeGreaterThanOrEqual(1_700);
	expect(report.rec.plan.features.preparationOverrunMs).toBeGreaterThan(0);
	expect(totalMs).toBeGreaterThan(original.thinkMs);
	expect(report.result.submittedAt).toBeCloseTo(release.at, 2);
	expect(report.result.at!).toBeGreaterThan(release.at);
	expect(observed[0]!.actual).toBeCloseTo(totalMs, 2);
	const row = harness.timingLog.entries()[0]!;
	expect(row.plannedMs).toBeCloseTo(original.thinkMs, 2);
	expect(row.actualMs).toBeCloseTo(totalMs, 2);
	expect(row.executionMs).toBeCloseTo(report.result.elapsedMs, 2);
});

it("retains the mandatory gesture after late search and does not learn the overrun as natural pace", async () => {
	const { report, original, commands, press, release, searchDoneAt } = await slowSearch();
	// Preserve the gesture's sampled reserve, not merely a generic 120/250 ms minimum.
	expect(release.at - searchDoneAt).toBeGreaterThanOrEqual(original.window.approachMs);
	expect(report.result.elapsedMs).toBeGreaterThanOrEqual(original.window.approachMs);
	const heldMotion = commands.filter(
		(c) => c.params?.type === "mouseMoved" && c.at > press.at && c.at < release.at
	);
	expect(heldMotion.length).toBeGreaterThan(2);
	expect(heldMotion.every((c) => c.params?.buttons === 1)).toBe(true);
	expect(observed[0]!.adapt).toBe(false);
	expect(observed[0]!.after).toBe(observed[0]!.before);
});
