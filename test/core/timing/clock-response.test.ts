// test/core/timing/clock-response.test.ts — fix C: the clock drives the pace across the WHOLE
// clock, not only in the last seconds.
//
// The owner's live 3+0 report ("it was still moving like it had a lot of time left even though it
// didnt") is the authority here, and the measurement behind this file (fixC-report.md) says why:
//
//   * the shipped head is `ChessMimicHead`, whose `sample()` never reads `allocSec` — the budget
//     controller, the one genuinely clock-proportional quantity, is computed, logged and then
//     discarded on the production path. Measured on the real ONNX bands, a 3+0 plan fell only from
//     4.77 s at 180 s to 3.24 s at 60 s (×0.68), and a 10+0 plan was *longer* at 100 s (3.70 s)
//     than at 600 s (2.21 s);
//   * `compression.clockS` (30) and `blunder.clockPressureMs` (20 000) are absolute second counts,
//     so they mean one thing in 1+0 and something else entirely in 10+0.
//
// The properties asserted here are therefore head-independent: `ClockBlindHead` stands in for a head
// whose learned distribution ignores both the clock and the allocation, and the *model* is required
// to make the plan follow the clock anyway. Nothing hard-codes a sampled value — the assertions are
// on monotonicity, on the ratio between a full clock and a low one, and on the relative-to-base
// equivalence of the three speeds.
//
// Two things are deliberately NOT asserted, because asserting them would be a claim about the
// estimator rather than about the model:
//
//   * points where something other than the clock sets the plan — the hand's own 400–900 ms per
//     move, or a hard cap that binds (`boundByCap` lands a bound total in `cap · U(jitterMin, 1)`,
//     whose floor can sit *above* the unbound plan one step up the sweep, because `caps.lowClockS`
//     switches a bullet game from `0.5 · C` to `0.15 · C` at exactly 30 s);
//   * steps whose claimed factor differs by less than `MIN_RESOLVABLE_GAP`. The think time is
//     log-normal with σ ≈ 1, so the standard error of a location estimate over `PROBES_PER_POINT`
//     draws is ≈ 5 %; a 7 % step is inside the noise, and a 10+0 sweep really did invert on one such
//     step before this was written. Comparisons are therefore made against the nearest earlier point
//     the sample can actually resolve, which still chains across the sweep.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng, type Rng } from "@core/rng";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { computeFeatures } from "@core/timing/features";
import {
	compressionFactor,
	hardCapSec,
	paceFactor,
	relativeClock,
	urgencyFactor,
} from "@core/timing/pressure";
import { TimingModel } from "@core/timing/timing-model";
import type {
	DistributionHead,
	Features,
	GameMeta,
	GameTimingState,
	HeadSample,
	Persona,
} from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx, median } from "./helpers";

const U = TIMING_CONSTANTS.urgency;

/** The three speeds the owner's report spans, as `[name, baseSec]`. */
const SPEEDS: ReadonlyArray<readonly [string, number]> = [
	["1+0", 60],
	["3+0", 180],
	["10+0", 600],
];

/** Fractions of the game's own base clock the sweeps walk down. */
const FRACTIONS = [1, 0.8, 0.6, 0.5, 0.4, 1 / 3, 0.25, 1 / 6, 1 / 12] as const;

/**
 * A plan within this multiple of the hand's own time for the same point is limited by the mouse,
 * not by the plan: the clock response cannot be read off it in either direction.
 */
const HAND_LIMITED_MULTIPLE = 1.5;

/**
 * Smallest relative difference in the claimed factor a comparison may rest on. The two points are
 * drawn from separately seeded models and the draw *counts* diverge as soon as a branch does (the CV
 * guard re-samples, a binding cap takes a draw, the fake-out branch is gated on the clock), so the
 * points are not reliably paired and the standard error of the log-scale location is ≈ σ/√n per side,
 * ≈ 5 % for `PROBES_PER_POINT` at σ ≈ 0.9. At a 12 % threshold the tightest comparison sat at 2σ and
 * one seed in four inverted on it; 25 % puts every comparison past 4σ.
 */
