/** The one rating everything about a Maia move agrees on (H2/H5/H12), with the H12 tilt draw. */

import { MAIA } from "@core/constants/maia";
import { policyEntropy } from "@core/policy/maia-policy";
import { usesMaia } from "@core/policy/maia-size";
import { fmt } from "../format";
import { maiaSelfElo, sliderEloOffset } from "../selection-elo";
import type { MaiaRating, SelectionInput } from "./frame";
import { tiltProbability } from "./params";

/**
 * The one rating everything about a Maia move agrees on (H2/H5/H12): the pipeline issued the
 * query at `maiaSelfElo` with the same pressure, slider and context terms; the selector adds the
 * ambiguity term from the model's own entropy and, when tilted, the tilt penalty. Computed before
 * the mate guard, so the mate ramp judges at it too. Draws the tilt coin (and may set the tilt).
 */
export function resolveMaiaRating(frame: SelectionInput): MaiaRating {
	const { ctx, pressureReduction, topCpRaw, rationale } = frame;
	const { rng, state } = ctx;
	const maiaMode = ctx.maia !== undefined && usesMaia(ctx.targetElo);
	let maiaE: number | undefined;
	let entropy = 0;
	if (ctx.maia !== undefined && maiaMode) {
		entropy = policyEntropy(ctx.maia.moves);
		const ambiguityEloPenalty = MAIA.context.ambiguityElo * entropy;
		const eloInput = {
			targetElo: ctx.targetElo,
			form: ctx.form,
			blunderScale: ctx.blunderScale,
			pressureReduction,
			contextEloPenalty: ctx.contextEloPenalty,
		};
		// H12: an adverse swing since our last move tilts the player with a rating-dependent
		// probability; judged at the pre-tilt rating so the trigger does not feed itself.
		if (
			state.lastPickCp !== undefined &&
			topCpRaw <= state.lastPickCp - MAIA.tilt.swingCp &&
			state.tiltMovesLeft === 0
		) {
			const pTilt = tiltProbability(maiaSelfElo({ ...eloInput, ambiguityEloPenalty }));
			if (pTilt > 0 && rng.chance(pTilt)) {
				state.tiltMovesLeft = MAIA.tilt.moves;
				rationale.push(
					`tilt: eval fell ${fmt(state.lastPickCp - topCpRaw, 0)} cp since our last move (p=${fmt(pTilt, 2)}), −${MAIA.tilt.elo} Elo for ${MAIA.tilt.moves} moves`
				);
			}
		}
		const tiltElo = state.tiltMovesLeft > 0 ? MAIA.tilt.elo : 0;
		maiaE = maiaSelfElo({ ...eloInput, ambiguityEloPenalty: ambiguityEloPenalty + tiltElo });
		const slider = sliderEloOffset(ctx.blunderScale);
		rationale.push(
			`maia E=${fmt(maiaE, 1)} (pressure −${fmt(pressureReduction, 0)}, slider ${slider > 0 ? "−" : "+"}${fmt(Math.abs(slider), 0)}, context −${fmt(ctx.contextEloPenalty ?? 0, 0)}, ambiguity −${fmt(ambiguityEloPenalty, 0)} [entropy ${fmt(entropy, 2)}]${tiltElo > 0 ? `, tilt −${tiltElo} (${state.tiltMovesLeft} left)` : ""})`
		);
	}
	return { maiaE, entropy };
}
