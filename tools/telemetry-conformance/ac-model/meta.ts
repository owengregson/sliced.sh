/** tools/telemetry-conformance/ac-model/meta.ts — what a move's context adds to its `ac` blob. */

import { TELEMETRY_BANDS } from "../../../src/core/constants/telemetry";
import type { TimingMode } from "../../../src/types/timing";

/** What the harness / session knows about a move that the blob does not carry. */
export interface AcMoveMeta {
	mode: TimingMode;
	thinkMs: number;
	clockMs: number;
	nReasonable?: number;
	/**
	 * `MoveTelemetryRecord.ownerOwnsWindow`: this row's window spans a period the **owner** owns (the
	 * opponent's turn, around a premove the hand sent during it), so a focus edge in it is his
	 * behaviour rather than our misconduct. Stated by the writer, never inferred from `mode` — a
	 * searched move can legitimately plan in `premove` mode, so the mode is not the fact.
	 */
	ownerOwnsWindow?: boolean;
}

/** `AcMoveMeta` of a harness move (`SimulatedMove` or a Task 30 record with the same fields). */
export function moveMetaOf(m: {
	plan: { mode: TimingMode; thinkMs: number };
	nReasonable: number;
	myClockMs: number;
}): AcMoveMeta {
	return {
		mode: m.plan.mode,
		thinkMs: m.plan.thinkMs,
		clockMs: m.myClockMs,
		nReasonable: m.nReasonable,
	};
}

/** §13.2 / §9.3a: a preview-eligible ("non-trivial") move. */
export function isNonTrivial(meta: AcMoveMeta): boolean {
	const b = TELEMETRY_BANDS.multiSelect;
	return (
		(meta.mode === "normal" || meta.mode === "long") &&
		meta.thinkMs >= b.minThinkMs &&
		meta.clockMs >= b.minClockMs
	);
}