const MIN_RESOLVABLE_GAP = 0.25;

const PROBES_PER_POINT = 600;

/**
 * Explicit per-case budget for the sweep-driven cases. `scripts/test-runner.sh` passes a 15 s default
 * and one sweep is 9 clock points × `PROBES_PER_POINT` real `planMove` calls, twice over for the two
 * heads and three times over for the speeds: ≈ 18 s for the file on an idle machine and past 30 s on a
 * loaded one, so the default would make these cases fail on machine load alone. Stated rather than
 * solved by shrinking the sample — the sample size is what makes the comparisons resolvable at 4σ
 * (see `MIN_RESOLVABLE_GAP`), and the statistical probes in `timing-model.test.ts` are the same shape.
 */
const SWEEP_TIMEOUT_MS = 180_000;

/** Fewest resolvable comparisons before a speed's sweep is treated as a measurement. */
const MIN_COMPARISONS = 3;

/**
 * Speeds where the clock has room to act once the hand and the §3a.3 caps have taken their share, so
 * a sweep there must always be a measurement rather than a plateau. 1+0 is deliberately absent: a
 * bullet game is under the `0.15 · C` cap from half its base clock and at the hand's own time soon
 * after, which the last case in this file states directly.
 */
const MUST_RESOLVE = ["3+0", "10+0"] as const;

/**
 * A stand-in for the shipped `ChessMimicHead`: a log-normal whose location is conditioned on
 * neither the clock nor `allocSec`. Its `id` has to be one of the two registered heads; it is the
 * ChessMimic path it models.
 */
class ClockBlindHead implements DistributionHead {
	readonly id = "chessmimic" as const;
	/** Roughly where the real 1500–1600 band sits in a blitz middlegame (measured: 3.5–5.5 s). */
	static readonly medianS = 4;
	static readonly sigma = 0.9;
	median(): number {
		return ClockBlindHead.medianS;
	}
	sample(_f: Features, _p: Persona, _st: GameTimingState, rng: Rng): HeadSample {
		return {
			tSec: ClockBlindHead.medianS * Math.exp(ClockBlindHead.sigma * rng.normal()),
			mode: "normal",
			why: [],
		};
	}
}

function features(baseSec: number, clockS: number, incSec = 0): Features {
	return computeFeatures(
		ctx({ baseSec, incSec, myClockMs: clockS * 1000, oppClockMs: clockS * 1000, ply: 40 })
	);
}

interface Point {
	clockS: number;
	/** Geometric mean of the planned think — the log-scale location, where a log-normal's signal is. */
	locationMs: number;
	medianMs: number;
	/** The factor the model claims here; a plateau in it is a designed plateau, not a finding. */
	urgency: number;
	/** Median of `orientation + approach`: what the hand alone costs at this point. */
	handMs: number;
	cv: number;
	/** The clock, rather than the hand or a binding cap, is what sets the plan here. */
	clockSet: boolean;
}

/**
 * One point per fraction of `baseSec`, each from a freshly seeded model so the draws are paired
 * down the sweep and the comparison is not a race between two independent noise terms.
 */
