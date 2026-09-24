/** §7.2 step 5 / H9: the mate guard every mode passes through before its own strategy. */

import type { ChosenMove } from "@typedefs/game";
import { SELECTION_CONSTANTS as C } from "../constants";
import { isImmediateMate } from "../conversion";
import { winProb } from "../elo-map";
import { fmt } from "../format";
import { finish } from "./finish";
import { type SelectionFrame, toCandidate } from "./frame";
import { mateRampProbability } from "./params";

/**
 * Never randomly decline an immediate board mate. A searched forced mate follows §7.2 step 5
 * (H9): mate-in-≤ `mateInMax` is played with `mateRampProbability` (1 from `mateAlwaysElo`);
 * deeper mates, and a declined one, fall through to the ordinary draw with every line that would
 * throw the win (raw loss ≥ `throwWinLoss`) excluded — a missed mate must not become a thrown win.
 * Returns the mate when it is played; otherwise narrows `frame.ranked` and returns `null`.
 */
export function guardMates(frame: SelectionFrame): ChosenMove | null {
	const { ctx, lines, rankedAll, rationale, winTopRaw } = frame;
	const NP = C.neverPlay;
	const immediateMate = rankedAll.find((r) => isImmediateMate(ctx.fen, r.line.pvUci[0] ?? ""));
	if (immediateMate) {
		rationale.push("mate: immediate legal checkmate");
		return finish(toCandidate(frame, immediateMate), "mate", lines, ctx, rationale);
	}
	const forcedMate = rankedAll
		.filter((r) => (r.line.score.mate ?? 0) > 0)
		.sort((a, b) => (a.line.score.mate ?? 0) - (b.line.score.mate ?? 0))[0];
	let throwWinFilter = false;
	if (forcedMate) {
		const n = forcedMate.line.score.mate ?? 0;
		const rampE = frame.maia.maiaE ?? frame.baselineE;
		if (n <= NP.mateInMax) {
			const p = mateRampProbability(rampE);
			if (p >= 1 || ctx.rng.chance(p)) {
				rationale.push(
					`mate: preserving forced mate-in-${n}${p < 1 ? ` (p=${fmt(p, 2)} at E=${fmt(rampE, 0)})` : ""}`
				);
				return finish(toCandidate(frame, forcedMate), "mate", lines, ctx, rationale);
			}
			rationale.push(`mate: mate-in-${n} declined (p=${fmt(p, 2)} at E=${fmt(rampE, 0)})`);
		} else {
			rationale.push(`mate: mate-in-${n} is beyond ${NP.mateInMax}, ordinary policy`);
		}
		throwWinFilter = true;
		rationale.push(`mate: throw-win filter, lines with loss ≥ ${NP.throwWinLoss} excluded`);
	}
	frame.throwWinFilter = throwWinFilter;
	frame.ranked = throwWinFilter
		? rankedAll.filter((r) => winTopRaw - winProb(r.cpRaw) < NP.throwWinLoss)
		: rankedAll;
	return null;
}
