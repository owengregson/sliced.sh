// test/behavioral/game/clock-tracking.test.ts — fix C step 2: rule the plumbing out, then show the
// response, on one real 3+0 game driven through the whole service-worker stack.
//
// The alternative explanation for the owner's live 3+0 report ("it was still moving like it had a lot
// of time left even though it didnt") was that nothing about the clock ever reaches the model: if
// `f.tc` stays `"untimed"` the budget controller, the compression, the caps and the §8.5 emergency
// regime are all bypassed and the whole game is planned clockless, and if `myClockMs` reads stale or
// base-every-time the same thing happens one level down. That had to be excluded before the model was
// touched, so the first case here asserts it and nothing else: it passes against the pre-fix tree.
//
// The second case is the behaviour itself, on the same game: as the page's clock falls move by move,
// the planned think falls with it and the §7.2 step 6 clock-pressure term rises. Every number comes
// from what the *site* reported — `site.setTimeControl` is the page learning its own clock, and the
// clocks are the readings `arrive()` carries.
import { afterEach, describe, expect, it } from "bun:test";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

/** The owner's game. */
const BLITZ = { baseMs: 180_000, incMs: 0 };

/** Clock readings the page reports, in order: a 3+0 game draining towards the flag. */
const READINGS = [180_000, 120_000, 60_000, 30_000] as const;

interface Observed {
	clockMs: number;
	tcBlitz: number;
	tcUntimed: number;
	clockS: number;
	baseS: number;
	/** `min(compression, urgency)` as `planMove` logged it for this move. */
	pace: number;
	alloc: number;
	thinkMs: number;
	mode: string;
	/** `f_clock` as §7.2 step 6 reported it in the selection rationale, when selection ran. */
	fClock: number | null;
}

function fClockOf(rationale: readonly string[]): number | null {
	for (const row of rationale) {
		const m = /f_clock=([0-9.]+)/.exec(row);
		if (m?.[1] !== undefined) return Number(m[1]);
	}
	return null;
}

/**
 * Play the game through `READINGS`: the page reports each clock in turn, the hand plays our move,
 * and the scripted opponent replies. One row per reading, read off the standing recommendation.
 */
async function playDraining(): Promise<Observed[]> {
	h = await createGameHarness({
		timeControl: null, // the production order: the site answers only once the game has started
		gameId: "blitz-draining",
		seed: "blitz-draining",
		settings: {
			automation: { autoMove: true },
			strength: { matchOpponentRating: false, targetElo: 1650, blunderScale: 1 },
		},
	});
	expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);
	h.site.setTimeControl(BLITZ);

	const out: Observed[] = [];
	for (const clockMs of READINGS) {
		const reply = out.length === 0 ? null : (h.transport.movesFor(h.site.board.fen())[0] ?? null);
		await h.arrive(reply, { w: clockMs, b: clockMs });
		expect(
			await h.until(() => {
				const f = h.session().recommendation()?.plan.features;
				return f !== undefined && f.clock_s === clockMs / 1000;
			}, 30_000),
			`no plan at ${clockMs} ms`
		).toBe(true);
		const rec = h.session().recommendation();
		const f = rec?.plan.features ?? {};
		out.push({
			clockMs,
			tcBlitz: f.tc_blitz ?? 0,
			tcUntimed: f.tc_untimed ?? 0,
			clockS: f.clock_s ?? -1,
			baseS: f.base_s ?? -1,
			pace: f.comp ?? -1,
			alloc: f.alloc ?? -1,
			thinkMs: rec?.plan.thinkMs ?? 0,
			mode: rec?.plan.mode ?? "?",
			fClock: fClockOf(rec?.chosen.rationale ?? []),
		});
		// let the hand play it, so the next reading lands on a position that has actually moved
		expect(
			await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000),
			`hand did not play at ${clockMs} ms`
		).toBe(true);
	}
	return out;
}

/** Built once: the run is a whole game through the real stack. */
let rows: Promise<Observed[]> | undefined;
function observed(): Promise<Observed[]> {
	rows ??= playDraining();
	return rows;
}

describe("a live 3+0 game: the page's clock reaches planMove and tracks it (fix C step 2)", () => {
	it("every move is planned as blitz, on the clock the page reported for that move", async () => {
		// The plumbing claim, and only it. This is what rules out "the time control never arrived" and
		// "`myClockMs` reads base every time" as the explanation for the owner's report.
		const seen = await observed();
		expect(seen.length).toBe(READINGS.length);
		for (const row of seen) {
			expect(row.tcBlitz, `${row.clockMs} ms`).toBe(1);
			expect(row.tcUntimed, `${row.clockMs} ms`).toBe(0);
			expect(row.clockS, `${row.clockMs} ms`).toBeCloseTo(row.clockMs / 1000, 6);
			expect(row.baseS, `${row.clockMs} ms`).toBe(BLITZ.baseMs / 1000);
			// and not the clockless substitute, which is what an `untimed` game would show here
			expect(row.clockS).not.toBe(TIMING_CONSTANTS.untimedVirtual.clockS);
		}
	}, 300_000);

	it("the planned think falls as that clock falls, and the error rate rises", async () => {
		const seen = await observed();
		const first = seen[0];
		const last = seen[seen.length - 1];
		if (!first || !last) throw new Error("no rows");

		// Pace, asserted on the quantity the clock actually sets rather than on one sampled think: two
		// single draws cannot be compared (move 1 of this very game fires a book premove of 144 ms,
		// which says nothing about the pace), while `features.comp` — `min(compression, urgency)` as
		// `planMove` logged it — is a deterministic function of the reading. The distribution itself is
		// gated in test/core/timing/clock-response.test.ts over 600 draws a point.
		expect(first.pace).toBe(1);
		expect(last.pace).toBeLessThan(1);
		let previousPace = Number.POSITIVE_INFINITY;
		let previousAlloc = Number.POSITIVE_INFINITY;
		for (const row of seen) {
			expect(row.pace, `pace at ${row.clockMs} ms`).toBeLessThanOrEqual(previousPace);
			expect(row.alloc, `alloc at ${row.clockMs} ms`).toBeLessThan(previousAlloc);
			previousPace = row.pace;
			previousAlloc = row.alloc;
		}
		// the urgency term, not the §3a.3 compression, is what moved: compression alone is 1 at 60 s
		const atMinute = seen.find((r) => r.clockMs === 60_000);
		expect(atMinute?.pace ?? 1).toBeLessThan(1);

		// Accuracy: §7.2 step 6's `f_clock`, which is 1 on a full clock and must have risen by 0:30.
		// It rising at all is also the proof that `SelectionContext.baseMs` reached the blunder model:
		// on the absolute ramp alone `f_clock` is exactly 1 at every one of these readings.
		expect(first.fClock).not.toBeNull();
		expect(last.fClock).not.toBeNull();
		expect(first.fClock ?? 0).toBe(1);
		expect(last.fClock ?? 0).toBeGreaterThan(1);
	}, 300_000);
});
