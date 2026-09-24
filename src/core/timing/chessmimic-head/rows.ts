/**
 * The ChessMimic head's inferred rows for one position: the history-only row plus one row per
 * timed move, inferred under the budget, validated and cached until the next position or game.
 */
import type { ChessMimicBand } from "@core/constants/models";
import { TIMING_CONSTANTS } from "../constants";
import type { GameTimingState, TimingContext, TimingPreparation } from "../types";
import { isRegisteredBand } from "./bands";
import { type InferPort, withBudget } from "./inference";
import { buildInputs, type ChessMimicInputs } from "./inputs";

const CM = TIMING_CONSTANTS.chessmimic;

export interface CachedDistribution {
	fen: string;
	/** The timed move in the window, `""` for the history-only row. */
	move: string;
	inputs: ChessMimicInputs;
	band: ChessMimicBand;
	probs: number[];
}

/** The history-only row's key. */
const HISTORY = "";

export class ChessMimicRows {
	/** Rows for `cacheFen`, keyed by the timed move (`HISTORY` for the history-only row). */
	private cache = new Map<string, CachedDistribution>();
	private cacheFen: string | null = null;
	private failure: string | null = null;
	/** Bumped by every `prepare`/`reset`; a stale inference result never overwrites a newer cache. */
	private generation = 0;

	constructor(
		private readonly infer: InferPort,
		private readonly budgetMs: number
	) {}

	/** Why the history-only row is missing, when it is (`null` once it is cached). */
	get lastFailure(): string | null {
		return this.failure;
	}

	/** Drop the per-game cache and invalidate any in-flight inference. */
	reset(): void {
		this.generation++;
		this.cache.clear();
		this.cacheFen = null;
		this.failure = null;
	}

	/**
	 * Issue inference for `ctx`: the history-only row plus one row per `options.candidates` move,
	 * concurrently; resolves when all are cached or have failed.
	 */
	async prepare(ctx: TimingContext, options?: TimingPreparation): Promise<void> {
		const gen = ++this.generation;
		this.cache.clear();
		this.cacheFen = ctx.fen;
		const moves = [HISTORY, ...new Set((options?.candidates ?? []).filter((m) => m !== HISTORY))];
		await Promise.all(moves.map((move) => this.inferRow(ctx, move, gen, options)));
	}

	/**
	 * Make sure the row for `ctx.chosenMove` is cached: a no-op when `prepare` already inferred it
	 * as a candidate, one inference otherwise. A position `prepare` has not seen is prepared afresh.
	 */
	async prepareMove(ctx: TimingContext, options?: TimingPreparation): Promise<void> {
		const move = ctx.chosenMove;
		if (this.cacheFen !== ctx.fen) {
			await this.prepare(ctx, { ...options, candidates: move ? [move] : [] });
			return;
		}
		if (!move || this.cache.has(move)) return;
		await this.inferRow(ctx, move, this.generation, options);
	}

	private async inferRow(
		ctx: TimingContext,
		move: string,
		gen: number,
		options?: TimingPreparation
	): Promise<void> {
		const history = move === HISTORY;
		const fail = (reason: string) => {
			if (history) this.failure = reason;
		};
		let inputs: ChessMimicInputs;
		try {
			inputs = buildInputs(ctx, move);
		} catch (e) {
			fail(`inputs: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		const budgetMs = options?.budgetMs ?? this.budgetMs;
		const result = await withBudget(
			Promise.resolve().then(() => (options?.signal?.aborted ? null : this.infer(inputs, options))),
			budgetMs,
			options?.signal
		);
		if (gen !== this.generation || this.cacheFen !== ctx.fen) return;
		if (!result || options?.signal?.aborted) {
			fail(
				options?.signal?.aborted
					? "search preparation ended before inference was ready"
					: `timeout/null after ${budgetMs} ms`
			);
			return;
		}
		if (!Array.isArray(result.probs) || result.probs.length !== CM.nBuckets) {
			fail(`bad shape ${Array.isArray(result.probs) ? result.probs.length : "?"}`);
			return;
		}
		if (!isRegisteredBand(result.band)) {
			fail(`bad band ${result.band}`);
			return;
		}
		if (result.probs.some((p) => !Number.isFinite(p) || p < 0) || !result.probs.some((p) => p > 0)) {
			fail("invalid probability distribution");
			return;
		}
		if (history) this.failure = null;
		this.cache.set(move, { fen: ctx.fen, move, inputs, band: result.band, probs: result.probs });
	}

	/** The timed move's row when it was inferred, else the history-only row. */
	row(st: Pick<GameTimingState, "fen" | "move">): CachedDistribution | null {
		if (this.cacheFen !== st.fen) return null;
		return (st.move ? this.cache.get(st.move) : undefined) ?? this.cache.get(HISTORY) ?? null;
	}

	/** The row the diagnostics report for `fen`: the history-only one, else any. */
	reported(fen: string): CachedDistribution | null {
		return this.cacheFen === fen
			? (this.cache.get(HISTORY) ?? this.cache.values().next().value ?? null)
			: null;
	}
}
