// test/core/strength/constants.test.ts
import { describe, expect, it } from "bun:test";
import { SELECTION_CONSTANTS as C } from "@core/strength/constants";

describe("SELECTION_CONSTANTS transcribes §7.2 / Appendix E", () => {
	it("score and win-probability constants", () => {
		expect(C.score.winProbK).toBe(0.00368208);
		expect(C.score.mateCpBase).toBe(1000);
		expect(C.score.mateHorizon).toBe(100);
	});
	it("blunder channel", () => {
		expect(C.blunder.mistakeProb).toBe(0.65);
		expect(C.blunder.mistakeLoss).toEqual([0.1, 0.3]);
		expect(C.blunder.blunderLoss).toEqual([0.3, 0.7]);
		expect(C.blunder.clockPressureMs).toBe(20_000);
		expect(C.blunder.clockGain).toBe(1.5);
		expect(C.blunder.complexityGain).toBe(0.6);
		expect(C.blunder.complexityStdCp).toBe(150);
		expect(C.blunder.damperMoves).toBe(3);
		expect(C.blunder.damperMultiplier).toBe(0.3);
	});
	it("streak and hybrid terms", () => {
		expect(C.tau.streakLength).toBe(12);
		expect(C.tau.streakMultiplier).toBe(1.3);
		expect(C.hybridBestmovePrior).toBe(2);
	});
	it("prior table (Appendix E §3.4)", () => {
		expect(C.prior.recapture).toBe(2.5);
		expect(C.prior.checkWeak).toBe(1.4);
		expect(C.prior.checkStrong).toBe(1.15);
		expect(C.prior.captureUndefended).toBe(1.8);
		expect(C.prior.castling).toBe(1.6);
		expect(C.prior.development).toBe(1.4);
		expect(C.prior.quietKingMove).toBe(0.35);
		expect(C.prior.underpromotion).toBe(0.05);
		expect(C.prior.kingShieldPawnPush).toBe(0.6);
		expect(C.prior.rookLift).toBe(0.7);
		expect(C.prior.retreat).toBe(0.6);
		expect(C.prior.waitingMoveWeak).toBe(0.7);
		expect(C.prior.sacrificeWeak).toBe(0.5);
		expect(C.prior.sacrificeStrong).toBe(0.9);
		expect(C.prior.backAndForth).toBe(0.5);
		expect(C.prior.kingActivation).toBe(1.5);
	});
	it("situational modifiers (Appendix E §3.3)", () => {
		expect(C.situational.aheadCp).toBe(300);
		expect(C.situational.tradeWhenAhead).toBe(1.8);
		expect(C.situational.quietSharpWhenAhead).toBe(0.7);
		expect(C.situational.forcingWhenBehind).toBe(1.4);
		expect(C.situational.tradeWhenBehind).toBe(0.6);
		expect(C.situational.fullElo).toBe(1400);
	});
	it("is deeply frozen", () => {
		expect(Object.isFrozen(C)).toBe(true);
		expect(Object.isFrozen(C.prior)).toBe(true);
		expect(Object.isFrozen(C.blunder.b0)).toBe(true);
	});
});
