/**
 * Builds a recommendation with one shared preparation budget for policy and engine work.
 *
 * `RecommendationPipeline.run` is a fixed sequence of stages, each in `recommendation/`:
 *
 *   1. context      — clocks, Maia mode, search budget, Maia rating, the shared deadline
 *   2. timing       — bounded timing inference, overlapping everything up to selection
 *   3. policy       — a held Maia answer, or a query in flight
 *   4. book         — the opening book's answer and any tablebase probe, overlapping the search
 *   5. analysis     — the anchor, Maia-shaped or broad search, and the shallow retry
 *   6. candidates   — the final policy wait, then an extra referee search for unscored moves
 *   7. selection    — the endgame tablebase (≤ 7 men), else book guards, then the selector
 *                     (or a legal fallback)
 *   8. plan         — the timing plan for the chosen move, charged with preparation spent
 *   9. assembly     — the `Recommendation` and the outcome the session acts on
 *
 * This file stays the public entry: every helper the session, the predicted-position analysis
 * and the tools import is re-exported from here.
 */

import { MAIA } from "@core/constants/maia";
import type { PolicyPort } from "@core/policy/types";
import type { BookPolicy } from "@core/strength/book/book-policy";
import type { TablebasePort } from "@core/tablebase/client";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { TimingModel } from "@core/timing/timing-model";

import { acquireAnalysis, scoreExtraCandidates } from "./recommendation/analysis";
import { assembleOutcome } from "./recommendation/assemble";
import { bookMove, openingChoice } from "./recommendation/book";
import { ownMoveContext, PreparationWindow } from "./recommendation/context";
import { isFastReply } from "./recommendation/fast-reply";
import { noteShortHistory, PolicyStage } from "./recommendation/policy";
import { PipelineSearcher } from "./recommendation/search";
import { chooseMove, markIncompleteSearch } from "./recommendation/select";
import { tablebaseMove, tablebaseProbe, tablebaseWaitMs } from "./recommendation/tablebase";
import {
	planChosenMove,
	prepareChosenMove,
	TimingInference,
	timingCandidates,
	timingContext,
} from "./recommendation/timing";
import type {
	RecommendationInput,
	RecommendationOutcome,
	RecommendationPipelineDeps,
} from "./recommendation/types";

export {
	type BudgetPosition,
	clockBoundSearch,
	estimatedThinkMs,
	extraSearchMs,
	type SearchBudget,
	type SearchBudgetInput,
	searchBudget,
} from "./recommendation/budget";
export { mergeLines } from "./recommendation/lines";
export {
	type MaiaSearchInput,
	maiaExtraSearchmoves,
	maiaHistoryFens,
	maiaPlaysOpening,
	maiaSearchMode,
	maiaUnscoredMoves,
	refereeElo,
	type ShapedSearchPlan,
	shapedRootSet,
	shapedSearchPlan,
} from "./recommendation/maia-search";
export {
	type MaiaContextInput,
	type MaiaContextTerms,
	type MaiaEloContext,
	maiaContextPenalty,
	type OwnMoveBudgetInput,
	ownMoveBudget,
	ownMoveClockRace,
	ownMoveFeatureDepth,
	ownMoveMaiaElo,
} from "./recommendation/own-move";
export { accountPreparation } from "./recommendation/timing";
export type {
	PipelineEngine,
	RecommendationInput,
	RecommendationOutcome,
	RecommendationPipelineDeps,
} from "./recommendation/types";

export class RecommendationPipeline {
	private readonly timing: TimingModel;
	private readonly book: BookPolicy | null;
	private readonly policy: PolicyStage;
	private readonly searcher: PipelineSearcher;
	private readonly tablebase: TablebasePort | null;
	private readonly now: () => number;

	constructor(deps: RecommendationPipelineDeps) {
		const policy: PolicyPort | null = deps.policy ?? null;
		this.timing = deps.timing;
		this.book = deps.book;
		this.tablebase = deps.tablebase ?? null;
		this.now = deps.now ?? Date.now;
		this.policy = new PolicyStage(policy, this.now);
		this.searcher = new PipelineSearcher(deps.engine, this.now);
	}

