// test/service/game-session/maia-session.test.ts — the session's pure Maia helpers (2026-09-13):
// H6.3 the per-game size commitment, H7.3 the predicted-position query built from the pipeline's
// own inputs, H8 the pre-inferred answer attached to the hold's context.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { LIMITS } from "@core/constants/limits";
import { MAIA, MAIA_INPUT } from "@core/constants/maia";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { createSelectionState } from "@core/strength/move-selector";
import { maiaSelfElo, pressureTerms, sliderEloOffset } from "@core/strength/selection-elo";
import type { SelectionContext } from "@core/strength/types";
import {
	attachPredictedPolicy,
	commitMaiaSize,
	commitmentSuperseded,
	maiaSizeForGame,
	type PredictedPolicyAnswer,
	policyAnswerFor,
	predictedPolicyInputs,
	samePosition,
} from "@service/game-session/maia-session";
import { type OwnMoveBudgetInput, ownMoveMaiaElo } from "@service/game-session/recommendation";
import type { Settings } from "@typedefs/settings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_EP = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

const result: PolicyResult = {
	moves: [
		["e7e5", 0.5],
		["c7c5", 0.3],
	],
	wdl: [0.3, 0.4, 0.3],
	size: "79m",
	ms: 12,
};

describe("H6.3 — one Maia size per game", () => {
	it("maps the target to the band's size (79M everywhere since 2026-09-13), the prior size above the ceiling, none above LIMITS.eloMax", () => {
		expect(maiaSizeForGame(1200)).toBe("79m");
		expect(maiaSizeForGame(1650)).toBe("79m");
		expect(maiaSizeForGame(2300)).toBe("79m");
		expect(maiaSizeForGame(MAIA.eloMax)).toBe(MAIA.prior.size);
		expect(maiaSizeForGame(MAIA.prior.eloMax)).toBe(MAIA.prior.size);
		expect(maiaSizeForGame(MAIA.prior.eloMax + 1)).toBeNull();
		expect(maiaSizeForGame(LIMITS.eloMax)).toBeNull();
	});

	it("records what the commitment was made from, and only an explicit change supersedes it", () => {
		const commit = commitMaiaSize(1350, { targetElo: 1200, matchOpponentRating: true });
		expect(commit).toEqual({
			size: "79m",
			targetElo: 1350,
			settingsTarget: 1200,
			matchOpponent: true,
		});
		// An opponent-matched drift changes the derived target, not the stored one: not superseded.
		expect(commitmentSuperseded(commit, { targetElo: 1200, matchOpponentRating: true })).toBe(false);
		expect(commitmentSuperseded(commit, { targetElo: 1800, matchOpponentRating: true })).toBe(true);
		expect(commitmentSuperseded(commit, { targetElo: 1200, matchOpponentRating: false })).toBe(true);
	});
});

