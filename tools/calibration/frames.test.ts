// tools/calibration/frames.test.ts — three rows end to end through the real referee (vendored
// Stockfish 19 smallnet under Bun): the record schema, the pool's order, the human-depth captures
// and the humanLine rule. Skips when the engine cannot boot in this runtime.
import { afterAll, describe, expect, it } from "bun:test";
import { compareLines } from "@core/strength/quality";
import type { RefereeEngine } from "../lib/engine/types";
import {
	CAPTURE_DEPTHS,
	type CalibrationRow,
	computeFrame,
	createFrameEngine,
	type FrameCacheRecord,
	gridExtraSearchmoves,
} from "./frames";
import { synthesise } from "./synth-corpus";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let engine: RefereeEngine | undefined;
let skipReason: string | undefined;
try {
	engine = await createFrameEngine();
} catch (err) {
	skipReason = err instanceof Error ? err.message : String(err);
}
afterAll(() => engine?.dispose());

function sortedBy(lines: FrameCacheRecord["lines"]): boolean {
	for (let i = 1; i < lines.length; i++) {
		const a = lines[i - 1];
		const b = lines[i];
		if (a && b && compareLines(a, b) > 0) return false;
	}
	return true;
}

describe.skipIf(engine === undefined)(
	`tools/calibration/frames.ts${skipReason ? ` (${skipReason})` : ""}`,
	() => {
		it("writes well-formed records for three rows", async () => {
			const { rows, policies } = await synthesise(["bullet"], 2);
			const cases: Array<{ row: CalibrationRow; grid: (typeof policies)[number]["policies"] }> =
				rows.map((row, i) => ({ row, grid: policies[i]?.policies ?? [] }));
			// Six roots at 3000, and a move no referee ranks among them: the humanLine path.
			cases.push({
				row: {
					id: "start:g2g4",
					ply: 0,
					fen: START,
					historyFens: [START],
					selfElo: 3000,
					oppoElo: 3000,
					humanMove: "g2g4",
					clockMs: 30_000,
					tc: "bullet",
					bucket: 3000,
				},
				grid: [],
			});
			let sawHumanLine = false;
			for (const { row, grid } of cases) {
				const id = row.id ?? "";
				const rec = await computeFrame(engine as RefereeEngine, row, id, grid);
				expect(rec.id).toBe(id);
				expect(rec.lines.length).toBeGreaterThan(0);
				expect(rec.complete).toBe(true);
				expect(rec.depth).toBeGreaterThan(0);
				const roots = rec.lines.map((l) => l.pvUci[0]);
				expect(new Set(roots).size).toBe(roots.length);
				for (const [i, line] of rec.lines.entries()) {
					expect(line.multipv).toBe(i + 1);
					expect(line.pvSan.length).toBe(line.pvUci.length);
				}
				// mergeLines order: the main frame sorted, then the extra roots sorted among themselves.
				const mainCount = rec.lines.length - rec.extra.length;
				expect(rec.lines.slice(mainCount).map((l) => l.pvUci[0])).toEqual(rec.extra);
				expect(sortedBy(rec.lines.slice(0, mainCount))).toBe(true);
				expect(sortedBy(rec.lines.slice(mainCount))).toBe(true);
				// Grid extras are exactly what the main frame left unscored.
				if (grid.length === 0) expect(rec.extra).toEqual([]);
				else
					expect(
						rec.extra.every((u) =>
							gridExtraSearchmoves(grid, rec.lines.slice(0, mainCount), row.fen).includes(u)
						)
					).toBe(true);
				// Human-depth captures: keys from the range, both keys and their depths non-decreasing.
				const keys = Object.keys(rec.byDepth).map(Number);
				expect(keys.length).toBeGreaterThan(0);
				expect(keys).toEqual([...keys].sort((a, b) => a - b));
				expect(keys.every((k) => CAPTURE_DEPTHS.includes(k))).toBe(true);
				expect(keys[0]).toBe(CAPTURE_DEPTHS[0]);
				const at = keys.map((k) => rec.byDepthAt[k] ?? -1);
				for (const [i, k] of keys.entries()) expect(at[i]).toBeGreaterThanOrEqual(k);
				expect(at).toEqual([...at].sort((a, b) => a - b));
				for (const k of keys) {
					const cycle = rec.byDepth[k] ?? [];
					expect(cycle.length).toBe(mainCount);
					expect(new Set(cycle.map((r) => r.uci)).size).toBe(cycle.length);
				}
				// humanLine exactly when the pool lacks the (legal) human move.
				const inPool = roots.includes(row.humanMove);
				expect(rec.humanLine !== undefined).toBe(!inPool);
				if (rec.humanLine) {
					sawHumanLine = true;
					expect(rec.humanLine.pvUci[0]).toBe(row.humanMove);
				}
				expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
			}
			expect(sawHumanLine).toBe(true);
		}, 30_000);
	}
);
