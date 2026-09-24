/**
 * tools/human-match/make-fixture.ts — writes `test/fixtures/strength/maia-draw.json`, the Maia
 * fixed-pool replay fixture (§8.2 of `docs/research/human-move-selection-ideas-2026-09-13.md`).
 *
 * For every position of the 60-position parity set (`test/fixtures/maia3/positions.json`):
 *   - the full legal-move distribution of every shipped model (`--sizes`; the 79M model alone
 *     since 2026-09-13 — the checked-in fixture predates that and holds the 5M and 23M answers) at
 *     the position's own
 *     `selfElo` / `oppoElo`, decoded by the real `encodeMaiaInputs` → `decodeMaiaOutputs` under the
 *     vendored onnxruntime-web (the parity test proves this path reproduces torch fp32), so the
 *     fixture is bit-faithful to what the offscreen host answers;
 *   - one real Stockfish 19 smallnet MultiPV frame at full strength (the referee) over exactly the
 *     union of each size's top-`--top` moves via `go searchmoves`, `movetime 600 depth 18`, one
 *     thread, 32 MB hash — the last complete cycle, as the other `stockfish18-*.json` fixtures.
 *
 * The engine scores are real but a fixed sample, not a calibration; the fixture exists so the whole
 * Maia draw (rails, temperature/offset, meters) is testable with no engine and no model.
 *
 *     bun tools/human-match/make-fixture.ts [--out FILE] [--movetime 600] [--depth 18]
 *                                           [--sizes 79m] [--top 8] [--limit N]
 *
 * Takes ≈ 1 min (the engine dominates). Never run inside `bun run check`. The stages live in
 * `make-fixture/`: arguments, the Maia policies, the engine frames and the railed-mass printout.
 */

import "./defines";
import path from "node:path";
import { MAIA } from "@core/constants/maia";
import { ROOT } from "../lib/paths";
import { parseFixtureArgs } from "./make-fixture/args";
import { searchFrames } from "./make-fixture/frames";
import { type ParityPosition, positionsWithPolicies } from "./make-fixture/policies";
import { railedMassAt } from "./make-fixture/railed-mass";
import type { MaiaDrawFixture } from "./make-fixture/types";

export type {
	FixturePolicy,
	FixturePosition,
	MaiaDrawFixture,
} from "./make-fixture/types";

async function main(): Promise<void> {
	const args = parseFixtureArgs(process.argv.slice(2));
	const parity = (await Bun.file(path.join(ROOT, "test/fixtures/maia3/positions.json")).json()) as {
		positions: ParityPosition[];
	};
	const source = args.limit > 0 ? parity.positions.slice(0, args.limit) : parity.positions;

	console.log(`maia: loading ${args.sizes.join(", ")} …`);
	const positions = await positionsWithPolicies(source, args.sizes);
	await searchFrames(positions, args.sizes, args);

	const fixture: MaiaDrawFixture = {
		provenance: {
			source: "test/fixtures/maia3/positions.json (the 60-position parity set, seed 34)",
			generator: "tools/human-match/make-fixture.ts",
			engine: "vendored Stockfish 19 smallnet, full strength (referee), one thread, 32 MB hash",
			models: args.sizes.map((s) => `maia3-${s}.onnx via onnxruntime-web wasm, one thread`),
			command: `go movetime ${args.movetime} depth ${args.depth} searchmoves <union of each size's top-${args.top}>`,
			threads: 1,
			hashMb: 32,
			collection:
				"Last complete MultiPV cycle per position before the bestmove; `pvSan` filled from the position. Fixed examples; not a rating calibration.",
			capturedOn: new Date().toISOString().slice(0, 10),
			note:
				"policy.<size>.moves are the decoded board-frame legal-move distributions at the position's own selfElo/oppoElo (full precision, summing to 1); lines cover only the searchmoves roots.",
		},
		positions,
	};
	await Bun.write(args.out, `${JSON.stringify(fixture)}\n`);
	console.log(`wrote ${args.out} (${positions.length} positions)`);

	const targets = [1000, 1500, 2000, 2400];
	for (const size of args.sizes) {
		const row = targets.map((E) => {
			let sum = 0;
			for (const p of positions) sum += railedMassAt(p, size, E);
			return `${E}: ${(sum / positions.length).toFixed(3)}`;
		});
		console.log(
			`railed mass under the current rails (${size}, mean over positions) — ${row.join("  ")}`
		);
	}
	console.log(`lossCap knots: ${MAIA.lossCap.map(([e, c]) => `${e}→${c}`).join(", ")}`);
}

if (import.meta.main) await main();
