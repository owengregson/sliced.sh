/**
 * Timing-model types shared across contexts (§8.3 `TimingPlan`, §8.6
 * `TimingLogEntry`). Task 16 owns the full §8.3 surface in
 * `src/core/timing/types.ts` and builds on these.
 */

import type { Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";

export type TimingMode = "premove" | "instant" | "normal" | "long";

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
}
