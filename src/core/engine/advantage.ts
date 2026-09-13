/**
 * The practical advantage index behind the panel's second rail (`ADVANTAGE` explains the blend).
 * Everything is from White's point of view: a positive index means White is closer to winning.
 */

import { material } from "@core/chess/material";
import { ADVANTAGE } from "@core/constants/advantage";
import { clamp } from "@core/util/clamp";
import type { Eval } from "@typedefs/engine";

export interface AdvantageInput {
	fen: string;
	/** White's point of view; `null` before any evaluation. */
	score: Eval | null;
	/** Both clocks in ms, when the page reports them. */
	clocks?: { w: number; b: number } | null | undefined;
}

/** The index in [−1, 1]; `null` when nothing about the position is known. */
export function advantageIndex(input: AdvantageInput): number | null {
	const score = input.score;
	if (score && score.mate !== undefined && score.mate !== 0) return score.mate > 0 ? 1 : -1;
	const counted = material(input.fen);
	const cp = score?.cp;
	if (!counted && cp === undefined) return null;
	let index = 0;
	if (counted) index += ADVANTAGE.materialWeight * Math.tanh(counted.diff / ADVANTAGE.materialScale);
	if (cp !== undefined) index += ADVANTAGE.engineWeight * Math.tanh(cp / ADVANTAGE.engineScaleCp);
	const clocks = input.clocks;
	if (clocks && clocks.w + clocks.b > 0) {
		const shorter = Math.min(clocks.w, clocks.b);
		const urgency = 1 - Math.min(shorter / ADVANTAGE.clockScaleMs, 1);
		index += ADVANTAGE.clockWeight * urgency * ((clocks.w - clocks.b) / (clocks.w + clocks.b));
	}
	return clamp(index, -1, 1);
}

/** White's share of the advantage rail, 0..1 (`0.5` = level). */
export function advantageShare(index: number): number {
	return clamp((index + 1) / 2, 0, 1);
}
