/** The records the Maia draw passes between its rails, band terms and pick record. */

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
	/** Safe endgame exchange factors; applied once, after tie-band preferences. */
	simplification?: ReadonlyMap<string, number>;
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
	/** `KL(final weights ‖ Maia renormalised over the drawn set)`, including policy preferences. */
	klFromMaia: number;
	/** Survivors the technique tie-break reordered (0 when the band had one member or no prior came). */
	tieBand: number;
	/** Survivors the H13 practical-difficulty term reordered (0 unless behind and the band had ≥ 2). */
	practicalBand: number;
	temperature: number;
}
