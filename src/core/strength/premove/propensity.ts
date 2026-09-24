/** How often a premove is attempted: the rating/persona propensities and the eligible categories. */

import { PREMOVE } from "@core/constants/books";
import { tcClass } from "@core/timing/features";
import type { TcClass } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import type { TimeControl } from "@typedefs/game";
import type { PremoveReason } from "./types";

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
