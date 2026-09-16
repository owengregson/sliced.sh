/** Maia candidate safeguards, weighted draws and policy-fidelity accounting. */

import { MAIA } from "@core/constants/maia";
import { klDivergence, temperedWeights } from "@core/policy/maia-policy";
import { maiaMaxCpLoss } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import type { Rng } from "@core/rng";

/** One scored engine line as the rails see it: the flags are computed by `selectMove`. */
export interface MaiaCandidate {
	uci: string;
	/** A mated line while an unmated alternative exists (§7.2 step 5's rule). */
	mated: boolean;
	/** Never-play rule 4: the PV shows the opponent capturing next and the line loses ≥ 0.25. */
	hangs: boolean;
	/** Win-fraction loss from the **raw** engine score against the best raw line. */
	lossRaw: number;
	/** Unclipped centipawn loss, for the upper range's additional quality bound. */
	cpLoss?: number;
	/** Scored by the extra `searchmoves` search on Maia's unscored favourites, not the main set. */
	extra: boolean;
}

/**
 * H11: the technique prior for the tie band — a ready map, or a resolver called with the band's
 * UCIs once it is known (so the prior is computed for those lines only). A move the map does not
 * name counts as 1.
 */
export type MaiaTieBreak =
	| ReadonlyMap<string, number>
	| ((band: readonly string[]) => ReadonlyMap<string, number>);

/**
 * H13 (2026-09-13, the free approximation): the practical-difficulty term for the tie band — a
 * ready map of trickiness in [0, 1] per UCI, or a resolver called with the band once it is known.
 * The caller supplies it only when the position qualifies (behind by `MAIA.practical.behindCp`);
 * a move the map does not name counts as 0.
 */
export type MaiaPractical =
	| ReadonlyMap<string, number>
	| ((band: readonly string[]) => ReadonlyMap<string, number>);

export interface MaiaDrawOptions {
	/**
	 * Σ p over the lines the search scored *before* the repetition/conversion guards (D2), so the
	 * `minScoredMass` diagnostic speaks about the search, not the guards. Default: the candidates'
	 * own mass.
	 */
	scoredMassBefore?: number;
	tieBreak?: MaiaTieBreak;
	practical?: MaiaPractical;
}

/**
 * What survives the rails, with the masses the meters and the `maia:` row report — the first
 * half of `drawMaiaMove`, exposed so generate-and-verify (H3) can take the draw over.
 */
export interface MaiaSurvivors {
	/** Maia's probability per UCI over every legal move it returned. */
	prob: Map<string, number>;
	/** The candidates the rails kept, in the order handed in. */
	survivors: MaiaCandidate[];
	/** `[uci, p]` over the survivors, the draw's pool. */
	pool: Array<readonly [string, number]>;
	scored: number;
	extra: number;
	scoredMass: number;
	scoredMassBefore: number;
	unscoredMass: number;
	railedMass: number;
}

/** What the draw decided, for `finish()`, the meters and the rationale. */
export interface MaiaDraw {
	uci: string;
	/** Maia's probability of the pick (raw, before tempering). */
	p: number;
	/** 1-based rank of the pick among the survivors in Maia's ordering (D1). */
	maiaRank: number;
	/** Scored candidates handed in (before the rails), the extra search's included. */
	scored: number;
	/** Of `scored`, how many the extra `searchmoves` search added. */
	extra: number;
	/** Share of Maia's mass the candidates handed in covered (after the guards, before the rails). */
	scoredMass: number;
	/** Share of Maia's mass the search scored before the guards (`options.scoredMassBefore`). */
	scoredMassBefore: number;
	/** Maia's mass on legal moves the search never scored: `Σ p − scoredMassBefore`, floored at 0. */
	unscoredMass: number;
	/** Σ p over the scored candidates the rails excluded. */
	railedMass: number;
	/** Candidates the draw was over. */
	survivors: number;
	/** `KL(final weights ‖ Maia renormalised over the drawn set)` — 0 unless a tie-break or T ≠ 1 moved mass. */
	klFromMaia: number;
	/** Survivors the technique tie-break reordered (0 when the band had one member or no prior came). */
	tieBand: number;
	/** Survivors the H13 practical-difficulty term reordered (0 unless behind and the band had ≥ 2). */
	practicalBand: number;
	temperature: number;
}

/** `MAIA.lossCap` by effective Elo: flat outside the knots, linear between. */
export function lossCapFor(E: number): number {
	const knots = MAIA.lossCap;
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (first === undefined || last === undefined) return 1;
	if (E <= first[0]) return first[1];
	if (E >= last[0]) return last[1];
	for (let i = 1; i < knots.length; i++) {
		const lo = knots[i - 1];
		const hi = knots[i];
		if (lo === undefined || hi === undefined) continue;
		if (E <= hi[0]) {
			const t = (E - lo[0]) / (hi[0] - lo[0]);
			return lo[1] + t * (hi[1] - lo[1]);
		}
	}
	return last[1];
}

function fmt(n: number, digits = 3): string {
	return Number(n.toFixed(digits)).toString();
}

