// test/behavioral/telemetry/timing-shape-speeds.test.ts — the §13.2 conformance gate at the speeds
// production can now reach, measured as a **population**.
//
// Until the time control was wired through (§4.3) no adapter ever set
// `PositionSnapshot.timeControl`, so every real game conditioned as `untimed` — and every harness
// supplied a class of its own, so the gate had only ever been measured at 600+0 rapid. `tcClass` is
// now derived from the clock inside the harness, and these runs drive the same unmodified
// `assertHumanShapedAc` model at bullet 1+0 and blitz 3+0.
//
// **Pooled across seed prefixes on purpose.** Every band here is a population statistic, and at one
// pool's size (≈ 100–170 normal rows) the standard error of the complexity correlation is ≈ 0.05–0.10
// — larger than the distance to its own floor. A per-pool verdict is therefore a coin flip dressed as
// a gate: the first version of this file asserted the full model on a single blitz pool and was green
// only on the draw it was written with. What is asserted now is the pooled value over
// `PREFIXES × (GAMES + PRESSURE_GAMES)` games, which moves the standard error to ≈ 0.02.
//
// What each speed can and cannot say is part of the result:
//   * previews need ≥ 1200 ms of planned think and ≥ 15 s of clock (`PREVIEW`), and the preview
//     *probability* ramp `g(thinkMs)` is ≈ 0 at 1200 ms and only reaches 1 at 4 s — so at bullet the
//     band's denominator is full of moves the model gives almost no chance of previewing;
//   * the compression ratio compares moves under 30 s of clock against moves with ≥ 60 s, and a 1+0
//     game never has more than 60 s, so its comfortable side cannot fill from play at all.
import { describe, expect, it } from "bun:test";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { type SplitViolations, splitViolations } from "@test/sim/telemetry/bands";
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

const RUN_TIMEOUT_MS = 300_000;
/**
 * Independent seed prefixes pooled into one population per speed. Twelve, not eight: the reviewer's
 * 12-family re-measurement showed the `p0…p7` set is the *low tail* of the preview-rate distribution
 * (0.72–7.14 % across families), so eight of them measured a tail rather than a population.
 */
const PREFIXES = 12;
/** Comfortable games per prefix, moves each, and games that start in time trouble. */
const GAMES = 6;
const MOVES = 30;
const PRESSURE_GAMES = 3;
/** A hold time past this is a "long think" for the tail-frequency table (ms). */
const LONG_THINK_MS = 4_000;

type Speed = "bullet" | "blitz";

interface Pool {
	acs: AcBlob[];
	meta: AcMoveMeta[];
	moves: SimulatedMove[];
	/** The per-prefix correlation, to show the spread a single pool's verdict rests on. */
	perPrefixR: number[];
}

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

async function build(speed: Speed): Promise<Pool> {
	const s = SIM_TELEMETRY.speeds[speed];
	const out: Pool = { acs: [], meta: [], moves: [], perPrefixR: [] };
	for (let p = 0; p < PREFIXES; p++) {
		const prefix: Pool = { acs: [], meta: [], moves: [], perPrefixR: [] };
		for (let g = 0; g < GAMES; g++)
			await add(prefix, `p${p}-${speed}-${g}`, { baseSec: s.baseSec, incSec: s.incSec });
		for (let g = 0; g < PRESSURE_GAMES; g++)
			await add(prefix, `p${p}-${speed}-pr-${g}`, {
				baseSec: s.baseSec,
				incSec: s.incSec,
				myStartMs: s.pressureStartMs,
			});
		out.acs.push(...prefix.acs);
		out.meta.push(...prefix.meta);
		out.moves.push(...prefix.moves);
		out.perPrefixR.push(summarizeAc(prefix.acs, prefix.meta).holdVsComplexity ?? Number.NaN);
	}
	return out;
}

/** Each speed's population is built once and shared by every case below. */
const pools = new Map<Speed, Promise<Pool>>();
function poolOf(speed: Speed): Promise<Pool> {
	const existing = pools.get(speed);
	if (existing) return existing;
	const built = build(speed);
	pools.set(speed, built);
	return built;
}

