/**
 * The per-position recommendation pipeline (Part I §3.2 steps 1–4) with the
 * §7.5 search-budget policy:
 *
 *   bookPolicy → engine.analyse → selectMove → timingModel.planMove
 *
 * The book, timing inference, and engine run **in parallel** (§7.3 item 3: "the engine
 * searches in parallel regardless"); the trap check that §7.3 needs the lines
 * for is applied here once both have answered (`lineFacts` + `isTrap`), so the
 * book never has to wait for the search. Timing inference is bounded by the head’s deadline and bypassed for clock races.
 *
 * Budget (§6.4 / §7.5): **plan-independent**, derived from the time control and
 * the position — `SEARCH_BUDGET.moveMs[tc]` (§6.4's "plan-independent
 * 400–1500 ms"), bounded by §7.5's `0.6 · plannedThinkMs` so the search still
 * finishes before the hand acts, bounded again by a fraction of the clock we
 * have left, and collapsed to the floor in a position with one legal move.
 * `depthCap` follows the speed class, while candidate breadth follows both the
 * budget and the active target. A shallow search retries only within the original
 * wall-clock budget and retains the available candidates for rating-sensitive selection.
 *
 * The old budget was `0.6 · plannedThinkMs` alone, which tied the search to the
 * wait: every `untimed` game (i.e. every game, before the time control was
 * wired through) planned ≈ 7.5 s and therefore searched the full 4 s cap before
 * a recommendation existed. Two harms, not one: the panel was blind for 4 s,
 * and because the executor fits the plan into what is left of its deadline, the
 * search became a **floor** on the realised `MoveHoldTime` — the §13.2 left
 * tail (premove / instant) could not be produced at all.
 */

import { loadPosition } from "@core/chess/fen";
import { matchingHistory, type PositionHistory } from "@core/chess/history";
import { isLoneKing } from "@core/chess/material";
import { phase as phaseOf } from "@core/chess/phase";
import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { LIMITS } from "@core/constants/limits";
import { SEARCH_BUDGET } from "@core/constants/search";
import { requestEloForTarget } from "@core/engine/options";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import type { BookContext, BookPolicy } from "@core/strength/book/book-policy";
import { isTrap, lineFacts } from "@core/strength/book/book-policy";
import { conversionPool, isImmediateMate } from "@core/strength/conversion";
import { effectiveElo } from "@core/strength/elo-map";
import { selectMove } from "@core/strength/move-selector";
import { avoidRepetition, repetitionRisk } from "@core/strength/repetition";
import { usesNativeSelection } from "@core/strength/selection-mode";
import type { SelectionContext, SelectionState } from "@core/strength/types";
import { budgetController, scheduleAlloc } from "@core/timing/budget";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { pieceCounts, tcClass } from "@core/timing/features";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import type { TimingModel } from "@core/timing/timing-model";
import type { TcClass, TimingContext } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import { errorMessage } from "@core/util/errors";
import { newId } from "@core/util/ids";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, PositionSnapshot, Recommendation, TimeControl } from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";

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
}

/**
 * The think time the timing model is *expected* to plan, before the search that
 * feeds it exists (§7.5's `plannedThinkMs`). Same allocation the model uses,
 * scaled by the user's speed knob.
 */
export function estimatedThinkMs(p: BudgetPosition, settings: Settings): number {
	const { pieces, pawns } = pieceCounts(p.fen);
	const F = TIMING_CONSTANTS.features;
	// The same untimed substitution `computeFeatures` makes (§8.4b item 1).
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
	return allocSec * MS_PER_S * Math.max(0, settings.timing.speedScale);
}

/** What sizes one own-move search: the time control, the position and §7.5's own upper bound. */
export interface SearchBudgetInput {
	tc: TcClass;
	/** Our remaining clock in ms; `0` when the page reports none (an untimed game). */
	myClockMs: number;
	/** Legal moves in the position — exactly one means there is nothing to search (0 = unreadable). */
	legalMoves: number;
	/** §7.5's bound: the think time the model is expected to plan (`estimatedThinkMs`). */
	plannedThinkMs: number;
	/** Active opponent-matched target, when different from the saved fixed target. */
	targetElo?: number;
	/** Form only decides whether Hybrid uses native selection; sampling breadth retains its target. */
	form?: number;
}

