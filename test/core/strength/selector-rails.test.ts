// test/core/strength/selector-rails.test.ts — the 2026-09-13 selector changes
// (`docs/research/human-move-selection-ideas-2026-09-13.md`, `docs/qa/selector-rails-2026-09-13.md`):
// H1 the rating-ramped hang rail with its one-ply view, H2 the slider as an Elo offset, H9 the
// restored mate ramp and throw-win filter, H11 the technique tie-break, H12 tilt, H15 the ≥ 2600
// Maia prior, H16 deep mated lines in Maia mode, and the fidelity meters (§3.2, D1, D2).
import { describe, expect, it } from "bun:test";
import { hangsOutright } from "@core/chess/safety";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { klDivergence, policyEntropy } from "@core/policy/maia-policy";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { SELECTION_CONSTANTS as C } from "@core/strength/constants";
import { winProb } from "@core/strength/elo-map";
import { drawMaiaMove, lossCapFor, type MaiaCandidate } from "@core/strength/maia-select";
import {
	createSelectionState,
	hangRailProbability,
	mateRampProbability,
	selectMove,
	tiltProbability,
} from "@core/strength/move-selector";
import { maiaSelfElo } from "@core/strength/selection-elo";
import type { SelectionState } from "@core/strength/types";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { type CtxOverrides, ctx, flatPrior, line, START } from "./helpers";

const NP = C.neverPlay;

function policy(
	moves: Array<[string, number]>,
	overrides: Partial<PolicyResult> = {}
): PolicyResult {
	return { moves, wdl: [0.3, 0.4, 0.3], size: "79m", ms: 42, ...overrides };
}

/** The Maia rating the selector judges at for `overrides` (form 0, no clock pressure). */
function maiaE(maia: PolicyResult, overrides: CtxOverrides = {}): number {
	const c = ctx(overrides);
	return maiaSelfElo({
		targetElo: c.targetElo,
		form: c.form,
		blunderScale: c.blunderScale,
		pressureReduction: 0,
		contextEloPenalty: c.contextEloPenalty,
		ambiguityEloPenalty: MAIA.context.ambiguityElo * policyEntropy(maia.moves),
	});
}

/** The target that lands the Maia rating exactly on `E` for `maia` (slider 1, form 0). */
function targetFor(E: number, maia: PolicyResult): number {
	return E + MAIA.context.ambiguityElo * policyEntropy(maia.moves);
}

interface Sample {
	counts: Map<string, number>;
	picks: ChosenMove[];
}

function sample(
	lines: readonly EvalLine[],
	n: number,
	overrides: CtxOverrides = {},
	seed = "rails"
): Sample {
	const rng = createRng(seed);
	const counts = new Map<string, number>();
	const picks: ChosenMove[] = [];
	for (let i = 0; i < n; i++) {
		const c = ctx({ ...overrides, rng, state: createSelectionState() });
		const m = selectMove(lines, c, flatPrior(lines));
		counts.set(m.uci, (counts.get(m.uci) ?? 0) + 1);
		picks.push(m);
	}
	return { counts, picks };
}

const FOUR: EvalLine[] = [
	line(START, "e2e4", { cp: 50 }, 1),
	line(START, "d2d4", { cp: 30 }, 2),
	line(START, "g1f3", { cp: 10 }, 3),
	line(START, "c2c4", { cp: 0 }, 4),
];
const P: Record<string, number> = { d2d4: 0.5, e2e4: 0.3, g1f3: 0.15, c2c4: 0.05 };
const MAIA_FOUR = policy(Object.entries(P));

describe("the ramps", () => {
	it("mateRampProbability: 0.5 at 800, linear to 1 at 1400, 1 above, clamped below", () => {
		expect(mateRampProbability(NP.mateProbEloFloor)).toBeCloseTo(NP.mateProbBase, 12);
		expect(mateRampProbability(1100)).toBeCloseTo(0.75, 12);
		expect(mateRampProbability(NP.mateAlwaysElo)).toBe(1);
		expect(mateRampProbability(2500)).toBe(1);
		expect(mateRampProbability(500)).toBeCloseTo(0.25, 12);
		expect(mateRampProbability(0)).toBe(0);
	});
	it("hangRailProbability: 0 below offElo, linear to 1 at fullElo", () => {
		const { offElo, fullElo } = MAIA.hangRail;
		expect(hangRailProbability(offElo - 1)).toBe(0);
		expect(hangRailProbability(offElo)).toBe(0);
		expect(hangRailProbability((offElo + fullElo) / 2)).toBeCloseTo(0.5, 12);
		expect(hangRailProbability(fullElo)).toBe(1);
		expect(hangRailProbability(2600)).toBe(1);
	});
	it("tiltProbability: probAtFloor at/below probFullElo, 0 at/above probFloorElo", () => {
		const T = MAIA.tilt;
		expect(tiltProbability(T.probFullElo)).toBeCloseTo(T.probAtFloor, 12);
		expect(tiltProbability(600)).toBeCloseTo(T.probAtFloor, 12);
		expect(tiltProbability((T.probFullElo + T.probFloorElo) / 2)).toBeCloseTo(T.probAtFloor / 2, 12);
		expect(tiltProbability(T.probFloorElo)).toBe(0);
		expect(tiltProbability(2000)).toBe(0);
	});
});

