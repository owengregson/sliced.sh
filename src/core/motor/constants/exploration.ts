/** The own-turn exploration planner (§9.3, §8.4b) and the mouse repertoire. */

import type { PersonaId } from "@typedefs/settings";
import type { MsRange } from "../types";

/**
 * Mouse repertoire design priors, NOT fitted Elo/cursor measurements. Chess expertise papers
 * motivate salient/relational attention, but do not measure mouse gestures or their frequency.
 * Intents in order: still, prepare, inspect, compare, verify, relate.
 */
export const REPERTOIRE = {
	eloRange: [800, 2800] as const,
	defaultElo: 1600,
	minWindowMs: 1000,
	lowClockMs: 8000,
	bouts: [2, 3] as const,
	repeatScale: 0.45,
	baseWeights: [0.32, 0.1, 0.28, 0.14, 0.12, 0.04] as const,
	expertWeights: [0.38, 0.18, 0.16, 0.08, 0.1, 0.1] as const,
	persona: {
		balanced: [1, 1, 1, 1, 1, 1],
		cautious: [1, 0.8, 1, 1.25, 1.6, 1],
		aggressive: [0.9, 1.3, 1.2, 1, 0.8, 1.2],
		blitz: [1.4, 1.6, 0.8, 0.6, 0.8, 0.8],
	} satisfies Record<PersonaId, readonly number[]>,
	openingPrepareScale: 2,
	sharpVerifyScale: 2.5,
	sharpStillScale: 0.7,
	endgameRelationScale: 1.5,
	orientationFrac: [0.08, 0.16] as MsRange,
	dwellMs: [240, 780] as MsRange,
	verifyDwellMs: [420, 1050] as MsRange,
	compareMinCandidates: 2,
} as const;

/** §9.3 exploration planner and §8.4b phase allocation. */
export const EXPLORATION = {
	/** Below this pre-touch budget the plan is `[rest]` only. */
	minWindowMs: 600,
	orientationFrac: [0.05, 0.15] as MsRange,
	decisionPauseFrac: [0.15, 0.4] as MsRange,
	hoverDwellMs: [200, 900] as MsRange,
	hoverCountWeights: [0.55, 0.3, 0.15],
	/** P(any hover) = hoverProb·(1 + nSlope·(n−1))·ramp(waitMs), capped. */
	hoverNSlope: 0.2,
	hoverRampMs: [600, 3000] as MsRange,
	hoverProbCap: 0.95,
	traceFrac: [0.4, 0.9] as MsRange,
	traceDwellMs: [100, 300] as MsRange,
	/** Feint: pause over the piece as if to grab, then pull back this far. */
	feintDwellMs: [80, 200] as MsRange,
	feintRetreatPx: [10, 30] as MsRange,
	tracePointRectPx: 6,
	/** Idle tremor covers at most this fraction of a rest. */
	restTremorFrac: 0.6,
	/** Resting on the dropped piece: Gaussian σ and hard radius around the anchor. */
	restPieceSigmaPx: 10,
	restPieceMaxPx: 30,
} as const;
