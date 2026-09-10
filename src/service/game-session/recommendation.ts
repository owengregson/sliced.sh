/**
 * The per-position recommendation pipeline (Part I §3.2 steps 1–4) with the
 * §7.5 search-budget policy:
 *
 *   bookPolicy → engine.analyse → selectMove → timingModel.planMove
 *
 * The book and the engine run **in parallel** (§7.3 item 3: "the engine
 * searches in parallel regardless"); the trap check that §7.3 needs the lines
 * for is applied here once both have answered (`lineFacts` + `isTrap`), so the
 * book never has to wait for the search. Everything but the engine call is a
 * pure function of its inputs.
 *
 * Budget (§6.4 / §7.5): **plan-independent**, derived from the time control and
 * the position — `SEARCH_BUDGET.moveMs[tc]` (§6.4's "plan-independent
 * 400–1500 ms"), bounded by §7.5's `0.6 · plannedThinkMs` so the search still
 * finishes before the hand acts, bounded again by a fraction of the clock we
 * have left, and collapsed to the floor in a position with one legal move.
 * `depthCap` follows the speed class, `K` the budget, and the shallow-device
 * guard retries once at `+300 ms` and then falls back to the top two lines with
 * τ halved.
 *
 * The old budget was `0.6 · plannedThinkMs` alone, which tied the search to the
 * wait: every `untimed` game (i.e. every game, before the time control was
 * wired through) planned ≈ 7.5 s and therefore searched the full 4 s cap before
 * a recommendation existed. Two harms, not one: the panel was blind for 4 s,
 * and because the executor fits the plan into what is left of its deadline, the
 * search became a **floor** on the realised `MoveHoldTime` — the §13.2 left
 * tail (premove / instant) could not be produced at all.
 */

import { phase as phaseOf } from "@core/chess/phase";
import { legalMoves } from "@core/chess/san";
import { SEARCH_BUDGET } from "@core/constants/search";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import type { BookContext, BookPolicy } from "@core/strength/book/book-policy";
import { isTrap, lineFacts } from "@core/strength/book/book-policy";
import { effectiveElo } from "@core/strength/elo-map";
import { selectMove } from "@core/strength/move-selector";
import type { SelectionContext, SelectionState } from "@core/strength/types";
import { budgetController, scheduleAlloc } from "@core/timing/budget";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { pieceCounts, tcClass } from "@core/timing/features";
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
	// §6.4: never below the user's MultiPV (the panel shows that many lines).
	const multiPv = Math.min(SEARCH_BUDGET.multiPvLarge, Math.max(adaptive, settings.engine.multiPv));
	return { movetimeMs, depthCap, multiPv };
}

/** Everything the own-move budget is a function of (§6.4 / §7.5): the clock and the position. */
export interface OwnMoveBudgetInput {
	fen: string;
	ply: number;
	myClockMs: number;
	timeControl: TimeControl | undefined;
	/** `Persona.tau` — the reserve scales with it. */
	tau: number;
	budgetUsedRatio: number;
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
	return searchBudget(
		{ tc, myClockMs: input.myClockMs, legalMoves: legalMoves(input.fen).length, plannedThinkMs },
		settings
	);
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

export class RecommendationPipeline {
	private readonly engine: PipelineEngine;
	private readonly timing: TimingModel;
	private readonly book: BookPolicy | null;

	constructor(deps: RecommendationPipelineDeps) {
		this.engine = deps.engine;
		this.timing = deps.timing;
		this.book = deps.book;
	}

