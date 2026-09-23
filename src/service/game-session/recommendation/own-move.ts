/**
 * Own-move derivations shared by the current position's search and predicted-position
 * pre-analysis: the think-time plan, Maia's query rating, the clock race and the search budget.
 * Both callers must derive identical answers, or a correct prediction misses the cache.
 */

import { loadPosition } from "@core/chess/fen";
import { isLoneKing } from "@core/chess/material";
import { legalMoves } from "@core/chess/san";
import { MAIA } from "@core/constants/maia";
import { MAIA_CONTEXT_THINK_REF_MS, SEARCH_BUDGET } from "@core/constants/search";
import { humanDepth } from "@core/engine/depth-policy";
import { maiaSelfElo, type PressureTerms, pressureTerms } from "@core/strength/selection-elo";
import { tcClass } from "@core/timing/features";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import type { TcClass } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import type { TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

import { estimatedThinkMs, MS_PER_S, type SearchBudget, searchBudget, tcSeconds } from "./budget";

/** Position and clock inputs shared by current and predicted-position searches. */
export interface OwnMoveBudgetInput {
	fen: string;
	ply: number;
	myClockMs: number;
	oppClockMs?: number;
	timeControl: TimeControl | undefined;
	/** `Persona.tau` — the reserve scales with it. */
	tau: number;
	budgetUsedRatio: number;
	targetElo?: number;
	form?: number;
	/** `maiaSearchMode(...)` for this search; the pre-analysis must pass the same answer. */
	maia?: boolean;
}

/** What `ownMoveBudget` derives from the clock and the position before sizing the search. */
interface OwnMovePlan {
	tc: TcClass;
	baseSec: number;
	incSec: number;
	plannedThinkMs: number;
	legalCount: number;
}

function ownMovePlan(input: OwnMoveBudgetInput, settings: Settings): OwnMovePlan {
	const [baseSec, incSec] = tcSeconds(input.timeControl);
	const tc = tcClass(baseSec, incSec);
	const plannedThinkMs = estimatedThinkMs(
		{
			fen: input.fen,
			ply: input.ply,
			myClockMs: input.myClockMs,
			baseSec,
			incSec,
			tc,
			tau: input.tau,
			budgetUsedRatio: input.budgetUsedRatio,
			targetElo: input.targetElo ?? settings.strength.targetElo,
		},
		settings
	);
	return { tc, baseSec, incSec, plannedThinkMs, legalCount: legalMoves(input.fen).length };
}

/** Clock and think-time inputs to Maia's context penalty. */
export interface MaiaContextInput {
	myClockMs: number;
	/** The game's base clock in ms; `0` = unknown or untimed (the clock term is 0). */
	baseMs: number;
	/** `estimatedThinkMs` for this move — the plan-independent allocation the search is sized by. */
	plannedThinkMs: number;
	/** Sustainable allocation for this position on a full clock. */
	referenceThinkMs?: number;
	tc: TcClass;
}

export interface MaiaContextTerms {
	/** `clamp(1 − myClockMs / baseMs, 0, 1)`; 0 without a base clock. */
	clockPressure: number;
	/** Shortfall from the healthy-clock reference, clamped to 0–1; zero when untimed. */
	shortThink: number;
	/** The Elo penalty, capped at `MAIA.context.maxPenalty`. */
	penalty: number;
}

/**
 * Reduce effective strength for clock pressure and curtailed thinking, including their
 * interaction. The selector applies Maia's ambiguity penalty separately.
 */
export function maiaContextPenalty(input: MaiaContextInput): MaiaContextTerms {
	const K = MAIA.context;
	const clockPressure =
		input.baseMs > 0 && Number.isFinite(input.myClockMs)
			? clamp(1 - input.myClockMs / input.baseMs, 0, 1)
			: 0;
	const ref = input.referenceThinkMs ?? MAIA_CONTEXT_THINK_REF_MS[input.tc];
	const shortThink = ref > 0 ? clamp(1 - input.plannedThinkMs / ref, 0, 1) : 0;
	const penalty = Math.min(
		K.maxPenalty,
		K.clockElo * clockPressure +
			K.thinkElo * shortThink +
			K.interactionElo * clockPressure * shortThink
	);
	return { clockPressure, shortThink, penalty };
}

/** The shared Maia query and selection rating, with its contributing terms. */
export interface MaiaEloContext {
	/** Canonical self conditioning shared by the query and selection safeguards. */
	selfElo: number;
	/** Clock/think penalty passed to the selector as contextEloPenalty. */
	contextEloPenalty: number;
	context: MaiaContextTerms;
	pressure: PressureTerms;
}

/**
 * Derive the Maia query rating from opponent pressure, the mistakes setting and clock/think
 * context. Predicted-position analysis and the selector share these terms and feature depth.
 */
export function ownMoveMaiaElo(input: OwnMoveBudgetInput, settings: Settings): MaiaEloContext {
	const plan = ownMovePlan(input, settings);
	const baseMs = plan.baseSec * MS_PER_S;
	const pressure = pressureTerms({
		fen: input.fen,
		myClockMs: input.myClockMs,
		oppClockMs: input.oppClockMs ?? 0,
		baseMs,
		incrementMs: plan.incSec * MS_PER_S,
	});
	const context = maiaContextPenalty({
		myClockMs: input.myClockMs,
		baseMs,
		plannedThinkMs: plan.plannedThinkMs,
		// The same allocation at a full clock: what an unhurried move of this class gets. Since
		// 2026-09-15 `estimatedThinkMs` reads no speed setting at all, so this no longer needs the
		// `speedScale: 1` override that used to keep the ratio free of the user's knob.
		referenceThinkMs: ownMovePlan({ ...input, myClockMs: baseMs, budgetUsedRatio: 0 }, settings)
			.plannedThinkMs,
		tc: plan.tc,
	});
	const selfElo = maiaSelfElo({
		targetElo: input.targetElo ?? settings.strength.targetElo,
		form: input.form ?? 0,
		blunderScale: settings.strength.blunderScale,
		pressureReduction: pressure.pressureReduction,
		contextEloPenalty: context.penalty,
	});
	return { selfElo, contextEloPenalty: context.penalty, context, pressure };
}

/**
 * Capture the frame at Maia's effective human depth only when Maia selects the move.
 * Including it in ownMoveBudget keeps current and predicted-position searches aligned.
 */
export function ownMoveFeatureDepth(
	input: OwnMoveBudgetInput,
	settings: Settings
): number | undefined {
	return input.maia === true ? humanDepth(ownMoveMaiaElo(input, settings).selfElo) : undefined;
}

/** The clock-race policy for an own-move position, as `ownMoveBudget` and the pipeline read it. */
export function ownMoveClockRace(
	input: Pick<OwnMoveBudgetInput, "fen" | "myClockMs" | "oppClockMs" | "timeControl">
): ReturnType<typeof clockRacePolicy> {
	const [baseSec, incSec] = tcSeconds(input.timeControl);
	const us = loadPosition(input.fen)?.turn();
	return clockRacePolicy({
		ownClockMs: input.myClockMs,
		opponentClockMs: input.oppClockMs ?? 0,
		baseMs: baseSec * MS_PER_S,
		incrementMs: incSec * MS_PER_S,
		loneKing: us !== undefined && isLoneKing(input.fen, us),
	});
}

/**
 * Shared search budget for current and predicted positions. Matching depth, breadth and
 * feature depth lets a correct prediction satisfy the own-move cache request.
 */
export function ownMoveBudget(input: OwnMoveBudgetInput, settings: Settings): SearchBudget {
	const { tc, plannedThinkMs, legalCount } = ownMovePlan(input, settings);
	const shaped = searchBudget(
		{
			tc,
			myClockMs: input.myClockMs,
			legalMoves: legalCount,
			plannedThinkMs,
			targetElo: input.targetElo ?? settings.strength.targetElo,
			form: input.form ?? 0,
			...(input.maia === undefined ? {} : { maia: input.maia }),
		},
		settings
	);
	// Predicted-position searches need the same feature depth for cache reuse.
	const featureDepth = ownMoveFeatureDepth(input, settings);
	const budget = featureDepth === undefined ? shaped : { ...shaped, featureDepth };
	const race = ownMoveClockRace(input);
	if (!race) return budget;
	const wanted = race.opponentOnly
		? Math.max(budget.multiPv, SEARCH_BUDGET.opponentRaceCandidates)
		: budget.multiPv;
	return {
		...budget,
		movetimeMs: Math.min(budget.movetimeMs, race.maxSearchMs),
		multiPv: legalCount > 0 ? Math.min(wanted, legalCount) : wanted,
	};
}
