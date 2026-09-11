import { TIMING_STATISTICS } from "@core/constants/telemetry";
import type { SessionStats } from "@typedefs/game";

/** Never mix historical hand-window averages with measured turn-to-submission time. */
export function normalizeTimingStats(stats: SessionStats): SessionStats {
	if (
		stats.timingVersion === TIMING_STATISTICS.version &&
		Number.isSafeInteger(stats.timingSamples) &&
		(stats.timingSamples ?? -1) >= 0 &&
		Number.isFinite(stats.avgThinkMs) &&
		stats.avgThinkMs >= 0
	)
		return stats;
	return { ...stats, timingVersion: TIMING_STATISTICS.version, timingSamples: 0, avgThinkMs: 0 };
}
