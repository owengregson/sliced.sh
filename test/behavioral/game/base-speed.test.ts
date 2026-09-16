// test/behavioral/game/base-speed.test.ts — `timing.baseSpeed` end to end (owner, 2026-09-15:
// "higher base speed should cause moves to happen faster not slower", and "speed multiplier
// should be on literally time for the entire start to finish of making the move … settings
// shouldnt really be modifying the model's ability to give good moves").
//
// So this measures the whole move — from the position arriving (`rec.computedAt`) to the piece
// being released on the board (the CDP `mouseReleased`) — and separately pins that the engine's
// own work does not move with the setting.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP, EXECUTOR } from "@core/constants/cdp";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { DistributionHead } from "@core/timing/types";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

const BLITZ = { baseMs: 180_000, incMs: 0 };
/** 30+0. Its search budget (`SEARCH_BUDGET.moveMs.classical`, 1.5 s) is the longest one allowed. */
const CLASSICAL = { baseMs: 1_800_000, incMs: 0 };

/** A discretionary think well clear of the physical floor, so the multiplier is observable. */
const HEAD: DistributionHead = {
	id: "v1-parametric",
	median: () => 6,
	sample: () => ({ tSec: 6, mode: "normal", why: ["base-speed fixture"] }),
};

/** A head that asks for almost nothing: the plan is then the hand's own floor and a long search
 * genuinely outlasts it, which is the ordering case worth exercising end to end. */
const QUICK_HEAD: DistributionHead = {
	id: "v1-parametric",
	median: () => 0.3,
	sample: () => ({ tSec: 0.3, mode: "normal", why: ["base-speed fixture: quick"] }),
};

interface Played {
	/** Position arrival → the piece landing on the board. The owner's "start to finish". */
	totalMs: number;
	plannedMs: number;
	/** What the hand itself spent, as the executor reports it. */
	gestureMs: number;
	/** Every `go` the playing engine was given: the engine's work, in its own words. */
	goLines: string[];
	rationale: string[];
}

async function play(
	baseSpeed: number,
	options: {
		clocks?: { w: number; b: number };
		/** How long the engine is held before it answers. Must stay under the class's own budget,
		 * or the pipeline's search deadline stops the search first and it is not the wait at all. */
		searchMs?: number;
		timeControl?: { baseMs: number; incMs: number };
		head?: DistributionHead;
	} = {}
): Promise<Played> {
	h = await createGameHarness({
		seed: "base-speed",
		gameId: "base-speed",
		manualStart: true,
		timeControl: options.timeControl ?? BLITZ,
		head: options.head ?? HEAD,
		settings: {
			automation: { autoMove: true },
			timing: { baseSpeed },
			execution: { previewSelectScale: 0, verifyMoves: false },
		},
	});
	const harness = h;
	const reports: ExecutionReport[] = [];
	const searchMs = options.searchMs ?? 0;
	if (searchMs > 0) harness.transport.hold = true;
	await harness.drive(() => {
		harness.site.hello();
		harness.site.startGame();
	});
	expect(await harness.until(() => harness.executor()?.isArmed() === true, 2_000)).toBe(true);
	harness.executor()?.on("executed", (report) => reports.push(report));
	await harness.arrive(null, options.clocks);
	if (searchMs > 0) {
		expect(await harness.until(() => harness.transport.goLines.length > 0, 2_000)).toBe(true);
		await harness.advance(searchMs);
		harness.transport.hold = false;
		await harness.drive(() => harness.transport.release());
	}
	expect(await harness.until(() => reports.length > 0, 60_000)).toBe(true);
	const report = reports[0]!;
	const release = harness.sim.debugger.commands.find(
		(c) => c.method === CDP.inputDispatchMouseEvent && c.params?.type === "mouseReleased"
	);
	if (!release) throw new Error("base-speed: the hand never released a piece");
	return {
		totalMs: release.at - report.rec.computedAt,
		plannedMs: report.rec.plan.thinkMs,
		gestureMs: report.result.elapsedMs,
		goLines: [...harness.transport.goLines],
		rationale: [...report.rec.plan.rationale],
	};
}

describe("base speed (owner, 2026-09-15)", () => {
	it("a higher base speed makes the whole move — arrival to landing — take less time", async () => {
		const slow = await play(0.5);
		await h?.dispose();
		h = undefined;
		const fast = await play(2);
		// The direction is the entire point of the change: the number the user raises must shorten
		// the move, not lengthen it.
		expect(fast.totalMs).toBeLessThan(slow.totalMs);
		expect(fast.plannedMs).toBeLessThan(slow.plannedMs);
		// 0.5× against 2× is a factor of four on the wait; the search and the hand's own floors are
		// shared overhead, so the measured whole move is somewhat less than 4× apart. Half is a
		// bound the fixtures cannot reach by accident.
		expect(fast.totalMs).toBeLessThan(slow.totalMs / 2);
		// And the hand really did move faster, not just wait less.
		expect(fast.gestureMs).toBeLessThan(slow.gestureMs);
	}, 90_000);

	it("the engine's work is identical across the slider: same searches, same limits", async () => {
		// "settings shouldnt really be modifying the model's ability to give good moves": the `go`
		// lines are what the engine was actually asked for — movetime and depth included — so two
		// runs of the same seeded position at opposite ends of the slider must produce the same
		// ones. `recommendation.test.ts` pins the arithmetic; this pins the wire.
		const slow = await play(0.5);
		await h?.dispose();
		h = undefined;
		const fast = await play(2);
		expect(fast.goLines).toEqual(slow.goLines);
		expect(fast.goLines.length).toBeGreaterThan(0);
	}, 90_000);

	it("a fast base speed still waits for the search: the hand is never rushed through it", async () => {
		// Base speed at the top of the slider plans a move no longer than the hand needs; the search
		// that chose it takes 1.4 s and so finishes after the plan's own deadline has passed. The
		// release target stays unchanged, and the hand records the unavoidable overrun rather than
		// adding a new think. It still respects physical motion limits. A classical control,
		// because in blitz the 600 ms search budget stops
		// the search before it could ever be the longer of the two.
		const played = await play(4, {
			timeControl: CLASSICAL,
			searchMs: 1_400,
			head: QUICK_HEAD,
		});
		expect(played.rationale.join(" ")).toContain("preparation: release target short");
		expect(played.plannedMs).toBeLessThan(played.totalMs);
		expect(played.totalMs).toBeGreaterThan(1_400);
		expect(played.gestureMs).toBeGreaterThanOrEqual(EXECUTOR.minTravelMs);
	}, 90_000);

	it("a slow base speed near a low clock still cannot flag: the caps apply after the scaling", async () => {
		// The slowest the slider goes, with 8 s left of a 3+0. Every clock rule runs on the scaled
		// plan, so the move stays inside the move-budget clock fraction and lands with time to
		// spare — a slower setting must not be able to lose the game on time.
		const clockMs = 8_000;
		const played = await play(0.35, { clocks: { w: clockMs, b: 120_000 } });
		expect(played.plannedMs).toBeLessThanOrEqual(clockMs * TIMING_CONSTANTS.moveBudget.clockFraction);
		expect(played.totalMs).toBeLessThan(clockMs);
	}, 90_000);
});
