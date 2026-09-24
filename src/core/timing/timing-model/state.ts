/** The per-game timing state, the settings knobs the heads read, and how a move updates both. */
import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS as C } from "../constants";
import type {
	Features,
	GameTimingState,
	TimingContext,
	TimingKnobs,
	TimingPlan,
	TimingSettings,
} from "../types";

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

/** A move is being planned: the position, the move and the ply the heads read. */
export function beginMove(st: GameTimingState, ctx: TimingContext): void {
	st.fen = ctx.fen;
	st.move = ctx.chosenMove;
	st.ply = ctx.ply;
}

/** Tilt: a large eval drop since our last plan starts `C.tilt.moves` tilted moves (not re-armed while one runs). */
export function armTilt(st: GameTimingState, f: Features): void {
	if (st.lastEvalOurPov !== null && f.eval_cp <= st.lastEvalOurPov - C.tilt.dropCp && st.tilt === 0)
		st.tilt = C.tilt.moves;
}

/** The plan was made: remember it, the eval the tilt trigger compares against and their thinks. */
export function recordPlan(
	st: GameTimingState,
	plan: TimingPlan,
	f: Features,
	ctx: TimingContext
): void {
	st.plannedMs.push(plan.thinkMs);
	st.lastPlan = plan;
	st.lastEvalOurPov = f.eval_cp;
	st.oppThinkMs = [...ctx.oppThinkMsHistory];
}

/**
 * Feed a realised think back: the think history, the tilt countdown and, for a normal or long
 * plan whose pace may teach (`adaptPace`), ε_t and the pace residual against the body median.
 */
export function observeThink(
	st: GameTimingState,
	actualThinkMs: number,
	plan: TimingPlan,
	adaptPace: boolean
): void {
	st.myThinkMs.push(actualThinkMs);
	if (st.tilt > 0) st.tilt--;
	if (
		adaptPace &&
		(plan.mode === "normal" || plan.mode === "long") &&
		actualThinkMs > 0 &&
		plan.thinkMs > 0
	) {
		const shift = clamp(
			Math.log(actualThinkMs / plan.thinkMs),
			-C.replan.observeShiftClamp,
			C.replan.observeShiftClamp
		);
		st.eps += shift;
		const bodyMs = plan.features.bodyMedianMs;
		if (bodyMs !== undefined && bodyMs > 0)
			st.paceResiduals.push(Math.log(actualThinkMs) - Math.log(bodyMs));
	}
}