describe("H1 — the hang rail ramps with the rating and sees one ply below cheapViewElo", () => {
	// White queen d1, black pawn e6: Qd5 walks into the pawn's capture (hangs outright), Qd4 is safe.
	// The best score stays under `conversion.aheadCp` so the conversion guard leaves the draw alone.
	const FEN = "4k3/8/4p3/8/8/8/8/3QK3 w - - 0 1";
	const SAFE = line(FEN, "d1d4", { cp: 280 }, 1);
	const HANG = { ...line(FEN, "d1d5", { cp: -40 }, 2), pvSan: ["Qd5", "exd5"] };
	const LINES = [SAFE, HANG];
	const maia = policy([
		["d1d5", 0.7],
		["d1d4", 0.3],
	]);
	const loss = winProb(280) - winProb(-40);
	it("the fixture: a piece hangs outright with raw loss ≈ 0.27, under every loss cap in play", () => {
		expect(hangsOutright(FEN, "d1d5")).toBe(true);
		expect(hangsOutright(FEN, "d1d4")).toBe(false);
		expect(280).toBeLessThan(C.conversion.aheadCp);
		expect(loss).toBeGreaterThan(NP.hangPieceLoss);
		expect(loss).toBeLessThan(lossCapFor(2200));
	});
	it("at E = 900 the rail is off: the hanging move is drawable at Maia's mass", () => {
		const targetElo = targetFor(900, maia);
		expect(maiaE(maia, { targetElo })).toBeCloseTo(900, 9);
		const { counts, picks } = sample(LINES, 500, { fen: FEN, targetElo, maia }, "hang-900");
		expect((counts.get("d1d5") ?? 0) / 500).toBeGreaterThan(0.6);
		expect(picks[0]?.rationale.join(" ")).toContain(
			`maia hang rail: off (E<${MAIA.hangRail.offElo})`
		);
		expect(picks[0]?.rationale.join(" ")).not.toContain("view");
	});
	it("at E = 2200 the rail is always on with the deep-PV view: never drawn", () => {
		const targetElo = targetFor(2200, maia);
		const { counts, picks } = sample(LINES, 500, { fen: FEN, targetElo, maia }, "hang-2200");
		expect(counts.get("d1d5")).toBeUndefined();
		expect(counts.get("d1d4")).toBe(500);
		expect(picks[0]?.rationale.join(" ")).toContain("maia hang rail: on, deep-PV view");
		expect(picks[0]?.maiaMeters?.railedMass).toBeCloseTo(0.7, 9);
	});
	it("at E = 1550 the rail fires with probability ramp(E) = 0.5, once per move, with the one-ply view", () => {
		const targetElo = targetFor(1550, maia);
		expect(hangRailProbability(1550)).toBeCloseTo(0.5, 12);
		const { picks } = sample(LINES, 2000, { fen: FEN, targetElo, maia }, "hang-1550");
		let fired = 0;
		for (const m of picks) {
			const text = m.rationale.join(" ");
			if (text.includes("maia hang rail: fired (p=0.5), one-ply view")) {
				fired++;
				expect(m.uci).toBe("d1d4");
			} else {
				expect(text).toContain("maia hang rail: skipped (p=0.5)");
			}
		}
		expect(Math.abs(fired / 2000 - 0.5)).toBeLessThan(0.05);
		// when the rail skips, the hanging move is drawn at its mass
		const skipped = picks.filter((m) => m.rationale.join(" ").includes("skipped"));
		const hung = skipped.filter((m) => m.uci === "d1d5").length;
		expect(Math.abs(hung / skipped.length - 0.7)).toBeLessThan(0.05);
	});
	it("the one-ply view still needs the loss threshold: a cheap-view 'hang' that costs nothing is not railed", () => {
		// Same square, but the engine says the queen sortie is fine (a 5 cp loss): no rail applies.
		const cheap = [SAFE, { ...line(FEN, "d1d5", { cp: 275 }, 2), pvSan: ["Qd5", "exd5"] }];
		const targetElo = targetFor(1550, maia);
		const { counts } = sample(cheap, 300, { fen: FEN, targetElo, maia }, "hang-cheap");
		expect((counts.get("d1d5") ?? 0) / 300).toBeGreaterThan(0.6);
	});
});

