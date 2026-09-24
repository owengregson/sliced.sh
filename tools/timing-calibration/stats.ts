/**
 * tools/timing-calibration/stats.ts — think-time distribution statistics with honest uncertainty.
 *
 * Per cell (time-control group × rating band × situation):
 *
 *   q10 … q90   think-time quantiles (s), linearly interpolated
 *   premove     P(think ≤ `PREMOVE_MAX_MS`) — chess.com's 0.1 s premove tick
 *   sub1        P(think < 1 s)
 *   crps        mean CRPS of the bot's empirical distribution against each human think (s)
 *   ks          two-sample Kolmogorov–Smirnov distance
 *   auc         P(bot think > human think) + ½ P(tie): the AUC of the best real-vs-bot classifier
 *               that sees one think time (0.5 = indistinguishable; reported as |AUC − 0.5| too)
 *
 * Moves of one player are not independent (pace is a personal trait, and one prolific account can
 * dominate a bucket), so intervals are **cluster bootstrap by player**: players are resampled with
 * replacement and every statistic is recomputed; the 2.5/97.5 percentiles are the 95 % interval.
 * The bot's draws are clustered by the human side they replay.
 *
 * Parts: `stats/summary.ts` (quantiles, shares and the cluster bootstrap), `stats/distance.ts`
 * (CRPS, KS, AUC, `compare`), `stats/sample.ts` (the per-player cap and the hash).
 */

export { auc, type Comparison, compare, crps, ks } from "./stats/distance";
export { capSides, hash32 } from "./stats/sample";
export {
	byCluster,
	type Interval,
	type Obs,
	QUANTILES,
	quantileSorted,
	type Summary,
	type SummaryCI,
	summarise,
	summariseCI,
	summariseGroups,
} from "./stats/summary";
