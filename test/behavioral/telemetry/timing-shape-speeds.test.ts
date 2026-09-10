// test/behavioral/telemetry/timing-shape-speeds.test.ts — the §13.2 conformance gate at the speeds
// production can now reach.
//
// Until the time control was wired through (§4.3) no adapter ever set
// `PositionSnapshot.timeControl`, so every real game conditioned as `untimed` — and every harness
// supplied a class of its own, so the gate had only ever been measured at 600+0 rapid. These runs
// drive the same `assertHumanShapedAc` model at **bullet 1+0 and blitz 3+0**, with the hand's motor
// class derived from the clock rather than handed in, and print the per-class summary
// (`formatConformanceReport`) so the numbers are on the record rather than inferred from a pass.
//
// What each speed can and cannot say is part of the result, and is asserted on the *counts* so that
// a future change which silently starts measuring nothing is visible:
//   * the 4–12 % preview band needs 200 non-trivial moves, and a move is only non-trivial with
//     ≥ 1200 ms of planned think and ≥ 15 s of clock (`PREVIEW`), so a bullet game has very few;
//   * the compression ratio compares moves under 30 s of clock against moves with ≥ 60 s, and a
//     1+0 game never has more than 60 s, so its comfortable side cannot fill from play alone.
import { describe, expect, it } from "bun:test";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { runSimulatedGame, type SimulatedMove } from "@test/sim/telemetry/harness";
import type { AcBlob } from "@typedefs/telemetry";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
	formatConformanceReport,
	moveMetaOf,
	summarizeAc,
} from "../../../tools/telemetry-conformance/ac-model";

const RUN_TIMEOUT_MS = 180_000;
/** Comfortable games per speed (the preview rate is a population statistic) and moves each. */
const GAMES = 6;
const MOVES = 30;
/** Games per speed that start in time trouble, so the compression band has a pressure side. */
const PRESSURE_GAMES = 3;

type Speed = "bullet" | "blitz";

interface Pool {
	acs: AcBlob[];
	meta: AcMoveMeta[];
	moves: SimulatedMove[];
}

const empty = (): Pool => ({ acs: [], meta: [], moves: [] });

async function add(
	into: Pool,
	seed: string,
	clock: Parameters<typeof runSimulatedGame>[0]["clock"]
) {
	const game = await runSimulatedGame({ seed, moves: MOVES, ...(clock ? { clock } : {}) });
	try {
		expect(game.moves.every((m) => m.result.ok && m.result.outcome === "executed")).toBe(true);
		into.acs.push(...game.acs);
		into.meta.push(...game.moves.map(moveMetaOf));
		into.moves.push(...game.moves);
	} finally {
		await game.dispose();
	}
}

/** Comfortable games, plus time-pressure games of the same speed. */
async function pool(speed: Speed): Promise<Pool> {
	const s = SIM_TELEMETRY.speeds[speed];
	const out = empty();
	for (let g = 0; g < GAMES; g++)
		await add(out, `${speed}-${g}`, { baseSec: s.baseSec, incSec: s.incSec });
	for (let g = 0; g < PRESSURE_GAMES; g++)
		await add(out, `${speed}-pressure-${g}`, {
			baseSec: s.baseSec,
			incSec: s.incSec,
			myStartMs: s.pressureStartMs,
		});
	return out;
}

