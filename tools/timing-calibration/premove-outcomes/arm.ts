/**
 * tools/timing-calibration/premove-outcomes/arm.ts — the safe trade the session would arm on an
 * opponent turn: the first plausible predicted capture (the same gates as `premoveCandidate`, with
 * the calibrated `tradeReplyMinProb`) on a square where an obvious recapture exists that
 * `isQueueableCandidate` proves safe.
 */

import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, legalMoves } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import { isQueueableCandidate } from "@core/strength/premove";
import {
	plausibleScore,
	predictionLines,
	replyProbability,
} from "@core/strength/premove/prediction";
import { isObviousRecapture } from "@core/timing/calibration";
import type { EvalLine } from "@typedefs/engine";

/** The armed `{ reply, premove }` after our move reached `afterMove`, or null. */
export function safeTradeArm(
	afterMove: string,
	lines: EvalLine[]
): { reply: string; premove: string } | null {
	const ranked = predictionLines(lines, legalMoves(afterMove));
	const best = ranked[0];
	if (!best) return null;
	for (const line of ranked) {
		const reply = line.pvUci[0];
		if (!reply || !plausibleScore(line, best)) continue;
		const p = replyProbability(reply, ranked);
		const capture = classifyMove(afterMove, reply)?.isCapture === true;
		if (!capture || p < PREMOVE.tradeReplyMinProb) continue;
		const next = applyMoves(afterMove, [reply]);
		if (!next) continue;
		const square = reply.slice(2, 4);
		const q = legalMoves(next).find(
			(m) =>
				m.slice(2, 4) === square &&
				isObviousRecapture(afterMove, reply, next, m) &&
				isQueueableCandidate(afterMove, { reply, premove: m, reason: "recapture" })
		);
		if (q) return { reply, premove: q };
	}
	return null;
}