describe("H7.3 — the predicted position's query", () => {
	const settings: Settings = { ...DEFAULT_SETTINGS, enabled: true };
	const position: OwnMoveBudgetInput = {
		fen: AFTER_E4_E5,
		ply: 2,
		myClockMs: 180_000,
		oppClockMs: 180_000,
		timeControl: { baseMs: 180_000, incMs: 0 },
		tau: 0.5,
		budgetUsedRatio: 0,
		targetElo: 1650,
		form: 0.2,
		maia: true,
	};
	const base = {
		fen: AFTER_E4_E5,
		history: { fen: START, moves: ["e2e4", "e7e5"] },
		position,
		settings,
		size: "79m" as const,
		opponentElo: 1700,
	};

	it("carries the committed size, the real history window ending in the fen, and both ratings", () => {
		const q = predictedPolicyInputs(base);
		expect(q).not.toBeNull();
		expect(q?.inputs.size).toBe("79m");
		expect(q?.inputs.fen).toBe(AFTER_E4_E5);
		expect(q?.inputs.historyFens).toHaveLength(3);
		expect(q?.inputs.historyFens.at(-1)).toBe(AFTER_E4_E5);
		expect(q?.historyPlies).toBe(3);
		expect(q?.inputs.oppoElo).toBe(1700);
		expect(q?.inputs.selfElo).toBe(q?.selfElo ?? -1);
		expect(predictedPolicyInputs({ ...base, size: null })).toBeNull();
		expect(predictedPolicyInputs({ ...base, position: { ...position, targetElo: 3201 } })).toBeNull();
	});

	it("selfElo is the pipeline's own rating for the position (ownMoveMaiaElo: pressure, slider, context)", () => {
		const relaxed = predictedPolicyInputs(base);
		expect(relaxed?.selfElo).toBe(ownMoveMaiaElo(position, settings).selfElo);
		expect(relaxed?.selfElo).toBe(
			maiaSelfElo({
				targetElo: 1650,
				form: 0.2,
				blunderScale: settings.strength.blunderScale,
				pressureReduction: 0,
				contextEloPenalty: ownMoveMaiaElo(position, settings).contextEloPenalty,
			})
		);
		// Opponent clock pressure lowers the rating asked about, exactly as `pressureTerms` says.
		const pressedPosition = { ...position, oppClockMs: 4_000, myClockMs: 60_000 };
		const pressed = predictedPolicyInputs({ ...base, position: pressedPosition });
		const terms = pressureTerms({
			fen: AFTER_E4_E5,
			myClockMs: 60_000,
			oppClockMs: 4_000,
			baseMs: 180_000,
			incrementMs: 0,
		});
		expect(terms.pressureReduction).toBeGreaterThan(0);
		expect(pressed?.selfElo).toBe(ownMoveMaiaElo(pressedPosition, settings).selfElo);
		expect(pressed?.selfElo ?? 0).toBeLessThan(relaxed?.selfElo ?? 0);
		// H2: the slider is an Elo offset — a higher mistakes knob asks for a lower rating.
		const easier = predictedPolicyInputs({
			...base,
			settings: { ...settings, strength: { ...settings.strength, blunderScale: 2 } },
		});
		expect(sliderEloOffset(2)).toBe(MAIA.slider.eloSpan);
		expect(easier?.selfElo ?? 0).toBeLessThan(relaxed?.selfElo ?? 0);
	});

	it("above MAIA.eloMax the H15 prior's size and Elo clamp apply", () => {
		const high = { ...position, targetElo: 3100 };
		const q = predictedPolicyInputs({ ...base, position: high, size: MAIA.prior.size });
		expect(q?.inputs.size).toBe(MAIA.prior.size);
		expect(q?.selfElo).toBe(
			Math.min(ownMoveMaiaElo(high, settings).selfElo, MAIA.conditioningEloMax)
		);
		expect(q?.selfElo ?? 0).toBeLessThanOrEqual(MAIA.conditioningEloMax);
	});

	it("falls back to the degenerate single frame and our own rating when history and opponent are unknown", () => {
		const q = predictedPolicyInputs({
			...base,
			history: { fen: START, moves: ["d2d4"] },
			opponentElo: null,
		});
		expect(q?.inputs.historyFens).toEqual([AFTER_E4_E5]);
		expect(q?.historyPlies).toBe(1);
		expect(q?.inputs.oppoElo).toBe(q?.selfElo ?? -1);
		expect(q?.historyPlies ?? 0).toBeLessThan(MAIA_INPUT.history);
	});
});

describe("H7.3 / H8 — the answer follows the position, not the FEN string", () => {
	const answer: PredictedPolicyAnswer = {
		identity: "matching-query",
		fen: AFTER_E4,
		result,
		selfElo: 1500,
		historyPlies: 2,
	};

	it("samePosition ignores counters and a non-usable en-passant spelling", () => {
		expect(samePosition(AFTER_E4, AFTER_E4_EP)).toBe(true);
		expect(samePosition(AFTER_E4, AFTER_E4_E5)).toBe(false);
	});

	it("policyAnswerFor re-keys the answer to the page's FEN string, or refuses another position", () => {
		expect(policyAnswerFor(answer, AFTER_E4, "matching-query")).toBe(answer);
		expect(policyAnswerFor(answer, AFTER_E4, "stale-query")).toBeNull();
		expect(policyAnswerFor(answer, AFTER_E4, undefined)).toBeNull();
		expect(policyAnswerFor(answer, AFTER_E4_EP, "matching-query")).toEqual({
			...answer,
			fen: AFTER_E4_EP,
		});
		expect(policyAnswerFor(answer, AFTER_E4_E5, "matching-query")).toBeNull();
		expect(policyAnswerFor(null, AFTER_E4, "matching-query")).toBeNull();
	});

	it("attachPredictedPolicy sets ctx.maia only for the hold's own position", () => {
		const ctx = (fen: string): SelectionContext => ({
			fen,
			targetElo: 1200,
			form: 0,
			ply: 1,
			phase: "opening",
			myClockMs: 60_000,
			oppClockMs: 60_000,
			selectionMode: "hybrid",
			blunderScale: 1,
			rng: createRng(1),
			state: createSelectionState(),
		});
		const hit = ctx(AFTER_E4_EP);
		expect(attachPredictedPolicy(hit, answer, "matching-query")).toBe(true);
		expect(hit.maia).toBe(result);
		const miss = ctx(AFTER_E4_E5);
		expect(attachPredictedPolicy(miss, answer, "matching-query")).toBe(false);
		expect(miss.maia).toBeUndefined();
		expect(attachPredictedPolicy(ctx(AFTER_E4), null, "matching-query")).toBe(false);
	});
});
