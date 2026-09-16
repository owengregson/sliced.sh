import { describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { MAIA } from "@core/constants/maia";
import { createRng } from "@core/rng";
import { SELECTION_CONSTANTS } from "@core/strength/constants";
import { selectMove } from "@core/strength/move-selector";
import { usesNativeSelection } from "@core/strength/selection-mode";
import type { EvalLine } from "@typedefs/engine";
import tactical from "../../fixtures/strength/stockfish18-high-elo.json";
import { ctx, flatPrior, line, START } from "./helpers";

const lines: EvalLine[] = tactical.lines.map((line) => ({
	...line,
	wdl: [line.wdl[0]!, line.wdl[1]!, line.wdl[2]!],
}));
const high = {
	targetElo: 2800,
	selectionMode: "hybrid" as const,
	myClockMs: 90000,
	oppClockMs: 90000,
	baseMs: 180000,
	incrementMs: 0,
};

describe("high-rating Hybrid native selection", () => {
	it("retains the captured UCI_Elo2800 second choice excluded by both old sampling channels", () => {
		expect(tactical.provenance.nativeElo).toBe(2800);
		expect(tactical.bestmove).toBe("d5e6");
		expect(lines.map((line) => line.score.cp)).toEqual([-93, -198, -288, -324, -342, -356]);
		for (let seed = 0; seed < 12; seed++) {
			const chosen = selectMove(
				lines,
				ctx({ ...high, fen: tactical.fen, engineBestmove: tactical.bestmove, rng: createRng(seed) }),
				flatPrior(lines)
			);
			expect(chosen.uci).toBe(tactical.bestmove);
			expect(chosen.source).toBe("engine-elo");
			expect(chosen.rankInLines).toBe(2);
			expect(chosen.cpLoss).toBe(105);
			expect(chosen.quality?.eligible).toBe(true);
			expect(chosen.rationale.join(" ")).toContain("UCI_Elo 2800");
		}
	});

	it("uses the existing saturation boundary, with Persona and lower Hybrid still sampling", () => {
		const pivot = SELECTION_CONSTANTS.tau.pivotElo;
		expect(usesNativeSelection("hybrid", pivot - 1)).toBe(false);
		expect(usesNativeSelection("hybrid", pivot)).toBe(true);
		for (const [selectionMode, targetElo, expectedSource] of [
			["hybrid", pivot - 1, "sampled"],
			["hybrid", pivot, "engine-elo"],
			["persona-sampling", 2800, "sampled"],
		] as const) {
			const chosen = selectMove(
				lines,
				ctx({
					...high,
					fen: tactical.fen,
					selectionMode,
					targetElo,
					engineBestmove: tactical.bestmove,
					blunderScale: 0,
					rng: { ...createRng("plateau"), normal: () => 0 },
				}),
				flatPrior(lines)
			);
			expect(chosen.source).toBe(expectedSource);
			expect(chosen.uci).toBe(expectedSource === "engine-elo" ? "d5e6" : "e2a6");
		}
	});

	it("keeps pressure-induced skill relaxation instead of forcing the native branch", () => {
		const chosen = selectMove(
			lines,
			ctx({
				...high,
				fen: tactical.fen,
				engineBestmove: tactical.bestmove,
				oppClockMs: 1000,
				blunderScale: 0,
			})
		);
		expect(chosen.source).toBe("sampled");
		expect(chosen.rationale.join(" ")).toContain("opponent clock pressure: accuracy −");
	});

	// Owner, 2026-09-15: guarded engine scores start above the Maia cutoff (they started above 3200);
	// 3100 pins the moved boundary.
	it("reports native requests independently of form and uses guarded engine scores above the Maia cutoff", () => {
		const pool = [line(START, "e2e4", { cp: 20 }, 1), line(START, "d2d4", { cp: 0 }, 2)];
		for (const [targetElo, form, request] of [
			[2499, 1, "2499"],
			[3100, 0, "3100"],
			[3300, 0, "unlimited"],
		] as const) {
			const chosen = selectMove(pool, ctx({ ...high, targetElo, form, engineBestmove: "d2d4" }));
			expect(chosen.uci).toBe(targetElo > MAIA.eloMax ? "e2e4" : "d2d4");
			expect(chosen.rationale.join(" ")).toContain(
				targetElo > MAIA.eloMax ? "full-strength engine" : `UCI_Elo ${request}`
			);
		}
	});

	it("falls back safely for missing or invalid native choices, and leaves unscored loss unknown", () => {
		const pool = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: -20 }, 2)];
		for (const engineBestmove of [undefined, "0000", "e2e5", "a9a8"]) {
			const chosen = selectMove(pool, ctx({ ...high, ...(engineBestmove ? { engineBestmove } : {}) }));
			expect(chosen.uci).toBe("e2e4");
			expect(chosen.source).toBe("engine-elo");
		}
		const unscored = selectMove(pool, ctx({ ...high, engineBestmove: "a2a3" }));
		expect(unscored.uci).toBe("a2a3");
		expect(unscored.rankInLines).toBe(0);
		expect(unscored.cpLoss).toBeUndefined();
		expect(unscored.quality?.eligible).toBe(false);
	});

	it("does not accept a scored forced loss when a non-mated continuation exists", () => {
		const pool = [line(START, "e2e4", { cp: -200 }, 1), line(START, "d2d4", { mate: -5 }, 2)];
		const chosen = selectMove(pool, ctx({ ...high, engineBestmove: "d2d4" }));
		expect(chosen.uci).toBe("e2e4");
	});

	it("preserves immediate and shortest searched mates ahead of the native choice", () => {
		const fen = "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1";
		const immediate = selectMove(
			[line(fen, "g6g7", { cp: 1500 }, 2), line(fen, "g6g5", { cp: 1600 }, 1)],
			ctx({ ...high, fen, engineBestmove: "g6g5" })
		);
		expect(immediate.uci).toBe("g6g7");
		expect(immediate.source).toBe("mate");
		const searched = selectMove(
			[line(START, "e2e4", { mate: 3 }, 1), line(START, "d2d4", { mate: 5 }, 2)],
			ctx({ ...high, engineBestmove: "d2d4" })
		);
		expect(searched.uci).toBe("e2e4");
		expect(searched.source).toBe("mate");
	});

	it("never reintroduces a stalemate or repetition removed by the winning-position guards", () => {
		const fen = "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1";
		const safe = line(fen, "g6g5", { cp: 1500 }, 2);
		for (const pool of [[safe], [line(fen, "f7e6", { cp: 1600 }, 1), safe]]) {
			expect(selectMove(pool, ctx({ ...high, fen, engineBestmove: "f7e6" })).uci).toBe("g6g5");
		}
		const history = {
			fen: "6k1/8/8/8/8/8/PPPP4/6K1 b - - 0 1",
			moves: ["g8h8", "g1h1", "h8g8", "h1g1", "g8h8", "g1h1", "h8g8"],
		};
		const repeatedFen = applyMoves(history.fen, history.moves)!;
		const progress = line(repeatedFen, "a2a3", { cp: 775 }, 2);
		for (const pool of [[progress], [line(repeatedFen, "h1g1", { cp: 800 }, 1), progress]]) {
			expect(
				selectMove(pool, ctx({ ...high, fen: repeatedFen, history, engineBestmove: "h1g1" })).uci
			).toBe("a2a3");
		}
	});
});