function sweep(head: () => DistributionHead, baseSec: number): Point[] {
	return FRACTIONS.map((fraction) => {
		const clockS = baseSec * fraction;
		const m = new TimingModel(head(), DEFAULT_SETTINGS.timing, createRng("clock-response"));
		const meta: GameMeta = {
			targetElo: 1650,
			profile: "balanced",
			baseSec,
			incSec: 0,
			site: "chesscom",
			gameId: "g",
		};
		const ts: number[] = [];
		const hands: number[] = [];
		for (let i = 0; i < PROBES_PER_POINT; i++) {
			if (i % 40 === 0) m.startGame({ ...meta, gameId: `g-${fraction}-${i}` });
			const plan = m.planMove(
				ctx({ baseSec, incSec: 0, myClockMs: clockS * 1000, oppClockMs: clockS * 1000, ply: 40 })
			);
			ts.push(plan.thinkMs);
			hands.push(plan.window.orientationMs + plan.window.approachMs);
		}
		const mean = ts.reduce((a, b) => a + b, 0) / ts.length;
		const sd = Math.sqrt(ts.reduce((a, b) => a + (b - mean) ** 2, 0) / ts.length);
		const locationMs = Math.exp(ts.reduce((a, b) => a + Math.log(b), 0) / ts.length);
		const handMs = median(hands);
		const capFloorMs = hardCapSec(features(baseSec, clockS)) * 1000 * TIMING_CONSTANTS.caps.jitterMin;
		return {
			clockS,
			locationMs,
			medianMs: median(ts),
			urgency: urgencyFactor(features(baseSec, clockS)),
			handMs,
			cv: mean > 0 ? sd / mean : 0,
			clockSet: locationMs >= handMs * HAND_LIMITED_MULTIPLE && locationMs < capFloorMs,
		};
	});
}

/** Sweeps are expensive; each `(head, speed)` pair is measured once and shared. */
const sweeps = new Map<string, Point[]>();
function sweepOf(kind: "clock-blind" | "v1", baseSec: number): Point[] {
	const key = `${kind}:${baseSec}`;
	const existing = sweeps.get(key);
	if (existing) return existing;
	const built = sweep(
		kind === "v1" ? () => new V1ParametricHead() : () => new ClockBlindHead(),
		baseSec
	);
	sweeps.set(key, built);
	return built;
}

/** The leading run of points whose plan the clock sets — the ones a claim can be made about. */
function clockSetPrefix(points: readonly Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		if (!p.clockSet) break; // the sweep falls, so past here it is the motor/cap plateau
		out.push(p);
	}
	return out;
}

/**
 * Every `[point, reference]` pair the sample can resolve: the reference is the nearest earlier point
 * whose claimed factor is higher by at least `MIN_RESOLVABLE_GAP`. Chained across the sweep, "no
 * pair inverts" is monotonicity, stated only over the steps this many draws can actually separate.
 */
function clockResponsePairs(points: readonly Point[]): Array<readonly [Point, Point]> {
	const pairs: Array<readonly [Point, Point]> = [];
	for (let i = 1; i < points.length; i++) {
		const here = points[i];
		if (!here) throw new Error("sweep hole");
		for (let j = i - 1; j >= 0; j--) {
			const candidate = points[j];
			if (candidate && candidate.urgency >= here.urgency * (1 + MIN_RESOLVABLE_GAP)) {
				pairs.push([here, candidate]);
				break;
			}
		}
	}
	return pairs;
}

function expectFollowsClock(pairs: ReadonlyArray<readonly [Point, Point]>, label: string): void {
	expect(pairs.length, `${label}: no resolvable comparisons`).toBeGreaterThanOrEqual(
		MIN_COMPARISONS
	);
	for (const [here, reference] of pairs)
		expect(
			here.locationMs,
			`${label}: ${here.clockS.toFixed(0)} s planned ${here.locationMs.toFixed(0)} ms (factor ${here.urgency.toFixed(3)}), more than ${reference.clockS.toFixed(0)} s at ${reference.locationMs.toFixed(0)} ms (factor ${reference.urgency.toFixed(3)})`
		).toBeLessThanOrEqual(reference.locationMs);
}

/** `location(deepest clock-set point) / location(full clock)`. */
function fullToLowRatio(points: readonly Point[]): number {
	const usable = clockSetPrefix(points);
	const full = usable[0];
	const low = usable[usable.length - 1];
	if (!full || !low) throw new Error("no clock-set points");
	return low.locationMs / full.locationMs;
}

/** The plan at `clockS` over the plan at a full clock, for one speed. */
function ratioAt(points: readonly Point[], baseSec: number, clockS: number): number {
	const full = points[0];
	const at = points.find((p) => Math.abs(p.clockS - clockS) < baseSec / 1000);
	if (!full || !at) throw new Error(`no sweep point at ${clockS} s`);
	return at.locationMs / full.locationMs;
}