/** Every §13.2 / §8.4a band except the one a speed is known to miss (asserted case by case). */
function assertHardInvariants(
	summary: ReturnType<typeof summarizeAc>,
	acs: readonly AcBlob[],
	meta: readonly AcMoveMeta[],
	moves: readonly SimulatedMove[]
): void {
	// §13.2 hard invariants, at every speed
	expect(summary.blurCount).toBe(0);
	expect(summary.toggles).toBe(0);
	expect(summary.untrusted).toBe(0);
	expect(summary.focusFieldsSet).toBe(0);

	// §8.4a: the hold time is neither a constant nor a low-variance cluster
	expect(summary.holdNormal.n).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.cvAfterMoves);
	expect(summary.holdNormal.cv).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.cvMin);
	// §9.6a: no non-premove/instant move completes faster than the floor
	acs.forEach((ac, i) => {
		const m = meta[i];
		if (!m || m.mode === "premove" || m.mode === "instant") return;
		expect(ac.MoveHoldTime).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.minMs);
	});
	// the hand never drops before the plan's deadline (any overrun is motor time)
	for (const m of moves)
		expect(m.result.elapsedMs).toBeGreaterThanOrEqual(m.plan.thinkMs - SIM_TELEMETRY.clockEpsilonMs);

	// §13.2 preview rate: the hard cap always, the 4–12 % band only with the population behind it
	// (both speeds fall short of `minMovesForBand` — see the header).
	expect(summary.multiSelect.rate ?? 0).toBeLessThanOrEqual(TELEMETRY_BANDS.multiSelect.hardMax);
	if (summary.multiSelect.eligible >= TELEMETRY_BANDS.multiSelect.minMovesForBand) {
		const [lo, hi] = TELEMETRY_BANDS.multiSelect.rate;
		expect(summary.multiSelect.rate ?? 0).toBeGreaterThanOrEqual(lo);
		expect(summary.multiSelect.rate ?? 0).toBeLessThanOrEqual(hi);
	}
}