describe("H2 — the mistakes slider as an Elo offset", () => {
	// Four near-equal moves, one bad move only the lowest ratings' loss cap admits, and one tail
	// move under p = 0.01 that the old temperature heated six-fold at slider 2.
	const BAD = line(START, "f2f3", { cp: -700 }, 5);
	const TAIL = line(START, "h2h3", { cp: -20 }, 6);
	const LINES = [...FOUR, BAD, TAIL];
	const maia = policy([
		["d2d4", 0.45],
		["e2e4", 0.3],
		["g1f3", 0.1],
		["f2f3", 0.1],
		["c2c4", 0.042],
		["h2h3", 0.008],
	]);
	const badLoss = winProb(50) - winProb(-700);
	const lossOf = (m: ChosenMove) =>
		winProb(50) - winProb(LINES.find((l) => l.pvUci[0] === m.uci)?.score.cp ?? 0);
	it("the fixture: the bad move is over the cap at slider 0 and under it at slider 2", () => {
		expect(badLoss).toBeGreaterThan(lossCapFor(maiaE(maia, { blunderScale: 0 })));
		expect(badLoss).toBeLessThan(lossCapFor(maiaE(maia, { blunderScale: 2 })));
		expect(maiaE(maia, { blunderScale: 0 }) - maiaE(maia, { blunderScale: 2 })).toBeCloseTo(
			2 * MAIA.slider.eloSpan,
			9
		);
	});
	it("mean raw loss is monotone non-decreasing in the slider, and the p < 0.01 tail does not rise", () => {
		const N = 2000;
		const meanLoss: number[] = [];
		const tailShare: number[] = [];
		for (const blunderScale of [0, 1, 2]) {
			const { picks, counts } = sample(LINES, N, { blunderScale, maia }, `slider-${blunderScale}`);
			let total = 0;
			for (const m of picks) {
				expect(m.source).toBe("maia");
				total += lossOf(m);
			}
			meanLoss.push(total / N);
			tailShare.push((counts.get("h2h3") ?? 0) / N);
		}
		expect(meanLoss[1]).toBeGreaterThanOrEqual(meanLoss[0] ?? 0);
		expect(meanLoss[2]).toBeGreaterThan(meanLoss[1] ?? 0);
		// the tail's share stays at Maia's own (≈ 0.008), never the 0.04 a T = 1.5 draw gave it
		for (const share of tailShare) expect(share).toBeLessThan(0.02);
		expect(tailShare[2]).toBeLessThanOrEqual((tailShare[0] ?? 0) + 0.01);
	});
	it("outside Maia mode the slider still scales the injected blunder channel as before", () => {
		const m0 = selectMove(FOUR, ctx({ blunderScale: 0, rng: createRng(3) }), flatPrior(FOUR));
		const m2 = selectMove(FOUR, ctx({ blunderScale: 2, rng: createRng(3) }), flatPrior(FOUR));
		expect(m0.rationale.join(" ")).toMatch(/b=0 \(b0=.* scale=0\)/);
		expect(m2.rationale.join(" ")).toMatch(/scale=2/);
	});
});

