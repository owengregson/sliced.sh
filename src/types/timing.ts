/**
 * Timing-model types shared across contexts (§8.3 `TimingPlan`, §8.6
 * `TimingLogEntry`). Task 16 owns the full §8.3 surface in
 * `src/core/timing/types.ts` and builds on these.
 */

import type { Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { MoveTelemetryRecord } from "@typedefs/telemetry";

export type TimingMode = "premove" | "instant" | "normal" | "long";

/**
 * §8.4b item 3: the move window as one generative process. The phase budgets
 * sum exactly to `thinkMs`; the approach (grab → drag → release) is always
 * last and the decision pause (no pointer motion) precedes it.
 */
export interface MoveWindowBudget {
	orientationMs: number;
	scanMs: number;
	previewMs: number;
	decisionMs: number;
	approachMs: number;
}

export interface TimingPlan {
	thinkMs: number;
	mode: TimingMode;
	preMoveHoverMs: number;
	dragDurationMs: number;
	fakeout?: { piece: Square; holdMs: number; gapMs: number };
	promotionDelayMs?: number;
	deadlineMs: number;
	rationale: string[];
	features: Record<string, number>;
	/** §8.4b item 2: perceptual latency at the start of the window (part of `thinkMs`). */
	orientationMs: number;
	/** §8.4b item 3: phase allocation of `thinkMs` (Tasks 17/18 consume these budgets). */
	window: MoveWindowBudget;
}

/** One row of the `LOCAL_KEYS.timingLog` ring buffer (§8.6). */
export interface TimingLogEntry {
	gameId: string;
	ply: number;
	mode: TimingMode;
	plannedMs: number;
	/** Null until `observe()` records the realised think time. */
	actualMs: number | null;
	alloc: number;
	clockMs: number;
	comp: number;
	eps: number;
	topTerms: Array<[string, number]>;
	persona: PersonaId;
	/**
	 * Task 33 / Task 30: the move's `ac`-equivalent telemetry, filled by the `GameSession`
	 * once the execution result is in; absent in exports written before Task 30.
	 */
	telemetry?: MoveTelemetryRecord;
}
