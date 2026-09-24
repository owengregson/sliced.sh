/** Session activity counts and the versioned search-quality samples (§13.6). */

export interface SessionQualitySample {
	scoredMoves: number;
	top1Pct: number;
	/** Mean loss between comparable root search scores, not independent post-game ACPL. */
	acpl: number;
	/** Welford sum of squared deviations for the root-loss sample. */
	lossM2: number;
}

export interface SessionQualityCohort extends SessionQualitySample {
	key: string;
	targetElo: number;
	eligibleGames: number;
	outOfBandStreak: number;
}

export interface SessionQualityGame extends SessionQualitySample {
	gameId: string;
	cohortKey: string;
	targetElo: number;
}

/** Overall activity counts plus versioned, comparable search-quality samples. */
export interface SessionStats {
	games: number;
	moves: number;
	avgThinkMs: number;
	/** Versioned full-turn observations; legacy hand-only averages are not comparable. */
	timingVersion?: number;
	timingSamples?: number;
	/** Bounded receipt history, saved atomically with the game totals for restart-safe deduplication. */
	finishedGameIds?: string[];
	/** Task 24 (§13.6 session strip): running top-1 agreement, 0–100 (absent until the first move). */
	top1Pct?: number;
	/** Running average centipawn loss (absent until the first move). */
	acpl?: number;
	/** Legacy pooled warning; discarded during quality migration. Current warnings live per cohort. */
	outOfBandStreak?: number;
	/**
	 * Moves the §13.6 quality pair was computed over — the ones that carry an engine evaluation.
	 * A premove is decided before the position exists and a book move outside the engine's lines
	 * has no rank or loss, so both are excluded from `top1Pct` / `acpl` (they would otherwise
	 * score as zero-loss non-top-1 moves and drag the pair down in exactly the speed classes
	 * §7.4 premoves in). `moves` still counts every move played.
	 */
	scoredMoves?: number;
	lossM2?: number;
	/** Older quality had no source/target provenance and is not reusable. */
	qualityVersion?: number;
	qualityCohorts?: SessionQualityCohort[];
	qualityGames?: SessionQualityGame[];
}