describe("H9 — weak players miss mates; a missed mate never throws the win", () => {
	const MATE3 = [line(START, "d2d4", { mate: 3 }, 1), line(START, "e2e4", { cp: 700 }, 2)];
	const MATE4 = [
		line(START, "d2d4", { mate: 4 }, 1),
		line(START, "e2e4", { cp: 700 }, 2),
		line(START, "f2f3", { cp: -300 }, 3),
	];
	it("a mate within mateInMax is played with the ramp's probability at 800 / 1200 / 1600 (base policy)", () => {
		for (const targetElo of [800, 1200, 1600]) {
			const expected = mateRampProbability(targetElo);
			const { picks } = sample(MATE3, 2000, { targetElo }, `ramp-${targetElo}`);
			const played = picks.filter((m) => m.source === "mate").length / 2000;
			expect(Math.abs(played - expected)).toBeLessThan(0.04);
			const declined = picks.find((m) => m.source !== "mate");
			if (expected < 1) {
				expect(declined?.rationale.join(" ")).toContain(
					`mate: mate-in-3 declined (p=${Number(expected.toFixed(2))} at E=${targetElo})`
				);
				expect(declined?.rationale.join(" ")).toContain("mate: throw-win filter");
			} else expect(declined).toBeUndefined();
		}
	});
	it("in Maia mode the ramp judges at the Maia rating, and a declined mate is the population's draw", () => {
		const maia = policy([
			["e2e4", 0.8],
			["d2d4", 0.2],
		]);
		const targetElo = targetFor(1100, maia);
		const expected = mateRampProbability(1100);
		expect(expected).toBeCloseTo(0.75, 12);
		const { picks } = sample(MATE3, 2000, { targetElo, maia }, "ramp-maia");
		const played = picks.filter((m) => m.source === "mate").length / 2000;
		expect(Math.abs(played - expected)).toBeLessThan(0.04);
		const declined = picks.filter((m) => m.source !== "mate");
		for (const m of declined) expect(m.source).toBe("maia");
		const missed = declined.filter((m) => m.uci === "e2e4").length / declined.length;
		expect(Math.abs(missed - 0.8)).toBeLessThan(0.06);
		expect(declined[0]?.rationale.join(" ")).toContain("mate: mate-in-3 declined (p=0.75 at E=1100)");
	});
	it("an immediate board mate is always played, at every rating, whatever Maia thinks", () => {
		const fen = "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1";
		const lines = [line(fen, "g6g5", { cp: 1500 }, 1), line(fen, "g6g7", { mate: 1 }, 2)];
		const maia = policy([
			["g6g5", 0.95],
			["g6g7", 0.05],
		]);
		for (const targetElo of [500, 800, 1200]) {
			const { counts, picks } = sample(lines, 300, { fen, targetElo, maia }, `mate1-${targetElo}`);
			expect(counts.get("g6g7")).toBe(300);
			for (const m of picks) expect(m.source).toBe("mate");
		}
	});
	it("a mate-in-≤ 3 is always played from mateAlwaysElo", () => {
		for (const targetElo of [NP.mateAlwaysElo, 1800, 2500]) {
			const { picks } = sample(MATE3, 300, { targetElo, blunderScale: 2 }, `always-${targetElo}`);
			for (const m of picks) {
				expect(m.source).toBe("mate");
				expect(m.uci).toBe("d2d4");
			}
		}
	});
	it("a mate deeper than mateInMax falls through, and lines with loss ≥ throwWinLoss are excluded", () => {
		const throwLoss = winProb(1096) - winProb(-300);
		const keepLoss = winProb(1096) - winProb(700);
		expect(throwLoss).toBeGreaterThan(NP.throwWinLoss);
		expect(keepLoss).toBeLessThan(NP.throwWinLoss);
		// base policy at 800, mistakes turned up: f2f3 would be the blunder channel's favourite
		const base = sample(MATE4, 1000, { targetElo: 800, blunderScale: 2 }, "throw-base");
		expect(base.counts.get("f2f3")).toBeUndefined();
		for (const m of base.picks) expect(m.source).not.toBe("mate");
		expect(base.picks[0]?.rationale.join(" ")).toContain(
			"mate: mate-in-4 is beyond 3, ordinary policy"
		);
		expect(base.picks[0]?.rationale.join(" ")).toContain(
			`mate: throw-win filter, lines with loss ≥ ${NP.throwWinLoss} excluded`
		);
		// Maia mode with most of the mass on the throw: still never drawn
		const maia = policy([
			["f2f3", 0.8],
			["e2e4", 0.15],
			["d2d4", 0.05],
		]);
		const human = sample(MATE4, 1000, { targetElo: 800, maia }, "throw-maia");
		expect(human.counts.get("f2f3")).toBeUndefined();
		expect((human.counts.get("e2e4") ?? 0) + (human.counts.get("d2d4") ?? 0)).toBe(1000);
		for (const m of human.picks) expect(m.source).toBe("maia");
	});
});

describe("H16 — deep mated lines below matedAllowBelowElo, in Maia mode as in the base policy", () => {
	const DEEP = [line(START, "e2e4", { cp: 30 }, 1), line(START, "f2f3", { mate: -3 }, 2)];
	const maia = policy([
		["f2f3", 0.9],
		["e2e4", 0.1],
	]);
	it("at E ≥ 1000 a mate −3 line is never drawn however much mass it carries", () => {
		const { counts } = sample(DEEP, 1000, { targetElo: targetFor(1050, maia), maia }, "deep-1050");
		expect(counts.get("f2f3")).toBeUndefined();
	});
	it("at E = 900 it is allowed with p = 0.25 and then drawn at Maia's mass", () => {
		const targetElo = targetFor(900, maia);
		const loss = winProb(30) - winProb(-1097);
		expect(loss).toBeLessThan(lossCapFor(900));
		const { counts, picks } = sample(DEEP, 2000, { targetElo, maia }, "deep-900");
		const allowed = picks.filter((m) =>
			m.rationale
				.join(" ")
				.includes(`never-play: E<${NP.matedAllowBelowElo}, deep mated lines allowed`)
		).length;
		expect(Math.abs(allowed / 2000 - NP.matedAllowProb)).toBeLessThan(0.04);
		const drawn = (counts.get("f2f3") ?? 0) / 2000;
		expect(Math.abs(drawn - NP.matedAllowProb * 0.9)).toBeLessThan(0.04);
		for (const m of picks) expect(m.source).toBe("maia");
	});
	it("a mate −1 line is still never drawn at 900 (mateMinDepth)", () => {
		const ONE = [line(START, "e2e4", { cp: 30 }, 1), line(START, "f2f3", { mate: -1 }, 2)];
		const { counts } = sample(ONE, 500, { targetElo: targetFor(900, maia), maia }, "deep-one");
		expect(counts.get("f2f3")).toBeUndefined();
	});
});

