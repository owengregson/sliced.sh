// test/core/strength/move-selector.test.ts
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { SELECTION_CONSTANTS } from "@core/strength/constants";
import { tauFor } from "@core/strength/elo-map";
import {
	cpEffective,
	createSelectionState,
	endgameTauFor,
	hangsPiece,
	resolvePriors,
	resolvePriorsDetailed,
	selectionParams,
	selectMove,
	winProb,
} from "@core/strength/move-selector";
import { ctx, flatPrior, line, START } from "./helpers";

/** Best +50 (e2e4), second −20 (d2d4). */
const TWO = [line(START, "e2e4", { cp: 50 }, 1), line(START, "d2d4", { cp: -20 }, 2)];

function top1Rate(targetElo: number, n: number, seed = "top1"): number {
	const rng = createRng(seed);
	const prior = flatPrior(TWO);
	let hits = 0;
	for (let i = 0; i < n; i++) {
		const c = ctx({ targetElo, rng, state: createSelectionState() });
		if (selectMove(TWO, c, prior).uci === "e2e4") hits++;
	}
	return hits / n;
}

describe("score helpers", () => {
	it("winProb is the lichess sigmoid", () => {
		expect(winProb(0)).toBe(0.5);
		expect(winProb(100)).toBeCloseTo(1 / (1 + Math.exp(-0.368208)), 12);
		expect(winProb(-100)).toBeCloseTo(1 - winProb(100), 12);
	});
	it("cpEffective clamps cp and maps mates to the boundary", () => {
		expect(cpEffective({ cp: 5000 })).toBe(1000);
		expect(cpEffective({ cp: -5000 })).toBe(-1000);
		expect(cpEffective({ cp: 37 })).toBe(37);
		expect(cpEffective({ mate: 1 })).toBe(1099);
		expect(cpEffective({ mate: 5 })).toBe(1095);
		expect(cpEffective({ mate: -1 })).toBe(-1099);
		expect(cpEffective({ mate: -3 })).toBe(-1097);
		expect(cpEffective({})).toBe(0);
	});
});

describe("selectMove — base policy (a)", () => {
	it("E = 2800: top-1 rate ≥ 0.9 over 10 000 samples", () => {
		expect(top1Rate(2800, 10_000)).toBeGreaterThanOrEqual(0.9);
	});
	it("E = 1000: top-1 rate between 0.35 and 0.65 over 10 000 samples", () => {
		const r = top1Rate(1000, 10_000);
		expect(r).toBeGreaterThanOrEqual(0.35);
		expect(r).toBeLessThanOrEqual(0.65);
	});
	it("is deterministic for a given seed and fills every ChosenMove field", () => {
		const a = selectMove(TWO, ctx({ rng: createRng(3) }), flatPrior(TWO));
		const b = selectMove(TWO, ctx({ rng: createRng(3) }), flatPrior(TWO));
		expect(a).toEqual(b);
		expect(["e2e4", "d2d4"]).toContain(a.uci);
		expect(a.san).toBe(a.uci === "e2e4" ? "e4" : "d4");
		expect(`${a.from}${a.to}`).toBe(a.uci);
		expect(a.promotion).toBeUndefined();
		expect(a.source).toBe("sampled");
		expect(a.rankInLines).toBe(a.uci === "e2e4" ? 1 : 2);
		expect(a.cpLoss).toBe(a.uci === "e2e4" ? 0 : 70);
		expect(a.rationale.length).toBeGreaterThan(0);
		expect(a.rationale.join(" ")).toContain("E=1500");
	});
	it("throws on an empty line set", () => {
		expect(() => selectMove([], ctx(), new Map())).toThrow(RangeError);
	});
	it("ignores lines without a move and throws only when none remain", () => {
		const empty = { ...line(START, "e2e4", { cp: 999 }, 1), pvUci: [], pvSan: [] };
		expect(() => selectMove([empty], ctx(), new Map())).toThrow(RangeError);
		const m = selectMove(
			[empty, ...TWO],
			ctx({ targetElo: 2800, rng: createRng(4) }),
			flatPrior(TWO)
		);
		expect(m.uci).toBe("e2e4");
		expect(m.rankInLines).toBe(1);
		expect(m.cpLoss).toBe(0);
	});
	it("runs the default heuristicPrior end to end when no prior map is supplied", () => {
		const DEV = [line(START, "g1f3", { cp: 30 }, 1), line(START, "b1c3", { cp: 20 }, 2)];
		const m = selectMove(DEV, ctx({ targetElo: 1500, rng: createRng("default-prior") }));
		expect(["g1f3", "b1c3"]).toContain(m.uci);
		expect(m.rationale.join(" ")).toContain("development ×1.4");
		const detailed = resolvePriorsDetailed(DEV, ctx({ targetElo: 1500 }));
		expect(detailed.values.get("g1f3")).toBeCloseTo(1.4, 12);
		expect(detailed.terms.get("b1c3")).toEqual([{ rule: "development", factor: 1.4 }]);
	});
	it("formats b0 in the rationale", () => {
		const m = selectMove(TWO, ctx({ targetElo: 1200, rng: createRng(6) }), flatPrior(TWO));
		expect(m.rationale.join(" ")).toMatch(/b0=0\.055 /);
		const mid = selectMove(TWO, ctx({ targetElo: 1300, rng: createRng(6) }), flatPrior(TWO));
		expect(mid.rationale.join(" ")).toMatch(/b0=0\.0475 /);
	});
	it("gap cutoff G(E): at 2200+ a line 70 cp behind is outside the base pool", () => {
		// σ(2800)=8 → jitter rarely closes a 70 cp gap below 60; second is chosen far under 10 %.
		expect(top1Rate(2800, 4000, "gap")).toBeGreaterThan(0.95);
	});
});

