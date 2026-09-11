import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { TIMING_CONSTANTS as C } from "@core/timing/constants";
import { TimingModel } from "@core/timing/timing-model";
import type { DistributionHead, TimingMode } from "@core/timing/types";
import { ctx } from "./helpers";

describe("move-window budgets", () => {
	for (const mode of ["normal", "long"] as const) {
		it(`bounds a clock-blind ${mode} head without making the cap a repeated delay`, () => {
			const head: DistributionHead = {
				id: "chessmimic",
				median: () => 90,
				sample: () => ({ tSec: 90, mode: mode as TimingMode, why: [] }),
			};
			const model = new TimingModel(
				head,
				{ ...DEFAULT_SETTINGS.timing, speedScale: 2 },
				createRng(mode)
			);
			model.startGame({
				gameId: mode,
				site: "chesscom",
				baseSec: 180,
				incSec: 0,
				targetElo: 1650,
				profile: "balanced",
			});
			for (const clock of [60_000, 20_000, 5_000]) {
				const durations = new Set<number>();
				for (let i = 0; i < 100; i++) {
					const plan = model.planMove(ctx({ myClockMs: clock }));
					expect(plan.thinkMs).toBeLessThanOrEqual(clock * C.budget.windowClockFraction);
					expect(plan.thinkMs).toBeLessThanOrEqual((plan.features.capSec ?? 0) * 1000);
					durations.add(Math.round(plan.thinkMs));
				}
				// Even a head with a single oversized output must keep a spread of durations.
				expect(durations.size).toBeGreaterThan(50);
			}
		});
	}
});