describe("the fidelity meters (§3.2, D1, D2)", () => {
	it("selfElo and entropy are the branch's own numbers", () => {
		const m = selectMove(FOUR, ctx({ maia: MAIA_FOUR, rng: createRng("meters") }), flatPrior(FOUR));
		expect(m.maiaMeters?.selfElo).toBeCloseTo(maiaE(MAIA_FOUR), 9);
		expect(m.maiaMeters?.entropy).toBeCloseTo(policyEntropy(MAIA_FOUR.moves), 12);
		expect(m.maiaMeters?.survivors).toBe(4);
		expect(m.maiaMeters?.railedMass).toBe(0);
		expect(m.maiaMeters?.unscoredMass).toBeCloseTo(0, 9);
		expect(m.maiaMeters?.candidates).toBeUndefined();
	});
	it("klFromMaia is 0 when nothing was railed and no tie-break ran, and rank is among survivors (D1)", () => {
		const plain = selectMove(FOUR, ctx({ maia: MAIA_FOUR, rng: createRng("kl") }), flatPrior(FOUR));
		expect(plain.maiaMeters?.klFromMaia).toBeCloseTo(0, 12);
		// the top-mass line is railed: the pick's rank counts the survivors only
		const bad = line(START, "f2f3", { cp: -800 }, 5);
		const maia = policy([
			["f2f3", 0.5],
			["d2d4", 0.25],
			["e2e4", 0.15],
			["g1f3", 0.075],
			["c2c4", 0.025],
		]);
		const { picks } = sample([...FOUR, bad], 200, { maia }, "rank");
		const order = ["d2d4", "e2e4", "g1f3", "c2c4"];
		for (const m of picks) {
			expect(m.maiaMeters?.rank).toBe(order.indexOf(m.uci) + 1);
			expect(m.maiaMeters?.survivors).toBe(4);
			expect(m.maiaMeters?.railedMass).toBeCloseTo(0.5, 9);
			expect(m.maiaMeters?.klFromMaia).toBeCloseTo(0, 12);
			expect(m.rationale.join(" ")).toMatch(/rank [1-4]\/4 survivors/);
		}
	});
	it("unscoredMass is Maia's mass on legal moves the search never scored", () => {
		const maia = policy([
			["b1c3", 0.3],
			["d2d4", 0.35],
			["e2e4", 0.2],
			["g1f3", 0.1],
			["c2c4", 0.05],
		]);
		const m = selectMove(FOUR, ctx({ maia, rng: createRng("unscored") }), flatPrior(FOUR));
		expect(m.maiaMeters?.unscoredMass).toBeCloseTo(0.3, 9);
		expect(m.rationale.join(" ")).toContain("scored mass 0.7 unscored 0.3");
	});
	it("D2: the scored-mass diagnostic is about the search, not the repetition/conversion guards", () => {
		const cands: MaiaCandidate[] = [
			{ uci: "e2e4", mated: false, hangs: false, lossRaw: 0, extra: false },
			{ uci: "d2d4", mated: false, hangs: false, lossRaw: 0.01, extra: false },
		];
		const maia = policy([
			["g1f3", 0.6],
			["e2e4", 0.2],
			["d2d4", 0.1],
			["c2c4", 0.1],
		]);
		// the guards removed g1f3 after the search scored it: no warning, both masses reported
		const rows: string[] = [];
		const draw = drawMaiaMove(cands, maia, 1500, createRng("d2"), rows, { scoredMassBefore: 0.9 });
		expect(draw?.scoredMass).toBeCloseTo(0.3, 12);
		expect(draw?.scoredMassBefore).toBe(0.9);
		expect(draw?.unscoredMass).toBeCloseTo(0.1, 12);
		expect(rows.join(" ")).not.toContain("of the model's mass (<");
		expect(rows.join(" ")).toContain("scored mass 0.9 (guards left 0.3) unscored 0.1");
		// without the hint the candidates' own mass is the search's and the warning fires
		const plainRows: string[] = [];
		const plain = drawMaiaMove(cands, maia, 1500, createRng("d2"), plainRows);
		expect(plain?.scoredMassBefore).toBeCloseTo(0.3, 12);
		expect(plain?.unscoredMass).toBeCloseTo(0.7, 12);
		expect(plainRows.join(" ")).toContain(`covers 0.3 of the model's mass (< ${MAIA.minScoredMass})`);
		expect(plainRows.join(" ")).not.toContain("guards left");
	});
});