describe("selectMove — selection modes", () => {
	it("3650 selects the strongest searched continuation even with a weaker engine-elo suggestion", () => {
		for (const selectionMode of ["engine-elo", "hybrid", "persona-sampling"] as const) {
			const chosen = selectMove(
				TWO,
				ctx({ targetElo: 3650, form: -1, selectionMode, engineBestmove: "d2d4", blunderScale: 2 })
			);
			expect(chosen.uci).toBe("e2e4");
			expect(chosen.rationale.join(" ")).toContain("maximum strength");
		}
	});
	it("engine-elo plays the engine's bestmove verbatim", () => {
		const c = ctx({ selectionMode: "engine-elo", engineBestmove: "d2d4" });
		const m = selectMove(TWO, c, flatPrior(TWO));
		expect(m.uci).toBe("d2d4");
		expect(m.source).toBe("engine-elo");
		expect(m.rankInLines).toBe(2);
	});
	it("engine-elo without a bestmove falls back to the top line", () => {
		const m = selectMove(TWO, ctx({ selectionMode: "engine-elo" }), flatPrior(TWO));
		expect(m.uci).toBe("e2e4");
		expect(m.source).toBe("engine-elo");
	});
	it("(e) hybrid boosts the engine bestmove prior ×2.0; persona-sampling does not", () => {
		const hybrid = resolvePriors(
			TWO,
			ctx({ selectionMode: "hybrid", engineBestmove: "d2d4" }),
			flatPrior(TWO)
		);
		expect(hybrid.get("e2e4")).toBe(1);
		expect(hybrid.get("d2d4")).toBe(2);
		const sampling = resolvePriors(
			TWO,
			ctx({ selectionMode: "persona-sampling", engineBestmove: "d2d4" }),
			flatPrior(TWO)
		);
		expect(sampling.get("d2d4")).toBe(1);
		expect(SELECTION_CONSTANTS.hybridBestmovePrior).toBe(2);
	});
	it("(e) the ×2 prior shifts sampling by 2^β(E) on two equal lines", () => {
		const equal = [line(START, "e2e4", { cp: 10 }, 1), line(START, "d2d4", { cp: 10 }, 2)];
		const prior = flatPrior(equal);
		const rng = createRng("hybrid");
		let d4 = 0;
		const n = 10_000;
		for (let i = 0; i < n; i++) {
			const c = ctx({
				targetElo: 1000,
				selectionMode: "hybrid",
				engineBestmove: "d2d4",
				rng,
				state: createSelectionState(),
			});
			if (selectMove(equal, c, prior).uci === "d2d4") d4++;
		}
		// β(1000) = 0.6 → 2^0.6 / (1 + 2^0.6) ≈ 0.603
		const expected = 2 ** 0.6 / (1 + 2 ** 0.6);
		expect(Math.abs(d4 / n - expected)).toBeLessThan(0.03);
	});
});

