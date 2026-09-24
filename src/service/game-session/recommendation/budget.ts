/** Search and think-time budgets for an own-move search, from the clock and the target alone. */

import { MAIA } from "@core/constants/maia";
import { SEARCH_BUDGET } from "@core/constants/search";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import { effectiveElo } from "@core/strength/elo-map";
import { usesNativeSelection } from "@core/strength/selection-mode";
import { budgetController, scheduleAlloc } from "@core/timing/budget";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { pieceCounts } from "@core/timing/features";
import type { TcClass } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import type { TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

export const MS_PER_S = 1000;

export interface SearchBudget {
	movetimeMs: number;
	depthCap: number;
	multiPv: number;
	/**
	 * Maia's human-depth frame, captured alongside the main search. It is part of the cache
	 * identity, so predicted-position searches must request the same depth. Absent uses the
	 * engine client's default feature depth.
	 */
	featureDepth?: number;
}

/** Seconds/ms of clock the budget controller needs, without any engine input. */
export interface BudgetPosition {
	fen: string;
	ply: number;
	myClockMs: number;
	baseSec: number;
	incSec: number;
	tc: TcClass;
	/** `Persona.tau` (time-management skill) — the reserve scales with it. */
	tau: number;
	budgetUsedRatio: number;
	targetElo?: number;
}

/** `TimeControl` in seconds; `[0, 0]` when the adapter reported none (untimed). */
export function tcSeconds(tc: TimeControl | undefined): [number, number] {
	if (!tc) return [0, 0];
	return [tc.baseMs / MS_PER_S, tc.incMs / MS_PER_S];
}

/**
 * Expected think time before analysis, from the timing model's allocation alone. The allocation
 * already includes own-clock pressure.
 *
 * **Independent of `timing.baseSpeed`** (owner, 2026-09-15: "settings shouldnt really be
 * modifying the model's ability to give good moves"). This number sizes the engine's search
 * (`searchBudget`) and the Maia short-think penalty (`maiaContextPenalty`), so a user asking for
 * faster moves must not thereby get a shorter search or a lower effective rating — the engine
 * keeps the allocation the target rating implies, and only the wall-clock wrapper around it
 * moves. It used to multiply by the raw `timing.speedScale` slider, which was 1 at the default,
 * so nothing about a default install's search changes with this.
 */
export function estimatedThinkMs(p: BudgetPosition, settings: Settings): number {
	const { pieces, pawns } = pieceCounts(p.fen);
	const F = TIMING_CONSTANTS.features;
	// Match the virtual clock used by computeFeatures for untimed games.
	const untimed = p.tc === "untimed";
	const baseS = untimed ? TIMING_CONSTANTS.untimedVirtual.clockS : p.baseSec;
	const incS = untimed ? TIMING_CONSTANTS.untimedVirtual.incS : p.incSec;
	const inputs = {
		tc: p.tc,
		base_s: baseS,
		base_eff: baseS + F.incWeight * incS,
		inc_s: incS,
		clock_s: untimed ? baseS : Math.max(0, p.myClockMs / MS_PER_S),
		ply: p.ply,
		non_pawn_pieces: pieces,
		pawns,
		budget_used_ratio: untimed ? 0 : p.budgetUsedRatio,
		targetElo: p.targetElo ?? settings.strength.targetElo,
	};
	const allocSec = settings.timing.respectBudget
		? budgetController(inputs, {
				s_game: 0,
				iota: 0,
				pi_p: 0,
				tau: p.tau,
				rho_mirror: 0,
				motor_k: 1,
			})
		: scheduleAlloc(inputs);
	return allocSec * MS_PER_S;
}

/** Inputs for an own-move search's clock and think-time limits. */
export interface SearchBudgetInput {
	tc: TcClass;
	/** Our remaining clock in ms; `0` when the page reports none (an untimed game). */
	myClockMs: number;
	/** Legal moves in the position — exactly one means there is nothing to search (0 = unreadable). */
	legalMoves: number;
	/** Expected think time from estimatedThinkMs; bounds how much may be spent searching. */
	plannedThinkMs: number;
	/** Active opponent-matched target, when different from the saved fixed target. */
	targetElo?: number;
	/** Form only decides whether Hybrid uses native selection; sampling breadth retains its target. */
	form?: number;
	/**
	 * Maia's referee search (`maiaSearchMode`): always the sampling breadth, whatever the
	 * `selectionMode` — the human policy needs the alternatives the engine would otherwise not score.
	 */
	maia?: boolean;
}

/**
 * Bound search time by speed class, expected think time and remaining clock, with a
 * minimum usable search duration. Exactly one legal move uses that minimum.
 */
export function searchBudget(input: SearchBudgetInput, settings: Settings): SearchBudget {
	const { tc, myClockMs, legalMoves, plannedThinkMs } = input;
	const bounds = [
		SEARCH_BUDGET.moveMs[tc],
		SEARCH_BUDGET.thinkFraction * plannedThinkMs,
		// An untimed game has no clock to protect; a timed one in trouble has nothing else to give.
		myClockMs > 0 ? SEARCH_BUDGET.clockFraction * myClockMs : Number.POSITIVE_INFINITY,
	];
	const movetimeMs =
		// An unreadable FEN also yields zero legal moves; only a forced move takes the floor.
		legalMoves === 1
			? SEARCH_BUDGET.minMovetimeMs
			: clamp(Math.min(...bounds), SEARCH_BUDGET.minMovetimeMs, SEARCH_BUDGET.maxMovetimeMs);
	const targetElo = input.targetElo ?? settings.strength.targetElo;
	const depthCap = automaticDepthForElo(targetElo);
	const adaptive =
		movetimeMs < SEARCH_BUDGET.multiPvSmallMs
			? SEARCH_BUDGET.multiPvSmall
			: movetimeMs < SEARCH_BUDGET.multiPvMediumMs
				? SEARCH_BUDGET.multiPvMedium
				: SEARCH_BUDGET.multiPvLarge;
	const sampling =
		input.maia === true ||
		!usesNativeSelection(settings.strength.selectionMode, effectiveElo(targetElo, input.form ?? 0));
	const breadth = sampling
		? (SEARCH_BUDGET.selectionCandidates.find((band) => targetElo <= band.maxElo)?.count ?? 0)
		: 0;
	const wanted = Math.max(adaptive, settings.engine.multiPv, breadth);
	const multiPv = legalMoves > 0 ? Math.min(wanted, legalMoves) : wanted;
	return { movetimeMs, depthCap, multiPv };
}

/** Candidate-search ceiling; run() also requires it to fit the shared preparation deadline. */
export function extraSearchMs(budget: SearchBudget): number {
	return Math.max(SEARCH_BUDGET.minMovetimeMs, Math.min(MAIA.extraSearchMs, budget.movetimeMs));
}

/**
 * Whether `searchBudget`'s clock fraction bound the movetime (the search was cut short to protect
 * the clock): the extra search is not spent then. `movetimeMs` is the smallest bound (floored),
 * so the clock bound binds exactly when it is at or under the movetime.
 */
export function clockBoundSearch(myClockMs: number, budget: SearchBudget): boolean {
	return myClockMs > 0 && SEARCH_BUDGET.clockFraction * myClockMs <= budget.movetimeMs;
}
