/** Policy acquisition: reuse a held Maia answer, or query the port and wait for it on a budget. */

import { positionKey } from "@core/chess/history";
import { MAIA, MAIA_INPUT } from "@core/constants/maia";
import { log } from "@core/logger";
import { maiaConditioningElo, maiaSizeFor } from "@core/policy/maia-size";
import { policyQueryIdentity } from "@core/policy/policy-query";
import type { PolicyInferenceInputs, PolicyPort, PolicyResult } from "@core/policy/types";
import { errorMessage } from "@core/util/errors";

import { maiaHistoryFens } from "./maia-search";
import type { MaiaEloContext } from "./own-move";
import type { PolicyAnswer, PolicyQuery, RecommendationInput } from "./types";

/** The policy the search starts with: an answer already held, or a query in flight (or neither). */
export interface PolicyAcquisition {
	held: PolicyAnswer | null;
	query: PolicyQuery | null;
}

export class PolicyStage {
	constructor(
		private readonly port: PolicyPort | null,
		private readonly now: () => number
	) {}

	/** Whether a policy port exists for this session (`MaiaSearchInput.policy`). */
	available(): boolean {
		return this.port !== null;
	}

	/** Reuse only an answer with identical model inputs and game history; otherwise query. */
	acquire(input: RecommendationInput, maiaElo: MaiaEloContext | null): PolicyAcquisition {
		const held = input.policyAnswer;
		const policyInputs = maiaElo ? this.inputs(input, maiaElo) : null;
		const identity = policyInputs
			? policyQueryIdentity({
					inputs: policyInputs,
					selectionMode: input.settings.strength.selectionMode,
					history: input.history,
				})
			: null;
		const preInferred: PolicyAnswer | null =
			maiaElo &&
			held &&
			identity !== null &&
			held.identity === identity &&
			positionKey(held.fen) === positionKey(input.snapshot.fen) &&
			held.result.size === policyInputs?.size
				? {
						result: held.result,
						selfElo: policyInputs.selfElo,
						historyPlies: policyInputs.historyFens.length,
					}
				: null;
		const query = policyInputs && !preInferred ? this.query(input, policyInputs) : null;
		return { held: preInferred, query };
	}

	/**
	 * Wait within a budget measured from query issue. The initial shaping wait can leave
	 * the query running so the selector can use an answer arriving during engine search.
	 * The final wait cancels the query when its remaining budget expires.
	 */
	async await(
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
	 * Query the retained model size with validated history and the shared effective rating.
	 * Self conditioning is capped at the supported selection ceiling; an unknown opponent
	 * uses our rating. A refused or failed query resolves to null.
	 */
	private query(input: RecommendationInput, inputs: PolicyInferenceInputs): PolicyQuery | null {
		if (!this.port) return null;
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		input.signal?.addEventListener("abort", onAbort, { once: true });
		const { selfElo, historyFens } = inputs;
		const issuedAt = this.now();
		let pending: Promise<PolicyResult | null>;
		try {
			pending = this.port
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

	private inputs(input: RecommendationInput, elo: MaiaEloContext): PolicyInferenceInputs {
		const selfElo = maiaConditioningElo(elo.selfElo);
		return {
			size: input.maiaSize ?? maiaSizeFor(input.targetElo),
			fen: input.snapshot.fen,
			historyFens: maiaHistoryFens(input.history, input.snapshot.fen),
			selfElo,
			oppoElo: input.opponentElo ?? selfElo,
		};
	}
}

/** Report missing history once the game is long enough to supply it. */
export function noteShortHistory(policy: PolicyAnswer | null, ply: number): void {
	if (policy && policy.historyPlies < MAIA_INPUT.history && ply >= MAIA_INPUT.history)
		log.debug("recommendation: maia query carried a short history", {
			historyPlies: policy.historyPlies,
			ply,
		});
}