describe("selectMove — never-play filters (b)(c)", () => {
	const MATED = [
		line(START, "e2e4", { cp: 30 }, 1),
		line(START, "d2d4", { cp: 10 }, 2),
		line(START, "f2f3", { mate: -1 }, 3),
	];
	it("(b) a mate −1 line is never chosen at E = 1600 when an alternative exists", () => {
		const rng = createRng("mated");
		const prior = new Map([
			["e2e4", 1],
			["d2d4", 1],
			["f2f3", 50],
		]);
		for (let i = 0; i < 5000; i++) {
			const c = ctx({ targetElo: 1600, blunderScale: 2, rng, state: createSelectionState() });
			expect(selectMove(MATED, c, prior).uci).not.toBe("f2f3");
		}
	});
	it("a mate −1 line is never chosen even at E = 900 (mate-in-1 threats are always obvious)", () => {
		const rng = createRng("mated-weak");
		for (let i = 0; i < 3000; i++) {
			const c = ctx({ targetElo: 900, blunderScale: 2, rng, state: createSelectionState() });
			expect(selectMove(MATED, c, flatPrior(MATED)).uci).not.toBe("f2f3");
		}
	});
	it("a deeper mated line (mate −3) can only be chosen below E = 1000", () => {
		const DEEP = [line(START, "e2e4", { cp: 30 }, 1), line(START, "f2f3", { mate: -3 }, 2)];
		const prior = new Map([
			["e2e4", 1],
			["f2f3", 1000],
		]);
		const rngStrong = createRng("deep-strong");
		for (let i = 0; i < 2000; i++) {
			const c = ctx({
				targetElo: 1000,
				blunderScale: 2,
				rng: rngStrong,
				state: createSelectionState(),
			});
			expect(selectMove(DEEP, c, prior).uci).toBe("e2e4");
		}
		const rngWeak = createRng("deep-weak");
		let chosen = 0;
		for (let i = 0; i < 2000; i++) {
			const c = ctx({ targetElo: 900, blunderScale: 2, rng: rngWeak, state: createSelectionState() });
			if (selectMove(DEEP, c, prior).uci === "f2f3") chosen++;
		}
		expect(chosen).toBeGreaterThan(0);
		// Allowed with p = 0.25 and then only through the blunder channel (b = 0.15): well under 25 %.
		expect(chosen / 2000).toBeLessThan(0.1);
	});
	it("when every line is mated no filter applies and a move is still returned", () => {
		const ALL = [line(START, "e2e4", { mate: -4 }, 1), line(START, "f2f3", { mate: -1 }, 2)];
		const m = selectMove(ALL, ctx({ targetElo: 2600, rng: createRng(9) }), flatPrior(ALL));
		expect(["e2e4", "f2f3"]).toContain(m.uci);
		expect(m.source).toBe("sampled");
		expect(m.rationale.join(" ")).not.toContain("mated line");
	});
	it("(c) mate-in-1 is always chosen at E ≥ 1400, with source 'mate'", () => {
		const MATE = [line(START, "e2e4", { cp: 500 }, 1), line(START, "d2d4", { mate: 1 }, 2)];
		for (const targetElo of [1400, 1800, 2500]) {
			const rng = createRng(`mate-${targetElo}`);
			for (let i = 0; i < 2000; i++) {
				const c = ctx({ targetElo, blunderScale: 2, rng, state: createSelectionState() });
				const m = selectMove(MATE, c, flatPrior(MATE));
				expect(m.uci).toBe("d2d4");
				expect(m.source).toBe("mate");
				expect(m.rankInLines).toBe(1);
			}
		}
	});
	it("the shortest mate is preferred when several are within 3", () => {
		const MATES = [
			line(START, "e2e4", { mate: 3 }, 1),
			line(START, "d2d4", { mate: 2 }, 2),
			line(START, "g1f3", { mate: 5 }, 3),
		];
		const m = selectMove(MATES, ctx({ targetElo: 2000, rng: createRng(1) }), flatPrior(MATES));
		expect(m.uci).toBe("d2d4");
		expect(m.source).toBe("mate");
	});
	it("preserves searched mates at low Elo and in the engine-elo path, including longer mates", () => {
		const MATE = [line(START, "d2d4", { mate: 8 }, 1), line(START, "e2e4", { cp: 700 }, 2)];
		for (const selectionMode of ["persona-sampling", "engine-elo", "hybrid"] as const) {
			for (const targetElo of [800, 1500, 3650]) {
				const m = selectMove(
					MATE,
					ctx({ targetElo, selectionMode, engineBestmove: "e2e4", blunderScale: 100 }),
					flatPrior(MATE)
				);
				expect(m.uci).toBe("d2d4");
				expect(m.source).toBe("mate");
			}
		}
	});
	it("never hangs a piece outside the blunder channel (PV shows a capture, loss ≥ 0.25)", () => {
		const hang = { ...line(START, "g1f3", { cp: -250 }, 2), pvSan: ["Nf3", "Nxf3"] };
		expect(hangsPiece(hang, 0.3, START)).toBe(true);
		expect(hangsPiece(hang, 0.2, START)).toBe(false);
		const quiet = { ...hang, pvSan: ["Nf3", "d6"] };
		expect(hangsPiece(quiet, 0.3, START)).toBe(false);
		// Without SAN the reply is classified from the PV.
		const uciOnly = { ...line(START, "e2e4", { cp: -250 }, 2, ["d7d5"]), pvSan: [] };
		expect(hangsPiece(uciOnly, 0.3, START)).toBe(false);
		const uciCapture = { ...line(START, "e2e4", { cp: -250 }, 2, ["d7d5", "e4d5"]), pvSan: [] };
		expect(hangsPiece({ ...uciCapture, pvUci: ["d2d4", "e7e5", "e5d4"] }, 0.3, START)).toBe(false);
		const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
		expect(hangsPiece({ ...uciCapture, pvUci: ["d7d5", "e4d5"], pvSan: [] }, 0.3, afterE4)).toBe(
			true
		);
		// End to end: raw loss 0.30 ≥ 0.25 with a 370 cp gap inside G(800) = 500, so only this
		// rail excludes it — and it is computed from the raw cp, so jitter cannot open it.
		const HANG = [
			line(START, "e2e4", { cp: 20 }, 1),
			{ ...line(START, "g1f3", { cp: -350 }, 2), pvSan: ["Nf3", "Nxf3"] },
		];
		const rng = createRng("hang");
		for (let i = 0; i < 3000; i++) {
			const c = ctx({ targetElo: 800, blunderScale: 0, rng, state: createSelectionState() });
			expect(selectMove(HANG, c, flatPrior(HANG)).uci).toBe("e2e4");
		}
	});
});

