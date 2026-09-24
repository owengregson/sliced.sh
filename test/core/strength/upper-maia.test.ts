import { describe, expect, it } from "bun:test";
import { MAIA } from "@core/constants/maia";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { drawDistribution } from "@core/strength/generate-verify";
import { maiaSurvivors } from "@core/strength/maia-select";
import { selectMove } from "@core/strength/move-selector";
import { pinIdentityCalibration } from "../../fakes/maia-calibration";
import { ctx, line, START } from "./helpers";

// These tests pin mechanics at the advertised rating; the calibration has its own tests.
pinIdentityCalibration();

const policy = (moves: Array<[string, number]>): PolicyResult => ({
	moves,
	wdl: [0.3, 0.4, 0.3],
	size: "79m",
	ms: 180,
});

describe("upper Maia verification", () => {
	it("uses bounded recognition at 2500–2800, then preserves upper verification of a horizon error", () => {
		const survivors = [
			{ uci: "e2e4", p: 0.4, shallowCp: 10, deepCp: 60 },
			{ uci: "d2d4", p: 0.3, shallowCp: 5, deepCp: 40 },
			{ uci: "g1f3", p: 0.3, shallowCp: 300, deepCp: -300 },
		];
		const run = (E: number) =>
			drawDistribution({ survivors, E, shallowDepth: 10 }, 3000, createRng("upper-horizon"));
		expect(run(2500)).toEqual(run(2800));
		// Exact law: the error looks appealing at human depth, but its likelihood ratio cannot
		// exceed 2 - pIntuition = 1.4. The independently tested upper-band algorithm is unchanged.
		const transfer =
			0.4 *
			2 *
			0.3 *
			(0.4 * (1 / (1 + Math.exp((10 - 300) / 80)) - 0.5) +
				0.3 * (1 / (1 + Math.exp((5 - 300) / 80)) - 0.5));
		expect(run(2800).get("g1f3")).toBeCloseTo(0.3 + transfer, 12);
		expect(run(2900).get("g1f3") ?? 0).toBeLessThan(0.3);
		expect(run(2950).get("g1f3") ?? 0).toBeLessThan(0.1);
		expect(run(3000).get("g1f3") ?? 0).toBeLessThan(0.025);
	});

	it("limits uncapped loss in winning positions without changing the lower-range rail", () => {
		const maia = policy([
			["e2e4", 0.1],
			["d2d4", 0.9],
		]);
		const candidates = [
			{ uci: "e2e4", mated: false, hangs: false, lossRaw: 0, cpLoss: 0, extra: false },
			{ uci: "d2d4", mated: false, hangs: false, lossRaw: 0, cpLoss: 500, extra: false },
		];
		expect(maiaSurvivors(candidates, maia, 2800, [])?.survivors).toHaveLength(2);
		expect(maiaSurvivors(candidates, maia, 3000, [])?.survivors.map((c) => c.uci)).toEqual(["e2e4"]);
		const winning = [line(START, "e2e4", { cp: 1800 }, 1), line(START, "d2d4", { cp: 1300 }, 2)];
		for (let seed = 0; seed < 30; seed++) {
			const move = selectMove(
				winning,
				ctx({ targetElo: 3000, maia, engineResultKind: "unrestricted", rng: createRng(seed) })
			);
			expect(move.uci).toBe("e2e4");
			expect(move.source).toBe("maia");
		}
	});

	it("uses bounded referee evidence when an upper comparison frame is missing", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 0 }, 2)];
		const maia = policy([
			["e2e4", 0.3],
			["d2d4", 0.7],
		]);
		let best = 0;
		for (let seed = 0; seed < 100; seed++) {
			const move = selectMove(
				lines,
				ctx({ targetElo: 3000, maia, engineResultKind: "unrestricted", rng: createRng(seed) })
			);
			best += Number(move.uci === "e2e4");
			expect(move.source).toBe("maia");
			expect(move.rationale.join(" ")).toContain("comparison frame unavailable");
			expect(move.maiaMeters?.verifyDepth).toBe(0);
		}
		// The bounded referee score lifts e2e4 far above its 0.3 Maia mass. The effective rating here is
		// 2894 (target 3000 less the ambiguity penalty), inside the 2800–3000 ramp; since the
		// 2026-09-15 recalibration that ramp starts from the calibrated 2800 end, so the measured
		// share is 62 / 100 (610 / 1000) rather than 93 / 100 (942 / 1000) before.
		expect(best).toBeGreaterThan(50);
	});

	it("does not label an unrestricted-referee fallback as native strength limiting", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 0 }, 2)];
		const move = selectMove(
			lines,
			ctx({
				targetElo: 2700,
				selectionMode: "hybrid",
				engineBestmove: "e2e4",
				engineResultKind: "unrestricted",
			})
		);
		expect(move.source).not.toBe("engine-elo");
		expect(move.rationale.join(" ")).toContain("unrestricted referee fallback");
		expect(move.rationale.join(" ")).not.toContain("hybrid: native selection");
		const native = selectMove(
			lines,
			ctx({
				targetElo: 2700,
				selectionMode: "hybrid",
				engineBestmove: "d2d4",
				engineResultKind: "native-limited",
			})
		);
		expect(native.uci).toBe("d2d4");
		expect(native.source).toBe("engine-elo");
	});
});