/**
 * §6.4 / §7.5: the movetime, depth cap and MultiPV of one own-move search.
 *
 * `movetimeMs` is the smallest of three bounds, floored at `minMovetimeMs`:
 * the class base (§6.4's plan-independent 400–1500 ms), §7.5's
 * `0.6 · plannedThinkMs` (the search must finish before we act) and
 * `clockFraction` of the clock we have left (never burn the clock searching).
 * A position with exactly one legal move takes the floor: no search can change
 * the answer.
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
		// Exactly one: `legalMoves()` answers `[]` on a FEN chess.js cannot parse, and an unreadable
		// position is the last thing that should get the shortest search.
		legalMoves === 1
			? SEARCH_BUDGET.minMovetimeMs
			: clamp(Math.min(...bounds), SEARCH_BUDGET.minMovetimeMs, SEARCH_BUDGET.maxMovetimeMs);
	const depthCap = Math.min(SEARCH_BUDGET.depthCap[tc], settings.engine.depthCap);
	const adaptive =
		movetimeMs < SEARCH_BUDGET.multiPvSmallMs
			? SEARCH_BUDGET.multiPvSmall
			: movetimeMs < SEARCH_BUDGET.multiPvMediumMs
				? SEARCH_BUDGET.multiPvMedium
				: SEARCH_BUDGET.multiPvLarge;
	const targetElo = input.targetElo ?? settings.strength.targetElo;
	const sampling = !usesNativeSelection(
		settings.strength.selectionMode,
		effectiveElo(targetElo, input.form ?? 0)
	);
	const breadth = sampling
		? (SEARCH_BUDGET.selectionCandidates.find((band) => targetElo <= band.maxElo)?.count ?? 0)
		: 0;
	const wanted = Math.max(adaptive, settings.engine.multiPv, breadth);
	const multiPv = legalMoves > 0 ? Math.min(wanted, legalMoves) : wanted;
	return { movetimeMs, depthCap, multiPv };
}

/** Everything the own-move budget is a function of (§6.4 / §7.5): the clock and the position. */
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
}

/**
 * The budget an own-move search of `fen` is given. One definition, because the §4.5 pre-analysis
 * of the *predicted* position has to ask for exactly what the own-move search will ask for: the
 * cache's depth gate is `depthCap − 2`, so a cheaper pre-analysis could never answer it.
 */
export function ownMoveBudget(input: OwnMoveBudgetInput, settings: Settings): SearchBudget {
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
		},
		settings
	);
	const budget = searchBudget(
		{
			tc,
			myClockMs: input.myClockMs,
			legalMoves: legalMoves(input.fen).length,
			plannedThinkMs,
			targetElo: input.targetElo ?? settings.strength.targetElo,
			form: input.form ?? 0,
		},
		settings
	);
	const us = loadPosition(input.fen)?.turn();
	const race = clockRacePolicy({
		ownClockMs: input.myClockMs,
		opponentClockMs: input.oppClockMs ?? 0,
		baseMs: baseSec * MS_PER_S,
		incrementMs: incSec * MS_PER_S,
		loneKing: us !== undefined && isLoneKing(input.fen, us),
	});
	return race ? { ...budget, movetimeMs: Math.min(budget.movetimeMs, race.maxSearchMs) } : budget;
}

export interface RecommendationInput {
	snapshot: PositionSnapshot;
	settings: Settings;
	/** The derived target (§7.4a) — already opponent-matched when that is on. */
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
	/** Fraction of the starting clock already spent (features 25). */
	budgetUsedRatio: number;
	rng: Rng;
	/** Cancels the search when the position moves on. */
	signal?: AbortSignal | undefined;
	nowMs: number;
	engineReady: boolean;
	autoQueen: boolean;
	inputMethod: "drag" | "click";
}