describe("H11 — the technique prior breaks ties inside Maia's near-indifference band", () => {
	const cands: MaiaCandidate[] = ["a1a2", "b1b2", "c1c2"].map((uci) => ({
		uci,
		mated: false,
		hangs: false,
		lossRaw: 0,
		extra: false,
	}));
	const maia = policy([
		["a1a2", 0.4],
		["b1b2", 0.35],
		["c1c2", 0.25],
	]);
	it("only the band is re-weighted, by the prior normalised to mean 1 over the band, and the KL says so", () => {
		expect(0.35 / 0.4).toBeGreaterThanOrEqual(MAIA.tieBandRatio);
		expect(0.25 / 0.4).toBeLessThan(MAIA.tieBandRatio);
		const seen: string[][] = [];
		const tieBreak = (band: readonly string[]) => {
			seen.push([...band]);
			return new Map([
				["a1a2", 1],
				["b1b2", 3],
				["c1c2", 100],
			]);
		};
		const rng = createRng("tie");
		const counts = new Map<string, number>();
		const N = 4000;
		let kl = 0;
		for (let i = 0; i < N; i++) {
			const rows: string[] = [];
			const draw = drawMaiaMove(cands, maia, 1500, rng, rows, { tieBreak });
			if (!draw) throw new Error("no draw");
			counts.set(draw.uci, (counts.get(draw.uci) ?? 0) + 1);
			expect(draw.tieBand).toBe(2);
			kl = draw.klFromMaia;
			expect(rows.join(" ")).toContain("maia tie-break: 2 near-equal survivors");
			expect(rows.join(" ")).toContain(`KL ${Number(kl.toFixed(3))}`);
		}
		expect(seen.every((band) => [...band].sort().join() === "a1a2,b1b2")).toBe(true);
		// a ×0.5, b ×1.5 (mean 2 over the band), c untouched: 0.2 / 0.525 / 0.25 renormalised
		const total = 0.2 + 0.525 + 0.25;
		const expected = { a1a2: 0.2 / total, b1b2: 0.525 / total, c1c2: 0.25 / total };
		for (const [uci, share] of Object.entries(expected))
			expect(Math.abs((counts.get(uci) ?? 0) / N - share)).toBeLessThan(0.03);
		const q = new Map(Object.entries(expected));
		const p = new Map(maia.moves);
		expect(kl).toBeCloseTo(klDivergence(q, p), 12);
		expect(kl).toBeGreaterThan(0);
	});
	it("a one-member band, a flat prior, or no prior leaves Maia's weights and a zero KL", () => {
		const lone = policy([
			["a1a2", 0.7],
			["b1b2", 0.2],
			["c1c2", 0.1],
		]);
		const calls: number[] = [];
		const tieBreak = (band: readonly string[]) => {
			calls.push(band.length);
			return new Map([["a1a2", 50]]);
		};
		const rows: string[] = [];
		const draw = drawMaiaMove(cands, lone, 1500, createRng("lone"), rows, { tieBreak });
		expect(calls).toEqual([]);
		expect(draw?.tieBand).toBe(0);
		expect(draw?.klFromMaia).toBeCloseTo(0, 12);
		expect(rows.join(" ")).not.toContain("tie-break");
		const flat = drawMaiaMove(cands, maia, 1500, createRng("flat"), [], {
			tieBreak: new Map([
				["a1a2", 2],
				["b1b2", 2],
			]),
		});
		expect(flat?.tieBand).toBe(0);
		expect(flat?.klFromMaia).toBeCloseTo(0, 12);
		const none = drawMaiaMove(cands, maia, 1500, createRng("none"), []);
		expect(none?.tieBand).toBe(0);
		expect(none?.klFromMaia).toBeCloseTo(0, 12);
	});
	it("end to end: conversion progress reaches the draw only through the band, and the rationale says so only then (C2)", () => {
		// Black keeps a pawn, so the conversion progress is the plain pawn-push score (2 for e4,
		// 0 for the king move) rather than the lone-king restriction count.
		const ROOK_ENDGAME = "4k3/7p/8/8/8/8/4P3/R3K3 w - - 0 40";
		const WON = [
			line(ROOK_ENDGAME, "e2e4", { cp: 600 }, 1),
			line(ROOK_ENDGAME, "e1d2", { cp: 590 }, 2),
		];
		const base = { fen: ROOK_ENDGAME, targetElo: 1500, ply: 70, phase: "endgame" as const };
		const tied = policy([
			["e2e4", 0.5],
			["e1d2", 0.5],
		]);
		const { counts, picks } = sample(WON, 2000, { ...base, maia: tied }, "won-tie");
		const text = picks[0]?.rationale.join(" ") ?? "";
		expect(text).toContain("maia tie-break: 2 near-equal survivors");
		expect(text).toContain("conversion: retaining the win with rating-sensitive progress");
		const push = picks.find((m) => m.uci === "e2e4");
		expect(push?.rationale.join(" ")).toContain("conversion-progress ×1.5");
		expect(push?.maiaMeters?.klFromMaia ?? 0).toBeGreaterThan(0);
		// the pawn push carries the progress boost: 2.25 : 1.5 → 0.6 of the draws
		expect(Math.abs((counts.get("e2e4") ?? 0) / 2000 - 0.6)).toBeLessThan(0.035);
		// Maia decided: no band, no prior, no misleading conversion row
		const decided = policy([
			["e1d2", 0.8],
			["e2e4", 0.2],
		]);
		const m = selectMove(
			WON,
			ctx({ ...base, maia: decided, rng: createRng("won-decided") }),
			undefined
		);
		expect(m.source).toBe("maia");
		expect(m.rationale.join(" ")).not.toContain("rating-sensitive progress");
		expect(m.rationale.join(" ")).not.toContain("prior:");
		expect(m.maiaMeters?.klFromMaia).toBeCloseTo(0, 12);
	});
});

