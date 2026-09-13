import { clamp } from "@core/util/clamp";
import { budgetController } from "./budget";
import { TIMING_CONSTANTS } from "./constants";
import { hardCapSec } from "./pressure";
import { ratingPace } from "./rating-pace";
import type { Features, Persona } from "./types";

const C = TIMING_CONSTANTS.moveBudget;

export interface MoveBudget {
	allocationSec: number;
	targetSec: number;
	capSec: number;
	effort: number;
	recognition: number;
	complexity: number;
	recognitionCapSec: number;
}

/** Allocate more to difficult decisions, with stronger recognition/selectivity at higher ratings. */
export function createMoveBudget(
	f: Features,
	persona: Persona,
	speedScale = 1,
	allocationOverride?: number
): MoveBudget {
	const rating =
		f.targetElo ??
		TIMING_CONSTANTS.features.eloCentre + f.elo_z * TIMING_CONSTANTS.features.eloHalfRange;
	const profile = ratingPace(rating);
	const knownChoices = f.analysis_lines === undefined || f.analysis_lines >= 2;
	const uncertainty = knownChoices
		? clamp(f.ln_n_reasonable / Math.log(C.complexityReferenceChoices), 0, 1)
		: 0.5;
	const tactical = clamp(
		f.swing_bad / C.swingScale +
			f.is_promotion * 0.35 +
			(f.is_forced && !f.is_recapture && knownChoices ? 0.45 + profile.selectivity * 0.25 : 0),
		0,
		1
	);
	// A unique engine best move can be difficult to discover. Only observable, familiar replies qualify.
	const recognition = Math.max(
		f.in_book * profile.recognition,
		f.is_only_legal,
		f.ponder_hit * (0.5 + profile.recognition * 0.4),
		(f.threat_reply ?? 0) * (0.3 + profile.recognition * 0.35),
		f.is_recapture && f.n_reasonable === 1 && knownChoices ? 0.45 + profile.recognition * 0.5 : 0
	);
	const complexity = Math.max(uncertainty, tactical) * (1 - recognition);
	const phaseEffort = f.phase_mid ? 1.08 : f.phase_end ? 0.9 : 0.95;
	const effort = clamp(
		(C.routineEffort + C.complexityEffort * complexity * (0.5 + profile.selectivity)) *
			(1 - C.recognitionDiscount * recognition) *
			phaseEffort,
		C.minimumEffort,
		C.maximumEffort
	);
	const allocationSec = budgetController(f, persona);
	const speed = Math.max(0, speedScale);
	const targetSec = (allocationOverride ?? allocationSec) * effort * speed;
	const burst = C.normalBurst + (C.criticalBurst - C.normalBurst) * complexity;
	const capSec =
		f.tc === "untimed"
			? Number.POSITIVE_INFINITY
			: Math.min(
					hardCapSec(f),
					Math.max(TIMING_CONSTANTS.caps.tinyCapS, allocationSec * burst * Math.min(1, speed)),
					Math.max(
						TIMING_CONSTANTS.caps.tinyCapS,
						f.clock_s * C.clockFraction + Math.max(0, f.inc_s) * C.incrementBurst
					)
				);
	const recognitionCapSec = recognition > 0 ? 1 + (1 - recognition) * 4 : Number.POSITIVE_INFINITY;
	return { allocationSec, targetSec, capSec, effort, recognition, complexity, recognitionCapSec };
}
