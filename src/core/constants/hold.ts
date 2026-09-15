/**
 * The scramble hold (owner, 2026-09-11): when our own clock is in a race, the hand no longer
 * answers the opponent's move at superhuman speed. During *their* turn it picks up the piece it
 * expects to move, carries it to the destination and holds it there; their move is the cue to let
 * go — a human in time trouble hovering a piece — unless the position that arrived makes the held
 * move unsound, in which case the piece goes back to its square and the ordinary pipeline decides.
 */
import type { MsRange } from "@core/motor/types";

export const SCRAMBLE_HOLD = {
	/**
	 * How often an opponent turn becomes a hold (owner, 2026-09-11: part of ordinary play too, and
	 * "much more often, not always" in a scramble). `regularProb` above `rampStartMs` on our clock,
	 * rising linearly to `scrambleProb` at `rampEndMs` and below.
	 */
	regularProb: 0.08,
	scrambleProb: 0.85,
	rampStartMs: 10_000,
	rampEndMs: 7_000,
	/**
	 * The opponent's clock, too: a time-pressed opponent bangs moves out, and a hand already
	 * hovering the answer is how a human keeps up. Same shape, a lower ceiling — it is their
	 * scramble, not ours. The higher of the two ramps applies.
	 */
	opponentScrambleProb: 0.55,
	opponentRampStartMs: 10_000,
	opponentRampEndMs: 5_000,
	/**
	 * The decision is not made once, at the start of their turn, but at checkpoints *during* it
	 * (owner, 2026-09-11): the first `decisionFirstMs` in, then every `decisionIntervalMs`, at most
	 * `decisionWeights.length` of them. Each checkpoint rolls its share of the turn's probability
	 * (front-loaded, so a scramble's decision comes early and a long think can still turn into a
	 * hold or a premove midway through the exploration). A premove entry is spread the same way.
	 */
	decisionFirstMs: [120, 400] as MsRange,
	decisionIntervalMs: [900, 2_200] as MsRange,
	decisionWeights: [0.7, 0.15, 0.1, 0.05] as readonly number[],
	/**
	 * How long the piece is held before it goes back if the opponent still has not moved — drawn
	 * per hold (owner: never a fixed N seconds), a longer patience in a scramble than in ordinary
	 * play, where a hand hovering for a quarter of a minute would be odd.
	 */
	scrambleHoldMs: [8_000, 15_000] as MsRange,
	regularHoldMs: [2_500, 7_000] as MsRange,
	/** Before a predicted search is ready, occasionally use the ponder continuation. */
	pvAnswerProb: 0.5,
	/**
	 * Ordinary play: seeing the reply, the hand often takes the ready move back for a searched
	 * one ("hold moves are generally weaker"). The odds of *keeping* it, by whether the reply was
	 * the one it was prepared against. In a scramble only the hang check decides.
	 */
	regularKeepPredicted: 0.6,
	regularKeepUnexpected: 0.3,
	/** How long to wait for the ponder's first line before the hold has a candidate, and how often. */
	candidateRetryMs: 150,
	candidateRetryMax: 8,
	/** Reaction after their position lands before the hand reaches for the piece: `U(min, max)`. */
	entryDelayMinMs: 120,
	entryDelayMaxMs: 450,
	/** The grab-and-carry window the hold is planned with (the drag is fast: a scramble). */
	windowMaxMs: 400,
	/**
	 * Seeing the opponent's move → letting go: the hand's reaction while holding. Right-skewed —
	 * `min + (max − min)·u²` — so most releases sit near the floor with a real tail (owner: keep the
	 * floor, add variance).
	 */
	releaseReactionMs: [110, 650] as MsRange,
} as const;