describe("H12 — tilt as per-game state", () => {
	const LINES = [line(START, "e2e4", { cp: 100 }, 1), line(START, "d2d4", { cp: 80 }, 2)];
	const maia = policy([
		["e2e4", 0.6],
		["d2d4", 0.4],
	]);
	it("finish() records the pick's raw score for the next trigger and counts a tilt down", () => {
		const state = createSelectionState();
		expect(state.tiltMovesLeft).toBe(0);
		expect(state.lastPickCp).toBeUndefined();
		selectMove(LINES, ctx({ maia, state, rng: createRng("last") }), flatPrior(LINES));
		expect(state.lastPickCp !== undefined && [100, 80].includes(state.lastPickCp)).toBe(true);
		const tilted: SelectionState = { ...createSelectionState(), tiltMovesLeft: 2 };
		selectMove(LINES, ctx({ maia, state: tilted, rng: createRng("down") }), flatPrior(LINES));
		expect(tilted.tiltMovesLeft).toBe(1);
	});
	it("an adverse swing tilts with the rating-dependent probability and costs tilt.elo for tilt.moves moves", () => {
		const E = 900;
		const targetElo = targetFor(E, maia);
		const pTilt = tiltProbability(E);
		expect(pTilt).toBeCloseTo(0.5 * (500 / 600), 12);
		const rng = createRng("tilt");
		let tilts = 0;
		for (let i = 0; i < 2000; i++) {
			const state: SelectionState = { ...createSelectionState(), lastPickCp: 100 + MAIA.tilt.swingCp };
			const m = selectMove(LINES, ctx({ targetElo, maia, state, rng }), flatPrior(LINES));
			const text = m.rationale.join(" ");
			if (text.includes("tilt:")) {
				tilts++;
				expect(text).toContain(
					`tilt: eval fell ${MAIA.tilt.swingCp} cp since our last move (p=${Number(pTilt.toFixed(2))}), −${MAIA.tilt.elo} Elo for ${MAIA.tilt.moves} moves`
				);
				expect(text).toContain(`tilt −${MAIA.tilt.elo} (${MAIA.tilt.moves} left)`);
				expect(m.maiaMeters?.selfElo).toBeCloseTo(E - MAIA.tilt.elo, 9);
				expect(state.tiltMovesLeft).toBe(MAIA.tilt.moves - 1);
				// the penalty persists for the remaining moves and then lifts
				for (let k = MAIA.tilt.moves - 1; k > 0; k--) {
					const next = selectMove(LINES, ctx({ targetElo, maia, state, rng }), flatPrior(LINES));
					expect(next.maiaMeters?.selfElo).toBeCloseTo(E - MAIA.tilt.elo, 9);
					expect(state.tiltMovesLeft).toBe(k - 1);
				}
				const calm = selectMove(LINES, ctx({ targetElo, maia, state, rng }), flatPrior(LINES));
				expect(calm.maiaMeters?.selfElo).toBeCloseTo(E, 9);
			} else {
				expect(m.maiaMeters?.selfElo).toBeCloseTo(E, 9);
				expect(state.tiltMovesLeft).toBe(0);
			}
		}
		expect(Math.abs(tilts / 2000 - pTilt)).toBeLessThan(0.04);
	});
	it("a swing under swingCp, or a rating at/above probFloorElo, never tilts", () => {
		for (const [lastPickCp, E] of [
			[100 + MAIA.tilt.swingCp - 1, 900],
			[100 + 2 * MAIA.tilt.swingCp, MAIA.tilt.probFloorElo],
			[100 + 2 * MAIA.tilt.swingCp, 2000],
		] as const) {
			const targetElo = targetFor(E, maia);
			const rng = createRng(`no-tilt-${E}`);
			for (let i = 0; i < 300; i++) {
				const state: SelectionState = { ...createSelectionState(), lastPickCp };
				const m = selectMove(LINES, ctx({ targetElo, maia, state, rng }), flatPrior(LINES));
				expect(m.rationale.join(" ")).not.toContain("tilt");
				expect(state.tiltMovesLeft).toBe(0);
			}
		}
	});
	it("the tilt penalty shares the context cap with the other terms", () => {
		const state: SelectionState = { ...createSelectionState(), tiltMovesLeft: 1 };
		const m = selectMove(
			LINES,
			ctx({ maia, state, contextEloPenalty: MAIA.context.maxPenalty, rng: createRng("cap") }),
			flatPrior(LINES)
		);
		expect(m.maiaMeters?.selfElo).toBeCloseTo(
			Math.max(MAIA.context.eloFloor, 1500 - MAIA.context.maxPenalty),
			9
		);
	});
});

