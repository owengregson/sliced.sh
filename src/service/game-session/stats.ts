/**
 * Activity totals remain global. Search-quality diagnostics are versioned and grouped by
 * the reference rating band/settings/time control captured when the recommendation was produced.
 * Each finished game is judged on its own eligible sample, never a cumulative mixed pair.
 */
import { LIMITS } from "@core/constants/limits";
import { QUALITY_STATISTICS, TIMING_STATISTICS } from "@core/constants/telemetry";
import { checkQualityBand } from "@core/strength/quality-band";
import { normalizeQualityStats, type QualityContext } from "@core/strength/session-quality";
import { normalizeTimingStats } from "@core/timing/session-stats";
import type { SessionQualitySample, SessionStats } from "@typedefs/game";

const PERCENT = 100;

export const EMPTY_STATS: Readonly<SessionStats> = Object.freeze({
	games: 0,
	moves: 0,
	avgThinkMs: 0,
	timingVersion: TIMING_STATISTICS.version,
	timingSamples: 0,
	qualityVersion: QUALITY_STATISTICS.version,
});

export interface MoveOutcome {
	/** Absent for queued premoves whose acceptance cannot be timed from the opponent's move. */
	thinkMs?: number;
	/** True only for comparable, sufficiently searched non-forced root evaluations. */
	scored: boolean;
	top1: boolean;
	cpLoss: number;
	/** Captured at search time, not from mutable settings at execution/game end. */
	qualityContext?: QualityContext | undefined;
}

function addSample(sample: Partial<SessionQualitySample>, move: MoveOutcome): SessionQualitySample {
	const previous = sample.scoredMoves ?? 0;
	const scoredMoves = previous + 1;
	const priorLoss = sample.acpl ?? 0;
	const delta = move.cpLoss - priorLoss;
	const acpl = priorLoss + delta / scoredMoves;
	return {
		scoredMoves,
		top1Pct: ((sample.top1Pct ?? 0) * previous + (move.top1 ? PERCENT : 0)) / scoredMoves,
		acpl,
		lossM2: Math.max(0, (sample.lossM2 ?? 0) + delta * (move.cpLoss - acpl)),
	};
}

export function foldMove(stored: SessionStats, move: MoveOutcome): SessionStats {
	const stats = normalizeTimingStats(normalizeQualityStats(stored));
	const moves = stats.moves + 1;
	const measuredMs =
		move.thinkMs !== undefined && Number.isFinite(move.thinkMs) && move.thinkMs >= 0
			? move.thinkMs
			: null;
	const timingSamples = (stats.timingSamples ?? 0) + (measuredMs === null ? 0 : 1);
	const next: SessionStats = {
		...stats,
		moves,
		timingSamples,
		avgThinkMs:
			measuredMs !== null
				? stats.avgThinkMs + (measuredMs - stats.avgThinkMs) / timingSamples
				: stats.avgThinkMs,
	};
	const context = move.qualityContext;
	if (
		!move.scored ||
		!Number.isFinite(move.cpLoss) ||
		move.cpLoss < 0 ||
		!context?.gameId ||
		!Number.isFinite(context.targetElo) ||
		stats.finishedGameIds?.includes(context.gameId)
	)
		return next;
	// Retained for aggregate exports; the live view and warnings use only the matching cohort.
	Object.assign(next, addSample(stats, move));
	const cohorts = [...(stats.qualityCohorts ?? [])];
	const oldCohort = cohorts.find((c) => c.key === context.cohortKey);
	next.qualityCohorts = [
		...cohorts.filter((c) => c.key !== context.cohortKey),
		{
			key: context.cohortKey,
			targetElo: context.targetElo,
			eligibleGames: oldCohort?.eligibleGames ?? 0,
			outOfBandStreak: oldCohort?.outOfBandStreak ?? 0,
			...addSample(oldCohort ?? {}, move),
		},
	].slice(-QUALITY_STATISTICS.maxCohorts);
	const games = stats.qualityGames ?? [];
	const sameSample = (game: (typeof games)[number]): boolean =>
		game.gameId === context.gameId && game.cohortKey === context.cohortKey;
	next.qualityGames = [
		...games.filter((game) => !sameSample(game)),
		{ ...context, ...addSample(games.find(sameSample) ?? {}, move) },
	].slice(-QUALITY_STATISTICS.maxPendingGames);
	return next;
}

/** Short/unscored games are excluded from the diagnostic streak, not treated as failures. */
export function foldGame(stored: SessionStats, gameId?: string | null): SessionStats {
	const stats = normalizeTimingStats(normalizeQualityStats(stored));
	const knownGames = Array.isArray(stats.finishedGameIds)
		? stats.finishedGameIds.filter((id) => typeof id === "string" && id.length > 0)
		: [];
	if (gameId && knownGames.includes(gameId)) return stats;
	const samples = (stats.qualityGames ?? []).filter((game) => game.gameId === gameId);
	const cohorts = (stats.qualityCohorts ?? []).map((cohort) => {
		const sample = samples.find((game) => game.cohortKey === cohort.key);
		if (!sample || sample.scoredMoves < QUALITY_STATISTICS.minGameMoves) return cohort;
		const verdict = checkQualityBand(sample.targetElo, sample);
		if (verdict.state === "insufficient") return cohort;
		return {
			...cohort,
			eligibleGames: cohort.eligibleGames + 1,
			outOfBandStreak: verdict.state === "outside" ? cohort.outOfBandStreak + 1 : 0,
		};
	});
	return {
		...stats,
		games: stats.games + 1,
		qualityCohorts: cohorts,
		qualityGames: (stats.qualityGames ?? []).filter((game) => game.gameId !== gameId),
		...(gameId
			? { finishedGameIds: [...knownGames, gameId].slice(-LIMITS.finishedGameHistorySize) }
			: {}),
	};
}
