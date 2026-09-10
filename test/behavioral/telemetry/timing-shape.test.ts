// test/behavioral/telemetry/timing-shape.test.ts — Task 33 Step 2 (f), §8.4a / §9.6a / §13.6: over
// 200 simulated moves (5 bot games driven by the real TimingModel, 3 with comfortable clocks and 2
// starting in time trouble) the `MoveHoldTime` the page measures has CV ≥ 0.5, no value under
// 250 ms outside premove/instant, correlates with `n_reasonable` (≥ 0.2) and compresses under
// time pressure. Every blob also passes the full human-shape assertion, and each hold time is
// reconciled against its plan: the hand never drops early, and only ever drops late when the
// motor floor alone exceeded the think budget.
import { describe, expect, it } from "bun:test";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { runSimulatedGame, type SimulatedMove } from "@test/sim/telemetry/harness";
import type { AcBlob } from "@typedefs/telemetry";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
	moveMetaOf,
	summarizeAc,
} from "../../../tools/telemetry-conformance/ac-model";

/** Real-time budget for the 200-move run (virtual time is free; the DOM dispatches are not). */
const RUN_TIMEOUT_MS = 60_000;

describe("telemetry: timing shape over 200 simulated moves (Step 2f)", () => {
	it(
		"MoveHoldTime is human-shaped: CV ≥ 0.5, ≥ 250 ms outside premove/instant, tracks complexity and compresses under pressure",
		async () => {
			const G = SIM_TELEMETRY.timingShapeGames;
			const acs: AcBlob[] = [];
			const meta: AcMoveMeta[] = [];
			const moves: SimulatedMove[] = [];
			for (let g = 0; g < G.comfortable + G.pressure; g++) {
				const pressure = g >= G.comfortable;
				const game = await runSimulatedGame({
					seed: `timing-shape-${g}`,
					moves: G.movesPerGame,
					...(pressure
						? {
								clock: {
									baseSec: SIM_TELEMETRY.game.baseSec,
									incSec: SIM_TELEMETRY.game.incSec,
									myStartMs: SIM_TELEMETRY.pressureStartMs,
								},
							}
						: {}),
				});
				try {
					expect(game.moves.every((m) => m.result.ok && m.result.outcome === "executed")).toBe(true);
					expect(game.moves).toHaveLength(G.movesPerGame);
					acs.push(...game.acs);
					meta.push(...game.moves.map(moveMetaOf));
					moves.push(...game.moves);
				} finally {
					await game.dispose();
				}
			}
			expect(acs).toHaveLength(SIM_TELEMETRY.timingShapeMoves);
			expect(meta).toHaveLength(SIM_TELEMETRY.timingShapeMoves);

			const summary = assertHumanShapedAc(acs, { moves: meta });
			// the four (f) bands, stated explicitly with N
			expect(summary.holdNormal.n).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.cvAfterMoves);
			expect(summary.holdNormal.cv).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.cvMin);
			// §9.6a's 250 ms floor holds on both sides of the plan: on the realised hold *and* on the
			// planned think. Only the second can catch a timing-model regression — the motor floors
			// the realised hold upward (a sub-250 ms plan would still drop late enough to pass), so
			// asserting the hold alone would hide exactly the bug this band exists to find.
			acs.forEach((ac, i) => {
				const m = meta[i]!;
				if (m.mode === "premove" || m.mode === "instant") return;
				expect(m.thinkMs).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.minMs);
				expect(ac.MoveHoldTime).toBeGreaterThanOrEqual(TELEMETRY_BANDS.holdTime.minMs);
			});
			expect(summary.holdVsComplexity).not.toBeNull();
			expect(summary.holdVsComplexity ?? 0).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.holdTime.complexityCorrMin
			);
			expect(summary.compression.pressure.n).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.compression.minMovesPerSide
			);
			expect(summary.compression.comfortable.n).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.compression.minMovesPerSide
			);
			expect(summary.compression.ratio).not.toBeNull();
			expect(summary.compression.ratio ?? 1).toBeLessThan(TELEMETRY_BANDS.compression.maxMeanRatio);
			// The page's hold time is the plan's think time as the hand realised it. The hand never
			// *rushes*: its own drop never lands before the planned deadline (`elapsedMs ≥ thinkMs`),
			// and the page's submit is the committed press's release — every committed move is a drag —
			// so `MoveHoldTime` sits at or just under the drop. It may land
			// *late*: the executor plans the touch from the motor profile's natural durations and
			// starts the approach at `max(now, t0 + think − approach − touch)`, so a think budget
			// shorter than the hand's Fitts-law floor collapses the pre-touch window and the drop
			// slips. That overrun is motor time, never a shortened think (§13.5: "MoveHoldTime =
			// think + motor is coherent"): the touch always *begins* inside the planned window, so
			// everything past the deadline is the hand physically moving.
			let onDeadline = 0;
			moves.forEach((m, i) => {
				const ac = acs[i]!;
				expect(m.result.elapsedMs).toBeGreaterThanOrEqual(
					m.plan.thinkMs - SIM_TELEMETRY.clockEpsilonMs
				);
				const submitBeforeDrop = m.result.elapsedMs - ac.MoveHoldTime;
				expect(submitBeforeDrop).toBeGreaterThanOrEqual(-SIM_TELEMETRY.clockEpsilonMs);
				expect(submitBeforeDrop).toBeLessThanOrEqual(TELEMETRY_BANDS.holdTime.submitBeforeDropMaxMs);
				const approach = m.result.timeline.find((t) => t.phase === "approach");
				expect(approach).toBeDefined();
				const touchStart = approach?.startMs ?? Number.POSITIVE_INFINITY;
				expect(touchStart).toBeLessThan(m.plan.thinkMs);
				// the whole overrun is inside the touch, and one touch is a plausible hand movement
				expect(m.result.elapsedMs - touchStart).toBeLessThanOrEqual(SIM_TELEMETRY.maxTouchMs);
				if (ac.MoveHoldTime <= m.plan.thinkMs + SIM_TELEMETRY.deadlineToleranceMs) onDeadline += 1;
			});
			// most moves land on the planned deadline; the motor floor only bites on the short ones
			expect(onDeadline / moves.length).toBeGreaterThan(0.5);
			// not a constant, not a low-variance cluster: no more than a quarter of the moves share one 100 ms bin
			const bins = new Map<number, number>();
			for (const h of summary.holdNormal.n ? acs.map((a) => a.MoveHoldTime) : []) {
				const bin = Math.floor(h / 100);
				bins.set(bin, (bins.get(bin) ?? 0) + 1);
			}
			expect(Math.max(...bins.values()) / acs.length).toBeLessThan(0.25);
			// The owner's live game: "the mouse minimum move time causes it to almost always move in
			// around 4 seconds". It does not: the hand's own motor span — the approach through the
			// release — is a minority of a normal move. Measured over 420 moves of a simulated 3+0
			// game: floor 354 ms, median 558 ms, q90 729 ms, max 1172 ms, against a mean planned think
			// of 3.9 s. What holds a move at seconds is the think budget, not `MOTOR`/`EXECUTOR`.
			//
			// This block is **characterisation, not a guard on the drag itself**: the span's spread
			// comes from the approach fit and the settle, so a hand whose travel ignored
			// `plan.dragDurationMs` — every piece moved at exactly the same speed — would still pass
			// here. That one is pinned where it is produced: `hand-controller.test.ts`, "the held leg
			// follows the plan's dragDurationMs". The span's upper bound is `maxTouchMs`, already
			// asserted above on the same quantity, and is not repeated.
			const spans = moves.map((m) => {
				const approach = m.result.timeline.find((t) => t.phase === "approach");
				return approach === undefined ? null : m.result.elapsedMs - approach.startMs;
			});
			expect(spans.every((x) => x !== null)).toBe(true);
			for (const span of spans) expect(span ?? 0).toBeGreaterThan(0);
			// not a constant: the spans spread over several 100 ms bins and none of them dominates
			const spanBins = new Map<number, number>();
			for (const span of spans) {
				const bin = Math.floor((span ?? 0) / 100);
				spanBins.set(bin, (spanBins.get(bin) ?? 0) + 1);
			}
			expect(spanBins.size).toBeGreaterThan(3);
			expect(Math.max(...spanBins.values()) / spans.length).toBeLessThan(0.5);
			// and on the moves that have a real think budget the hand is a small part of the move
			const ratios = moves
				.map((m, i) => ({ m, span: spans[i] ?? 0 }))
				.filter(({ m }) => m.plan.mode === "normal" || m.plan.mode === "long")
				.map(({ m, span }) => span / m.plan.thinkMs)
				.sort((a, b) => a - b);
			expect(ratios.length).toBeGreaterThan(TELEMETRY_BANDS.holdTime.cvAfterMoves);
			expect(ratios[Math.floor(ratios.length / 2)] ?? 1).toBeLessThan(0.5);
			// and the summary is what the conformance report prints
			expect(summarizeAc(acs, meta)).toEqual(summary);
		},
		RUN_TIMEOUT_MS
	);
});