/** The §13.2 / §8.4a bands that hold at every speed, plus the ones a speed is known to miss. */
function assertHardInvariants(pool: Pool): ReturnType<typeof summarizeAc> {
	const { acs, meta, moves } = pool;
	const summary = summarizeAc(acs, meta);

	// §13.2 hard invariants
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

	// §13.2 preview selections: the hard cap at any size, and — the half that was asserted nowhere
	// that could fail — "never 0 %, never 100 %" once the sample is big enough to mean anything.
	// The 4–12 % band itself is a per-speed verdict and is asserted case by case below.
	expect(summary.multiSelect.rate ?? 0).toBeLessThanOrEqual(TELEMETRY_BANDS.multiSelect.hardMax);
	if (summary.multiSelect.eligible >= TELEMETRY_BANDS.multiSelect.minMovesForNonZero) {
		expect(summary.multiSelect.count).toBeGreaterThan(0);
		expect(summary.multiSelect.count).toBeLessThan(summary.multiSelect.eligible);
	}
	return summary;
}

/** The per-move rules hold at any sample size: they are asserted, not recorded, everywhere. */
function expectNoPerMoveViolations(pool: Pool): SplitViolations {
	const split = splitViolations(pool.acs, pool.meta);
	expect(split.perMove).toEqual([]);
	return split;
}

/** ln(hold) means, medians and long-think frequency per `n_reasonable` — the mechanism table. */
function byComplexity(
	pool: Pool
): Array<{ n: number; rows: number; median: number; mean: number; longPct: number }> {
	const groups = new Map<number, number[]>();
	pool.acs.forEach((ac, i) => {
		const m = pool.meta[i];
		if (!m || (m.mode !== "normal" && m.mode !== "long") || m.nReasonable === undefined) return;
		const xs = groups.get(m.nReasonable) ?? [];
		xs.push(ac.MoveHoldTime);
		groups.set(m.nReasonable, xs);
	});
	return [...groups.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([n, xs]) => {
			const sorted = [...xs].sort((a, b) => a - b);
			return {
				n,
				rows: xs.length,
				median: sorted[Math.floor(xs.length / 2)] ?? 0,
				mean: xs.reduce((a, b) => a + b, 0) / xs.length,
				longPct: (100 * xs.filter((x) => x > LONG_THINK_MS).length) / xs.length,
			};
		});
}

const rSpread = (pool: Pool): string =>
	pool.perPrefixR.map((r) => r.toFixed(3)).join(" ") +
	` (below ${TELEMETRY_BANDS.holdTime.complexityCorrMin}: ${
		pool.perPrefixR.filter((r) => r < TELEMETRY_BANDS.holdTime.complexityCorrMin).length
	}/${pool.perPrefixR.length})`;

