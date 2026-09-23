/** Builds a recommendation with one shared preparation budget for policy and engine work. */

import { loadPosition } from "@core/chess/fen";
import { matchingHistory, type PositionHistory, positionKey } from "@core/chess/history";
import { isLoneKing } from "@core/chess/material";
import { phase as phaseOf } from "@core/chess/phase";
import { legalMoves, parseUci, playUci, uciToSan } from "@core/chess/san";
import { BOOK } from "@core/constants/books";
import { MAIA, MAIA_INPUT, type MaiaSize } from "@core/constants/maia";
import { MAIA_CONTEXT_THINK_REF_MS, MAIA_SEARCH, SEARCH_BUDGET } from "@core/constants/search";
import { TABLEBASE } from "@core/constants/tablebase";
import { automaticDepthForElo, humanDepth } from "@core/engine/depth-policy";
import { requestEloForTarget } from "@core/engine/options";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import { maiaConditioningElo, maiaSizeFor, usesMaia } from "@core/policy/maia-size";
import { policyQueryIdentity } from "@core/policy/policy-query";
import type { PolicyInferenceInputs, PolicyPort, PolicyResult } from "@core/policy/types";
import type { Rng } from "@core/rng";
import type { BookContext, BookPolicy } from "@core/strength/book/book-policy";
import { isTrap, lineFacts } from "@core/strength/book/book-policy";
import { conversionPool, isImmediateMate } from "@core/strength/conversion";
import { effectiveElo } from "@core/strength/elo-map";
import { isMaxStrength } from "@core/strength/max-strength";
import { selectMove } from "@core/strength/move-selector";
import { avoidRepetition, repetitionRisk } from "@core/strength/repetition";
import { maiaSelfElo, type PressureTerms, pressureTerms } from "@core/strength/selection-elo";
import { usesNativeSelection } from "@core/strength/selection-mode";
import { decideTablebase } from "@core/strength/tablebase-policy";
import type { SelectionContext, SelectionState } from "@core/strength/types";
import { tablebaseChosenMove } from "@core/tablebase/choice";
import type { TablebasePort } from "@core/tablebase/client";
import { pieceCount, type TablebaseProbe } from "@core/tablebase/probe";
import { rankTablebaseMoves } from "@core/tablebase/rank";
import { budgetController, scheduleAlloc } from "@core/timing/budget";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { pieceCounts, tcClass } from "@core/timing/features";
import { remainingMoveWindow } from "@core/timing/move-window";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import type { TimingModel } from "@core/timing/timing-model";
import type { TcClass, TimingContext, TimingPlan } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import { errorMessage } from "@core/util/errors";
import { newId } from "@core/util/ids";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, PositionSnapshot, Recommendation, TimeControl } from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";

import { remainingClockMs } from "./clock";
import { searchResultBeforeDeadline } from "./search-deadline";

const MS_PER_S = 1000;

/** The engine surface the pipeline needs (`EngineController` satisfies it). */
export interface PipelineEngine {
	analyse(req: AnalysisRequest): AnalysisHandle;
	engineElo(): number | undefined;
}

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

/**
 * Charge preparation to the sampled opponent-arrival-to-release window. A late search cannot
 * retroactively become a longer human think. The hand sheds optional actions and retains its
 * physical limits; any resulting overrun is measured separately and excluded from pace learning.
 * Move choice is still completed before execution; this never trades away search quality.
 */
