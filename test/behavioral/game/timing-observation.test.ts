import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { legalMoves } from "@core/chess/san";
import { CDP } from "@core/constants/cdp";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { TimingModel } from "@core/timing/timing-model";
import type { Features } from "@core/timing/types";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
const observed: Array<{
	actual: number;
	planned: number;
	before: number;
	after: number;
	adapt?: boolean | undefined;
}> = [];
const features: Features[] = [];
let restore: () => void;

beforeEach(() => {
	observed.length = 0;
	features.length = 0;
	const original = TimingModel.prototype.observe;
	const spy = spyOn(TimingModel.prototype, "observe").mockImplementation(function (
		this: TimingModel,
		actual,
		plan,
		attribution
	) {
		const before = this.state.eps;
		original.call(this, actual, plan, attribution);
		observed.push({
			actual,
			planned: plan.thinkMs,
			before,
			after: this.state.eps,
			adapt: attribution?.adaptPace,
		});
	});
	restore = () => spy.mockRestore();
});
afterEach(async () => {
	restore();
	await h?.dispose();
});

async function boot(searchMs: number): Promise<void> {
	h = await createGameHarness({
		manualStart: true,
		timeControl: { baseMs: 180_000, incMs: 0 },
		settings: {
			automation: { autoMove: true },
			timing: { profile: "custom" },
			execution: { previewSelectScale: 0 },
		},
		head: {
			id: "v1-parametric",
			median: () => 4,
			sample: (f) => {
				features.push(f);
				return { tSec: 4, mode: "normal", why: [] };
			},
		},
	});
	h.transport.hold = true;
	await h.drive(() => {
		h.site.hello();
		h.site.startGame();
	});
	expect(await h.until(() => h.executor()?.isArmed() === true, 2000)).toBe(true);
	await h.arrive();
	expect(await h.until(() => h.transport.goLines.length > 0, 1000)).toBe(true);
	await h.advance(searchMs);
	h.transport.hold = false;
	await h.drive(() => h.transport.release());
}

it("includes search time in full-move feedback while retaining the physical hand duration", async () => {
	await boot(500);
	const reports: ExecutionReport[] = [];
	h.executor()?.on("executed", (r) => reports.push(r));
	expect(await h.until(() => observed.length === 1, 10_000)).toBe(true);
	const report = reports[0]!;
	const release = h.sim.debugger.commands.find(
		(c) => c.method === CDP.inputDispatchMouseEvent && c.params?.type === "mouseReleased"
	)!;
	const total = release.at - report.rec.computedAt;
	// The head answers 4 s; the plan carries the base-speed gain (`SETTING_GAIN.speedScale`), so the
	// reference is the plan itself, not a literal.
	expect(total).toBeCloseTo(report.rec.plan.thinkMs, 2);
	expect(report.result.elapsedMs).toBeCloseTo(report.rec.plan.thinkMs - 500, 2);
	expect(observed[0]?.actual).toBeCloseTo(total, 2);
	expect(observed[0]?.after).toBeCloseTo(observed[0]!.before, 5);
	expect(report.result.submittedAt).toBeCloseTo(release.at, 2);
	expect(report.result.at!).toBeGreaterThan(report.result.submittedAt!); // Verification/rest is excluded.
	const row = h.timingLog.entries()[0]!;
	expect(row.actualMs).toBeCloseTo(total, 2);
	expect(row.executionMs).toBeCloseTo(report.result.elapsedMs, 2);
	expect(row.telemetry?.ac.MoveHoldTime).toBeCloseTo(report.result.elapsedMs, 2);
	expect((await h.snapshot()).stats.avgThinkMs).toBeCloseTo(total, 2);
	expect(features[0]).toMatchObject({ tc: "blitz", inc_s: 0, clock_s: 180, base_eff: 180 });
});

it("records manual fast-forward without training it as the natural pace", async () => {
	await boot(200);
	expect(await h.until(() => h.session().recommendation() !== null, 1000)).toBe(true);
	await h.advance(300);
	void h.drive(() => h.session().playNowRequested());
	expect(await h.until(() => observed.length === 1, 5000)).toBe(true);
	expect(observed[0]?.actual).toBeLessThan(observed[0]!.planned);
	expect(observed[0]?.adapt).toBe(false);
	expect(observed[0]?.after).toBe(observed[0]?.before);
});

it("passes the opponent's observed seven-second think in seconds to timing features", async () => {
	await boot(0);
	expect(await h.until(() => observed.length === 1, 10_000)).toBe(true);
	await h.drive(() => h.site.arrive(null, { w: 176_000, b: 180_000 }));
	await h.advance(7000);
	const reply = legalMoves(h.site.board.fen())[0]!;
	await h.drive(() => h.site.arrive(reply, { w: 176_000, b: 173_000 }));
	expect(await h.until(() => features.length >= 2, 2000)).toBe(true);
	expect(features.at(-1)?.opp_last).toBeCloseTo(
		Math.log(7 + TIMING_CONSTANTS.features.oppPaceOffsetS),
		6
	);
	expect(features.at(-1)?.clock_ratio).toBeCloseTo(Math.log(177 / 174), 6);
});