describe("Maia-79M as a bounded upper-range prior", () => {
	const prior79 = (moves: Array<[string, number]>) => policy(moves, { size: "79m", ms: 184 });
	it("the pool is the engine's gap; Maia decides inside it, floored, and the pick differs from the engine's", () => {
		const maia = prior79(Object.entries(P));
		const near = FOUR.map((l, i) => ({ ...l, score: { cp: 50 - 3 * i } }));
		for (const targetElo of [3001, 3020, 3040]) {
			const engine = selectMove(
				near,
				ctx({ targetElo, selectionMode: "hybrid", engineBestmove: "e2e4", rng: createRng(11) }),
				flatPrior(FOUR)
			);
			expect(engine.source).toBe("engine-elo");
			expect(engine.uci).toBe("e2e4");
			const N = 2000;
			const { counts, picks } = sample(near, N, { targetElo, maia }, `prior-${targetElo}`);
			const floor = MAIA.prior.floorWeight;
			let total = 0;
			for (const uci of Object.keys(P)) total += Math.max(floor, P[uci] ?? 0);
			for (const [uci, p] of Object.entries(P))
				expect(Math.abs((counts.get(uci) ?? 0) / N - Math.max(floor, p) / total)).toBeLessThan(0.035);
			const m = picks[0];
			expect(m?.source).toBe("maia");
			expect(m?.maiaProb).toBe(P[m?.uci ?? ""] ?? -1);
			expect(m?.rationale.join(" ")).toContain(`maia prior: 79m E=3000 pool 4/4 within`);
			expect(m?.maiaMeters?.selfElo).toBe(3000);
			expect(m?.maiaMeters?.survivors).toBe(4);
			expect(m?.maiaMeters?.rank).toBe(
				[...Object.entries(P)].sort((a, b) => b[1] - a[1]).findIndex(([u]) => u === m?.uci) + 1
			);
		}
	});
	it("targets that the pipeline queries at different ratings draw different moves for the same seed", () => {
		// The query's `selfElo` differs per target, so the policies differ; the pick tracks them.
		const low = prior79([
			["d2d4", 0.9],
			["e2e4", 0.1],
		]);
		const high = prior79([
			["e2e4", 0.9],
			["d2d4", 0.1],
		]);
		const a = selectMove(
			FOUR,
			ctx({ targetElo: 2600, maia: low, rng: createRng(5) }),
			flatPrior(FOUR)
		);
		const b = selectMove(
			FOUR,
			ctx({ targetElo: 2800, maia: high, rng: createRng(5) }),
			flatPrior(FOUR)
		);
		expect(a.uci).toBe("d2d4");
		expect(b.uci).toBe("e2e4");
	});
	it("a line Maia gives no mass to is still played when it is alone inside the gap", () => {
		const clear = [line(START, "e2e4", { cp: 200 }, 1), line(START, "d2d4", { cp: 30 }, 2)];
		const maia = prior79([["d2d4", 1]]);
		const { counts, picks } = sample(clear, 200, { targetElo: 3100, maia }, "alone");
		expect(counts.get("e2e4")).toBe(200);
		expect(picks[0]?.maiaProb).toBe(0);
		expect(picks[0]?.maiaMeters?.railedMass).toBe(1);
		expect(picks[0]?.rationale.join(" ")).toContain("pool 1/2");
	});
	it("mated and hanging lines never enter the pool, and LIMITS.eloMax stays pure engine", () => {
		const hanging = { ...line(START, "f2f3", { cp: 40 }, 2), pvSan: ["f3", "Bxe4"] };
		const mated = line(START, "g2g4", { mate: -2 }, 3);
		const lines = [line(START, "e2e4", { cp: 50 }, 1), hanging, mated];
		// f2f3's loss (0.01) is under the hang threshold, so it is in the pool; make it hang for real
		const hangs = { ...line(START, "h2h4", { cp: -250 }, 4), pvSan: ["h4", "Bxh4"] };
		const maia = prior79([
			["g2g4", 0.6],
			["h2h4", 0.3],
			["e2e4", 0.05],
			["f2f3", 0.05],
		]);
		const { counts } = sample([...lines, hangs], 300, { targetElo: 2800, maia }, "pool");
		expect(counts.get("g2g4")).toBeUndefined();
		expect(counts.get("h2h4")).toBeUndefined();
		expect((counts.get("e2e4") ?? 0) + (counts.get("f2f3") ?? 0)).toBe(300);
		const top = selectMove(
			[...lines, hangs],
			ctx({ targetElo: LIMITS.eloMax, maia, rng: createRng("top") }),
			flatPrior(lines)
		);
		expect(top.source).toBe("engine-elo");
		expect(top.uci).toBe("e2e4");
		expect(top.rationale.join(" ")).not.toContain("maia");
	});
});