	/**
	 * One position → one `Recommendation`, or `null` when the engine produced no
	 * usable line and the book had nothing either (the caller stays `analysing`).
	 */
	async run(input: RecommendationInput): Promise<RecommendationOutcome | null> {
		const { snapshot, settings } = input;
		const myColor = snapshot.myColor;
		if (myColor === null) return null;
		const [baseSec, incSec] = tcSeconds(snapshot.timeControl);
		const myClockMs = snapshot.clocks[myColor].ms;
		const oppClockMs = snapshot.clocks[myColor === "w" ? "b" : "w"].ms;
		const budget = ownMoveBudget(
			{
				fen: snapshot.fen,
				ply: snapshot.ply,
				myClockMs,
				timeControl: snapshot.timeControl,
				tau: input.tau,
				budgetUsedRatio: input.budgetUsedRatio,
			},
			settings
		);

		// §7.3 item 3 + §3.2 step 1: the book and the engine run at the same time.
		const bookPending = this.bookMove(input);
		const analysis = await this.analyse(snapshot, budget, input.signal);
		if (input.signal?.aborted) return null;
		const book = await bookPending;

		const lines = usableLines(analysis?.final.lines ?? []);
		const depth = analysis?.final.depth ?? 0;
		const shallow = depth > 0 && depth < SEARCH_BUDGET.shallowDepth;
		const chosen = this.choose(input, lines, book, analysis, shallow);
		if (!chosen) return null;

		const timingCtx: TimingContext = {
			fen: snapshot.fen,
			ply: snapshot.ply,
			moves: [...input.moves],
			myColor,
			chosenMove: chosen.uci,
			lines,
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
		if (book !== null) timingCtx.inBook = true;
		const plan = this.timing.planMove(timingCtx);
		// Appendix D §2 feature 11, *not* the MultiPV count: `K` is a function of the time budget
		// (§7.5's 3/6/8 ladder), so reporting it as `n_reasonable` would put a driver of the think
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
		if (!policy || !input.settings.strength.useOpeningBook) return null;
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
	 * §7.5 quality guard: one retry with `+300 ms` when the first result came back
	 * shallower than `retryDepth`. A search the caller aborted resolves `null`.
	 */
	private async analyse(
		snapshot: PositionSnapshot,
		budget: SearchBudget,
		signal: AbortSignal | undefined
	): Promise<AnalysisResult | null> {
		const first = await this.runSearch(snapshot, budget, signal);
		if (!first || signal?.aborted) return first;
		if (first.final.depth >= SEARCH_BUDGET.retryDepth) return first;
		log.debug("recommendation: shallow search, retrying once", {
			depth: first.final.depth,
			extraMs: SEARCH_BUDGET.retryExtraMs,
		});
		const retry = await this.runSearch(
			snapshot,
			{
				...budget,
				movetimeMs: Math.min(
					SEARCH_BUDGET.maxMovetimeMs,
					budget.movetimeMs + SEARCH_BUDGET.retryExtraMs
				),
			},
			signal
		);
		return retry && retry.final.depth > first.final.depth ? retry : first;
	}

	private async runSearch(
		snapshot: PositionSnapshot,
		budget: SearchBudget,
		signal: AbortSignal | undefined
	): Promise<AnalysisResult | null> {
		const req: AnalysisRequest = {
			id: newId(),
			fen: snapshot.fen,
			multiPv: budget.multiPv,
			limit: { movetimeMs: Math.round(budget.movetimeMs), depth: budget.depthCap },
			priority: "move",
		};
		const elo = this.engine.engineElo();
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
	 * with the engine's lines; otherwise `selectMove`, with the §7.5 shallow guard.
	 */
	private choose(
		input: RecommendationInput,
		lines: EvalLine[],
		book: ChosenMove | null,
		analysis: AnalysisResult | null,
		shallow: boolean
	): ChosenMove | null {
		const E = effectiveElo(input.targetElo, input.form);
		if (book) {
			const facts = lineFacts(book.uci, lines);
			if (!isTrap(E, facts)) return book;
			log.info("recommendation: book move vetoed by the trap check", {
				uci: book.uci,
				loss: facts.lossLowerBound,
			});
		}
		const pool = shallow ? lines.slice(0, SEARCH_BUDGET.shallowLines) : lines;
		if (pool.length === 0) return book;
		// `run()` has already refused a position whose colour is unknown; reading it again here keeps
		// that the only place the question is answered, rather than defaulting to white's clock.
		const myColor = input.snapshot.myColor;
		if (myColor === null) return book;
		const ctx: SelectionContext = {
			fen: input.snapshot.fen,
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
		const last = input.moves[input.moves.length - 1];
		if (last !== undefined) ctx.lastMove = last;
		const bestmove = analysis?.bestmove;
		if (bestmove) ctx.engineBestmove = bestmove;
		if (shallow) ctx.tauScale = SEARCH_BUDGET.shallowTauScale;
		try {
			return selectMove(pool, ctx);
		} catch (error) {
			log.warn("recommendation: selection failed", { error: errorMessage(error) });
			return book;
		}
	}
}
