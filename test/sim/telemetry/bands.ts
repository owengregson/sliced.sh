// test/sim/telemetry/bands.ts
/**
 * Splitting `assertHumanShapedAc`'s verdict into the part that holds at **any** sample size and the
 * part that is a statement about a population.
 *
 * The per-move rules (`EventTrusted`, the blur/focus fields, `TotalFocusTime ≥ MoveHoldTime`,
 * `PointerOffset` finite and ≥ 0, the §9.6a 250 ms floor, the 25 % multi-select hard cap, and
 * "never 0 % / never 100 %") are properties of one blob and must be empty everywhere. The
 * statistical rows (the CV, the 4–12 % preview band, the complexity correlation, the compression
 * ratio) have a standard error that at small N is wider than the distance to their own floors, so a
 * test on a small sample must *record* them rather than gate on them.
 *
 * This exists so that a test which cannot assert the statistical rows still asserts every per-move
 * rule **through the model** instead of re-listing a hand-picked subset — a subset silently drops
 * whatever it forgets, which is how `TotalFocusTime`, `PointerOffset` and the hard cap stopped being
 * checked in the cases that replaced the model call.
 */

import type { AcBlob } from "@typedefs/telemetry";
import {
	AcConformanceError,
	type AcMoveMeta,
	assertHumanShapedAc,
} from "../../../tools/telemetry-conformance/ac-model";

/** Substrings that identify a violation row as a *population* statement. */
export const STATISTICAL_MARKERS = [
	"hold-time CV",
	"outside",
	"correlation",
	"hold ratio",
] as const;

export function isStatisticalViolation(row: string): boolean {
	return STATISTICAL_MARKERS.some((m) => row.includes(m));
}

export interface SplitViolations {
	/** Every row the unmodified model reported. */
	all: string[];
	/** Rows that hold at any sample size — always assert this is empty. */
	perMove: string[];
	/** Rows that are population statements — record these, with their numbers. */
	statistical: string[];
}

/** Run the unmodified model over `acs` and split whatever it reports. */
export function splitViolations(
	acs: readonly AcBlob[],
	meta: readonly AcMoveMeta[]
): SplitViolations {
	let all: string[] = [];
	try {
		assertHumanShapedAc(acs, { moves: meta });
	} catch (error) {
		if (!(error instanceof AcConformanceError)) throw error;
		all = error.violations;
	}
	return {
		all,
		perMove: all.filter((v) => !isStatisticalViolation(v)),
		statistical: all.filter(isStatisticalViolation),
	};
}