describe("telemetry: the §13.2 gate at bullet and blitz, pooled", () => {
	for (const speed of ["bullet", "blitz"] as const) {
		it(
			`${speed}: the §13.2 hard invariants hold over ${PREFIXES * (GAMES + PRESSURE_GAMES) * MOVES} moves, and the summary is on the record`,
			async () => {
				const pool = await poolOf(speed);
				// A floor, not an equality: a simulated game can end in mate before its 30th move.
				expect(pool.acs.length).toBeGreaterThan(PREFIXES * (GAMES + PRESSURE_GAMES) * MOVES * 0.95);
				const summary = assertHardInvariants(pool);
				// Every per-move rule, through the model rather than a hand-picked subset.
				expectNoPerMoveViolations(pool);
				console.log(formatConformanceReport(summary, `ac conformance — ${speed} (pooled)`));
				console.log(`  per-prefix r: ${rSpread(pool)}`);
			},
			RUN_TIMEOUT_MS
		);
	}

	// A FINDING, not a knob. Three §13.2 rows fail at bullet on the pooled population, and the band
	// constants are left exactly as they are:
	//
	//   hold-time vs n_reasonable correlation 0.12 < 0.2     (robust: 10 of 12 families below)
	//   multi-select rate 2.3 % (9/397) outside 4–12 %        (recorded: the population is ≈ 3.7 %
	//                                                          with a per-pool sd of ~1.5 pp, so a
	//                                                          pool either side of 4 % is ordinary)
	//   time-pressure hold ratio 0.99 > 0.85                  (recorded: the reference side is 14
	//                                                          moves against 547, see the case below)
	//
	// Only the correlation is asserted *present*. The other two are recorded with their numbers,
	// because their verdict moves with the draw and the pool size — asserting them would be the same
	// coin-flip gate this file exists to remove. What **is** asserted for all three is that nothing
	// *else* fails: every row is one of the known statistical rows, so a regression in any per-move
	// rule cannot hide behind them.
	it(
		"bullet: the complexity band fails on the pooled population, and nothing unknown does",
		async () => {
			const pool = await poolOf("bullet");
			const split = expectNoPerMoveViolations(pool);
			console.log(`bullet pooled violations: ${JSON.stringify(split.all)}`);
			const summary = summarizeAc(pool.acs, pool.meta);

			// the robust one, asserted
			expect(split.statistical.some((v) => v.includes("hold-time vs n_reasonable correlation"))).toBe(
				true
			);
			expect(summary.holdVsComplexity ?? 1).toBeLessThan(TELEMETRY_BANDS.holdTime.complexityCorrMin);
			// the two recorded ones: whatever they do, they are the only other rows that may appear
			const known = ["multi-select rate", "time-pressure hold ratio"];
			for (const row of split.statistical)
				expect(
					row.includes("hold-time vs n_reasonable correlation") || known.some((k) => row.includes(k))
				).toBe(true);
			// Anchor the band itself: if the eligible pool ever fell below the band's own minimum the
			// preview rate would stop being evaluated at all, with nothing noticing.
			expect(summary.multiSelect.eligible).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.multiSelect.minMovesForBand
			);
			console.log(
				`bullet preview rate ${(100 * (summary.multiSelect.rate ?? 0)).toFixed(2)} % (${summary.multiSelect.count}/${summary.multiSelect.eligible}) — band ${100 * TELEMETRY_BANDS.multiSelect.rate[0]}–${100 * TELEMETRY_BANDS.multiSelect.rate[1]} %, population ≈ 3.7 % over 12 families`
			);
		},
		RUN_TIMEOUT_MS
	);

	it(
		"blitz: the complexity band is not a stable gate at this speed — the pooled value is recorded, not asserted",
		async () => {
			// On this seed population blitz clears the floor (pooled ≈ 0.24) while 2 of 8 prefixes do
			// not (0.129, 0.168); the reviewer's independent prefixes put the same population at ≈ 0.15
			// with 5 of 8 failing. Both measurements are of the same generator, which is the point: the
			// per-game persona is a large variance component, so the band's *verdict* at blitz depends
			// on which games you drew. Asserting either direction here would be a coin flip dressed as
			// a release gate — the first version of this file did exactly that and was green only on
			// its own draw. What is asserted is the part that does not move: the effect has the right
			// sign, and every other band passes (above).
			const pool = await poolOf("blitz");
			const split = expectNoPerMoveViolations(pool);
			const summary = summarizeAc(pool.acs, pool.meta);
			const r = summary.holdVsComplexity ?? 0;
			console.log(
				`blitz pooled r = ${r.toFixed(3)} (floor ${TELEMETRY_BANDS.holdTime.complexityCorrMin}) over ${summary.holdNormal.n} normal rows · per-prefix ${rSpread(pool)} · statistical rows ${JSON.stringify(split.statistical)}`
			);
			// A floor of 0.10, not `> 0`. The decisive re-measurement (432 games per speed) puts blitz
			// at 0.2087 with a family minimum of 0.168 and a spread of 0.168–0.259, so 0.10 is half the
			// worst pooled observation and cannot flake. It is a backstop against total collapse, not a
			// guard on the complexity term: zeroing the four explicit complexity coefficients leaves r
			// at 0.144, which still clears it — what catches the term is the bullet case above. The
			// 0.20 floor itself is not asserted here: at blitz its verdict
			// moves with the seed population (0.2087 over 432 games, 0.234 over these 108, ≈ 0.15 over
			// the reviewer's first prefix set), which is exactly the coin flip C1 was about.
			expect(r).toBeGreaterThanOrEqual(0.1);
			// the preview band, which blitz does clear with the population behind it
			expect(summary.multiSelect.eligible).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.multiSelect.minMovesForBand
			);
			const [lo, hi] = TELEMETRY_BANDS.multiSelect.rate;
			expect(summary.multiSelect.rate ?? 0).toBeGreaterThanOrEqual(lo);
			expect(summary.multiSelect.rate ?? 0).toBeLessThanOrEqual(hi);
		},
		RUN_TIMEOUT_MS
	);

	it(
		"the complexity term acts on the frequency of long thinks, not on the bulk",
		async () => {
			// Why a Pearson r on ln(hold) is a weak estimator of what the model actually does, and the
			// evidence for the Appendix D question: at bullet the median is flat across `n_reasonable`
			// while the long-think frequency climbs, so the signal lives entirely in the tail. At blitz
			// the bulk does respond, which is why r survives there and collapses at bullet.
			for (const speed of ["bullet", "blitz"] as const) {
				const table = byComplexity(await poolOf(speed));
				console.log(
					`${speed} by n_reasonable: ${table
						.map(
							(r) =>
								`n=${r.n} N=${r.rows} median ${r.median.toFixed(0)} mean ${r.mean.toFixed(0)} p(>${LONG_THINK_MS / 1000}s) ${r.longPct.toFixed(1)}%`
						)
						.join(" | ")}`
				);
			}
			const bullet = byComplexity(await poolOf("bullet"));
			const at = (n: number) => bullet.find((r) => r.n === n);
			const low = at(2);
			const high = at(4);
			expect(low).toBeDefined();
			expect(high).toBeDefined();
			if (!low || !high) return;
			// the bulk barely moves …
			expect(Math.abs(high.median - low.median)).toBeLessThan(100);
			// … while the mean and the tail frequency both rise with complexity
			expect(high.mean).toBeGreaterThan(low.mean * 0.95);
			const lowest = at(1);
			expect(lowest).toBeDefined();
			if (lowest) expect(high.longPct).toBeGreaterThan(lowest.longPct);
		},
		RUN_TIMEOUT_MS
	);

	it(
		"the compression band: blitz fills both sides; bullet's clock cannot fill the comfortable one",
		async () => {
			// Stated rather than assumed. `comfortableClockMs` is 60 s and a 1+0 game starts there, so
			// at bullet the reference side holds a handful of first moves out of 2160. A speed-aware
			// reference would be a band change, which is not this lane's to make.
			const blitz = summarizeAc(...(await poolOf("blitz").then((p) => [p.acs, p.meta] as const)));
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

			const bullet = summarizeAc(...(await poolOf("bullet").then((p) => [p.acs, p.meta] as const)));
			console.log(
				`compression — bullet: pressure ${bullet.compression.pressure.mean.toFixed(0)} ms (n=${bullet.compression.pressure.n}) vs comfortable ${bullet.compression.comfortable.mean.toFixed(0)} ms (n=${bullet.compression.comfortable.n}) → ratio ${bullet.compression.ratio?.toFixed(2) ?? "n/a"}`
			);
			expect(bullet.compression.pressure.n).toBeGreaterThan(0);
			// With twelve families the reference side finally crosses `minMovesPerSide` — on 14 moves
			// against 547, every one of them the first move of a game at exactly the 60 s threshold —
			// so the band *fires* at bullet on a ratio that is not a measurement of anything. That is
			// the finding: the reference is defined in absolute seconds, and a 1+0 game has no
			// "comfortable" phase to compare against. Recorded, with the band untouched.
			const comfortable = (await poolOf("bullet")).meta.filter(
				(move) => move.clockMs >= TELEMETRY_BANDS.compression.comfortableClockMs
			);
			expect(comfortable.length).toBeLessThanOrEqual(PREFIXES * GAMES);
			expect(
				comfortable.every((move) => move.clockMs === SIM_TELEMETRY.speeds.bullet.baseSec * 1000)
			).toBe(true);
		},
		RUN_TIMEOUT_MS
	);

	it(
		"clock races remove deliberate hand floors while retaining valid move telemetry",
		async () => {
			// Urgent instant moves must complete quickly on the page, not merely receive a short plan.
			// Ordinary moves still retain the normal timing invariants checked above.
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
							expect(m.myClockMs).toBeLessThan(TIMING_CONSTANTS.clockRace.ownThresholdMs);
							// … the plan really is collapsed below the normal floor …
							expect(m.plan.thinkMs).toBeLessThan(TELEMETRY_BANDS.holdTime.minMs);
							if ((m.plan.features.clockRace ?? 0) > 0) {
								expect(hold).toBeGreaterThan(0);
								expect(hold).toBeLessThan(300);
							} else if (m.plan.mode !== "premove" && m.plan.mode !== "instant")
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
