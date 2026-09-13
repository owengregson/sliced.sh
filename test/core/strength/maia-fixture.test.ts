// test/core/strength/maia-fixture.test.ts — the Maia fixed-pool replay (§8.2–§8.3 of
// docs/research/human-move-selection-ideas-2026-09-13.md): the 60-position parity set with the
// shipped 5M model's real legal-move distributions and one real Stockfish 18 referee frame each
// (test/fixtures/strength/maia-draw.json, written by tools/human-match/make-fixture.ts), replayed
// through the current `selectMove` at four targets with seeded draws. The assertions are
// internal-consistency properties that must survive any selector change; none is a calibration.
import { describe, expect, it } from "bun:test";
import { type Phase, phase } from "@core/chess/phase";
import { MAIA } from "@core/constants/maia";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { conversionPool } from "@core/strength/conversion";
import { cpEffective } from "@core/strength/elo-map";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { rankedLines } from "@core/strength/quality";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import fixture from "../../fixtures/strength/maia-draw.json";
import { ctx, flatPrior } from "./helpers";

const TARGETS = [1000, 1500, 2000, 2400] as const;
/**
 * Seeded draws per position and target, by cost class. `conversionPool` replays up to 12 PV plies
 * of every candidate through chess.js on *each* `selectMove` call, so a won position costs
 * ≈ 2.7 ms a draw against ≈ 0.2 ms elsewhere (measured 2026-09-13: 27 of the 60 positions are
 * conversion-active). The class is a deterministic function of the fixture, so the allocation is
 * stable; these counts keep the four replays near 6 s in total. Raise them if that guard gets a
 * per-position cache.
 */
const DRAWS = { plain: 100, conversion: 12 } as const;
/** Mean raw loss may rise between adjacent targets by at most this (cp) or 5 %, whichever is larger. */
const LOSS_TOLERANCE_CP = 1.5;
/**
 * The fixture's key: the real 5M distributions it was written with. Since 2026-09-13 the package
 * ships the 79M model only and `PolicyResult.size` is that type; the size is a label to the
 * selector and the distribution is what is replayed, so the label below is the shipped size
 * (tools/human-match/README.md records the decision to keep the fixture as written).
 */
const FIXTURE_KEY = "5m" as const;

interface Position {
	index: number;
	fen: string;
	ply: number;
	phase: Phase;
	bestmove: string | undefined;
	lines: EvalLine[];
	policy: PolicyResult;
	/** Maia's probability by UCI. */
	prob: Map<string, number>;
	/** Raw cp loss by UCI against the best scored line (`cpEffective`, mates mapped). */
	lossCp: Map<string, number>;
	draws: number;
}

const positions: Position[] = fixture.positions.map((p) => {
	const lines = p.lines as unknown as EvalLine[];
	const ranked = rankedLines(lines);
	const top = cpEffective(ranked[0]?.score ?? { cp: 0 });
	const lossCp = new Map<string, number>();
	for (const line of ranked) lossCp.set(line.pvUci[0] ?? "", top - cpEffective(line.score));
	const moves = p.policy[FIXTURE_KEY].moves as Array<[string, number]>;
	const ph = phase(p.fen, p.ply) ?? "middlegame";
	const conversion = conversionPool(lines, { fen: p.fen, phase: ph }).active;
	return {
		index: p.index,
		fen: p.fen,
		ply: p.ply,
		phase: ph,
		bestmove: p.engine.bestmove ?? undefined,
		lines,
		policy: { moves, wdl: p.policy[FIXTURE_KEY].wdl as [number, number, number], size: "79m" },
		prob: new Map(moves),
		lossCp,
		draws: conversion ? DRAWS.conversion : DRAWS.plain,
	};
});
const TOTAL_DRAWS = positions.reduce((n, p) => n + p.draws, 0);

interface Replay {
	target: number;
	draws: number;
	meanLossCp: number;
	sources: Map<ChosenMove["source"], number>;
	/** Picks whose UCI no line scores. */
	unscoredPicks: number;
	/** Maia-sourced picks under `MAIA.minProb`. */
	lowProbMaiaPicks: number;
	/** `maiaMeters` seen, and the violations of their stated ranges. */
	meters: number;
	meterViolations: string[];
	railedMassSum: number;
}

