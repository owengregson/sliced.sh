import { describe, expect, it } from "bun:test";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { drawDistribution } from "@core/strength/generate-verify";
import { maiaSurvivors } from "@core/strength/maia-select";
import { selectMove } from "@core/strength/move-selector";
import { ctx, line, START } from "./helpers";

const policy = (moves: Array<[string, number]>): PolicyResult => ({
	moves,
	wdl: [0.3, 0.4, 0.3],
	size: "79m",
	ms: 180,
});

describe("upper Maia verification", () => {
	it("preserves the established 2500–2800 draw, then resolves a shallow horizon error", () => {
		const survivors = [
			{ uci: "e2e4", p: 0.4, shallowCp: 10, deepCp: 60 },
			{ uci: "d2d4", p: 0.3, shallowCp: 5, deepCp: 40 },
			{ uci: "g1f3", p: 0.3, shallowCp: 300, deepCp: -300 },
		];
		const run = (E: number) =>
			drawDistribution({ survivors, E, shallowDepth: 10 }, 3000, createRng("upper-horizon"));
		expect(run(2500)).toEqual(run(2800));
		expect(run(2800).get("g1f3")).toBeGreaterThan(0.85);
		expect(run(2900).get("g1f3") ?? 0).toBeLessThan(0.1);
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
		expect(best).toBeGreaterThan(75);
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

describe("upper prior and pure-engine boundary", () => {
	it("keeps a missing-policy native3100 answer inside the scored quality bound", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: -55 }, 2)];
		for (const engineBestmove of ["d2d4", "g1f3"]) {
			const move = selectMove(
				lines,
				ctx({
					targetElo: 3100,
					selectionMode: "hybrid",
					engineResultKind: "native-limited",
					engineBestmove,
				})
			);
			expect(move.uci).toBe("e2e4");
			expect(move.source).toBe("engine-elo");
			expect(move.rationale.join(" ")).toContain("within 8 cp");
		}
		const close = [lines[0]!, line(START, "d2d4", { cp: 45 }, 2)];
		expect(
			selectMove(
				close,
				ctx({
					targetElo: 3100,
					selectionMode: "hybrid",
					engineResultKind: "native-limited",
					engineBestmove: "d2d4",
				})
			).uci
		).toBe("d2d4");
	});
	it("retains the upper prior's quality bound when Maia fails on an unrestricted3200 search", () => {
		const lines = [line(START, "e2e4", { cp: 1800 }, 1), line(START, "d2d4", { cp: 1600 }, 2)];
		for (let seed = 0; seed < 30; seed++) {
			const move = selectMove(
				lines,
				ctx({
					targetElo: 3200,
					selectionMode: "hybrid",
					engineResultKind: "unrestricted",
					engineBestmove: "d2d4",
					rng: createRng(seed),
				})
			);
			expect(move.uci).toBe("e2e4");
			expect(move.source).toBe("sampled");
			expect(move.rationale.join(" ")).toContain("within 4 cp");
		}
	});
	it("narrows actual score alternatives toward3200 even when both evaluations exceed1000", () => {
		const lines = [line(START, "e2e4", { cp: 1800 }, 1), line(START, "d2d4", { cp: 1790 }, 2)];
		const maia = policy([
			["e2e4", 0.01],
			["d2d4", 0.99],
		]);
		let nearBoundaryAlternative = 0;
		for (let seed = 0; seed < 100; seed++) {
			nearBoundaryAlternative += Number(
				selectMove(lines, ctx({ targetElo: 3001, maia, rng: createRng(seed) })).uci === "d2d4"
			);
			expect(selectMove(lines, ctx({ targetElo: 3200, maia, rng: createRng(seed) })).uci).toBe("e2e4");
		}
		expect(nearBoundaryAlternative).toBeGreaterThan(85);
	});

	it("never re-enters Maia above3200 due to form, pressure, stale policy or selection mode", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: 20 }, 2)];
		const maia = policy([["d2d4", 1]]);
		for (const selectionMode of ["hybrid", "engine-elo", "persona-sampling"] as const) {
			const move = selectMove(
				lines,
				ctx({
					targetElo: 3201,
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