describe("the relative-clock urgency factor (§8, fix C)", () => {
	it("is 1 on a full clock, 1 for an untimed game, and never above 1 at any clock", () => {
		for (const [name, baseSec] of SPEEDS) {
			expect(urgencyFactor(features(baseSec, baseSec)), name).toBe(1);
			for (const fraction of FRACTIONS) {
				const u = urgencyFactor(features(baseSec, baseSec * fraction));
				expect(u, `${name} at ${fraction}`).toBeLessThanOrEqual(1);
				expect(u, `${name} at ${fraction}`).toBeGreaterThanOrEqual(U.floor);
			}
			// an empty clock bottoms out at the floor rather than running away
			expect(urgencyFactor(features(baseSec, 0))).toBeCloseTo(U.floor, 10);
		}
		const untimed = computeFeatures(ctx({ baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 }));
		expect(urgencyFactor(untimed)).toBe(1);
		expect(relativeClock(untimed)).toBe(1);
	});

	it("means the same thing in 1+0, 3+0 and 10+0: it is a fraction of the game's own base clock", () => {
		// The actual defect in `compression.clockS = 30`: 30 s is half a 1+0 game and 5 % of a 10+0.
		for (const fraction of FRACTIONS) {
			const us = SPEEDS.map(([, baseSec]) => urgencyFactor(features(baseSec, baseSec * fraction)));
			const first = us[0] ?? 0;
			for (const u of us) expect(u).toBeCloseTo(first, 10);
		}
	});

	it("falls strictly with the clock until it reaches its floor", () => {
		for (const [name, baseSec] of SPEEDS) {
			let previous = Number.POSITIVE_INFINITY;
			for (const fraction of FRACTIONS) {
				const u = urgencyFactor(features(baseSec, baseSec * fraction));
				if (fraction < U.kneeFraction && u > U.floor)
					expect(u, `${name} at ${fraction}`).toBeLessThan(previous);
				previous = u;
			}
		}
	});

	it("is a fraction of `base_s`, not `base_eff`: a 3+2 game starts at 1, not at 0.69", () => {
		// Review M8: `pressure.ts` explains why `base_eff` is the wrong denominator — it folds in
		// `40 · inc`, so a 3+2 game would read 0.69 on its very first move and be hurried before
		// anything had happened — and nothing asserted it. This is that assertion.
		const full = features(180, 180, 2);
		expect(full.base_eff).toBeGreaterThan(full.base_s); // the denominator that would be wrong
		expect(relativeClock(full)).toBe(1);
		expect(urgencyFactor(full)).toBe(1);
	});

	it("an increment floors it: a 3+2 player in time trouble still gets 2 s a move", () => {
		const f = features(180, 10, 2);
		expect(f.inc_s).toBeGreaterThanOrEqual(U.incFloorIncS);
		expect(urgencyFactor(f)).toBeGreaterThanOrEqual(U.incFloor);
	});

	it("never plans slower than today: the pace factor is at or under the §3a.3 compression", () => {
		// The one hard constraint on this lane — whatever is added may only ever pull the planned
		// think down — plus its other half: where the existing compression is the binding term the
		// pace factor IS the compression, so the late-game regime §13.2 measures does not move.
		let bindingPoints = 0;
		for (const [name, baseSec] of SPEEDS) {
			for (let clockS = 0; clockS <= baseSec; clockS += baseSec / 120) {
				const f = features(baseSec, clockS);
				const comp = compressionFactor(f);
				const pace = paceFactor(f);
				expect(pace, `${name} at ${clockS.toFixed(1)} s`).toBeLessThanOrEqual(comp);
				expect(pace, `${name} at ${clockS.toFixed(1)} s`).toBeLessThanOrEqual(1);
				if (comp < urgencyFactor(f)) {
					expect(pace, `${name} at ${clockS.toFixed(1)} s`).toBe(comp);
					bindingPoints++;
				}
			}
		}
		expect(bindingPoints).toBeGreaterThan(0);
	});
});

