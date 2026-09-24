/** The inference port the head queries, and the budget every query runs under. */
import type { TimingPreparation } from "../types";
import type { ChessMimicInputs } from "./inputs";

/** What the inference port resolves: the 30 probabilities and the band that produced them. */
export interface InferResult {
	probs: number[];
	band: string;
	/** Inference wall time in the offscreen document, when reported. */
	ms?: number;
}

/** Inference port: resolves the bucket probabilities, or `null` on failure. */
export type InferPort = (
	inputs: ChessMimicInputs,
	options?: TimingPreparation
) => Promise<InferResult | null>;

/** Resolve `p`, or `null` once `budgetMs` passes or `signal` aborts, whichever comes first. */
export function withBudget<T>(
	p: Promise<T | null>,
	budgetMs: number,
	signal?: AbortSignal
): Promise<T | null> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: T | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(value);
		};
		const abort = () => finish(null);
		const timer = setTimeout(abort, budgetMs);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		p.then(finish, abort);
	});
}