export interface RecommendationOutcome {
	rec: Recommendation;
	/** The number of "reasonable" moves the timing features derived (the hand's exploration size). */
	nReasonable: number;
	/** The book answered for this position (the timing model's `in_book` half). */
	fromBook: boolean;
	budget: SearchBudget;
	/** `null` when the engine never answered (book-only or a failed search). */
	analysis: AnalysisResult | null;
}

export interface RecommendationPipelineDeps {
	engine: PipelineEngine;
	timing: TimingModel;
	book: BookPolicy | null;
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

export class RecommendationPipeline {
	private readonly engine: PipelineEngine;
	private readonly timing: TimingModel;
	private readonly book: BookPolicy | null;
	private readonly now: () => number;

	constructor(deps: RecommendationPipelineDeps) {
		this.engine = deps.engine;
		this.timing = deps.timing;
		this.book = deps.book;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * One position → one `Recommendation`, or `null` when the engine produced no
	 * usable line and the book had nothing either (the caller stays `analysing`).
	 */
	async run(input: RecommendationInput): Promise<RecommendationOutcome | null> {
		const { snapshot, settings } = input;
		const myColor = snapshot.myColor;
		if (myColor === null || input.signal?.aborted) return null;
		const [baseSec, incSec] = tcSeconds(snapshot.timeControl);
		const myClockMs = snapshot.clocks[myColor].ms;
		const oppClockMs = snapshot.clocks[myColor === "w" ? "b" : "w"].ms;
		const budget = ownMoveBudget(
			{
				fen: snapshot.fen,
				ply: snapshot.ply,
				myClockMs,
				oppClockMs,
				timeControl: snapshot.timeControl,
				tau: input.tau,
				budgetUsedRatio: input.budgetUsedRatio,
				targetElo: input.targetElo,
				form: input.form,
			},
			settings
		);

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
		const preparationStarted = this.now();
		const abortPreparation = () => preparation.abort();
		input.signal?.addEventListener("abort", abortPreparation, { once: true });
		const timingPending = this.timing.prepare(timingCtx, {
			budgetMs: budget.movetimeMs,
			signal: preparation.signal,
		});

		// §7.3 item 3 + §3.2 step 1: the book and the engine run at the same time.
		const bookPending = this.bookMove(input);
		let analysis: AnalysisResult | null;
		try {
			analysis = await this.analyse(snapshot, budget, input.targetElo, input.signal, input.history);
		} finally {
			// Cached analysis may return before warmed inference. Keep only the original
			// short inference window; searches already beyond it never wait any longer.
			await finishTimingPreparation(
				timingPending,
				Math.min(TIMING_CONSTANTS.chessmimic.inferenceBudgetMs, budget.movetimeMs) -
					(this.now() - preparationStarted),
				input.signal
			);
			preparation.abort();
			input.signal?.removeEventListener("abort", abortPreparation);
			await timingPending;
		}
		if (input.signal?.aborted) return null;
		const book = await bookPending;

		const lines = usableLines(analysis?.final.lines ?? []);
		const depth = analysis?.final.depth ?? 0;
		const chosen = this.choose(input, lines, book, analysis);
		if (!chosen) return null;
		if (analysis && !analysis.final.complete && chosen.source !== "book") {
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
		if (book !== null) timingCtx.inBook = true;
		const plan = this.timing.planMove(timingCtx);
		// Appendix D §2 feature 11, *not* the MultiPV count: `K` depends on target and time budget,
		// so reporting it as `n_reasonable` would put a driver of the think
		// time on the complexity axis and make `report.py`'s `ln(hold) vs ln(n_reasonable)`
		// correlation spurious. `planMove` has just computed the real one.
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
		return { rec, nReasonable, fromBook: book !== null, budget, analysis };
	}

	/** §7.3: the book move for this position, or `null` (disabled, out of book, or it threw). */
	private async bookMove(input: RecommendationInput): Promise<ChosenMove | null> {
		const policy = this.book;
		if (!policy || !input.settings.strength.useOpeningBook || input.targetElo >= LIMITS.eloMax)
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
	 * §7.5 quality guard: a shallow early result may retry within the original wall-clock budget.
	 * A search that exhausted the budget never starts a second full search.
	 */
	private async analyse(
		snapshot: PositionSnapshot,
		budget: SearchBudget,
		targetElo: number,
		signal: AbortSignal | undefined,
		history?: PositionHistory
	): Promise<AnalysisResult | null> {
		const started = this.now();
		const first = await this.runSearch(snapshot, budget, targetElo, signal, history);
		if (!first || signal?.aborted) return first;
		if (first.final.depth >= SEARCH_BUDGET.retryDepth) return first;
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
			signal,
			history
		);
		return retry && retry.final.depth > first.final.depth ? retry : first;
	}

	private async runSearch(
		snapshot: PositionSnapshot,
		budget: SearchBudget,
		targetElo: number,
		signal: AbortSignal | undefined,
		history?: PositionHistory
	): Promise<AnalysisResult | null> {
		const validHistory = matchingHistory(history, snapshot.fen);
		const req: AnalysisRequest = {
			id: newId(),
			fen: validHistory?.fen ?? snapshot.fen,
			...(validHistory?.moves.length ? { moves: validHistory.moves } : {}),
			multiPv: budget.multiPv,
			limit: { movetimeMs: Math.round(budget.movetimeMs), depth: budget.depthCap },
			priority: "move",
		};
		const elo = requestEloForTarget(targetElo);
		if (elo !== undefined) req.elo = elo;
		let handle: AnalysisHandle;
		try {
			handle = this.engine.analyse(req);
		} catch (error) {
			log.warn("recommendation: analyse refused", { error: errorMessage(error) });
			return null;
		}
		const onAbort = (): void => void handle.stop();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await handle.result;
			return result.status === "failed" ? null : result;
		} catch (error) {
			log.warn("recommendation: analyse failed", { error: errorMessage(error) });
			return null;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * §3.2 step 2. The book wins unless the trap check (§7.3, `E ≥ 2000`) vetoes it
	 * with the engine's lines; otherwise `selectMove` uses the available searched candidates.
	 */
	private choose(
		input: RecommendationInput,
		lines: EvalLine[],
		bookMove: ChosenMove | null,
		analysis: AnalysisResult | null
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
		// Short searches keep their alternatives. Restricting to the top two and halving
		// sampling noise made fast moves substantially stronger than the requested rating.
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
					ownClockMs: input.snapshot.clocks[color].ms,
					opponentClockMs: input.snapshot.clocks[color === "w" ? "b" : "w"].ms,
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
		// `run()` has already refused a position whose colour is unknown; reading it again here keeps
		// that the only place the question is answered, rather than defaulting to white's clock.
		const myColor = input.snapshot.myColor;
		if (myColor === null) return book;
		const ctx: SelectionContext = {
			fen: input.snapshot.fen,
			...(input.history ? { history: input.history } : {}),
			targetElo: input.targetElo,
			form: input.form,
			ply: input.snapshot.ply,
			phase: phaseOf(input.snapshot.fen, input.snapshot.ply) ?? "middlegame",
			myClockMs: input.snapshot.clocks[myColor].ms,
			oppClockMs: input.snapshot.clocks[myColor === "w" ? "b" : "w"].ms,
			selectionMode: input.settings.strength.selectionMode,
			blunderScale: input.settings.strength.blunderScale,
			rng: input.rng,
			state: input.selectionState,
		};
		// §7.2 step 6 reads this to scale the clock-pressure term by the game's own base clock rather
		// than by an absolute 20 s. Absent when the page has reported no control, which the blunder model
		// treats as "unknown" and falls back to the absolute ramp for.
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
