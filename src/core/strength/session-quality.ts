import { QUALITY_STATISTICS } from "@core/constants/telemetry";
import type { SessionStats, TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";
import { bandFor } from "./bands";

export interface QualityContext {
	gameId: string;
	cohortKey: string;
	targetElo: number;
}

/** Targets sharing a reference band can accumulate across persona-matched opponents. */
export function qualityCohortKey(
	targetElo: number,
	strength: Settings["strength"],
	timeControl: TimeControl | undefined
): string {
	return JSON.stringify([
		QUALITY_STATISTICS.version,
		bandFor(targetElo).elo,
		strength.selectionMode,
		strength.persona,
		strength.blunderScale,
		strength.useOpeningBook,
		timeControl?.baseMs ?? null,
		timeControl?.incMs ?? null,
	]);
}

/** Preserve activity/receipts, but never relabel legacy clipped, mixed-target quality as current. */
export function normalizeQualityStats(stats: SessionStats): SessionStats {
	if (stats.qualityVersion === QUALITY_STATISTICS.version) return stats;
	const {
		top1Pct: _top1,
		acpl: _acpl,
		lossM2: _lossM2,
		scoredMoves: _scored,
		outOfBandStreak: _streak,
		qualityCohorts: _cohorts,
		qualityGames: _games,
		...activity
	} = stats;
	return { ...activity, qualityVersion: QUALITY_STATISTICS.version };
}
