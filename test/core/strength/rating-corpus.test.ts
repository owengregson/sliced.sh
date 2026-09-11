import { describe, expect, it } from "bun:test";
import { phase } from "@core/chess/phase";
import { createRng } from "@core/rng";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { heuristicPrior } from "@core/strength/prior";
import type { EvalLine } from "@typedefs/engine";
import corpus from "../../fixtures/strength/stockfish18-blitz.json";
import { ctx } from "./helpers";

/** Fixed native-engine candidates exercise the policy, not a claimed Elo calibration. */
function measuredLoss(targetElo: number, truncate = false): number {
	let total = 0;
	let count = 0;
	for (const position of corpus.positions.filter((p) => p.K === 20)) {
		const lines: EvalLine[] = truncate ? position.lines.slice(0, 6) : position.lines;
		const context = ctx({
			fen: position.fen,
			phase: phase(position.fen) ?? "middlegame",
			ply: 20,
			targetElo,
			selectionMode: "hybrid",
			engineBestmove: position.best.split(" ")[1] ?? "",
			myClockMs: 90000,
			oppClockMs: 90000,
			baseMs: 180000,
			incrementMs: 0,
			rng: createRng(`corpus:${position.name}`),
			state: createSelectionState(),
		});
		const prior = heuristicPrior(position.fen, lines, context);
		for (let sample = 0; sample < 250; sample++) {
			const chosen = selectMove(lines, context, prior);
			if (chosen.cpLoss === undefined) continue;
			total += chosen.cpLoss;
			count++;
		}
	}
	if (!count) throw new Error("Native corpus supplied no comparable move scores");
	return total / count;
}

describe("selection with native Stockfish blitz candidates", () => {
	it("retains rating sensitivity on a fixed broader native candidate population", () => {
		const weak = measuredLoss(1200);
		const club = measuredLoss(1650);
		const strong = measuredLoss(2400);
		expect(weak).toBeGreaterThan(club);
		expect(club).toBeGreaterThan(strong);
	});

	it("exposes the lost error diversity when the same search is truncated to its top six", () => {
		const full = measuredLoss(1650);
		const narrow = measuredLoss(1650, true);
		expect(full).toBeGreaterThan(narrow);
		for (const position of corpus.positions.filter((p) => p.K === 6 && p.name !== "kiwipete")) {
			const scores = position.lines.map((line) => line.score.cp);
			// A sampler cannot produce the displayed 45–60 loss band from a pool this narrow.
			expect(Math.max(...scores) - Math.min(...scores)).toBeLessThan(45);
		}
	});
});
