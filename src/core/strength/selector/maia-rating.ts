/** The one rating everything about a Maia move agrees on (H2/H5/H12), with the H12 tilt draw. */

import { MAIA } from "@core/constants/maia";
import { policyEntropy, temperPolicy } from "@core/policy/maia-policy";
import { usesMaia } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import { fmt } from "../format";
import {
	maiaCalibrationPoint,
	maiaEloTimeClass,
	maiaSelfElo,
	sliderEloOffset,
} from "../selection-elo";
import type { MaiaRating, SelectionInput } from "./frame";
import { tiltProbability } from "./params";

/**
 * The one rating everything about a Maia move agrees on (H2/H5/H12): the pipeline issued the
 * query at `maiaSelfElo` with the same pressure, slider and context terms; the selector adds the
 * ambiguity term from the model's own entropy and, when tilted, the tilt penalty. Computed before
 * the mate guard, so the mate ramp judges at it too. Draws the tilt coin (and may set the tilt).
 *
 * Since 2026-09-23 the rating goes through the Maia strength calibration (`MAIA_CALIBRATION`,
 * per chess.com time class, via `maiaSelfElo`), and the policy is reshaped once at the
 * calibrated temperature (`temperPolicy`); the Maia draw reads that `policy`, not `ctx.maia`.
 */
export function resolveMaiaRating(frame: SelectionInput): MaiaRating {
	const { ctx, pressureReduction, topCpRaw, rationale } = frame;
	const { rng, state } = ctx;
	const maiaMode = ctx.maia !== undefined && usesMaia(ctx.targetElo);
	let maiaE: number | undefined;
	let maiaPolicy: PolicyResult | undefined;
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
			baseMs: ctx.baseMs,
			incrementMs: ctx.incrementMs,
			calibration: ctx.maiaCalibration,
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
		// The calibrated temperature reshapes the whole answer once, so the rails, verification
		// and the draw all see the distribution the calibration was fitted with. Entropy (above)
		// stays the model's own: it measures the position, not the sampling.
		const calibration = maiaCalibrationPoint(eloInput);
		maiaPolicy = temperPolicy(ctx.maia, calibration.temperature);
		rationale.push(
			`maia calibration: ${maiaEloTimeClass(eloInput)} conditioning ${fmt(calibration.conditioningElo, 0)} temperature ${fmt(calibration.temperature, 3)}`
		);
		const slider = sliderEloOffset(ctx.blunderScale);
		rationale.push(
			`maia E=${fmt(maiaE, 1)} (pressure −${fmt(pressureReduction, 0)}, slider ${slider > 0 ? "−" : "+"}${fmt(Math.abs(slider), 0)}, context −${fmt(ctx.contextEloPenalty ?? 0, 0)}, ambiguity −${fmt(ambiguityEloPenalty, 0)} [entropy ${fmt(entropy, 2)}]${tiltElo > 0 ? `, tilt −${tiltElo} (${state.tiltMovesLeft} left)` : ""})`
		);
	}
	return { maiaE, policy: maiaPolicy, entropy };
}