function replay(target: number): Replay {
	const r: Replay = {
		target,
		draws: 0,
		meanLossCp: 0,
		sources: new Map(),
		unscoredPicks: 0,
		lowProbMaiaPicks: 0,
		meters: 0,
		meterViolations: [],
		railedMassSum: 0,
	};
	let lossSum = 0;
	for (const p of positions) {
		// One seed per position, shared across targets: common random numbers, so the targets
		// differ by what the selector did, not by which uniforms it happened to draw.
		const rng = createRng(`maia-fixture:${p.index}`);
		const prior = flatPrior(p.lines);
		const base = {
			fen: p.fen,
			ply: p.ply,
			phase: p.phase,
			targetElo: target,
			selectionMode: "hybrid" as const,
			myClockMs: 90_000,
			oppClockMs: 90_000,
			baseMs: 180_000,
			incrementMs: 0,
			maia: p.policy,
			...(p.bestmove === undefined ? {} : { engineBestmove: p.bestmove }),
		};
		for (let i = 0; i < p.draws; i++) {
			const m = selectMove(p.lines, ctx({ ...base, rng, state: createSelectionState() }), prior);
			r.draws++;
			r.sources.set(m.source, (r.sources.get(m.source) ?? 0) + 1);
			const loss = p.lossCp.get(m.uci);
			if (loss === undefined) r.unscoredPicks++;
			else lossSum += loss;
			if (m.source === "maia" && (p.prob.get(m.uci) ?? 0) < MAIA.minProb) r.lowProbMaiaPicks++;
			const meters = m.maiaMeters;
			if (meters !== undefined) {
				r.meters++;
				r.railedMassSum += meters.railedMass;
				if (!(meters.klFromMaia >= -1e-9))
					r.meterViolations.push(`#${p.index} kl=${meters.klFromMaia}`);
				if (!(meters.railedMass >= 0 && meters.railedMass <= 1 + 1e-9))
					r.meterViolations.push(`#${p.index} railed=${meters.railedMass}`);
				if (!(meters.unscoredMass >= 0 && meters.unscoredMass <= 1 + 1e-9))
					r.meterViolations.push(`#${p.index} unscored=${meters.unscoredMass}`);
				if (!(meters.entropy >= 0 && meters.entropy <= 1 + 1e-9))
					r.meterViolations.push(`#${p.index} entropy=${meters.entropy}`);
			}
		}
	}
	r.meanLossCp = lossSum / Math.max(1, r.draws - r.unscoredPicks);
	return r;
}

const replays = TARGETS.map(replay);
console.log(
	`maia-fixture: ${TOTAL_DRAWS} draws/target — ${replays
		.map(
			(r) =>
				`${r.target}: ${r.meanLossCp.toFixed(1)} cp, maia ${r.sources.get("maia") ?? 0}, meters ${r.meters}${r.meters > 0 ? ` railed ${(r.railedMassSum / r.meters).toFixed(3)}` : ""}`
		)
		.join(" | ")}`
);

describe("Maia fixed-pool replay (maia-draw.json)", () => {
	it("the fixture is the 60-position parity set with a complete referee frame per position", () => {
		expect(positions.length).toBe(60);
		for (const p of fixture.positions) {
			expect(p.engine.complete).toBe(true);
			expect(p.lines.length).toBe(p.engine.searchmoves.length);
			let mass = 0;
			for (const [, prob] of p.policy[FIXTURE_KEY].moves as Array<[string, number]>) mass += prob;
			expect(mass).toBeCloseTo(1, 6);
		}
	});

	it("every pick is a scored candidate, at every target", () => {
		for (const r of replays) {
			expect(r.draws).toBe(TOTAL_DRAWS);
			expect(r.unscoredPicks).toBe(0);
		}
	});

	it("Maia decides most moves, and never one under MAIA.minProb", () => {
		for (const r of replays) {
			const maia = r.sources.get("maia") ?? 0;
			expect(maia).toBeGreaterThan(r.draws / 2);
			expect(r.lowProbMaiaPicks).toBe(0);
		}
	});

	it("mean raw loss is non-increasing in the target Elo (1000 → 2400, small tolerance)", () => {
		const summary = replays
			.map(
				(r) =>
					`${r.target}: ${r.meanLossCp.toFixed(2)} cp (${[...r.sources].map(([s, n]) => `${s} ${n}`).join(", ")})`
			)
			.join("\n  ");
		for (let i = 1; i < replays.length; i++) {
			const prev = replays[i - 1]!;
			const cur = replays[i]!;
			const tolerance = Math.max(LOSS_TOLERANCE_CP, 0.05 * prev.meanLossCp);
			expect(
				cur.meanLossCp,
				`mean raw loss rose ${prev.target} → ${cur.target}:\n  ${summary}`
			).toBeLessThanOrEqual(prev.meanLossCp + tolerance);
		}
	});

	it("maiaMeters, when the selector reports them, have klFromMaia ≥ 0 and every mass in [0, 1]", () => {
		for (const r of replays) {
			expect(r.meterViolations.slice(0, 5)).toEqual([]);
			if (r.meters > 0) expect(r.railedMassSum / r.meters).toBeLessThanOrEqual(1);
		}
	});

	it("the replay is deterministic for a seed", () => {
		const p = positions[3]!;
		const run = (): string[] => {
			const rng = createRng("maia-fixture:determinism");
			const out: string[] = [];
			for (let i = 0; i < 25; i++)
				out.push(
					selectMove(
						p.lines,
						ctx({ fen: p.fen, ply: p.ply, targetElo: 1500, maia: p.policy, rng }),
						flatPrior(p.lines)
					).uci
				);
			return out;
		};
		expect(run()).toEqual(run());
	});
});
