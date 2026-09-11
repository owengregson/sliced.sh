import { LIMITS } from "@core/constants/limits";
import { COPY } from "../copy";
import type { SliderThreshold } from "./slider";

/** The strength controls share the engine's network cutoff and accessible range description. */
export const STRENGTH_NETWORK_THRESHOLD: SliderThreshold = {
	value: LIMITS.nnueSmallEloMax,
	label: COPY.strength.networkCutoff(LIMITS.nnueSmallEloMax),
	lowerLabel: COPY.strength.smallNetwork,
	upperLabel: COPY.strength.largeNetwork,
	description: COPY.strength.networkDescription(LIMITS.nnueSmallEloMax, LIMITS.eloMax),
};