// Owner, 2026-09-15: one division at the Maia cutoff ("we just go straight from that to big net").
// The former (3000, 3200] band — Maia ranking a narrowing pool of small-network lines ("within 8 cp"
// at 3100, "within 4 cp" at 3200, Maia's d2d4 drawn at 3001) — is removed, so these cases now pin
// its absence: every target above `MAIA.eloMax` plays the strongest guarded engine continuation.
describe("one division at the Maia cutoff: pure engine above it", () => {
	it("plays the strongest guarded continuation just above the cutoff, whatever the native choice", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 45 }, 2)];
		for (const targetElo of [MAIA.eloMax + 1, 3100, 3200]) {
			for (const engineBestmove of ["d2d4", "g1f3"]) {
				const move = selectMove(
					lines,
					ctx({
						targetElo,
						selectionMode: "hybrid",
						engineResultKind: "native-limited",
						engineBestmove,
					})
				);
				expect(move.uci).toBe("e2e4");
				expect(move.source).toBe("engine-elo");
				expect(move.rationale.join(" ")).toContain("full-strength engine");
				expect(move.rationale.join(" ")).not.toContain("within");
			}
		}
	});
	it("does not sample an unrestricted search above the cutoff when no policy answer came", () => {
		const lines = [line(START, "e2e4", { cp: 1800 }, 1), line(START, "d2d4", { cp: 1600 }, 2)];
		for (let seed = 0; seed < 30; seed++) {
			const move = selectMove(
				lines,
				ctx({
					targetElo: MAIA.eloMax + 1,
					selectionMode: "hybrid",
					engineResultKind: "unrestricted",
					engineBestmove: "d2d4",
					rng: createRng(seed),
				})
			);
			expect(move.uci).toBe("e2e4");
			expect(move.source).toBe("engine-elo");
		}
	});
	it("a policy answer on hand draws nothing above the cutoff, while the cutoff itself is Maia's", () => {
		const lines = [line(START, "e2e4", { cp: 1800 }, 1), line(START, "d2d4", { cp: 1790 }, 2)];
		const maia = policy([
			["e2e4", 0.01],
			["d2d4", 0.99],
		]);
		let maiaAtCutoff = 0;
		for (let seed = 0; seed < 100; seed++) {
			const above = selectMove(lines, ctx({ targetElo: MAIA.eloMax + 1, maia, rng: createRng(seed) }));
			expect(above.uci).toBe("e2e4");
			expect(above.source).toBe("engine-elo");
			expect(above.maiaMeters).toBeUndefined();
			maiaAtCutoff += Number(
				selectMove(lines, ctx({ targetElo: MAIA.eloMax, maia, rng: createRng(seed) })).source === "maia"
			);
		}
		expect(maiaAtCutoff).toBeGreaterThan(85);
	});

	it("never re-enters Maia above the cutoff due to form, pressure, stale policy or selection mode", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 20 }, 2)];
		const maia = policy([["d2d4", 1]]);
		for (const selectionMode of ["hybrid", "engine-elo", "persona-sampling"] as const) {
			const move = selectMove(
				lines,
				ctx({
					targetElo: MAIA.eloMax + 1,
					form: -1,
					oppClockMs: 100,
					myClockMs: 1000,
					selectionMode,
					maia,
					engineBestmove: "d2d4",
					blunderScale: 2,
				})
			);
			expect(move.uci).toBe("e2e4");
			expect(move.source).toBe("engine-elo");
			expect(move.maiaMeters).toBeUndefined();
			expect(move.rationale.join(" ")).toContain("full-strength engine");
		}
	});
});
