/** The motor profile (Appendix G §8 plus the V2.1 exploration block) and its classifications. */

import type { MsRange } from "./geometry";

export type MotorStyle = "bezier" | "wind";

export type ClickStyle = "drag" | "click";

export type TimeControlClass = "bullet" | "blitz" | "rapid" | "classical";

export type MotorMoveKind = "normal" | "premove" | "capture" | "recapture" | "promotion" | "castle";

export type RestStyle = "piece" | "clock" | "offboard" | "mixed";

/** Appendix G §8 defaults plus the V2.1 exploration block and a version for fitted profiles (§9.6). */
export interface MotorProfile {
	version: number;
	/** Time before the hand starts moving after the decision (not think time). */
	reactionMs: MsRange;
	/** Fitts intercept (s) and slope (s/bit). */
	fittsA: number;
	fittsB: number;
	/** 1.0 = model; blitz ≈ 0.75, classical ≈ 1.3. */
	travelSpeedScale: number;
	peakSpeedCapPxPerS: number;
	/** σ of the AR(1) tremor. */
	jitterPx: number;
	overshootProb: number;
	/** Pause with the piece held before dropping. */
	hesitationProb: number;
	/** Second small sub-movement inside the target. */
	microCorrectionProb: number;
	pressHoldMs: MsRange;
	grabDelayMs: MsRange;
	releaseSettleMs: MsRange;
	sampleIntervalMs: number;
	/** Promotion "look" before the picker click; `[0, 0]` for other moves. */
	lookDelayMs: MsRange;
	styleMix: { bezier: number; wind: number };
	exploration: {
		hoverProb: number;
		feintProb: number;
		/** Persona base rate of §9.3a. */
		previewBase: number;
		restStyle: RestStyle;
	};
}

export type HandState =
	| "rest"
	| "orientation"
	| "exploring"
	| "approaching"
	| "grabbing"
	| "dragging"
	| "dropping"
	| "correcting"
	| "promoting"
	/** The piece is carried to its destination and held there, waiting for the opponent's move. */
	| "holding";
