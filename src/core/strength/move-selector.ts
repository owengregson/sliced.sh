/**
 * Rating-aware selection with shared mate, repetition, conversion and piece-safety guards.
 *
 * `selectMove` is a short pipeline over one `SelectionFrame` (`selector/frame.ts`): prepare the
 * guarded, ranked lines; fix the Maia rating (`selector/maia-rating.ts`); pass the mate guard
 * (`selector/mate-guard.ts`); then offer the move to each strategy in turn until one decides —
 * full strength above the Maia cutoff, the Maia draw, the engine's native choice, and the §7.2
 * base policy, which always decides (`selector/strategies/`). The order is the RNG draw order.
 */

import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { fmt } from "./format";
import { prepareSelection, type SelectionFrame } from "./selector/frame";
import { resolveMaiaRating } from "./selector/maia-rating";
import { guardMates } from "./selector/mate-guard";
import { selectFullStrength } from "./selector/strategies/full-strength";
import { selectMaiaDraw } from "./selector/strategies/maia-draw";
import { applyUpperRefereeCap, selectNative } from "./selector/strategies/native";
import { selectSampled } from "./selector/strategies/sampled";
import type { SelectionContext } from "./types";

export { cpEffective, winProb } from "./elo-map";
export { hangsPiece } from "./selector/candidate";
export {
	endgameTauFor,
	hangRailProbability,
	mateRampProbability,
	type SelectionParams,
	selectionParams,
	tiltProbability,
} from "./selector/params";
export { type ResolvedPriors, resolvePriors, resolvePriorsDetailed } from "./selector/priors";
export { createSelectionState } from "./selector/state";

/**
 * `selectMove(lines, ctx, prior?) → ChosenMove` — §7.2 steps 1–9. `lines` are
 * side-to-move POV; `prior` defaults to `heuristicPrior`.
 */
export function selectMove(
	lines: readonly EvalLine[],
	ctx: SelectionContext,
	prior?: ReadonlyMap<string, number>
): ChosenMove {
	const input = prepareSelection(lines, ctx, prior);
	const frame: SelectionFrame = {
		...input,
		maia: resolveMaiaRating(input),
		ranked: input.rankedAll,
		throwWinFilter: false,
	};
	const mate = guardMates(frame);
	if (mate) return mate;
	if (frame.pressureReduction > 0)
		frame.rationale.push(`opponent clock pressure: accuracy −${fmt(frame.pressureReduction, 0)} Elo`);
	const decided = selectFullStrength(frame) ?? selectMaiaDraw(frame);
	if (decided) return decided;
	applyUpperRefereeCap(frame);
	return selectNative(frame) ?? selectSampled(frame);
}