	/**
	 * One position → one `Recommendation`, or `null` when the engine produced no
	 * usable line and the book had nothing either (the caller stays `analysing`).
	 */
	async run(input: RecommendationInput): Promise<RecommendationOutcome | null> {
		const preparationStarted = this.now();
		const { snapshot } = input;
		const myColor = snapshot.myColor;
		if (myColor === null || input.signal?.aborted) return null;
		// Book lookup overlaps the policy and engine work; so does a tablebase probe. The book's
		// answer (normally resident) also decides the fast-reply cap before the search starts.
		const bookPending = bookMove(this.book, input);
		const tablebasePending = tablebaseProbe(this.tablebase, input);
		// A tablebase answer is decided by the probe, not the search: the cap stays out of it.
		const fastReply = tablebasePending === null && (await isFastReply(input, bookPending));
		if (input.signal?.aborted) return null;
		const own = ownMoveContext(input, myColor, this.policy.available(), fastReply);
		const timingCtx = timingContext(input, own, this.timing.state.lastEvalOurPov);
		const window = new PreparationWindow(preparationStarted, own.budget, this.now);
		// Timing inference only needs position/history/clocks; overlap its bounded
		// preparation with the search, then fill the chosen move before sampling.
		const inference = new TimingInference(
			this.timing,
			timingCtx,
			own.timingBudgetMs,
			input.signal,
			timingCandidates(input)
		);
		const policyStart = this.policy.acquire(input, own.maiaElo);
		const policyQuery = policyStart.query;

		try {
			let acquired: Awaited<ReturnType<typeof acquireAnalysis>>;
			try {
				acquired = await acquireAnalysis(
					{ searcher: this.searcher, policy: this.policy, now: this.now },
					input,
					own,
					window,
					policyStart
				);
			} finally {
				await inference.settle(
					Math.min(TIMING_CONSTANTS.chessmimic.inferenceBudgetMs, own.timingBudgetMs) -
						(this.now() - preparationStarted)
				);
			}
			if (!acquired || input.signal?.aborted) return null;
			const { analysis } = acquired;
			const bookAnswer = await bookPending;
			// Any final policy wait must fit both its inference budget and the shared deadline.
			let policy = acquired.policy;
			if (!policy && policyQuery)
				policy = await this.policy.await(
					policyQuery,
					input.signal,
					Math.min(MAIA.inferenceBudgetMs, Math.max(0, window.deadlineMs - policyQuery.issuedAt)),
					true
				);
			if (input.signal?.aborted) return null;
			const policyResult = policy?.result ?? null;
			noteShortHistory(policy, snapshot.ply);
			const opening = openingChoice(input, own.maia, policyResult, bookAnswer);

			const candidates = await scoreExtraCandidates(
				this.searcher,
				input,
				own,
				window,
				acquired,
				policyResult
			);
			if (!candidates) return null;
			const { lines, maiaExtra } = candidates;
			const tablebaseChoice = tablebasePending
				? await tablebaseMove(input, tablebasePending, lines, {
						waitMs: tablebaseWaitMs(input, own, window, this.now()),
					})
				: null;
			if (input.signal?.aborted) return null;
			const chosen =
				tablebaseChoice ??
				chooseMove(
					input,
					lines,
					opening.book,
					analysis,
					policyResult,
					maiaExtra,
					own.maiaElo,
					own.maia
				);
			if (!chosen) return null;
			markIncompleteSearch(chosen, analysis, lines.length);

			if (input.signal?.aborted) return null;
			await prepareChosenMove(this.timing, timingCtx, chosen.uci, input.signal);
			if (input.signal?.aborted) return null;
			const plan = planChosenMove(
				this.timing,
				timingCtx,
				{ chosen, lines, bookAnswer, maiaOpening: opening.maiaOpening, ply: snapshot.ply },
				this.now
			);
			return assembleOutcome(input, {
				chosen,
				lines,
				analysis,
				plan,
				policy,
				budget: acquired.shaped?.budget ?? own.budget,
			});
		} finally {
			inference.release();
			policyQuery?.abort.abort();
		}
	}
}
