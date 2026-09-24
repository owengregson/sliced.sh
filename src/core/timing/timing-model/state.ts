/** The per-game timing state and the settings knobs the heads read. */
import { TIMING_CONSTANTS as C } from "../constants";
import type { GameTimingState, TimingKnobs, TimingSettings } from "../types";

export function knobsFromSettings(settings: TimingSettings): TimingKnobs {
	return {
		sigmaScale: Math.max(0, settings.varianceScale),
		piOffset: (settings.premoveTendency - C.knobs.premoveNeutral) * C.knobs.premoveLogitSpan,
		lambdaScale: Math.max(0, settings.longThinkFrequency),
	};
}

export function freshState(gameId: string, knobs?: TimingKnobs): GameTimingState {
	return {
		gameId,
		fen: "",
		ply: 0,
		eps: 0,
		freezeEps: false,
		tilt: 0,
		oppThinkMs: [],
		myThinkMs: [],
		plannedMs: [],
		paceResiduals: [],
		lastEvalOurPov: null,
		lastPlan: null,
		knobs: knobs ? { ...knobs } : { sigmaScale: 1, piOffset: 0, lambdaScale: 1 },
	};
}

/**
 * Copy a previous model's per-game history into `st`: the AR(1) residual, the tilt counter, both
 * pace histories, planned timing history and the eval the tilt trigger compares against.
 */
export function adoptHistory(st: GameTimingState, previous: GameTimingState): void {
	st.eps = previous.eps;
	st.tilt = previous.tilt;
	st.oppThinkMs = [...previous.oppThinkMs];
	st.myThinkMs = [...previous.myThinkMs];
	st.plannedMs = [...previous.plannedMs];
	st.paceResiduals = [...previous.paceResiduals];
	st.lastEvalOurPov = previous.lastEvalOurPov;
	st.lastPlan = previous.lastPlan;
}
