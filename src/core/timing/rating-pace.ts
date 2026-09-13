import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";

export interface RatingPace {
	recognition: number;
	selectivity: number;
	discipline: number;
}

/** Continuous policy priors; ratings beyond the measured human range saturate conservatively. */
export function ratingPace(targetElo: number): RatingPace {
	const knots = TIMING_CONSTANTS.ratingPace.knots;
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (!first || !last) throw new RangeError("rating timing profile is empty");
	const elo = Number.isFinite(targetElo) ? clamp(targetElo, first[0], last[0]) : 1650;
	let low = first;
	let high = last;
	for (const knot of knots) {
		if (knot[0] >= elo) {
			high = knot;
			break;
		}
		low = knot;
	}
	const t = high[0] === low[0] ? 0 : (elo - low[0]) / (high[0] - low[0]);
	const at = (i: 1 | 2 | 3) => low[i] + t * (high[i] - low[i]);
	return { recognition: at(1), selectivity: at(2), discipline: at(3) };
}
