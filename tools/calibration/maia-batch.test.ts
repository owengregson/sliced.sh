// tools/calibration/maia-batch.test.ts — the native batch path against the torch fp32 reference
// (`test/fixtures/maia3/expected-79m.json`) on a handful of fixture positions, CPU EP only, plus
// the stored-form rounding. Skips when the calibration venv or the model parts are absent; the
// full wasm parity proof is `bun tools/calibration/maia-parity.ts`.
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { MAIA_DIR, MAIA_FILES, MAIA_MODEL_FILES } from "@core/constants/maia";
import { maiaIndexToUci, maiaMoveIndex } from "@core/policy/maia-encoder";
import { compactResult, DEFAULT_PYTHON, maiaGrid } from "./maia-batch";

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURES = path.join(ROOT, "test/fixtures/maia3");
const POSITIONS = 8;
/** fp16-weight export versus torch fp32, as `test/integration/maia-onnx.test.ts`. */
const PROB_TOLERANCE = 2e-3;

const modelPresent = existsSync(
	path.join(ROOT, MAIA_DIR, `${MAIA_MODEL_FILES["79m"].file}${MAIA_FILES.partSuffix}0`)
);
const skip = !existsSync(DEFAULT_PYTHON) || !modelPresent;

interface FixturePosition {
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
}

describe("tools/calibration/maia-batch.ts", () => {
	it.skipIf(skip)(
		"reproduces the torch reference top moves at each fixture position's own Elo",
		async () => {
			const { positions } = (await Bun.file(path.join(FIXTURES, "positions.json")).json()) as {
				positions: FixturePosition[];
			};
			const expected = (await Bun.file(path.join(FIXTURES, "expected-79m.json")).json()) as {
				positions: Array<{ top: Array<[string, number]> }>;
			};
			const picked = positions.slice(0, POSITIONS);
			const results = await maiaGrid(
				picked.map((p, i) => ({
					id: String(i),
					historyFens: p.historyFens,
					oppoElo: p.oppoElo,
					selfElos: [p.selfElo],
				})),
				{ workers: 1, threads: 2, coremlWorkers: 0, batch: 4 }
			);
			for (const [i, p] of picked.entries()) {
				const mirrored = p.fen.split(" ")[1] === "b";
				const policy = results[i]?.policies[0];
				expect(policy?.selfElo).toBe(p.selfElo);
				const got = new Map(policy?.moves);
				const top = expected.positions[i]?.top ?? [];
				expect(top.length).toBeGreaterThan(0);
				for (const [mirroredUci, prob] of top) {
					const uci = maiaIndexToUci(maiaMoveIndex(mirroredUci, false), mirrored);
					expect(Math.abs((got.get(uci) ?? -1) - prob)).toBeLessThan(PROB_TOLERANCE);
				}
				const board = maiaIndexToUci(maiaMoveIndex(top[0]?.[0] ?? "", false), mirrored);
				expect(policy?.moves[0]?.[0]).toBe(board);
			}
		},
		60_000
	);

	it("stores 6 significant digits and drops moves under 1e-5", () => {
		const out = compactResult({
			id: "x",
			policies: [
				{
					selfElo: 1500,
					moves: [
						["e2e4", 0.123456789],
						["d2d4", 0.0000099],
					],
					wdl: [0.1234567, 0.2, 0.6765433],
				},
			],
		});
		expect(out.policies[0]?.moves).toEqual([["e2e4", 0.123457]]);
		expect(out.policies[0]?.wdl).toEqual([0.123457, 0.2, 0.676543]);
	});
});
