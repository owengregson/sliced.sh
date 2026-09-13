import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng, type Rng } from "@core/rng";
import { computeFeatures } from "@core/timing/features";
import { createMoveBudget } from "@core/timing/move-budget";
import { samplePersona } from "@core/timing/persona-latents";
import { TimingModel } from "@core/timing/timing-model";
import type {
	DistributionHead,
	Features,
	GameTimingState,
	HeadSample,
	Persona,
} from "@core/timing/types";
import { ctx, median } from "./helpers";

class ClockBlindHead implements DistributionHead {
	readonly id = "chessmimic" as const;
	median() {
		return 6;
	}
	mean() {
		return 6 * Math.exp((0.9 * 0.9) / 2);
	}
	sample(_f: Features, _p: Persona, _s: GameTimingState, rng: Rng): HeadSample {
		return { tSec: 6 * Math.exp(0.9 * rng.normal()), mode: "normal", why: [] };
	}
}

function plans(clockS: number, baseSec: number, incSec = 0) {
	return Array.from({ length: 160 }, (_, i) => {
		const gameId = `clock-${i}`;
		const model = new TimingModel(new ClockBlindHead(), DEFAULT_SETTINGS.timing, createRng(gameId));
		model.startGame({
			gameId,
			targetElo: 2400,
			profile: "balanced",
			baseSec,
			incSec,
			site: "chesscom",
		});
		return model.planMove(
			ctx({
				targetElo: 2400,
				baseSec,
				incSec,
				myClockMs: clockS * 1000,
				oppClockMs: Math.max(60, clockS) * 1000,
			})
		);
	});
}

describe("one own-clock budget", () => {
	it("progressively reduces ordinary deliberation before the last seconds, across time controls", () => {
		for (const base of [60, 180, 300, 600, 1800]) {
			const full = median(plans(base, base).map((p) => p.thinkMs));
			const low = median(plans(20, base).map((p) => p.thinkMs));
			const emergency = median(plans(4, base).map((p) => p.thinkMs));
			expect(low).toBeLessThan(full);
			expect(emergency).toBeLessThan(low);
			expect(emergency).toBeLessThan(350);
		}
	}, 30000);
	it("keeps genuine increment time available instead of multiplying several low-clock penalties", () => {
		for (const targetElo of [400, 1200, 2000, 2800, 3800]) {
			const p = samplePersona("increment", "balanced", targetElo);
			const f = computeFeatures(ctx({ targetElo, myClockMs: 20000, incSec: 0 }));
			expect(createMoveBudget({ ...f, inc_s: 5 }, p).targetSec).toBeGreaterThan(
				createMoveBudget(f, p).targetSec * 2
			);
		}
	});
	it("retains a varied physical move and a single logged budget at 30 and 20 seconds", () => {
		for (const clock of [30, 20]) {
			const measured = plans(clock, 180);
			expect(new Set(measured.map((p) => Math.round(p.thinkMs))).size).toBeGreaterThan(120);
			for (const p of measured) {
				expect(p.thinkMs).toBeGreaterThanOrEqual(p.orientationMs + p.window.approachMs - 0.001);
				expect(p.features.budgetTargetSec).toBeGreaterThan(0);
				expect(p.thinkMs).toBeLessThanOrEqual((p.features.capSec ?? 0) * 1000 + 0.001);
				expect(p.rationale.some((r) => r.startsWith("low clock:") || r.startsWith("evening:"))).toBe(
					false
				);
			}
		}
	});
});