describe("TimingModel.planMove: the plan follows the clock", () => {
	/**
	 * Assert the clock response for every speed whose sweep this sample can resolve, and that the
	 * speeds which must resolve did. A speed that cannot is skipped rather than asserted — see
	 * `clockSetPrefix` and `MIN_RESOLVABLE_GAP` — and `MUST_RESOLVE` is what stops the skip from
	 * quietly swallowing the whole test.
	 */
	function expectSpeedsFollowClock(kind: "clock-blind" | "v1", maxRatio: number): void {
		const resolved: string[] = [];
		for (const [name, baseSec] of SPEEDS) {
			const points = sweepOf(kind, baseSec);
			const pairs = clockResponsePairs(clockSetPrefix(points));
			if (pairs.length < MIN_COMPARISONS) continue;
			resolved.push(name);
			expectFollowsClock(pairs, `${kind} ${name}`);
			expect(fullToLowRatio(points), `${kind} ${name}`).toBeLessThanOrEqual(maxRatio);
		}
		for (const name of MUST_RESOLVE) expect(resolved, kind).toContain(name);
	}

	it(
		"a head that ignores the clock and the allocation still produces a falling pace",
		() => {
			// This is the production path: `ChessMimicHead.sample()` never reads `allocSec`, and the ONNX
			// distribution's own clock conditioning is weak (and inverted over part of a 10+0).
			expectSpeedsFollowClock("clock-blind", 0.8);
		},
		SWEEP_TIMEOUT_MS
	);

	it(
		"the v1 head's own budget response compounds with it rather than replacing it",
		() => {
			expectSpeedsFollowClock("v1", 0.7);
		},
		SWEEP_TIMEOUT_MS
	);

	it(
		"the owner's own game: at 1:00 of a 3+0 the plan is visibly quicker than at 3:00",
		() => {
			// The reported case, as its own assertion, so a change that satisfies the generic sweeps while
			// leaving 3+0 flat cannot hide. Bounded on both sides: "quicker" is not "instant".
			const blind = ratioAt(sweepOf("clock-blind", 180), 180, 60);
			expect(blind).toBeLessThanOrEqual(0.8);
			expect(blind).toBeGreaterThanOrEqual(0.3);
			expect(ratioAt(sweepOf("v1", 180), 180, 60)).toBeLessThanOrEqual(0.6);
		},
		SWEEP_TIMEOUT_MS
	);

	it(
		"a 1+0 game is paced by the hand and the §3a.3 cap, not by this factor",
		() => {
			// Said out loud rather than left implicit in a skip: the v1 body median in a bullet game is
			// already within reach of the hand's own time at a full clock, so there is far less clock-set
			// range than the same head has in a 3+0. The brief's own note — the hand needs 400–900 ms per
			// move whatever the plan says — is where bullet's pace actually comes from.
			expect(clockSetPrefix(sweepOf("v1", 60)).length).toBeLessThan(
				clockSetPrefix(sweepOf("v1", 180)).length
			);
		},
		SWEEP_TIMEOUT_MS
	);

	it(
		"the think time stays a distribution, not a pace: the per-clock spread survives",
		() => {
			// The owner's second report — "it just seems pretty robotic", a think that reads the same on
			// every move — is the failure mode a pace multiplier could introduce, so it is gated here.
			// §8.4a already requires a per-game CV of 0.5; a fixed clock must clear it too, wherever the
			// hand is not the thing setting the time.
			for (const [name, baseSec] of SPEEDS)
				for (const point of clockSetPrefix(sweepOf("v1", baseSec)))
					expect(point.cv, `${name} at ${point.clockS.toFixed(0)} s`).toBeGreaterThanOrEqual(
						TIMING_CONSTANTS.cvGuard.minCv
					);
		},
		SWEEP_TIMEOUT_MS
	);
});
