/**
 * Turning Maia-3's raw outputs into a legal-move distribution, and that distribution into the
 * selector's sampling weights. Pure.
 *
 * - `decodeMaiaOutputs`: the 4352 move logits are gathered at the legal indices only (the model
 *   scores every from→to pair, legal or not), max-subtracted, exponentiated and normalised — the
 *   masked softmax the paper evaluates with — then mapped back to board-frame UCI (un-mirrored
 *   when black is to move) and sorted by probability. The three value logits are softmaxed to
 *   side-to-move `(loss, draw, win)`.
 * - `temperedWeights`: `p^(1/T)` renormalised, after dropping moves under `minProb` (unless that
 *   would drop every move); `T ≤ 0` is argmax (weight 1 on the top move, nothing else). Order is
 *   the caller's.
 * - `policyEntropy` (H5, 2026-09-13): the model's own uncertainty about the position, normalised
 *   so a coin flip between every legal move is 1 and a forced move is 0.
 * - `klDivergence` (§3.2 meters): how far a final draw distribution sits from the model's.
 */

import { type MaiaEncoded, maiaIndexToUci } from "./maia-encoder";

export interface MaiaDecoded {
	/** `[uci, p]` over the legal moves in the board frame, descending by `p`, summing to 1. */
	moves: Array<[string, number]>;
	/** Side-to-move `(loss, draw, win)`. */
	wdl: [number, number, number];
}

/** Mask `moveLogits` (length `MAIA_INPUT.moveVocab`) to `encoded.legal`, softmax, un-mirror; `valueLogits` → softmax. */
export function decodeMaiaOutputs(
	moveLogits: ArrayLike<number>,
	valueLogits: ArrayLike<number>,
	encoded: Pick<MaiaEncoded, "legal" | "mirrored">
): MaiaDecoded {
	const { legal, mirrored } = encoded;
	const n = legal.length;
	let max = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < n; i++) {
		const logit = moveLogits[legal[i] ?? 0] ?? Number.NEGATIVE_INFINITY;
		if (logit > max) max = logit;
	}
	const weights = new Float64Array(n);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const logit = moveLogits[legal[i] ?? 0] ?? Number.NEGATIVE_INFINITY;
		const w = Math.exp(logit - max);
		weights[i] = w;
		sum += w;
	}
	const moves: Array<[string, number]> = [];
	for (let i = 0; i < n; i++) {
		const index = legal[i];
		if (index === undefined) continue;
		moves.push([maiaIndexToUci(index, mirrored), sum > 0 ? (weights[i] ?? 0) / sum : 1 / n]);
	}
	moves.sort((a, b) => b[1] - a[1]);

	const v0 = valueLogits[0] ?? 0;
	const v1 = valueLogits[1] ?? 0;
	const v2 = valueLogits[2] ?? 0;
	const vMax = Math.max(v0, v1, v2);
	const e0 = Math.exp(v0 - vMax);
	const e1 = Math.exp(v1 - vMax);
	const e2 = Math.exp(v2 - vMax);
	const vSum = e0 + e1 + e2;
	return { moves, wdl: [e0 / vSum, e1 / vSum, e2 / vSum] };
}

/**
 * `p^(1/T)` over the given moves, renormalised — the draw weights for a temperature. Moves below
 * `minProb` (before tempering) are dropped unless nothing would remain.
 */
export function temperedWeights(
	moves: ReadonlyArray<readonly [string, number]>,
	temperature: number,
	minProb: number
): Map<string, number> {
	const out = new Map<string, number>();
	if (moves.length === 0) return out;
	let kept: ReadonlyArray<readonly [string, number]> = moves.filter(([, p]) => p >= minProb);
	if (kept.length === 0) kept = moves;
	if (!(temperature > 0)) {
		let top = kept[0];
		for (const move of kept) if (top === undefined || move[1] > top[1]) top = move;
		if (top) out.set(top[0], 1);
		return out;
	}
	const power = 1 / temperature;
	let sum = 0;
	const tempered: Array<[string, number]> = [];
	for (const [uci, p] of kept) {
		const w = p > 0 ? p ** power : 0;
		tempered.push([uci, w]);
		sum += w;
	}
	for (const [uci, w] of tempered) out.set(uci, sum > 0 ? w / sum : 1 / tempered.length);
	return out;
}

/**
 * Normalised Shannon entropy of a move distribution: `−Σ p log p / log(#moves)` in [0, 1] (the
 * probabilities are renormalised first, so a partial list still answers). `0` for one move or
 * none — there is nothing to be uncertain about.
 */
export function policyEntropy(moves: ReadonlyArray<readonly [string, number]>): number {
	if (moves.length <= 1) return 0;
	let sum = 0;
	for (const [, p] of moves) if (p > 0) sum += p;
	if (sum <= 0) return 0;
	let h = 0;
	for (const [, p] of moves) {
		if (p <= 0) continue;
		const q = p / sum;
		h -= q * Math.log(q);
	}
	return Math.min(1, Math.max(0, h / Math.log(moves.length)));
}

/**
 * `KL(q ‖ p)` in nats over the keys of `q`, with `p` renormalised over those same keys — the
 * amount by which a draw distribution `q` departs from the model's `p` on the set it was drawn
 * over. `0` when they agree; a key `p` gives no mass to contributes nothing when `q` gives it
 * none either and is treated as maximally surprising otherwise (the sum is left at `Infinity`).
 */
export function klDivergence(
	q: ReadonlyMap<string, number>,
	p: ReadonlyMap<string, number>
): number {
	let qSum = 0;
	let pSum = 0;
	for (const [uci, w] of q) {
		if (w > 0) qSum += w;
		pSum += Math.max(0, p.get(uci) ?? 0);
	}
	if (qSum <= 0) return 0;
	let kl = 0;
	for (const [uci, w] of q) {
		if (w <= 0) continue;
		const qi = w / qSum;
		const pi = pSum > 0 ? Math.max(0, p.get(uci) ?? 0) / pSum : 0;
		if (pi <= 0) return Number.POSITIVE_INFINITY;
		kl += qi * Math.log(qi / pi);
	}
	return Math.max(0, kl);
}
