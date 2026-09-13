// test/core/strength/consistency.test.ts — §8.3 internal-consistency assertions of
// docs/research/human-move-selection-ideas-2026-09-13.md, the ones that cost nothing and run on
// every `bun run check`:
//   - monotonicity: on a fixed pool of real Stockfish 18 blitz frames
//     (test/fixtures/strength/stockfish18-blitz.json, the non-Maia §7.2 policy) the mean raw loss
//     of the seeded draw must be non-increasing in the target Elo across 800 … 2500;
//   - rails: on the Maia fixture (maia-draw.json) the mean `maiaMeters.railedMass` per target band
//     stays under a stated ceiling, whenever the selector reports the meters.
// Neither is a calibration claim; both catch a change that silently reverses the rating axis.
import { describe, expect, it } from "bun:test";
import { phase } from "@core/chess/phase";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { cpEffective } from "@core/strength/elo-map";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { heuristicPrior } from "@core/strength/prior";
import { rankedLines } from "@core/strength/quality";
import type { EvalLine } from "@typedefs/engine";
import maiaFixture from "../../fixtures/strength/maia-draw.json";
import corpus from "../../fixtures/strength/stockfish18-blitz.json";
import { ctx, flatPrior } from "./helpers";

/** 800 … 2500 in steps of 100. */
const TARGETS = Array.from({ length: 18 }, (_, i) => 800 + 100 * i);
const DRAWS_PER_POSITION = 200;
/** Adjacent targets may differ upward by at most this (cp) or 5 %, whichever is larger. */
const LOSS_TOLERANCE_CP = 1.5;

/**
 * Ceiling on the mean Σ p the rails remove per move, by target band. The generator measured
 * 0.03–0.04 under the 2026-09-13 rails on this fixture (see tools/human-match/README.md); the
 * ceiling leaves room for a rating-ramped rail (H1/H16) without letting the wrapper quietly
 * become the chooser.
 */
const RAILED_MASS_CEILING: ReadonlyArray<readonly [target: number, ceiling: number]> = [
	[1000, 0.15],
	[1500, 0.15],
	[2000, 0.15],
	[2400, 0.15],
];

interface Pool {
	name: string;
	fen: string;
	lines: EvalLine[];
	best: string;
	lossCp: Map<string, number>;
}

const pools: Pool[] = corpus.positions
	.filter((p) => p.K === 20)
	.map((p) => {
		const lines = p.lines as unknown as EvalLine[];
		const ranked = rankedLines(lines);
		const top = cpEffective(ranked[0]?.score ?? { cp: 0 });
		const lossCp = new Map<string, number>();
		for (const line of ranked) lossCp.set(line.pvUci[0] ?? "", top - cpEffective(line.score));
		return { name: p.name, fen: p.fen, lines, best: p.best.split(" ")[1] ?? "", lossCp };
	});

/** Mean raw cp loss of the §7.2 draw at `targetElo` over every pool, one seed per pool. */
function meanLoss(targetElo: number): number {
	let total = 0;
	let count = 0;
	for (const pool of pools) {
		const context = ctx({
			fen: pool.fen,
			phase: phase(pool.fen) ?? "middlegame",
			ply: 20,
			targetElo,
			selectionMode: "persona-sampling",
			engineBestmove: pool.best,
			myClockMs: 90_000,
			oppClockMs: 90_000,
			baseMs: 180_000,
			incrementMs: 0,
			rng: createRng(`consistency:${pool.name}`),
			state: createSelectionState(),
		});
		const prior = heuristicPrior(pool.fen, pool.lines, context);
		for (let i = 0; i < DRAWS_PER_POSITION; i++) {
			const chosen = selectMove(pool.lines, context, prior);
			const loss = pool.lossCp.get(chosen.uci);
			if (loss === undefined) continue;
			total += loss;
			count++;
		}
	}
	if (count === 0) throw new Error("the blitz pool produced no scored draws");
	return total / count;
}

describe("§8.3 monotonicity on the Stockfish 18 blitz pool", () => {
	const curve = TARGETS.map((target) => ({ target, loss: meanLoss(target) }));
	const table = curve.map((c) => `${c.target}: ${c.loss.toFixed(2)}`).join("  ");
	console.log(`consistency: mean raw loss (cp) by target — ${table}`);

	it("uses the four 20-root frames", () => {
		expect(pools.map((p) => p.name)).toEqual(["start", "ruy", "italian", "kiwipete"]);
	});

	it("mean raw loss is non-increasing in target Elo from 800 to 2500 (small tolerance)", () => {
		for (let i = 1; i < curve.length; i++) {
			const prev = curve[i - 1]!;
			const cur = curve[i]!;
			const tolerance = Math.max(LOSS_TOLERANCE_CP, 0.05 * prev.loss);
			expect(cur.loss, `rose ${prev.target} → ${cur.target}: ${table}`).toBeLessThanOrEqual(
				prev.loss + tolerance
			);
		}
	});

	it("the endpoints are strictly ordered: 800 loses clearly more than 2500", () => {
		const first = curve[0]!;
		const last = curve[curve.length - 1]!;
		expect(first.loss).toBeGreaterThan(last.loss * 1.5);
	});
});

describe("§8.3 rails: railedMass per band on the Maia fixture", () => {
	// The fixture's key: the real 5M distributions it was written with (2026-09-13: the package
	// ships the 79M model only, and `PolicyResult.size` is the shipped type — the size is a label
	// to the selector, the distribution is what is replayed; see tools/human-match/README.md).
	const FIXTURE_KEY = "5m" as const;
	const positions = maiaFixture.positions.map((p) => ({
		index: p.index,
		fen: p.fen,
		ply: p.ply,
		lines: p.lines as unknown as EvalLine[],
		policy: {
			moves: p.policy[FIXTURE_KEY].moves as Array<[string, number]>,
			wdl: p.policy[FIXTURE_KEY].wdl as [number, number, number],
			size: "79m",
		} satisfies PolicyResult,
	}));

	// `railedMass` is Σ p over what the rails excluded — a function of the position and the target,
	// not of the draw — so two draws per position see it (the second covers a fallback path).
	const DRAWS_PER_POSITION = 2;
	for (const [target, ceiling] of RAILED_MASS_CEILING) {
		it(`target ${target}: mean railedMass ≤ ${ceiling} when the selector reports meters`, () => {
			let sum = 0;
			let seen = 0;
			let draws = 0;
			for (const p of positions) {
				const rng = createRng(`railed:${p.index}`);
				const prior = flatPrior(p.lines);
				for (let i = 0; i < DRAWS_PER_POSITION; i++) {
					const m = selectMove(
						p.lines,
						ctx({
							fen: p.fen,
							ply: p.ply,
							phase: phase(p.fen, p.ply) ?? "middlegame",
							targetElo: target,
							maia: p.policy,
							rng,
							state: createSelectionState(),
						}),
						prior
					);
					draws++;
					if (m.maiaMeters === undefined) continue;
					seen++;
					sum += m.maiaMeters.railedMass;
				}
			}
			expect(draws).toBe(positions.length * DRAWS_PER_POSITION);
			if (seen === 0) {
				// The selector does not report meters yet (src/types/game.ts seeds the field): nothing
				// to bound. The assertion arms itself the moment they appear.
				console.log(`railedMass @${target}: no maiaMeters reported; ceiling not exercised`);
				return;
			}
			expect(sum / seen).toBeLessThanOrEqual(ceiling);
		});
	}
});