describe("selectMove — streak damper (f)", () => {
	it("τ ×1.3 once 12 consecutive top-1 picks have been made", () => {
		const fresh = createSelectionState();
		const base = selectionParams(1500, fresh).tau;
		expect(base).toBeCloseTo(tauFor(1500), 12);
		const streak = { ...createSelectionState(), top1Streak: 12 };
		expect(selectionParams(1500, streak).tau).toBeCloseTo(base * 1.3, 12);
		const eleven = { ...createSelectionState(), top1Streak: 11 };
		expect(selectionParams(1500, eleven).tau).toBeCloseTo(base, 12);
	});
	it("counts top-1 picks in state and resets on a non-top-1 move", () => {
		const FORCED = [line(START, "e2e4", { cp: 900 }, 1), line(START, "d2d4", { cp: -900 }, 2)];
		const state = createSelectionState();
		const c = ctx({ targetElo: 2600, rng: createRng("streak"), state });
		for (let i = 0; i < 12; i++) {
			const m = selectMove(FORCED, c, flatPrior(FORCED));
			expect(m.rankInLines).toBe(1);
			expect(m.rationale.join(" ")).not.toContain("streak");
		}
		expect(state.top1Streak).toBe(12);
		const thirteenth = selectMove(FORCED, c, flatPrior(FORCED));
		expect(thirteenth.rationale.join(" ")).toContain("streak");
		expect(state.top1Streak).toBe(13);
		const played = selectMove(
			FORCED,
			{ ...c, selectionMode: "engine-elo", engineBestmove: "d2d4" },
			flatPrior(FORCED)
		);
		expect(played.rankInLines).toBe(2);
		expect(state.top1Streak).toBe(0);
	});
});

