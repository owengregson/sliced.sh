/**
 * The timing model's part in a recommendation: its context, the bounded inference that overlaps
 * the search, and the plan for the chosen move, charged with the preparation already spent.
 */

import { BOOK } from "@core/constants/books";
import { remainingMoveWindow } from "@core/timing/move-window";
import type { TimingModel } from "@core/timing/timing-model";
import type { TimingContext, TimingPlan } from "@core/timing/types";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";

import type { OwnMoveContext } from "./context";
import type { RecommendationInput } from "./types";

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

/** The timing context before a move is chosen; `planChosenMove` fills the move and its lines. */
export function timingContext(
	input: RecommendationInput,
	own: OwnMoveContext,
	evalBeforeOppMove: TimingContext["evalBeforeOppMove"]
): TimingContext {
	const { snapshot } = input;
	return {
		fen: snapshot.fen,
		ply: snapshot.ply,
		moves: [...input.moves],
		myColor: own.myColor,
		chosenMove: "",
		lines: [],
		evalBeforeOppMove,
		expectedOppReply: input.expectedOppReply,
		myClockMs: own.myClockMs,
		oppClockMs: own.oppClockMs,
		baseSec: own.baseSec,
		incSec: own.incSec,
		oppThinkMsHistory: [...input.oppThinkMsHistory],
		myThinkMsHistory: [...input.myThinkMsHistory],
		site: snapshot.site,
		targetElo: input.targetElo,
		profile: input.persona,
		engineReady: input.engineReady,
		inputMethod: input.inputMethod,
		autoQueen: input.autoQueen,
		nowMs: input.nowMs,
		priorFen: input.priorFen ?? null,
		hoverSquare: input.hoverSquare ?? null,
	};
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

/**
 * Timing inference only needs position/history/clocks: it runs bounded alongside the search, and
 * is cancelled with the recommendation or once its window has passed.
 */
export class TimingInference {
	private readonly controller = new AbortController();
	private readonly onAbort = () => this.controller.abort();
	private readonly pending: Promise<void>;

	constructor(
		timing: TimingModel,
		ctx: TimingContext,
		budgetMs: number,
		private readonly signal: AbortSignal | undefined
	) {
		signal?.addEventListener("abort", this.onAbort, { once: true });
		this.pending = timing.prepare(ctx, { budgetMs, signal: this.controller.signal });
	}

	/**
	 * Cached analysis may return before warmed inference. Keep only the original short inference
	 * window (`remainingMs`); searches already beyond it never wait any longer.
	 */
	async settle(remainingMs: number): Promise<void> {
		await finishTimingPreparation(this.pending, remainingMs, this.signal);
		this.release();
		await this.pending;
	}

	/** Cancel whatever inference is still running and drop the abort listener (idempotent). */
	release(): void {
		this.controller.abort();
		this.signal?.removeEventListener("abort", this.onAbort);
	}
}

/** What the timing plan needs to know about the chosen move. */
export interface ChosenForTiming {
	chosen: ChosenMove;
	lines: EvalLine[];
	bookAnswer: ChosenMove | null;
	maiaOpening: boolean;
	ply: number;
}

/** Fill the chosen move into the context and plan it, charged with the preparation spent. */
export function planChosenMove(
	timing: TimingModel,
	ctx: TimingContext,
	move: ChosenForTiming,
	now: () => number
): TimingPlan {
	const { chosen, bookAnswer } = move;
	ctx.chosenMove = chosen.uci;
	ctx.lines = move.lines;
	// Familiarity belongs to the chosen book move or a confident Maia opening choice.
	const inBook =
		bookAnswer?.uci === chosen.uci ||
		(move.maiaOpening &&
			move.ply <= BOOK.maxPly &&
			(chosen.maiaProb ?? 0) >= BOOK.maiaOpeningMinProb);
	if (inBook) ctx.inBook = true;
	return accountPreparation(timing.planMove(ctx), now());
}
