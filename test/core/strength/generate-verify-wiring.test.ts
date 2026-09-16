// test/core/strength/generate-verify-wiring.test.ts — generate-and-verify wired into the Maia
// branch of `selectMove` (H3/H4, 2026-09-13) and the H13 practical-difficulty proxy inside the
// tie band. The end-to-end contract: with the same search's human-depth frame on hand the
// verification decides among Maia's candidates and the meters say so; without it the plain draw
// runs untouched; when behind, the tie band prefers the candidate the opponent must answer quietly.
import { describe, expect, it } from "bun:test";
import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
import { MAIA } from "@core/constants/maia";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { drawDistribution, gvKl } from "@core/strength/generate-verify";
import {
	drawMaiaFromSurvivors,
	drawMaiaMove,
	type MaiaCandidate,
	maiaSurvivors,
} from "@core/strength/maia-select";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { type CtxOverrides, ctx, flatPrior, line, START } from "./helpers";

function policy(moves: Array<[string, number]>): PolicyResult {
	return { moves, wdl: [0.3, 0.4, 0.3], size: "79m", ms: 42 };
}

interface Sample {
	counts: Map<string, number>;
	picks: ChosenMove[];
}

function sample(
	lines: readonly EvalLine[],
	n: number,
	overrides: CtxOverrides,
	seed: string
): Sample {
	const rng = createRng(seed);
	const counts = new Map<string, number>();
	const picks: ChosenMove[] = [];
	for (let i = 0; i < n; i++) {
		const m = selectMove(
			lines,
			ctx({ ...overrides, rng, state: createSelectionState() }),
			flatPrior(lines)
		);
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
/** The human-depth frame: at depth 8 c2c4 looks 300 cp better than anything else. */
const SHALLOW: EvalLine[] = [
	{ ...line(START, "c2c4", { cp: 300 }, 1), depth: 8 },
	{ ...line(START, "e2e4", { cp: 40 }, 2), depth: 8 },
	{ ...line(START, "d2d4", { cp: 30 }, 3), depth: 8 },
	{ ...line(START, "g1f3", { cp: 10 }, 4), depth: 8 },
];

describe("H3 — generate-and-verify runs only with the human-depth frame", () => {
	it("the registry ships the path on", () => {
		expect(GV.enabled).toBe(true);
	});
	it("with shallowLines the meters carry candidates and verifyDepth, the rationale the stages, and the KL meter is the module's own", () => {
		const { picks } = sample(
			FOUR,
			200,
			{ targetElo: 2300, maia: MAIA_FOUR, shallowLines: SHALLOW, shallowDepth: 8 },
			"wired"
		);
		let intuition = 0;
		for (const m of picks) {
			expect(m.source).toBe("maia");
			const meters = m.maiaMeters;
			expect(meters).toBeDefined();
			if (meters === undefined) return;
			expect(meters.verifyDepth).toBe(8);
			expect(meters.candidates).toBeGreaterThanOrEqual(1);
			expect(meters.candidates).toBeLessThanOrEqual(4);
			expect(meters.survivors).toBe(4);
			expect(meters.rank).toBe(["d2d4", "e2e4", "g1f3", "c2c4"].indexOf(m.uci) + 1);
			expect(m.maiaProb).toBeCloseTo(P[m.uci] ?? -1, 12);
			const text = m.rationale.join("\n");
			if (text.includes("generate-verify: intuition")) {
				intuition++;
				expect(text).toContain("generate-verify: intuition");
			} else {
				expect(text).toMatch(/generate-verify: recognition proposals [12] of 4/);
				expect(meters.candidates).toBeLessThanOrEqual(2);
			}
			expect(text).toContain("tie-band terms (technique prior, practical difficulty) skipped");
			expect(text).not.toContain("no human-depth frame");
			expect(text).toMatch(/maia: 79m E=\d+ p=0\.\d+ rank [1-4]\/4 survivors .* KL \d+(\.\d+)? 42 ms/);
			expect(Number.isFinite(meters.klFromMaia)).toBe(true);
			expect(meters.klFromMaia).toBeGreaterThan(0);
		}
		// pIntuition(≈ 2200) ≈ 0.62 since the 2026-09-15 recalibration (was ≈ 0.16): most picks are on
		// recognition alone, a large minority are verified (binomial mean ≈ 124 of 200)
		expect(intuition).toBeGreaterThan(95);
		expect(intuition).toBeLessThan(150);
		// The meter is drawDistribution over the same input on the fen-seeded rng, so every pick
		// on this position reports the same number, and it is what the module says it is.
		const first = picks[0]?.maiaMeters?.klFromMaia ?? -1;
		for (const m of picks) expect(m.maiaMeters?.klFromMaia).toBe(first);
		const E = picks[0]?.maiaMeters?.selfElo ?? 0;
		const survivors = FOUR.map((l) => {
			const uci = l.pvUci[0] ?? "";
			const shallow = SHALLOW.find((s) => s.pvUci[0] === uci);
			return {
				uci,
				p: P[uci] ?? 0,
				deepCp: cpEffective(l.score),
				shallowCp: cpEffective(shallow?.score ?? {}),
			};
		});
		const q = drawDistribution(
			{ survivors, E, shallowDepth: 8 },
			GV.meterSamples,
			createRng(`gv-meter:${START}`)
		);
		expect(first).toBeCloseTo(gvKl(q, new Map(Object.entries(P))), 12);
	});
	it("the verification lifts the shallow favourite above its Maia mass: lightly through 2800, more in the upper band", () => {
		const strong = sample(
			FOUR,
			2000,
			{ targetElo: 2300, maia: MAIA_FOUR, shallowLines: SHALLOW, shallowDepth: 8 },
			"strong"
		);
		const weak = sample(
			FOUR,
			2000,
			{ targetElo: 1000, maia: MAIA_FOUR, shallowLines: SHALLOW, shallowDepth: 3 },
			"weak"
		);
		const upper = sample(
			FOUR,
			2000,
			{ targetElo: 2950, maia: MAIA_FOUR, shallowLines: SHALLOW, shallowDepth: 8 },
			"upper"
		);
		const plain = sample(FOUR, 2000, { targetElo: 2300, maia: MAIA_FOUR }, "strong");
		const share = (s: Sample, uci: string) => (s.counts.get(uci) ?? 0) / 2000;
		// Maia gives c2c4 0.05. Before the 2026-09-15 recalibration the path drew it ≈ 0.62 of the
		// time at ≈ 2200 — the near-argmax that made the extension outplay its rating against
		// chess.com humans (docs/qa/generate-verify-2026-09-13.md, "Recalibration"). Now at ≈ 2200
		// (intuition ≈ 0.62, k 2–3, σ 80) it is generated only when drawn as one of two and measured
		// ≈ 0.11; at ≈ 900 (intuition ≈ 0.69, σ 88) ≈ 0.09; at ≈ 2850 in the upper band (k ≈ 3,
		// σ ≈ 63, intuition ≈ 0.47) ≈ 0.25. The plain draw stays at Maia's 0.05.
		expect(share(plain, "c2c4")).toBeLessThan(0.09);
		for (const result of [strong, weak]) {
			const E = result.picks[0]?.maiaMeters?.selfElo ?? 0;
			const survivors = FOUR.map((l) => ({
				uci: l.pvUci[0]!,
				p: P[l.pvUci[0]!]!,
				deepCp: cpEffective(l.score),
				shallowCp: cpEffective(SHALLOW.find((s) => s.pvUci[0] === l.pvUci[0])!.score),
			}));
			const expected = drawDistribution({ survivors, E }, 0, createRng("exact"));
			let chi2 = 0;
			for (const [uci, p] of expected)
				chi2 += ((result.counts.get(uci) ?? 0) - 2000 * p) ** 2 / (2000 * p);
			expect(chi2).toBeLessThan(16.27);
			expect(expected.get("c2c4")).toBeGreaterThan(0.05);
			expect(expected.get("c2c4")).toBeLessThan(0.075);
		}
		expect(share(upper, "c2c4")).toBeGreaterThan(share(strong, "c2c4") + 0.08);
		// nothing outside the survivors, and the deep referee's ranking still sets rankInLines
		for (const m of strong.picks)
			expect(m.rankInLines).toBe(FOUR.findIndex((l) => l.pvUci[0] === m.uci) + 1);
	});
	it("without shallowLines the plain draw runs: no candidates/verifyDepth, the rationale says why, the frequencies are Maia's", () => {
		const { counts, picks } = sample(FOUR, 2000, { targetElo: 2300, maia: MAIA_FOUR }, "plain");
		for (const m of picks) {
			expect(m.maiaMeters?.candidates).toBeUndefined();
			expect(m.maiaMeters?.verifyDepth).toBeUndefined();
			expect(m.maiaMeters?.klFromMaia).toBeCloseTo(0, 12);
			expect(m.rationale.join(" ")).toContain(
				"generate-verify: no human-depth frame for this search, plain draw"
			);
			expect(m.rationale.join(" ")).not.toContain("generate-verify: k=");
		}
		for (const [uci, p] of Object.entries(P))
			expect(Math.abs((counts.get(uci) ?? 0) / 2000 - p)).toBeLessThan(0.035);
	});
	it("a shallowDepth without a frame is not a frame: the plain draw runs", () => {
		const m = selectMove(
			FOUR,
			ctx({ targetElo: 2300, maia: MAIA_FOUR, shallowDepth: 8, rng: createRng("depth-only") }),
			flatPrior(FOUR)
		);
		expect(m.maiaMeters?.verifyDepth).toBeUndefined();
		expect(m.rationale.join(" ")).toContain("no human-depth frame");
	});
	it("a survivor missing from the shallow frame cannot borrow deep verification", () => {
		const partial = SHALLOW.filter((l) => l.pvUci[0] !== "d2d4");
		const { picks } = sample(
			FOUR,
			100,
			{ targetElo: 2300, maia: MAIA_FOUR, shallowLines: partial, shallowDepth: 8 },
			"partial"
		);
		const text = picks.map((m) => m.rationale.join("\n")).join("\n");
		expect(text).toContain("recognition retained; no comparable new evidence");
		expect(text).not.toContain("deep scores stood in");
	});
	it("the rails run before the candidates are generated: a railed line is never a candidate", () => {
		const bad = line(START, "f2f3", { cp: -800 }, 5);
		const maia = policy([
			["f2f3", 0.6],
			["d2d4", 0.2],
			["e2e4", 0.1],
			["g1f3", 0.06],
			["c2c4", 0.04],
		]);
		const shallow = [...SHALLOW, { ...line(START, "f2f3", { cp: 900 }, 5), depth: 8 }];
		const { counts, picks } = sample(
			[...FOUR, bad],
			300,
			{ targetElo: 1500, maia, shallowLines: shallow, shallowDepth: 6 },
			"railed"
		);
		expect(counts.get("f2f3")).toBeUndefined();
		for (const m of picks) {
			expect(m.maiaMeters?.railedMass).toBeCloseTo(0.6, 9);
			expect(m.maiaMeters?.survivors).toBe(4);
			expect(m.rationale.join("\n")).not.toMatch(/^ {2}f2f3 /m);
		}
	});
	it("the same seed draws the same move: the wiring is deterministic", () => {
		const run = () =>
			Array.from(
				{ length: 30 },
				(_, i) =>
					selectMove(
						FOUR,
						ctx({
							targetElo: 2000,
							maia: MAIA_FOUR,
							shallowLines: SHALLOW,
							shallowDepth: 8,
							rng: createRng(`det:${i}`),
						}),
						flatPrior(FOUR)
					).uci
			);
		expect(run()).toEqual(run());
	});
});

describe("maiaSurvivors + drawMaiaFromSurvivors is drawMaiaMove", () => {
	const cands: MaiaCandidate[] = [
		{ uci: "e2e4", mated: false, hangs: false, lossRaw: 0, extra: false },
		{ uci: "d2d4", mated: false, hangs: false, lossRaw: 0.01, extra: true },
		{ uci: "f2f3", mated: false, hangs: true, lossRaw: 0.3, extra: false },
	];
	const maia = policy([
		["f2f3", 0.5],
		["e2e4", 0.3],
		["d2d4", 0.15],
		["b1c3", 0.05],
	]);
	it("the split halves reproduce the whole, rows and record alike", () => {
		const a: string[] = [];
		const whole = drawMaiaMove(cands, maia, 1500, createRng("split"), a, { scoredMassBefore: 0.95 });
		const b: string[] = [];
		const set = maiaSurvivors(cands, maia, 1500, b, { scoredMassBefore: 0.95 });
		expect(set).not.toBeNull();
		if (set === null) return;
		expect(set.survivors.map((c) => c.uci)).toEqual(["e2e4", "d2d4"]);
		expect(set.railedMass).toBeCloseTo(0.5, 12);
		expect(set.unscoredMass).toBeCloseTo(0.05, 12);
		expect(set.extra).toBe(1);
		const half = drawMaiaFromSurvivors(set, maia, 1500, createRng("split"), b);
		if (whole === null) throw new Error("drawMaiaMove returned null");
		expect(half).toEqual(whole);
		expect(b).toEqual(a);
		expect(half.practicalBand).toBe(0);
	});
	it("maiaSurvivors is null, with the row, when nothing scored carries minProb", () => {
		const rows: string[] = [];
		const set = maiaSurvivors(cands, policy([["b1c3", 1]]), 1500, rows);
		expect(set).toBeNull();
		expect(rows.join(" ")).toContain(`no scored candidate at p ≥ ${MAIA.minProb}, base policy`);
	});
});

describe("H13 — practical difficulty inside the tie band, only when behind", () => {
	// 1. e4 e5: two white tries scored well behind. After Nf3 the PV reply is the quiet Nc6; after
	// d4 it is the capture exd5 — a forcing only-reply the opponent finds on autopilot.
	const FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
	const QUIET = line(FEN, "g1f3", { cp: -200 }, 1, ["b8c6"]);
	const FORCING = line(FEN, "d2d4", { cp: -700 }, 2, ["e5d4"]);
	const LINES = [QUIET, FORCING];
	const tied = policy([
		["g1f3", 0.5],
		["d2d4", 0.5],
	]);
	// A target that keeps the Maia rating under the hang rail's `offElo` and inside the loss cap,
	// so only the practical term can move the band.
	const base = { fen: FEN, ply: 2, targetElo: 1000 };
	const N = 2000;
	const sharpness = Math.abs(winProb(-200) - winProb(-700));
	it("the fixture: behind, sharp enough for full trickiness, both survivors under the cap", () => {
		expect(MAIA.practical.enabled).toBe(true);
		expect(-200).toBeLessThanOrEqual(MAIA.practical.behindCp);
		expect(sharpness).toBeGreaterThanOrEqual(MAIA.practical.minReplyLoss);
		expect(winProb(-200) - winProb(-700)).toBeLessThan(0.55);
	});
	it("the quiet-only-reply candidate is drawn more often: 2 : 1.5 over the band", () => {
		const { counts, picks } = sample(LINES, N, { ...base, maia: tied }, "practical");
		const text = picks[0]?.rationale.join("\n") ?? "";
		expect(text).toContain(
			"maia practical: 2 near-equal survivors weighted by 1 + trickiness (g1f3 1, d2d4 0.5)"
		);
		expect(text).not.toContain("maia tie-break");
		// factors (1 + 1) / 1.75 and (1 + 0.5) / 1.75 on equal masses: 0.571 / 0.429
		expect(Math.abs((counts.get("g1f3") ?? 0) / N - 2 / 3.5)).toBeLessThan(0.035);
		for (const m of picks) {
			expect(m.source).toBe("maia");
			expect(m.maiaMeters?.klFromMaia ?? 0).toBeGreaterThan(0);
			// no quality reason exists for the term yet: the sample stays an ordinary Maia pick
			expect(m.quality?.eligible).toBe(true);
		}
	});
	it("not applied when ahead: the same band, the same replies, Maia's masses", () => {
		// +50 keeps the position out of the conversion guard (aheadCp 300) and above behindCp.
		const AHEAD = [
			line(FEN, "g1f3", { cp: 50 }, 1, ["b8c6"]),
			line(FEN, "d2d4", { cp: -350 }, 2, ["e5d4"]),
		];
		const { counts, picks } = sample(AHEAD, N, { ...base, maia: tied }, "ahead");
		for (const m of picks) {
			expect(m.rationale.join(" ")).not.toContain("maia practical");
			expect(m.maiaMeters?.klFromMaia).toBeCloseTo(0, 12);
		}
		expect(Math.abs((counts.get("g1f3") ?? 0) / N - 0.5)).toBeLessThan(0.035);
	});
	it("not applied outside the tie band: a decided Maia leaves nothing to weight", () => {
		const decided = policy([
			["d2d4", 0.8],
			["g1f3", 0.2],
		]);
		const { counts, picks } = sample(LINES, N, { ...base, maia: decided }, "decided");
		for (const m of picks) {
			expect(m.rationale.join(" ")).not.toContain("maia practical");
			expect(m.maiaMeters?.klFromMaia).toBeCloseTo(0, 12);
		}
		expect(Math.abs((counts.get("d2d4") ?? 0) / N - 0.8)).toBeLessThan(0.035);
	});
	it("a flat proxy moves nothing: equal sharpness and both replies forcing", () => {
		const BOTH = [
			line(FEN, "d2d4", { cp: -200 }, 1, ["e5d4"]),
			line(FEN, "f1b5", { cp: -700 }, 2, ["c7c6"]),
		];
		// f1b5 c7c6 is quiet, d2d4 exd4 forcing: this one moves — the control is the one below
		const moved = selectMove(
			BOTH,
			ctx({
				...base,
				maia: policy([
					["d2d4", 0.5],
					["f1b5", 0.5],
				]),
				rng: createRng("moved"),
			}),
			flatPrior(BOTH)
		);
		expect(moved.rationale.join(" ")).toContain("maia practical");
		const SAME = [
			line(FEN, "d2d4", { cp: -200 }, 1, ["e5d4"]),
			line(FEN, "f2f4", { cp: -700 }, 2, ["e5f4"]),
		];
		const flat = selectMove(
			SAME,
			ctx({
				...base,
				maia: policy([
					["d2d4", 0.5],
					["f2f4", 0.5],
				]),
				rng: createRng("flat"),
			}),
			flatPrior(SAME)
		);
		expect(flat.rationale.join(" ")).not.toContain("maia practical");
		expect(flat.maiaMeters?.klFromMaia).toBeCloseTo(0, 12);
	});
	it("with the human-depth frame the verification decides and the term is skipped, with the row", () => {
		const shallow = [
			{ ...line(FEN, "g1f3", { cp: -200 }, 1), depth: 4 },
			{ ...line(FEN, "d2d4", { cp: -700 }, 2), depth: 4 },
		];
		const { picks } = sample(
			LINES,
			50,
			{ ...base, maia: tied, shallowLines: shallow, shallowDepth: 4 },
			"gv-behind"
		);
		for (const m of picks) {
			const text = m.rationale.join(" ");
			expect(text).not.toContain("maia practical");
			expect(text).toContain("tie-band terms (technique prior, practical difficulty) skipped");
			expect(m.maiaMeters?.verifyDepth).toBe(4);
		}
	});
});
