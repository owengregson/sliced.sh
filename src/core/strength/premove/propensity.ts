/** How often a premove is attempted: the rating/persona propensities and the eligible categories. */

import { PREMOVE } from "@core/constants/books";
import type { Rng } from "@core/rng";
import { tcClass } from "@core/timing/features";
import type { TcClass } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import type { TimeControl } from "@typedefs/game";
import type { PremoveContext, PremoveReason } from "./types";

/** `0.35 + 0.5·clamp((E − 1200)/1200, 0, 1)` × π_p; 0 below E = 1200. */
export function premoveProbability(E: number, piP = 1): number {
	if (E < PREMOVE.minElo) return 0;
	const base =
		PREMOVE.probBase + PREMOVE.probRange * clamp((E - PREMOVE.minElo) / PREMOVE.probSpan, 0, 1);
	return clamp(base * clamp(piP, 0, 1), 0, 1);
}

export function tradePremoveProbability(E: number, piP = 1): number {
	if (piP <= 0) return 0;
	const base =
		PREMOVE.tradeProbBase +
		PREMOVE.tradeProbRange * clamp((E - PREMOVE.minElo) / PREMOVE.probSpan, 0, 1);
	return base * (PREMOVE.tradePersonaFloor + (1 - PREMOVE.tradePersonaFloor) * clamp(piP, 0, 1));
}

/** The ordinary and the trade attempt propensities, and the larger of the two. */
export interface AttemptPropensities {
	ordinaryP: number;
	tradeP: number;
	p: number;
}

/**
 * The attempt propensities for this premove: the calibrated ones (`ctx.propensity`) where the
 * think-time table has them, else the strength propensities at the rating and π_p. One attempt
 * is drawn at the larger (`p`); each kind is then thinned to its own.
 */
export function attemptPropensities(
	ctx: Pick<PremoveContext, "propensity" | "targetElo" | "piP">
): AttemptPropensities {
	const ordinaryP = ctx.propensity?.ordinary ?? premoveProbability(ctx.targetElo, ctx.piP);
	const tradeP = ctx.propensity?.trade ?? tradePremoveProbability(ctx.targetElo, ctx.piP);
	return { ordinaryP, tradeP, p: Math.max(ordinaryP, tradeP) };
}

/**
 * Whether a safe trade survives the thinning to its own propensity. The attempt was drawn at the
 * larger propensity: a trade whose own is smaller (a calibrated rate below the ordinary one) is
 * kept with probability `tradeP / p`. The strength propensities never draw here (the trade rate is
 * the larger), so their random stream is unchanged.
 */
export function keepsSafeTrade(tradeP: number, p: number, rng: Rng): boolean {
	return !(tradeP < p) || rng.chance(tradeP / p);
}

/**
 * Category eligibility for a site queue. isQueueableCandidate provides the actual board proof;
 * a reason cannot establish that an unexpected reply makes a move illegal.
 */
export function isQueueableReason(reason: PremoveReason): boolean {
	return (PREMOVE.queueReasons as readonly PremoveReason[]).includes(reason);
}

/** Ordinary premoves use these speed classes; safe trades and clock races also work in slower controls. */
export function isPremoveSpeed(timeControl: TimeControl | undefined): boolean {
	if (!timeControl) return false;
	const cls = tcClass(timeControl.baseMs / 1000, timeControl.incMs / 1000);
	return (PREMOVE.speeds as readonly TcClass[]).includes(cls);
}