/** Maia's probability per UCI (the larger when a move is listed twice, which it never should be). */
export function policyProbabilities(policy: Pick<PolicyResult, "moves">): Map<string, number> {
	const prob = new Map<string, number>();
	for (const [uci, p] of policy.moves) prob.set(uci, Math.max(prob.get(uci) ?? 0, p));
	return prob;
}

/** H11's band: the survivors whose weight is at least `MAIA.tieBandRatio` of the top weight. */
export function tieBandOf(weights: ReadonlyMap<string, number>): string[] {
	if (weights.size < 2) return [];
	let top = 0;
	for (const w of weights.values()) top = Math.max(top, w);
	return [...weights.keys()].filter((u) => (weights.get(u) ?? 0) >= MAIA.tieBandRatio * top);
}

/**
 * Multiply the weights of `band` by `factorOf(uci)`, normalised by their probability-weighted
 * mean, so the band's total mass is unchanged and nothing outside it moves. Returns the band
 * size when it reordered anything.
 */
function scaleBand(
	weights: Map<string, number>,
	band: readonly string[],
	factorOf: (uci: string) => number
): number {
	if (band.length < 2) return 0;
	let mass = 0;
	let scaledMass = 0;
	for (const u of band) {
		const weight = weights.get(u) ?? 0;
		mass += weight;
		scaledMass += weight * Math.max(0, factorOf(u));
	}
	const mean = mass > 0 ? scaledMass / mass : 0;
	if (!(mean > 0)) return 0;
	let moved = false;
	for (const u of band) {
		const factor = Math.max(0, factorOf(u)) / mean;
		if (factor !== 1) moved = true;
		weights.set(u, (weights.get(u) ?? 0) * factor);
	}
	return moved ? band.length : 0;
}

/** H11: the technique prior over the band (a move the map does not name counts as 1). */
function applyTieBreak(
	weights: Map<string, number>,
	band: readonly string[],
	tieBreak: MaiaTieBreak | undefined
): number {
	if (tieBreak === undefined || band.length < 2) return 0;
	const values = typeof tieBreak === "function" ? tieBreak(band) : tieBreak;
	return scaleBand(weights, band, (u) => values.get(u) ?? 1);
}

/**
 * H13: `1 + trickiness` over the band (a move the map does not name counts as 0), normalised to
 * probability-weighted mean 1 — the same shape as the tie-break, so neither moves mass outside the
 * band. Returns the band size and the trickiness rows for the rationale.
 */
function applyPractical(
	weights: Map<string, number>,
	band: readonly string[],
	practical: MaiaPractical | undefined
): { moved: number; rows: string[] } {
	if (practical === undefined || band.length < 2) return { moved: 0, rows: [] };
	const values = typeof practical === "function" ? practical(band) : practical;
	const moved = scaleBand(weights, band, (u) => 1 + Math.max(0, values.get(u) ?? 0));
	const rows = band.map((u) => `${u} ${fmt(Math.max(0, values.get(u) ?? 0), 2)}`);
	return { moved, rows };
}

/**
 * The first half of `drawMaiaMove`: Maia's mass over the scored set, the rails (mated, hangs,
 * `lossCapFor(E)`) and the masses the meters report. `null` when nothing scored carries
 * `p ≥ MAIA.minProb` (the base policy must decide). Every row it has to say goes to `rationale`.
 */
export function maiaSurvivors(
	candidates: readonly MaiaCandidate[],
	policy: PolicyResult,
	E: number,
	rationale: string[],
	options: Pick<MaiaDrawOptions, "scoredMassBefore"> = {}
): MaiaSurvivors | null {
	const prob = policyProbabilities(policy);
	let total = 0;
	for (const p of prob.values()) total += p;
	let scoredMass = 0;
	let extra = 0;
	for (const c of candidates) {
		scoredMass += prob.get(c.uci) ?? 0;
		if (c.extra) extra++;
	}
	const scoredMassBefore = options.scoredMassBefore ?? scoredMass;
	const unscoredMass = Math.max(0, total - scoredMassBefore);
	if (scoredMassBefore < MAIA.minScoredMass)
		rationale.push(
			`maia: engine's scored set covers ${fmt(scoredMassBefore)} of the model's mass (< ${MAIA.minScoredMass})`
		);

	const cap = lossCapFor(E);
	const cpCap = maiaMaxCpLoss(E);
	const survivors = candidates.filter(
		(c) => !c.mated && !c.hangs && c.lossRaw <= cap && (c.cpLoss ?? 0) <= cpCap
	);
	const excluded = candidates.length - survivors.length;
	let railedMass = 0;
	if (excluded > 0) {
		const kept = new Set(survivors.map((c) => c.uci));
		for (const c of candidates) if (!kept.has(c.uci)) railedMass += prob.get(c.uci) ?? 0;
		rationale.push(
			`maia never-play: ${excluded} line(s) excluded (loss cap ${fmt(cap, 2)} at E, mass ${fmt(railedMass)})`
		);
	}
	const pool: Array<readonly [string, number]> = survivors.map((c) => [c.uci, prob.get(c.uci) ?? 0]);
	if (!pool.some(([, p]) => p >= MAIA.minProb)) {
		rationale.push(`maia: no scored candidate at p ≥ ${MAIA.minProb}, base policy`);
		return null;
	}
	return {
		prob,
		survivors,
		pool,
		scored: candidates.length,
		extra,
		scoredMass,
		scoredMassBefore,
		unscoredMass,
		railedMass,
	};
}

