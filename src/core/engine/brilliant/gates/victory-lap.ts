/** Gate 4 — fight, or victory lap? And last, whether it only continues an earlier sacrifice. */

import type { Chess } from "chess.js";
import { scanOffers } from "../offers";
import type { BrilliantEvidence, BrilliantPlan, BrilliantReason, BrilliantTuning } from "../types";
import { isMatingThreat } from "./mating-threat";

/**
 * The win was not already there for free (a mating threat, a trivial or gratuitous win), and a
 * sacrifice continuing a recent one is badged only when it is itself decisive.
 */
export function victoryLapGate(
	plan: BrilliantPlan,
	evidence: BrilliantEvidence,
	tuning: BrilliantTuning,
	board: Chess | null
): BrilliantReason | null {
	const bestAlternative = Math.max(0, ...evidence.alternatives.map((alt) => alt.points));
	// A victory lap means the win was there without giving anything away, so only a plain
	// alternative answers gate 4: a move that sacrifices as well is the same idea with another
	// piece (`sacrificialAlternativeNotTrivial`). `bestAlternative` above keeps every alternative —
	// the continuation test below asks a different question.
	const plain =
		tuning.sacrificialAlternativeNotTrivial > 0
			? evidence.alternatives.filter((alt) => {
					const scan = scanOffers(plan.fen, alt.uci, tuning);
					// An unproved exchange must not erase evidence of an already available win.
					return !scan.complete || scan.offers.length === 0;
				})
			: evidence.alternatives;
	const plainBest = Math.max(0, ...plain.map((alt) => alt.points));
	const ratedPlainBest = Math.max(0, ...plain.map((alt) => alt.ratedPoints ?? 0));
	if (isMatingThreat(plan, evidence, tuning, board, plainBest)) return "mating-threat";
	// The fastest mate is still the move that had to be found, however winning the rest is.
	const playedMate = evidence.playedMate ?? 0;
	const alternativeMates = evidence.alternatives.flatMap((alt) =>
		alt.mate !== undefined && alt.mate > 0 ? [alt.mate] : []
	);
	const fastestMate = playedMate > 0 && alternativeMates.every((mate) => mate >= playedMate);
	const fasterMate = playedMate > 0 && alternativeMates.every((mate) => mate > playedMate);
	// Already winning, and the sacrifice gains nothing on the plain move: a gratuitous one.
	// The rated test reads "already won" at the mover's rating — +7 is ≈ 0.93 on the reference
	// curve but ≈ 0.98 at 2655 (the owner's 32…Nxb2, 2026-09-23, 184267516150) — and the gain on
	// the reference curve, where it is not compressed. A sacrifice worse than the plain move is
	// the near-best gate's question, not a victory lap (the benchmark's 21.Bf6, 2323).
	const gain = evidence.playedPoints - plainBest;
	const gratuitous =
		((plainBest >= tuning.gratuitousWinning && gain < tuning.gratuitousGain) ||
			(tuning.gratuitousRatedWinning > 0 &&
				ratedPlainBest >= tuning.gratuitousRatedWinning &&
				gain >= 0 &&
				gain < tuning.gratuitousGain)) &&
		Math.max(0, ...plan.offers.map((offer) => offer.concession)) <= tuning.gratuitousMaxConcession;
	if (
		(plainBest >= tuning.trivialAlternative || gratuitous) &&
		!(tuning.fastestMateNotTrivial > 0 && fastestMate)
	)
		return "trivial-win";
	// Last, so `continuation` also says every other gate passed (the next move's window reads it).
	// A continuation that is itself the decisive move is a brilliant find of its own.
	const decisive =
		(evidence.playedPoints - bestAlternative >= tuning.sequenceDecisiveGap ||
			(tuning.fasterMateDecisive > 0 && fasterMate)) &&
		(tuning.decisiveNeedsMovedPiece <= 0 ||
			plan.offers.some((offer) => offer.shape !== "ignored-threat" && offer.shape !== "indirect"));
	if (evidence.recentSacrifice === true && !decisive) return "continuation";
	return null;
}