export function accountPreparation(plan: TimingPlan, searchDoneMs: number): TimingPlan {
	const room = remainingMoveWindow(plan, searchDoneMs);
	return {
		...plan,
		features: {
			...plan.features,
			preparationMs: room.elapsedMs,
			preparationOverrunMs: room.overrunMs,
		},
		rationale:
			room.overrunMs > 0
				? [
						...plan.rationale,
						`preparation: release target short by ${room.overrunMs.toFixed(0)} ms; optional actions omitted`,
					]
				: plan.rationale,
	};
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

/** What decides whether an own-move search is Maia's referee search. */
export interface MaiaSearchInput {
	targetElo: number;
	/** A policy port exists for this session (`RecommendationPipelineDeps.policy`). */
	policy: boolean;
	/** The position is a clock race (`clockRacePolicy` non-null): the engine is faster, skip Maia. */
	clockRace: boolean;
}

/**
 * Whether Maia selects the move. Predicted-position searches use the same decision for
 * strength, breadth and feature depth so their cache entries remain reusable.
 */
export function maiaSearchMode(input: MaiaSearchInput): boolean {
	return input.policy && !input.clockRace && usesMaia(input.targetElo);
}

/**
 * Maia supplies population opening choices below the book threshold. The book remains
 * available as a fallback when the policy query returns no answer.
 */
export function maiaPlaysOpening(input: { targetElo: number; form: number }): boolean {
	return usesMaia(input.targetElo) && effectiveElo(input.targetElo, input.form) < BOOK.maiaOnlyElo;
}

/**
 * The strength an own-move search runs at: Maia's referee search is at **full strength** (no
 * `elo`, which the UCI client turns into `UCI_LimitStrength false`), everything else at the
 * native `UCI_Elo` for the target when the engine calibrates that far.
 */
export function refereeElo(targetElo: number, maia: boolean): number | undefined {
	return maia ? undefined : requestEloForTarget(targetElo);
}

/**
 * The Maia query's position history: the last `MAIA_INPUT.history` positions oldest → newest,
 * ending with `fen` itself, replayed from the validated game history. `[fen]` when there is no
 * history that reaches this board (the encoder repeats the earliest position to fill).
 */
export function maiaHistoryFens(history: PositionHistory | undefined, fen: string): string[] {
	const valid = matchingHistory(history, fen);
	const board = valid ? loadPosition(valid.fen) : null;
	if (!valid || !board) return [fen];
	const fens = [board.fen()];
	for (const move of valid.moves) {
		if (!playUci(board, move)) return [fen];
		fens.push(board.fen());
	}
	// Preserve the caller's exact final FEN string after validating the replay.
	fens[fens.length - 1] = fen;
	return fens.slice(-MAIA_INPUT.history);
}

/**
 * Maia's legal moves the referee search left unscored (no line in `scored` starts with them),
 * each at `p ≥ MAIA.minProb`, most likely first. The extra referee search draws its
 * `searchmoves` from the front of this list.
 */
export function maiaUnscoredMoves(
	policy: PolicyResult,
	scored: readonly EvalLine[],
	fen: string
): Array<[uci: string, p: number]> {
	const legal = new Set(legalMoves(fen));
	const seen = new Set(scored.map((line) => line.pvUci[0]));
	const prob = new Map<string, number>();
	for (const [uci, p] of policy.moves) {
		if (!legal.has(uci) || seen.has(uci)) continue;
		prob.set(uci, Math.max(prob.get(uci) ?? 0, p));
	}
	return [...prob].filter(([, p]) => p >= MAIA.minProb).sort((a, b) => b[1] - a[1]);
}

/**
 * Unscored moves earn a referee search when their combined probability or top probability
 * passes its threshold. Return at most extraCandidates roots.
 */
export function maiaExtraSearchmoves(unscored: ReadonlyArray<readonly [string, number]>): string[] {
	let mass = 0;
	for (const [, p] of unscored) mass += p;
	const top = unscored[0]?.[1] ?? 0;
	if (mass < MAIA.extraMassMin && top < MAIA.extraTopProb) return [];
	return unscored.slice(0, MAIA.extraCandidates).map(([uci]) => uci);
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

/**
 * Append unique extra-search candidates without changing the main frame's order.
 * The main best line remains the evaluation and loss reference; a shallower extra
 * search must not replace it with an optimistic score. The selector ranks the merged pool.
 */
export function mergeLines(main: readonly EvalLine[], extra: readonly EvalLine[]): EvalLine[] {
	const seen = new Set(main.map((line) => line.pvUci[0]));
	const added = extra.filter((line) => {
		const uci = line.pvUci[0];
		if (uci === undefined || uci === "" || seen.has(uci)) return false;
		seen.add(uci);
		return true;
	});
	if (added.length === 0) return [...main];
	return [...main, ...added].map((line, i) => ({ ...line, multipv: i + 1 }));
}

/** Maia's legal moves for `fen`, most likely first (ties by UCI), duplicates folded to the max. */
function maiaRankedLegal(policy: PolicyResult, fen: string): Array<[uci: string, p: number]> {
	const legal = new Set(legalMoves(fen));
	const prob = new Map<string, number>();
	for (const [uci, p] of policy.moves) {
		if (!legal.has(uci)) continue;
		prob.set(uci, Math.max(prob.get(uci) ?? 0, p));
	}
	return [...prob].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Cover Maia's legal probability mass, retain available engine continuations, and fill
 * to the minimum root count. Sort roots for stable cache identity. An unreadable board
 * or a policy with no legal moves yields an empty set.
 */
export function shapedRootSet(
	policy: PolicyResult,
	fen: string,
	knownTopMoves: readonly string[] = []
): string[] {
	const K = MAIA_SEARCH.shaped;
	const ranked = maiaRankedLegal(policy, fen);
	if (ranked.length === 0) return [];
	const legal = new Set(legalMoves(fen));
	const roots = new Set<string>();
	let total = 0;
	for (const [, p] of ranked) total += p;
	let covered = 0;
	for (const [uci, p] of ranked) {
		if (roots.size >= K.maxRoots || covered >= K.massCover * total) break;
		roots.add(uci);
		covered += p;
	}
	let forced = 0;
	for (const uci of knownTopMoves) {
		if (forced >= K.knownTopMoves) break;
		if (!legal.has(uci) || roots.has(uci)) continue;
		roots.add(uci);
		forced += 1;
	}
	for (const [uci] of ranked) {
		if (roots.size >= K.minRoots) break;
		roots.add(uci);
	}
	return [...roots].sort();
}

/** One Maia-shaped search: its roots and the budget it runs at. */
export interface ShapedSearchPlan {
	searchmoves: string[];
	/** Root count and budget after any confidence-based reduction. */
	budget: SearchBudget;
	/** Whether Maia's top probability qualifies for a shorter search. */
	confident: boolean;
}

/**
 * Size a search over Maia's roots, shortening confident choices toward the search floor.
 * Predicted-position and own-move searches share this shape for cache reuse. Return null
 * when the policy or an independent engine continuation is unavailable.
 */
export function shapedSearchPlan(
	policy: PolicyResult,
	fen: string,
	knownTopMoves: readonly string[] | undefined,
	budget: SearchBudget,
	targetElo = 0
): ShapedSearchPlan | null {
	const legal = new Set(legalMoves(fen));
	if (!knownTopMoves?.some((uci) => legal.has(uci))) return null;
	const searchmoves = shapedRootSet(policy, fen, knownTopMoves);
	if (searchmoves.length === 0) return null;
	const K = MAIA_SEARCH.shaped;
	const top = maiaRankedLegal(policy, fen)[0]?.[1] ?? 0;
	const confident = top >= K.confidentProb && targetElo <= MAIA.upperVerification.fromElo;
	const floor = SEARCH_BUDGET.minMovetimeMs;
	const movetimeMs = confident
		? Math.max(floor, budget.movetimeMs - K.confidentTimeFraction * (budget.movetimeMs - floor))
		: budget.movetimeMs;
	return {
		searchmoves,
		budget: { ...budget, multiPv: searchmoves.length, movetimeMs },
		confident,
	};
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

export interface RecommendationInput {
	snapshot: PositionSnapshot;
	settings: Settings;
	/** The active target, already opponent-matched when that setting is enabled. */
	targetElo: number;
	persona: PersonaId;
	/** Per-game AR(1) form latent. */
	form: number;
	/** `Persona.tau` of the timing model's per-game persona. */
	tau: number;
	/** UCI moves played this game (oldest first). */
	moves: string[];
	/** Starting FEN and validated move history for repetition-aware searches. */
	history?: PositionHistory;
	expectedOppReply: string | null;
	oppThinkMsHistory: number[];
	myThinkMsHistory: number[];
	selectionState: SelectionState;
	/** Fraction of the starting clock already spent. */
	budgetUsedRatio: number;
	rng: Rng;
	/** Cancels the search when the position moves on. */
	signal?: AbortSignal | undefined;
	nowMs: number;
	engineReady: boolean;
	autoQueen: boolean;
	inputMethod: "drag" | "click";
	/** The opponent rating supplied to Maia; absent uses our own rating. */
	opponentElo?: number;
	/** Model size retained for the game; absent uses maiaSizeFor(targetElo). */
	maiaSize?: MaiaSize;
	/**
	 * Policy answer retained for exactly snapshot.fen; a mismatch is ignored.
	 * knownTopMoves records the engine roots used by predicted-position analysis so the
	 * own-move search can reproduce its cache key. Absent means only Maia's roots are known.
	 */
	policyAnswer?: {
		fen: string;
		identity: string;
		result: PolicyResult;
		selfElo: number;
		historyPlies: number;
		knownTopMoves?: string[];
	};
}

export interface RecommendationOutcome {
	rec: Recommendation;
	/** The number of "reasonable" moves the timing features derived (the hand's exploration size). */
	nReasonable: number;
	/** Whether the chosen move came from the opening book. */
	fromBook: boolean;
	/** Whether the chosen move came from the endgame tablebase (rated Book on the board). */
	fromTablebase?: boolean;
	budget: SearchBudget;
	/** `null` when the engine never answered (book-only or a failed search). */
	analysis: AnalysisResult | null;
}

export interface RecommendationPipelineDeps {
	engine: PipelineEngine;
	timing: TimingModel;
	book: BookPolicy | null;
	/** Optional Maia policy port; a missing answer uses engine selection. */
	policy?: PolicyPort;
	/** Optional endgame tablebase (2026-09-23); absent or unavailable, the engine plays. */
	tablebase?: TablebasePort | null;
	now?: () => number;
}

/** `TimeControl` in seconds; `[0, 0]` when the adapter reported none (untimed). */
function tcSeconds(tc: TimeControl | undefined): [number, number] {
	if (!tc) return [0, 0];
	return [tc.baseMs / MS_PER_S, tc.incMs / MS_PER_S];
}

/** Lines whose first PV move is usable. */
function usableLines(lines: readonly EvalLine[]): EvalLine[] {
	return lines.filter((l) => l.pvUci[0] !== undefined && l.pvUci[0] !== "");
}

/** A quick engine/cache answer keeps the original short inference window, never an extra search. */
async function finishTimingPreparation(
	pending: Promise<void>,
	remainingMs: number,
	signal?: AbortSignal
): Promise<void> {
	if (remainingMs <= 0 || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, remainingMs);
		signal?.addEventListener("abort", finish, { once: true });
		pending.then(finish, finish);
	});
}

/** A Maia answer with its query rating and history coverage. */
interface PolicyAnswer {
	result: PolicyResult;
	selfElo: number;
	historyPlies: number;
}

/** A restricted search's roots, and whether it is the cacheable Maia-shaped own-move search. */
interface SearchShape {
	searchmoves: readonly string[];
	shaped: boolean;
}

/** A pending Maia query and when it was issued (the budget is measured from there). */
interface PolicyQuery {
	pending: Promise<PolicyResult | null>;
	issuedAt: number;
	abort: AbortController;
	selfElo: number;
	historyPlies: number;
}

export class RecommendationPipeline {
	private readonly engine: PipelineEngine;
	private readonly timing: TimingModel;
	private readonly book: BookPolicy | null;
	private readonly policy: PolicyPort | null;
	private readonly tablebase: TablebasePort | null;
	private readonly now: () => number;

	constructor(deps: RecommendationPipelineDeps) {
		this.engine = deps.engine;
		this.timing = deps.timing;
		this.book = deps.book;
		this.policy = deps.policy ?? null;
		this.tablebase = deps.tablebase ?? null;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * One position → one `Recommendation`, or `null` when the engine produced no
	 * usable line and the book had nothing either (the caller stays `analysing`).
	 */
	async run(input: RecommendationInput): Promise<RecommendationOutcome | null> {
		const preparationStarted = this.now();
		const { snapshot, settings } = input;
		const myColor = snapshot.myColor;
		if (myColor === null || input.signal?.aborted) return null;
		const [baseSec, incSec] = tcSeconds(snapshot.timeControl);
		const myClockMs = remainingClockMs(snapshot, myColor, input.nowMs);
		const oppClockMs = remainingClockMs(snapshot, myColor === "w" ? "b" : "w", input.nowMs);
		const position = {
			fen: snapshot.fen,
			ply: snapshot.ply,
			myClockMs,
			oppClockMs,
			timeControl: snapshot.timeControl,
			tau: input.tau,
			budgetUsedRatio: input.budgetUsedRatio,
			targetElo: input.targetElo,
			form: input.form,
		};
		const mode: MaiaSearchInput = {
			targetElo: input.targetElo,
			policy: this.policy !== null,
			clockRace: ownMoveClockRace(position) !== null,
		};
		const maia = maiaSearchMode(mode);
		const shape = { ...position, maia };
		const budget = ownMoveBudget(shape, settings);
		// Opponent-only rush keeps its short move search, but can afford the usual
		// bounded timing inference. Otherwise a 30–70 ms search needlessly loses the
		// learned clock distribution even while our own clock is comfortable.
		const timingBudgetMs = ownMoveClockRace(position)?.opponentOnly
			? Math.max(TIMING_CONSTANTS.chessmimic.inferenceBudgetMs, budget.movetimeMs)
			: budget.movetimeMs;
		// The query, selector and human-depth frame share the same rating inputs.
		const maiaElo = maia ? ownMoveMaiaElo(shape, settings) : null;

		const timingCtx: TimingContext = {
			fen: snapshot.fen,
			ply: snapshot.ply,
			moves: [...input.moves],
			myColor,
			chosenMove: "",
			lines: [],
			evalBeforeOppMove: this.timing.state.lastEvalOurPov,
			expectedOppReply: input.expectedOppReply,
			myClockMs,
			oppClockMs,
			baseSec,
			incSec,
			oppThinkMsHistory: [...input.oppThinkMsHistory],
			myThinkMsHistory: [...input.myThinkMsHistory],
			site: snapshot.site,
			targetElo: input.targetElo,
			profile: input.persona,
			engineReady: input.engineReady,
			inputMethod: input.inputMethod,
			autoQueen: input.autoQueen,
			nowMs: input.nowMs,
		};
		// Timing inference only needs position/history/clocks; overlap its bounded
		// preparation with the search, then fill the chosen move before sampling.
		const preparation = new AbortController();
		const preparationDeadline = preparationStarted + budget.movetimeMs;
		const remainingBudget = (requested: SearchBudget): SearchBudget | null => {
			const remaining = Math.min(requested.movetimeMs, preparationDeadline - this.now());
			return remaining > 0 ? { ...requested, movetimeMs: Math.max(1, Math.round(remaining)) } : null;
		};
		const abortPreparation = () => preparation.abort();
		input.signal?.addEventListener("abort", abortPreparation, { once: true });
		const timingPending = this.timing.prepare(timingCtx, {
			budgetMs: timingBudgetMs,
			signal: preparation.signal,
		});
		// Reuse only an answer with identical model inputs and game history.
		const held = input.policyAnswer;
		const policyInputs = maiaElo ? this.policyInputs(input, maiaElo) : null;
		const identity = policyInputs
			? policyQueryIdentity({
					inputs: policyInputs,
					selectionMode: settings.strength.selectionMode,
					history: input.history,
				})
			: null;
		const preInferred: PolicyAnswer | null =
			maiaElo &&
			held &&
			identity !== null &&
			held.identity === identity &&
			positionKey(held.fen) === positionKey(snapshot.fen) &&
			held.result.size === policyInputs?.size
				? {
						result: held.result,
						selfElo: policyInputs.selfElo,
						historyPlies: policyInputs.historyFens.length,
					}
				: null;
		const policyQuery = policyInputs && !preInferred ? this.queryPolicy(input, policyInputs) : null;

		try {
			// Book lookup overlaps the policy and engine work; so does a tablebase probe.
			const bookPending = this.bookMove(input);
			const tablebasePending = this.tablebaseProbe(input);
			// An early policy answer shapes one search over its roots and known engine continuations.
			// Without one, search broadly and consider extra candidates only if time remains.
			let policy: PolicyAnswer | null = preInferred;
			let shaped: ShapedSearchPlan | null = null;
			let anchor: AnalysisResult | null = null;
			let analysis: AnalysisResult | null;
			try {
				if (maia && MAIA_SEARCH.shaped.enabled) {
					let known = preInferred ? held?.knownTopMoves : undefined;
					const legal = new Set(legalMoves(snapshot.fen));
					if (!known?.some((uci) => legal.has(uci))) {
						const available = remainingBudget(budget);
						if (available && available.movetimeMs >= 2 * SEARCH_BUDGET.minMovetimeMs) {
							const anchorMs = Math.min(
								MAIA_SEARCH.shaped.anchorMaxMs,
								available.movetimeMs * MAIA_SEARCH.shaped.anchorFraction
							);
							anchor = await this.runSearch(
								snapshot,
								{
									...available,
									movetimeMs: anchorMs,
									multiPv: Math.min(SEARCH_BUDGET.ponderMultiPv, available.multiPv),
								},
								input.targetElo,
								true,
								input.signal,
								input.history,
								undefined,
								Math.min(preparationDeadline, this.now() + anchorMs)
							);
							if (anchor?.final.complete)
								known = usableLines(anchor.final.lines).flatMap((line) =>
									line.pvUci[0] ? [line.pvUci[0]] : []
								);
						}
					}
					if (!policy && policyQuery)
						policy = await this.awaitPolicy(
							policyQuery,
							input.signal,
							Math.min(
								MAIA_SEARCH.shaped.policyFirstMs,
								Math.max(0, preparationDeadline - policyQuery.issuedAt)
							)
						);
					if (input.signal?.aborted) return null;
					const available = remainingBudget(budget);
					if (policy && available)
						shaped = shapedSearchPlan(policy.result, snapshot.fen, known, available, input.targetElo);
				}
				const search = remainingBudget(shaped?.budget ?? budget);
				analysis = search
					? await this.analyse(
							snapshot,
							search,
							input.targetElo,
							maia,
							input.signal,
							input.history,
							shaped ? { searchmoves: shaped.searchmoves, shaped: true } : undefined,
							preparationDeadline
						)
					: null;
				if (
					!analysis ||
					usableLines(analysis.final.lines).length === 0 ||
					(!analysis.final.complete && anchor?.final.complete)
				)
					analysis = anchor ?? analysis;
			} finally {
				// Cached analysis may return before warmed inference. Keep only the original
				// short inference window; searches already beyond it never wait any longer.
				await finishTimingPreparation(
					timingPending,
					Math.min(TIMING_CONSTANTS.chessmimic.inferenceBudgetMs, timingBudgetMs) -
						(this.now() - preparationStarted),
					input.signal
				);
				preparation.abort();
				input.signal?.removeEventListener("abort", abortPreparation);
				await timingPending;
			}
			if (input.signal?.aborted) return null;
			const bookAnswer = await bookPending;
			// Any final policy wait must fit both its inference budget and the shared deadline.
			if (!policy && policyQuery)
				policy = await this.awaitPolicy(
					policyQuery,
					input.signal,
					Math.min(MAIA.inferenceBudgetMs, Math.max(0, preparationDeadline - policyQuery.issuedAt)),
					true
				);
			if (input.signal?.aborted) return null;
			const policyResult = policy?.result ?? null;
			if (policy && policy.historyPlies < MAIA_INPUT.history && snapshot.ply >= MAIA_INPUT.history)
				// Report missing history once the game is long enough to supply it.
				log.debug("recommendation: maia query carried a short history", {
					historyPlies: policy.historyPlies,
					ply: snapshot.ply,
				});
			// Use Maia for eligible opening choices only when its answer arrived; retain the book fallback.
			const maiaOpening =
				policyResult !== null &&
				maia &&
				maiaPlaysOpening({ targetElo: input.targetElo, form: input.form });
			const book = maiaOpening ? null : bookAnswer;
			if (maiaOpening && bookAnswer)
				log.debug("recommendation: book suppressed, maia plays the opening", {
					uci: bookAnswer.uci,
					ply: snapshot.ply,
				});

			let lines = usableLines(analysis?.final.lines ?? []);
			// Score significant unsearched policy candidates only with time left after a broad search.
			// Shaped searches already covered their roots; incomplete extra frames are discarded.
			let maiaExtra: string[] = [];
			const extraBudget = remainingBudget({ ...budget, movetimeMs: extraSearchMs(budget) });
			if (
				analysis &&
				policyResult &&
				maia &&
				!shaped &&
				!clockBoundSearch(myClockMs, budget) &&
				extraBudget &&
				extraBudget.movetimeMs >= SEARCH_BUDGET.minMovetimeMs
			) {
				const searchmoves = maiaExtraSearchmoves(maiaUnscoredMoves(policyResult, lines, snapshot.fen));
				if (searchmoves.length > 0) {
					const extra = await this.runSearch(
						snapshot,
						{ ...extraBudget, multiPv: searchmoves.length },
						input.targetElo,
						maia,
						input.signal,
						input.history,
						{ searchmoves, shaped: false },
						preparationDeadline
					);
					if (input.signal?.aborted) return null;
					if (extra && !extra.final.complete) {
						// Incomplete frames cannot provide comparable scores for extra candidates.
						log.debug("recommendation: extra referee frame incomplete, ignored", {
							depth: extra.final.depth,
							lines: extra.final.lines.length,
							searchmoves,
						});
					} else if (extra) {
						const merged = mergeLines(lines, usableLines(extra.final.lines));
						const main = new Set(lines.map((line) => line.pvUci[0]));
						maiaExtra = merged.flatMap((line) => {
							const uci = line.pvUci[0];
							return uci !== undefined && !main.has(uci) ? [uci] : [];
						});
						lines = merged;
					}
				}
			}
			const depth = analysis?.final.depth ?? 0;
			const tablebaseChoice = tablebasePending
				? await this.tablebaseMove(input, tablebasePending, lines, {
						waitMs: Math.max(
							preparationDeadline - this.now(),
							// Max strength always plays the tables' move: outside a clock race it waits a
							// little past a quick search for the probe already in flight.
							isMaxStrength(input.targetElo) && ownMoveClockRace(position) === null
								? preparationStarted + TABLEBASE.maxStrengthMinWaitMs - this.now()
								: 0
						),
					})
				: null;
			if (input.signal?.aborted) return null;
			const chosen =
				tablebaseChoice ??
				this.choose(input, lines, book, analysis, policyResult, maiaExtra, maiaElo, maia);
			if (!chosen) return null;
			if (
				analysis &&
				!analysis.final.complete &&
				chosen.source !== "book" &&
				chosen.source !== "tablebase"
			) {
				delete chosen.cpLoss;
				chosen.quality = {
					kind: "search",
					eligible: false,
					reason: "incomplete",
					depth,
					candidates: lines.length,
				};
			}

			if (input.signal?.aborted) return null;
			timingCtx.chosenMove = chosen.uci;
			timingCtx.lines = lines;
			// Familiarity belongs to the chosen book move or a confident Maia opening choice.
			const inBook =
				bookAnswer?.uci === chosen.uci ||
				(maiaOpening &&
					snapshot.ply <= BOOK.maxPly &&
					(chosen.maiaProb ?? 0) >= BOOK.maiaOpeningMinProb);
			if (inBook) timingCtx.inBook = true;
			const plan = accountPreparation(this.timing.planMove(timingCtx), this.now());
			// Use position complexity from timing features; MultiPV count depends on the search budget
			// and would create a spurious relationship between measured complexity and move time.
			const nReasonable = Math.max(1, plan.features.n_reasonable ?? 1);

			const best = lines[0];
			const rec: Recommendation = {
				chosen,
				lines,
				eval: best?.score ?? { cp: 0 },
				depth,
				nps: analysis?.final.nps ?? 0,
				plan,
				computedAt: input.nowMs,
				fen: snapshot.fen,
			};
			const wdl = best?.wdl;
			if (wdl) rec.wdl = wdl;
			if (policy) {
				rec.maia = {
					size: policy.result.size,
					wdl: policy.result.wdl,
					historyPlies: policy.historyPlies,
					selfElo: policy.selfElo,
				};
				if (policy.result.ms !== undefined) rec.maia.ms = policy.result.ms;
				if (chosen.maiaProb !== undefined) rec.maia.p = chosen.maiaProb;
				if (chosen.maiaMeters !== undefined) rec.maia.meters = chosen.maiaMeters;
			}
			return {
				rec,
				nReasonable,
				fromBook: chosen.source === "book",
				fromTablebase: chosen.source === "tablebase",
				budget: shaped?.budget ?? budget,
				analysis,
			};
		} finally {
			preparation.abort();
			input.signal?.removeEventListener("abort", abortPreparation);
			policyQuery?.abort.abort();
		}
	}

	/**
	 * Query the retained model size with validated history and the shared effective rating.
	 * Self conditioning is capped at the supported selection ceiling; an unknown opponent
	 * uses our rating. A refused or failed query resolves to null.
	 */
	private queryPolicy(
		input: RecommendationInput,
		inputs: PolicyInferenceInputs
	): PolicyQuery | null {
		if (!this.policy) return null;
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		input.signal?.addEventListener("abort", onAbort, { once: true });
		const { selfElo, historyFens } = inputs;
		const issuedAt = this.now();
		let pending: Promise<PolicyResult | null>;
		try {
			pending = this.policy
				.infer(inputs, { budgetMs: MAIA.inferenceBudgetMs, signal: abort.signal })
				.catch((error: unknown) => {
					log.debug("recommendation: maia query failed", { error: errorMessage(error) });
					return null;
				});
		} catch (error) {
			log.debug("recommendation: maia query refused", { error: errorMessage(error) });
			pending = Promise.resolve(null);
		}
		void pending.finally(() => input.signal?.removeEventListener("abort", onAbort));
		return { pending, issuedAt, abort, selfElo, historyPlies: historyFens.length };
	}

	private policyInputs(input: RecommendationInput, elo: MaiaEloContext): PolicyInferenceInputs {
		const selfElo = maiaConditioningElo(elo.selfElo);
		return {
			size: input.maiaSize ?? maiaSizeFor(input.targetElo),
			fen: input.snapshot.fen,
			historyFens: maiaHistoryFens(input.history, input.snapshot.fen),
			selfElo,
			oppoElo: input.opponentElo ?? selfElo,
		};
	}

	/**
	 * Wait within a budget measured from query issue. The initial shaping wait can leave
	 * the query running so the selector can use an answer arriving during engine search.
	 * The final wait cancels the query when its remaining budget expires.
	 */
	private async awaitPolicy(
		query: PolicyQuery,
		signal: AbortSignal | undefined,
		withinMs?: number,
		cancelOnTimeout = withinMs === undefined
	): Promise<PolicyAnswer | null> {
		const elapsed = this.now() - query.issuedAt;
		const remainingMs = (withinMs ?? MAIA.inferenceBudgetMs) - elapsed;
		const result = await new Promise<PolicyResult | null>((resolve) => {
			const finish = (value: PolicyResult | null) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish(null);
			// A zero wait is still a macrotask: an already-settled query is read before the timer fires.
			const timer = setTimeout(() => finish(null), Math.max(0, remainingMs));
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			query.pending.then(finish, () => finish(null));
		});
		if (result === null) {
			if (!cancelOnTimeout) {
				log.debug("recommendation: maia answer not in time to shape the search, broad search", {
					elapsedMs: this.now() - query.issuedAt,
				});
				return null;
			}
			query.abort.abort();
			log.debug("recommendation: maia unavailable for this move, engine policy", {
				elapsedMs: this.now() - query.issuedAt,
			});
			return null;
		}
		return { result, selfElo: query.selfElo, historyPlies: query.historyPlies };
	}

	/**
	 * Opening-book answer, or null when disabled, unavailable or failed. The book is off above the
	 * Maia cutoff (`MAIA.eloMax`, the one strength division since 2026-09-15). Max-strength mode
	 * never consults the book on its own account (owner, 2026-09-15: "the absolute best possible
	 * move"), whatever that cutoff is later set to.
	 */
	private async bookMove(input: RecommendationInput): Promise<ChosenMove | null> {
		const policy = this.book;
		if (
			!policy ||
			!input.settings.strength.useOpeningBook ||
			input.targetElo > MAIA.eloMax ||
			isMaxStrength(input.targetElo)
		)
			return null;
		const ctx: BookContext = {
			fen: input.snapshot.fen,
			ply: input.snapshot.ply,
			targetElo: effectiveElo(input.targetElo, input.form),
			useOpeningBook: true,
			rng: input.rng,
		};
		try {
			return await policy.bookMove(ctx);
		} catch (error) {
			log.warn("recommendation: book failed", { error: errorMessage(error) });
			return null;
		}
	}

	/**
	 * Start a tablebase probe for a ≤ 7-man position when the policy plays the tables' move here
	 * (`decideTablebase`: always at max strength, occasionally at human ratings, never below the
	 * floor), or `null`. The draw is made first, so a position the policy would not play from never
	 * leaves the browser; it consumes the game's rng only when the probability is strictly between
	 * 0 and 1.
	 */
	private tablebaseProbe(
		input: RecommendationInput
	): { pending: Promise<TablebaseProbe | null>; p: number } | null {
		const port = this.tablebase;
		const fen = input.snapshot.fen;
		const pieces = pieceCount(fen);
		if (!port || !input.settings.strength.useTablebase || pieces === null) return null;
		if (pieces > TABLEBASE.maxPieces) return null;
		const E = effectiveElo(input.targetElo, input.form);
		const decision = decideTablebase(input.targetElo, E, pieces, input.rng);
		if (!decision.use) {
			if (decision.p > 0)
				log.debug("recommendation: tablebase not consulted this move", { p: decision.p, pieces });
			return null;
		}
		let pending: Promise<TablebaseProbe | null>;
		try {
			pending = port.probe(fen).catch((error: unknown) => {
				log.debug("recommendation: tablebase probe failed", { error: errorMessage(error) });
				return null;
			});
		} catch (error) {
			log.debug("recommendation: tablebase probe refused", { error: errorMessage(error) });
			return null;
		}
		return { pending, p: decision.p };
	}

	/**
	 * The tables' best move for the position, waiting at most `waitMs` for the probe (0 reads only
	 * an answer already in hand), or `null` — no answer in time, nothing legal in it, or the
	 * position moved on. The engine's lines only break ties between moves of equal result.
	 */
	private async tablebaseMove(
		input: RecommendationInput,
		probe: { pending: Promise<TablebaseProbe | null>; p: number },
		lines: readonly EvalLine[],
		options: { waitMs: number }
	): Promise<ChosenMove | null> {
		const answer = await new Promise<TablebaseProbe | null>((resolve) => {
			const finish = (value: TablebaseProbe | null) => {
				clearTimeout(timer);
				input.signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish(null);
			// A zero wait is still a macrotask: an already-settled probe is read before the timer fires.
			const timer = setTimeout(() => finish(null), Math.max(0, options.waitMs));
			if (input.signal?.aborted) onAbort();
			else input.signal?.addEventListener("abort", onAbort, { once: true });
			probe.pending.then(finish, () => finish(null));
		});
		if (!answer) {
			log.debug("recommendation: no tablebase answer in time, engine plays", {
				waitMs: Math.round(options.waitMs),
			});
			return null;
		}
		const fen = input.snapshot.fen;
		const ranked = rankTablebaseMoves({
			fen,
			probe: answer,
			history: input.history,
			enginePreference: lines.flatMap((line) => (line.pvUci[0] ? [line.pvUci[0]] : [])),
		});
		if (!ranked) return null;
		const chosen = tablebaseChosenMove(fen, ranked, lines, [
			`tablebase: ${ranked.outcome} (p=${Number(probe.p.toFixed(3))})`,
		]);
		if (chosen)
			log.debug("recommendation: tablebase move", {
				uci: chosen.uci,
				outcome: ranked.outcome,
				zeroingPlies: ranked.best.zeroingPlies,
			});
		return chosen;
	}

	/** Retry a shallow early result only within the original wall-clock budget. */
	private async analyse(
		snapshot: PositionSnapshot,
		budget: SearchBudget,
		targetElo: number,
		maia: boolean,
		signal: AbortSignal | undefined,
		history?: PositionHistory,
		shape?: SearchShape,
		deadlineMs?: number
	): Promise<AnalysisResult | null> {
		const started = this.now();
		const first = await this.runSearch(
			snapshot,
			budget,
			targetElo,
			maia,
			signal,
			history,
			shape,
			deadlineMs
		);
		if (!first || signal?.aborted) return first;
		if (first.final.depth >= Math.min(SEARCH_BUDGET.retryDepth, budget.depthCap)) return first;
		const remaining = budget.movetimeMs - Math.max(this.now() - started, first.final.timeMs);
		if (remaining < SEARCH_BUDGET.minMovetimeMs) return first;
		log.debug("recommendation: shallow search, retrying once", {
			depth: first.final.depth,
			remainingMs: remaining,
		});
		const retry = await this.runSearch(
			snapshot,
			{
				...budget,
				movetimeMs: remaining,
			},
			targetElo,
			maia,
			signal,
			history,
			shape,
			deadlineMs
		);
		return retry && retry.final.depth > first.final.depth ? retry : first;
	}

	/**
	 * Run a search with validated history and the shared wall-clock deadline. Restricted
	 * Maia-shaped searches are cacheable by root set; extra candidate searches are not.
	 */
	private async runSearch(
		snapshot: PositionSnapshot,
		budget: SearchBudget,
		targetElo: number,
		maia: boolean,
		signal: AbortSignal | undefined,
		history?: PositionHistory,
		shape?: SearchShape,
		deadlineMs?: number
	): Promise<AnalysisResult | null> {
		if (signal?.aborted) return null;
		const validHistory = matchingHistory(history, snapshot.fen);
		const req: AnalysisRequest = {
			id: newId(),
			targetElo,
			fen: validHistory?.fen ?? snapshot.fen,
			...(validHistory?.moves.length ? { moves: validHistory.moves } : {}),
			multiPv: budget.multiPv,
			limit: { movetimeMs: Math.round(budget.movetimeMs), depth: budget.depthCap },
			priority: "move",
		};
		// Feature depth is part of the cache identity.
		if (budget.featureDepth !== undefined) req.featureDepth = budget.featureDepth;
		if (shape?.searchmoves.length) {
			req.searchmoves = [...shape.searchmoves];
			if (shape.shaped) req.shaped = true;
			log.debug(
				shape.shaped
					? "recommendation: maia-shaped referee search"
					: "recommendation: maia extra referee search",
				{ searchmoves: req.searchmoves, multiPv: req.multiPv, movetimeMs: req.limit.movetimeMs }
			);
		}
		const elo = refereeElo(targetElo, maia);
		if (elo !== undefined) req.elo = elo;
		let handle: AnalysisHandle;
		try {
			handle = this.engine.analyse(req);
		} catch (error) {
			log.warn("recommendation: analyse refused", { error: errorMessage(error) });
			return null;
		}
		return searchResultBeforeDeadline(handle, req, {
			deadlineMs: deadlineMs ?? this.now() + budget.movetimeMs,
			now: this.now,
			...(signal ? { signal } : {}),
		});
	}

	/**
	 * Prefer a safe book move unless repetition, conversion or mate guards veto it. Otherwise
	 * select from the evaluated candidates.
	 */
	private choose(
		input: RecommendationInput,
		lines: EvalLine[],
		bookMove: ChosenMove | null,
		analysis: AnalysisResult | null,
		policy: PolicyResult | null,
		maiaExtra: readonly string[] = [],
		maiaElo: MaiaEloContext | null = null,
		humanFrame = false
	): ChosenMove | null {
		const E = effectiveElo(input.targetElo, input.form);
		let book = bookMove;
		const converting = conversionPool(lines, {
			fen: input.snapshot.fen,
			phase: phaseOf(input.snapshot.fen) ?? "middlegame",
			...(input.history ? { history: input.history } : {}),
		}).active;
		const mateAvailable = lines.some(
			(line) => (line.score.mate ?? 0) > 0 || isImmediateMate(input.snapshot.fen, line.pvUci[0] ?? "")
		);
		if (converting || mateAvailable) book = null;
		// Include an unsearched book candidate in the draw check. Its optimistic score is only
		// for this veto; an actual alternative must still come from a legal evaluated engine line.
		const guardLines =
			book && !lines.some((line) => line.pvUci[0] === book?.uci)
				? [
						...lines,
						{
							multipv: 0,
							depth: 0,
							score: lines[0]?.score ?? { cp: 0 },
							pvUci: [book.uci],
							pvSan: [book.san],
						},
					]
				: lines;
		const guarded = book ? avoidRepetition(guardLines, input.snapshot.fen, input.history) : null;
		if (book && guarded?.avoided && input.history && repetitionRisk(input.history, book.uci) > 0)
			book = null;
		if (book) {
			const facts = lineFacts(book.uci, lines);
			if (!isTrap(E, facts)) return book;
			log.info("recommendation: book move vetoed by the trap check", {
				uci: book.uci,
				loss: facts.lossLowerBound,
			});
		}
		// Keep the candidate pool broad so shorter searches do not strengthen the sampled player.
		const pool = lines;
		if (pool.length === 0) {
			const fen = input.snapshot.fen;
			const color = input.snapshot.myColor;
			const legal = legalMoves(fen);
			const engineMove = analysis?.bestmove;
			let uci = engineMove && legal.includes(engineMove) ? engineMove : undefined;
			const race =
				color &&
				clockRacePolicy({
					ownClockMs: remainingClockMs(input.snapshot, color, input.nowMs),
					opponentClockMs: remainingClockMs(input.snapshot, color === "w" ? "b" : "w", input.nowMs),
					baseMs: input.snapshot.timeControl?.baseMs ?? 0,
					incrementMs: input.snapshot.timeControl?.incMs ?? 0,
					loneKing: isLoneKing(fen, color),
				});
			if (!uci && color && race && isLoneKing(fen, color)) uci = legal[0];
			const parts = uci && parseUci(uci);
			if (!uci || !parts) return book;
			return {
				uci,
				san: uciToSan(fen, uci) ?? uci,
				...parts,
				source: "sampled",
				rankInLines: 0,
				quality: {
					kind: "search",
					eligible: false,
					reason: "unknown",
					depth: analysis?.final.depth ?? 0,
					candidates: 0,
				},
				rationale: [
					engineMove === uci
						? "search: legal bestmove before a complete PV"
						: "clock race: legal lone-king fallback while analysis is unavailable",
				],
			};
		}
		// Do not guess a player color when constructing clock-sensitive selection inputs.
		const myColor = input.snapshot.myColor;
		if (myColor === null) return book;
		const ctx: SelectionContext = {
			fen: input.snapshot.fen,
			...(input.history ? { history: input.history } : {}),
			targetElo: input.targetElo,
			form: input.form,
			ply: input.snapshot.ply,
			phase: phaseOf(input.snapshot.fen, input.snapshot.ply) ?? "middlegame",
			myClockMs: remainingClockMs(input.snapshot, myColor, input.nowMs),
			oppClockMs: remainingClockMs(input.snapshot, myColor === "w" ? "b" : "w", input.nowMs),
			selectionMode: input.settings.strength.selectionMode,
			blunderScale: input.settings.strength.blunderScale,
			rng: input.rng,
			state: input.selectionState,
		};
		if (analysis)
			ctx.engineResultKind = analysis.request.elo === undefined ? "unrestricted" : "native-limited";
		if (policy) ctx.maia = policy;
		if (maiaExtra.length > 0) ctx.maiaExtra = maiaExtra;
		// The selector judges candidates at the rating used for the query.
		if (maiaElo) ctx.contextEloPenalty = maiaElo.contextEloPenalty;
		// Only the complete human-depth frame informs generate-and-verify. The main frame
		// remains the evaluation reference.
		const shallow = humanFrame ? analysis?.atFeatureDepth : undefined;
		if (shallow?.complete === true && shallow.lines.length > 0) {
			ctx.shallowLines = usableLines(shallow.lines);
			ctx.shallowDepth = shallow.depth;
			// Compare shallow and main choices for human-depth diagnostics.
			const deepBest = lines[0]?.pvUci[0];
			const shallowBest = ctx.shallowLines[0]?.pvUci[0];
			log.debug("recommendation: human-depth frame", {
				shallowDepth: shallow.depth,
				deepDepth: analysis?.final.depth ?? 0,
				deepBest,
				shallowBest,
				agree: deepBest !== undefined && deepBest === shallowBest,
			});
		}
		// Scale selection pressure by the game's base clock when known; otherwise the blunder
		// model uses its absolute-clock fallback.
		const baseMs = input.snapshot.timeControl?.baseMs ?? 0;
		if (baseMs > 0) ctx.baseMs = baseMs;
		ctx.incrementMs = input.snapshot.timeControl?.incMs ?? 0;
		const last = input.moves[input.moves.length - 1];
		if (last !== undefined) ctx.lastMove = last;
		const bestmove = analysis?.bestmove;
		if (bestmove) ctx.engineBestmove = bestmove;
		try {
			return selectMove(pool, ctx);
		} catch (error) {
			log.warn("recommendation: selection failed", { error: errorMessage(error) });
			return book;
		}
	}
}