/**
 * The record of a Maia pick `uci` over `set` — the rank among the survivors, the `maia:` and
 * `maia wdl:` rows — for whichever stage chose it (the weighted draw, or generate-and-verify).
 */
export function maiaDrawRecord(
	set: MaiaSurvivors,
	policy: PolicyResult,
	E: number,
	uci: string,
	moved: { klFromMaia: number; tieBand: number; practicalBand: number },
	rationale: string[]
): MaiaDraw {
	const { prob, survivors, scoredMass, scoredMassBefore, unscoredMass, railedMass, extra } = set;
	const p = prob.get(uci) ?? 0;
	const ordered = [...survivors].sort((a, b) => (prob.get(b.uci) ?? 0) - (prob.get(a.uci) ?? 0));
	const maiaRank = ordered.findIndex((c) => c.uci === uci) + 1;
	const ms = policy.ms === undefined ? "n/a" : fmt(policy.ms, 0);
	const added = extra > 0 ? ` (+${extra} from searchmoves)` : "";
	const guards =
		fmt(scoredMassBefore) !== fmt(scoredMass) ? ` (guards left ${fmt(scoredMass)})` : "";
	const railed = railedMass > 0 ? ` railed ${fmt(railedMass)}` : "";
	const kl = moved.klFromMaia > 0 ? ` KL ${fmt(moved.klFromMaia)}` : "";
	rationale.push(
		`maia: ${policy.size} E=${fmt(E, 0)} p=${fmt(p)} rank ${maiaRank}/${survivors.length} survivors scored mass ${fmt(scoredMassBefore)}${guards}${added} unscored ${fmt(unscoredMass)}${railed}${kl} ${ms} ms`
	);
	const [loss, draw, win] = policy.wdl;
	rationale.push(`maia wdl: ${fmt(loss, 2)}/${fmt(draw, 2)}/${fmt(win, 2)}`);
	return {
		uci,
		p,
		maiaRank,
		scored: set.scored,
		extra,
		scoredMass,
		scoredMassBefore,
		unscoredMass,
		railedMass,
		survivors: survivors.length,
		klFromMaia: moved.klFromMaia,
		tieBand: moved.tieBand,
		practicalBand: moved.practicalBand,
		temperature: MAIA.temperature,
	};
}

/**
 * The second half of `drawMaiaMove`: one weighted draw from Maia's distribution over the
 * survivors at `MAIA.temperature`, with the H11 tie-break and the H13 practical-difficulty term
 * applied inside the tie band, and the pick's record.
 */
export function drawMaiaFromSurvivors(
	set: MaiaSurvivors,
	policy: PolicyResult,
	E: number,
	rng: Rng,
	rationale: string[],
	options: Pick<MaiaDrawOptions, "tieBreak" | "practical"> = {}
): MaiaDraw {
	const weights = temperedWeights(set.pool, MAIA.temperature, MAIA.minProb);
	const band = tieBandOf(weights);
	const tieBand = applyTieBreak(weights, band, options.tieBreak);
	if (tieBand > 0)
		rationale.push(
			`maia tie-break: ${tieBand} near-equal survivors (≥ ${MAIA.tieBandRatio}× top weight), technique prior applied`
		);
	const practical = applyPractical(weights, band, options.practical);
	if (practical.moved > 0)
		rationale.push(
			`maia practical: ${practical.moved} near-equal survivors weighted by 1 + trickiness (${practical.rows.join(", ")})`
		);
	const items = [...weights.keys()];
	const uci = rng.weighted(
		items,
		items.map((u) => weights.get(u) ?? 0)
	);
	return maiaDrawRecord(
		set,
		policy,
		E,
		uci,
		{ klFromMaia: klDivergence(weights, set.prob), tieBand, practicalBand: practical.moved },
		rationale
	);
}

/**
 * Draw one of `candidates` from Maia's distribution at the rating `E` (already the one the query
 * was issued at: pressure, slider, context and ambiguity folded in by `maiaSelfElo`), or `null`
 * when the base policy must decide this move (nothing scored carries `p ≥ MAIA.minProb`, or the
 * rails emptied the set). Every outcome leaves its reason in `rationale`.
 */
export function drawMaiaMove(
	candidates: readonly MaiaCandidate[],
	policy: PolicyResult,
	E: number,
	rng: Rng,
	rationale: string[],
	options: MaiaDrawOptions = {}
): MaiaDraw | null {
	const set = maiaSurvivors(candidates, policy, E, rationale, options);
	if (set === null) return null;
	return drawMaiaFromSurvivors(set, policy, E, rng, rationale, options);
}
