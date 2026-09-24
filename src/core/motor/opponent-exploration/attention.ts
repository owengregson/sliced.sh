/**
 * The attention plan's scheduling (owner, 2026-09-12): whether a turn ponders at all, which spell
 * comes next and how long it lasts. Attention decays with the opponent's elapsed think; the
 * lengths are set by the time control, the game phase and whether a premove or hold is armed.
 */
import type { Rng } from "@core/rng";
import { OPPONENT_EXPLORATION as O } from "../constants";
import { sampleRange } from "../geometry";
import type { OpponentAttentionContext, OpponentExplorationPolicy } from "../opponent-candidates";
import type { ExplorationSpell, OpponentExplorationOptions } from "./types";

/**
 * Rolled once per opponent turn: some turns get no pondering at all beyond a rest. The share is
 * the class's `noPonderProb`, raised when the opponent's clock promises a quick reply. A low-time
 * turn always ponders in its own short, own-only way (readiness), and a turn without a context
 * ponders as before.
 */
export function decideOpponentTurn(
	attention: OpponentAttentionContext | undefined,
	policy: OpponentExplorationPolicy | undefined,
	rng: Rng
): { ponder: boolean } {
	if (!attention || policy?.lowTime === true) return { ponder: true };
	const quick =
		attention.opponentClockMs > 0 && attention.opponentClockMs < O.quickReplyClockMs
			? O.noPonderShortBoost
			: 0;
	const probability = Math.min(1, O.attention[attention.tcClass].noPonderProb + quick);
	return { ponder: !rng.chance(probability) };
}

export function chooseSpell(
	opts: OpponentExplorationOptions,
	attention: OpponentAttentionContext | undefined,
	rng: Rng
): ExplorationSpell {
	if (opts.quiet) return "still";
	if (!attention) return "active";
	const previous = opts.previousSpell;
	if (previous === undefined) return "first";
	if (previous !== "still") return "still";
	const a = attentionLevel(attention);
	const activeProb =
		(attention.armed ? O.armed.activeProb : 1) *
		(O.decay.activeFloor + (1 - O.decay.activeFloor) * a);
	if (rng.chance(activeProb)) return "active";
	return rng.chance(O.decay.glanceProb) ? "glance" : "still";
}

/** `2^(−think / halfLife)`: 1 as their turn begins, halved after a half-life. */
export function attentionLevel(attention: OpponentAttentionContext): number {
	const halfLife = O.attention[attention.tcClass].decayHalfLifeMs;
	return 2 ** (-Math.max(0, attention.opponentThinkMs) / halfLife);
}

export function spellMs(
	spell: ExplorationSpell,
	opts: OpponentExplorationOptions,
	attention: OpponentAttentionContext | undefined,
	rng: Rng
): number {
	if (!attention) {
		return sampleRange(opts.policy?.lowTime === true ? O.lowTimeBoutMs : O.boutMs, rng);
	}
	const A = O.attention[attention.tcClass];
	if (spell === "still") {
		const growth = 1 + O.decay.stillGrowthMax * (1 - attentionLevel(attention));
		return sampleRange(A.stillMs, rng) * growth;
	}
	if (spell === "glance") return sampleRange(O.glanceMs, rng);
	const phase =
		attention.phase === "opening"
			? O.phaseActiveScale.opening
			: attention.phase === "endgame"
				? O.phaseActiveScale.endgame
				: attention.sharp
					? O.phaseActiveScale.sharp
					: O.phaseActiveScale.middlegame;
	const armed = attention.armed ? O.armed.activeScale : 1;
	if (spell === "first") return sampleRange(A.firstLookMs, rng) * armed;
	return sampleRange(A.activeMs, rng) * phase * armed;
}

/** `maxMs` as a ceiling: absent is unbounded, a non-finite value leaves no room at all. */
export function spellCeiling(maxMs: number | undefined): number {
	return maxMs === undefined
		? Number.POSITIVE_INFINITY
		: Number.isFinite(maxMs)
			? Math.max(0, maxMs)
			: 0;
}