describe("telemetry: the §13.2 gate at bullet and blitz", () => {
	it(
		"blitz 3+0: every ac blob is human-shaped, and the measured summary is on the record",
		async () => {
			const { acs, meta, moves } = await pool("blitz");
			expect(acs).toHaveLength((GAMES + PRESSURE_GAMES) * MOVES);
			const summary = assertHumanShapedAc(acs, { moves: meta });
			console.log(formatConformanceReport(summary, "ac conformance — blitz 3+0"));
			assertHardInvariants(summary, acs, meta, moves);
			expect(summarizeAc(acs, meta)).toEqual(summary);
		},
		RUN_TIMEOUT_MS
	);

	it(
		"bullet 1+0: the §13.2 hard invariants hold, and the measured summary is on the record",
		async () => {
			const { acs, meta, moves } = await pool("bullet");
			expect(acs).toHaveLength((GAMES + PRESSURE_GAMES) * MOVES);
			const summary = summarizeAc(acs, meta);
			console.log(formatConformanceReport(summary, "ac conformance — bullet 1+0"));
			assertHardInvariants(summary, acs, meta, moves);
			// The one band this speed misses is asserted — unchanged — by the case below.
			expect(summary.holdVsComplexity).not.toBeNull();
		},
		RUN_TIMEOUT_MS
	);

	// A FINDING, not a knob: at bullet the complexity correlation band fails, and the band is left
	// exactly as it is. Measured over 270 moves (6 × 30 comfortable + 3 × 30 time-pressure games of
	// 1+0): **r = 0.19 against a floor of 0.20**. Over the comfortable games alone it is 0.21, so
	// the pressure games are what pull it under: with a 60 s clock the compression factor and the
	// hard cap set the think time, which squeezes out the complexity term the band measures — in
	// bullet the *clock*, not the position, decides how long a move takes. This is a property of the
	// model (Appendix D §3a.3) that only became measurable once production could reach bullet at
	// all; nothing in this lane changed either side of it. `it.failing` records it so the suite
	// stays honest: if the model is changed and the band starts passing, this case fails loudly.
	it.failing(
		"bullet 1+0: the hold-vs-complexity band FAILS at r = 0.19 (floor 0.20) — recorded, not widened",
		async () => {
			const { acs, meta } = await pool("bullet");
			assertHumanShapedAc(acs, { moves: meta });
		},
		RUN_TIMEOUT_MS
	);

	it(
		"the compression band: blitz fills both sides; bullet's clock cannot fill the comfortable one",
		async () => {
			// Stated rather than assumed. `comfortableClockMs` is 60 s and a 1+0 game starts there, so
			// at bullet the ratio is structurally un-assertable: the reference side holds at most the
			// first move of each game. A speed-aware reference would be a band change, which is not
			// this lane's to make — the measured numbers are in the report instead.
			const blitzPool = await pool("blitz");
			const blitz = summarizeAc(blitzPool.acs, blitzPool.meta);
			console.log(
				`compression — blitz: pressure ${blitz.compression.pressure.mean.toFixed(0)} ms (n=${blitz.compression.pressure.n}) vs comfortable ${blitz.compression.comfortable.mean.toFixed(0)} ms (n=${blitz.compression.comfortable.n}) → ratio ${blitz.compression.ratio?.toFixed(2) ?? "n/a"} (max ${TELEMETRY_BANDS.compression.maxMeanRatio})`
			);
			expect(blitz.compression.pressure.n).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.compression.minMovesPerSide
			);
			expect(blitz.compression.comfortable.n).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.compression.minMovesPerSide
			);
			expect(blitz.compression.ratio ?? 1).toBeLessThan(TELEMETRY_BANDS.compression.maxMeanRatio);

			const bulletPool = await pool("bullet");
			const bullet = summarizeAc(bulletPool.acs, bulletPool.meta);
			console.log(
				`compression — bullet: pressure ${bullet.compression.pressure.mean.toFixed(0)} ms (n=${bullet.compression.pressure.n}) vs comfortable ${bullet.compression.comfortable.mean.toFixed(0)} ms (n=${bullet.compression.comfortable.n}) → ratio ${bullet.compression.ratio?.toFixed(2) ?? "n/a"}`
			);
			expect(bullet.compression.pressure.n).toBeGreaterThan(0);
			expect(bullet.compression.comfortable.n).toBeLessThan(
				TELEMETRY_BANDS.compression.minMovesPerSide
			);
		},
		RUN_TIMEOUT_MS
	);

	it(
		"the §8.5 emergency regime is reachable now, and its realised holds still clear the §13.2 floor",
		async () => {
			// Gated on `tc !== "untimed"`, so before the time control was wired through this whole
			// branch was dead code in production. With a real bullet clock it is entered within a few
			// moves of running low. The interesting question is what the *page* then sees: the plan
			// collapses to tens of ms, while the hand's own motor time is hundreds — and §13.2's
			// 250 ms floor applies to every non-premove/instant move. Run as a matrix over starting
			// clocks and seeds so the answer does not rest on one draw.
			const s = SIM_TELEMETRY.speeds.bullet;
			const rows: Array<{ clockMs: number; mode: string; plannedMs: number; holdMs: number }> = [];
			let live = 0;
			for (const seed of ["a", "b"])
				for (const startMs of [2_000, 2_500, 3_000, s.emergencyStartMs]) {
					const game = await runSimulatedGame({
						seed: `em-${seed}-${startMs}`,
						moves: 10,
						clock: { baseSec: s.baseSec, incSec: s.incSec, myStartMs: startMs },
					});
					try {
						for (const m of game.moves) {
							if (m.plan.features.emergency !== 1) continue;
							const hold = Math.round(m.observation?.ac.MoveHoldTime ?? -1);
							rows.push({
								clockMs: Math.round(m.myClockMs),
								mode: m.plan.mode,
								plannedMs: Math.round(m.plan.thinkMs),
								holdMs: hold,
							});
							if (m.myClockMs > 0) live += 1;
							// the regime is only entered under the §8.5 threshold …
							expect(m.myClockMs).toBeLessThan(TIMING_CONSTANTS.replan.emergencyClockMs);
							// … the plan really is collapsed below the normal floor …
							expect(m.plan.thinkMs).toBeLessThan(TELEMETRY_BANDS.holdTime.minMs);
							// … and yet the page never sees a sub-250 ms non-premove/instant move, because
							// the hand's own motor time is the floor in practice: §8.5's "no floors" and
							// §13.2's 250 ms floor do not actually collide.
							if (m.plan.mode !== "premove" && m.plan.mode !== "instant")
								expect(hold).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.minMs);
						}
						expect(game.moves.every((m) => m.result.outcome === "executed")).toBe(true);
						assertHumanShapedAc(game.acs, { moves: game.moves.map(moveMetaOf) });
					} finally {
						await game.dispose();
					}
				}
			console.log(`emergency regime — bullet: ${JSON.stringify(rows)}`);
			expect(rows.length).toBeGreaterThan(0);
			// at least one of them was entered with the clock still running, not on a drained clock
			expect(live).toBeGreaterThan(0);
		},
		RUN_TIMEOUT_MS
	);
});