describe("selectMove — endgame technique by Elo (Appendix E §3.5)", () => {
	it("τ ×1.5 in endgames below 1200, ×0.7 from 1800, unchanged between and outside endgames", () => {
		const s = createSelectionState();
		expect(selectionParams(1000, s, "endgame").tau).toBeCloseTo(1.5 * tauFor(1000), 12);
		expect(selectionParams(2000, s, "endgame").tau).toBeCloseTo(0.7 * tauFor(2000), 12);
		expect(selectionParams(1500, s, "endgame").tau).toBeCloseTo(tauFor(1500), 12);
		expect(selectionParams(1000, s, "middlegame").tau).toBeCloseTo(tauFor(1000), 12);
		expect(selectionParams(2000, s).tau).toBeCloseTo(tauFor(2000), 12);
		expect(endgameTauFor(1199, "endgame")).toBe(1.5);
		expect(endgameTauFor(1200, "endgame")).toBe(1);
		expect(endgameTauFor(1800, "endgame")).toBe(0.7);
		// Stacks with the streak term.
		const streak = { ...createSelectionState(), top1Streak: 12 };
		expect(selectionParams(1000, streak, "endgame").tau).toBeCloseTo(1.5 * 1.3 * tauFor(1000), 12);
	});
	it("protects conversion at both high and low Elo while retaining the won-endgame prior", () => {
		const ROOK_ENDGAME = "8/8/4k3/8/8/8/4P3/R3K3 w - - 0 40";
		const WON = [
			line(ROOK_ENDGAME, "e2e4", { cp: 600 }, 1),
			line(ROOK_ENDGAME, "e1d2", { cp: 590 }, 2),
		];
		const m = selectMove(
			WON,
			ctx({ fen: ROOK_ENDGAME, targetElo: 2000, ply: 70, phase: "endgame", rng: createRng("won") })
		);
		const text = m.rationale.join(" ");
		expect(text).toContain("conversion: preserving the win");
		expect(m.uci).toBe("e2e4");
		expect(text).toContain("won-endgame-technique ×1.5");
		const weak = selectMove(
			WON,
			ctx({ fen: ROOK_ENDGAME, targetElo: 1000, ply: 70, phase: "endgame", rng: createRng("won") })
		);
		expect(weak.rationale.join(" ")).toContain("conversion: preserving the win");
		expect(weak.uci).toBe("e2e4");
	});
});

describe("selectMove — form", () => {
	it("form shifts the effective Elo used for every band", () => {
		const m = selectMove(TWO, ctx({ targetElo: 1500, form: 1, rng: createRng(2) }), flatPrior(TWO));
		expect(m.rationale.join(" ")).toContain("E=1650");
	});
});
