/**
 * Move review — the chess.com-style rating of every landed move (owner, 2026-09-14).
 *
 * Chess.com's published model grades a move by the **expected points** it gave up: the player's
 * chance of scoring, on 0.00 (lost) … 0.50 (even) … 1.00 (won), from the engine evaluation *and
 * the player's rating*. Our probability curve is a local approximation, not their fitted model.
 * The extension reviews on its **own** Stockfish 19 instance (`PORT_NAMES
 * .reviewEngine`, always the full build, never strength-limited). Commands and options are isolated;
 * CPU and memory bandwidth are shared. Play-window admission must pause competing review work.
 *
 * Service-worker only. Nothing here may be imported by a page-realm module: a bundler inlines an
 * object literal whole, and the overlay only needs `MOVE_QUALITY`'s geometry.
 */

/**
 * One search shape for every position: a position's frame is at once the "before" lines of the
 * move played from it and the "after" score of the move that led to it, so the whole game is
 * reviewed with one search per position — and a position searched ahead of time (our planned
 * move's result, the opponent's likely replies) answers the moment the move lands.
 */
export const REVIEW = {
	/** Input guard: measured classifier p95 ~125 ms plus scheduling/stop margin, inside the turn. */
	inputLeadMs: 300,
	/**
	 * MultiPV per position: the best line (the loss reference), the runner-up (Great: "the only
	 * good move") and a third line for the brilliant gates' "not already winning without it".
	 */
	multiPv: 3,
	/** A frame at this depth is final: nothing deeper is searched for that position. */
	targetDepth: 18,
	/** The ceiling per position — chess.com's own "~5 sec" budget. */
	movetimeMs: 5_000,
	/**
	 * A landed move whose frames are still short of `targetDepth` waits this long for them, then
	 * publishes from whatever complete frames reach `publishDepth`: a chip that arrives a second
	 * late is worth more than one that never arrives.
	 */
	landedWaitMs: 700,
	publishDepth: 12,
	/** Tactical special labels require deeper evidence than ordinary loss bands. */
	specialDepth: 16,
	/** Do not compare a deep reference with a much shallower independent after-position. */
	specialDepthTolerance: 2,
	/** Independent review thread cap; play admission, not this cap, protects critical windows. */
	threadsMin: 1,
	threadsMax: 4,
	hashMb: 64,
	/** Pending review searches kept; the least urgent is dropped beyond it. */
	maxQueued: 6,
	/** Frames remembered per session (positions), oldest dropped first. */
	knownPositions: 24,
	/** Opponent replies searched ahead of time while they think, most likely first. */
	speculativeReplies: 2,
	/**
	 * After a review search fails (the full build would not boot, it crashed, the port dropped),
	 * nothing is tried again for the next step's wait — a failing engine must not be asked once
	 * per microtask. The first retry comes quickly because the usual failure is one crashed boot
	 * followed by a good one: the owner's log (2026-09-15) shows the full build's worker faulting
	 * right after two boots and the third working, and a fixed 30 s wait cost a minute of ratings.
	 * Only failures in a row climb the steps; the last one holds.
	 */
	retryBackoffMs: [1_000, 2_000, 5_000, 15_000, 30_000],
} as const;

/** The wait after `failures` review failures in a row (1-based): `REVIEW.retryBackoffMs`, holding at the last step. */
export function reviewRetryDelayMs(failures: number): number {
	return REVIEW.retryBackoffMs.reduce<number>(
		(wait, step, index) => (index < failures ? step : wait),
		REVIEW.retryBackoffMs[0]
	);
}

/**
 * The expected-points curve. Chess.com's model is fitted on its own games and unpublished; this is
 * the Lichess win-probability logistic (`referenceSlope`, per centipawn, at `referenceRating`)
 * whose steepness grows with the mover's rating — a stronger player converts the same
 * advantage more reliably, so the same centipawns are worth more points to them, and the same
 * slip costs them more. Mates are certain: 1.00 for the side delivering it, 0.00 against.
 */
export const EXPECTED_POINTS = {
	referenceRating: 1_500,
	referenceSlope: 0.00368208,
	ratingScaleSpan: 2_000,
	minSlopeScale: 0.65,
	maxSlopeScale: 1.5,
	/**
	 * Chess.com is "more generous" with Great and Brilliant "for newer players compared to those
	 * who are higher-rated": rating-dependent thresholds interpolate linearly between these two.
	 */
	noviceRating: 600,
	expertRating: 2_400,
} as const;

/**
 * The ladder. Chess.com publishes the ordinary bands as expected-points loss against the best
 * move — Best 0.00, Excellent 0.00–0.02, Good 0.02–0.05, Inaccuracy 0.05–0.10, Mistake
 * 0.10–0.20, Blunder 0.20–1.00 — and the precedence of the special categories:
 * Book → Brilliant → Great → Miss → the bands. A boundary belongs to the more severe band.
 */
export const MOVE_CLASSIFICATION = {
	goodLoss: 0.02,
	inaccuracyLoss: 0.05,
	mistakeLoss: 0.1,
	blunderLoss: 0.2,
	/**
	 * Conservative Blunder admission for our approximate curve: also require this much loss on
	 * the reference curve. The 2450 multiplier alone overclassified the owner's reviewed game.
	 * A 0.10 margin above the published 0.20 band reserves the harshest label for clear errors;
	 * smaller losses remain Mistakes. This is a local calibration, not Chess.com's fitted model.
	 */
	blunderMinReferenceLoss: 0.3,
	/** Floating-point equality, not an allowance: a move that loses anything is not Best. */
	zeroLossTolerance: 1e-9,
	/** A frame shallower than this supports no verdict at all. */
	minDepth: 10,
	/** "A winning position", in expected points (≈ +3.8 at 1500). */
	winningPoints: 0.8,

	/**
	 * Great — "critical to the outcome of the game, such as turning a losing position into an
	 * equal one, an equal position into a winning one, or finding the only good move". The move is
	 * the best one, every alternative gives up at least the gap (smaller for newer players), the
	 * move leaves the mover at least `greatMinAfter`, and the best alternative would not have been
	 * winning anyway. Taking material for free is Best, not Great: a capture that wins material
	 * outright on its square is excluded.
	 */
	greatGapNovice: 0.1,
	greatGapExpert: 0.15,
	greatMinAfter: 0.4,
	greatMaxAlternative: 0.7,

	/**
	 * Miss — "you fail to capitalize on your opponent's mistake and miss the opportunity to gain a
	 * winning position". The opponent's last move handed over at least `missMinOpportunity`, the
	 * mover was not already winning before it but is now, and the move gives at least
	 * `missMinLoss` back without keeping the win. A move that also leaves the mover far worse than
	 * before the opponent's mistake (more than `missMaxWorsening`) is graded on its loss.
	 */
	missMinOpportunity: 0.1,
	missMinLoss: 0.1,
	missMaxWorsening: 0.2,

	/** A book move that loses this much is graded on its loss instead (a trap, not theory). */
	bookMaxLoss: 0.1,
} as const;

/**
 * Brilliant — "a good piece sacrifice": Chessigma's four gates (its Brilliant Benchmark, 93/100
 * against chess.com's labels) over chess.com's own conditions.
 *
 *   1. Chosen, or forced?   more than one legal move, not book, and another move would have
 *                           given up less material
 *   2. Gift, or illusion?   a piece (≥ `minOfferedPiece`) can be taken for a net material
 *                           concession of at least `minConcession`, after the legal exchange on
 *                           that square and net of whatever the move itself won
 *   3. Holds, or collapses? the best or nearly best move (`maxLoss*`, generous for newer
 *                           players), and the mover is not worse than `minAfter` afterwards
 *   4. Fight, or victory lap? the best alternative was not already `trivialAlternative` winning
 *
 * The offered piece need not be the one that moved: an indirect sacrifice, an ignored threat, a
 * piece hung on purpose, a sacrifice by capture and an exchange sacrifice are all offers.
 */
export const BRILLIANT = {
	minOfferedPiece: 3,
	minConcession: 1,
	/** Bounds on the same-square exchange search per offered capture. */
	maxExchangeNodes: 256,
	maxExchangePlies: 16,
	/** Short mate proof for already-attacked pieces, only with a winning plain alternative. */
	ignoredThreatMatePlies: 3,
	matingThreatAlternative: 0.9,
	/**
	 * Tuned with `tools/move-review`: chess.com badges the second- or third-best line of a depth-18
	 * review, and with the loss measured at the mover's rating (`nearBestRatedLoss`) the owner's
	 * reviewed 18…Bg4 (2132) is 0.068 behind — within ≈ 0.077 at that rating, outside the earlier
	 * 0.045. On the benchmark these allowances add one real brilliant for a few extra badges.
	 */
	maxLossNovice: 0.12,
	maxLossExpert: 0.07,
	minAfter: 0.45,
	trivialAlternative: 0.97,
	/**
	 * Gate 2's illusion test: an ignored threat whose engine line has the opponent take the piece
	 * and the mover win back all but this much on the very next move is a trade, not a gift.
	 */
	illusionRegainTolerance: 1,
	/**
	 * Continuations: a sacrifice within `sequencePlies` of the same player's previous move that
	 * already passed these gates continues that attack, and is badged again only when it is itself
	 * decisive — at least `sequenceDecisiveGap` better (reference expected points) than the best
	 * alternative. In the owner's chess.com-reviewed games (2026-09-15) Qf2 then Rxh3+ are both
	 * brilliant (Rxh3+ the only winning move, gap 0.71) while Nxh6+ after Nxf7 is not (gap 0.18).
	 * The benchmark pins one brilliant per game, so it cannot judge consecutive brilliants and
	 * flatters any suppression; the rule rests on those labelled games. Backward-looking only.
	 */
	sequencePlies: 4,
	sequenceDecisiveGap: 0.3,
	/**
	 * Mates (the owner's reviewed games, 2026-09-15): chess.com badges 33.Rh7+ (mate in 3) although
	 * 33.Qxg6 also mated (in 4), right after the brilliant 32.Rxf7+. 1 = the fastest mate is not a
	 * victory lap however winning the alternatives are; 1 = a strictly faster mate than every
	 * alternative is decisive for a continuation. 0 turns either off (for `score.ts --set`).
	 */
	fastestMateNotTrivial: 1,
	fasterMateDecisive: 1,
	/**
	 * 1 = a move that keeps a forced mate slower than one another root move had is not near-best,
	 * however little expected points the extra moves cost (mate in 5 and mate in 6 score alike).
	 * The owner's 37.Qc8 (2026-09-23, 184243330558, 2628): mate in 6 beside 37.Qad8's mate in 5,
	 * leaving the g5 bishop every winning move left, badged brilliant; chess.com does not.
	 */
	slowerMateNotBrilliant: 1,
	/**
	 * Gratuitous sacrifices (the owner's reviewed games, 2026-09-15): 20.Rxd4 at +8.7, where the
	 * plain 20.Nxd4 kept +8.5, is not brilliant. A victory lap is also a best alternative already at
	 * `gratuitousWinning` that the sacrifice improves on by less than `gratuitousGain` (reference
	 * expected points). The fastest-mate exemption above still applies.
	 */
	// SF19 full-network evaluation: 0.90 suppressed sound sacs at +6 with no trivial win.
	// 0.95 still excludes the owner's +8.5 Rxd4 regression; see the SF19 QA report.
	gratuitousWinning: 0.95,
	gratuitousGain: 0.02,
	/**
	 * Only a small gift is gratuitous: 21.Rxf7 (a rook for a pawn, concession 4, brilliant) and
	 * 20.Rxd4 (concession 1, not) gain the same ~0.005 on a plain move that already wins.
	 */
	gratuitousMaxConcession: 2,
	/**
	 * 1 = the near-best gate reads the loss at the mover's rating (our local expected-points model)
	 * rather than on the reference curve. Deep in a won position the reference curve inflates a
	 * strong player's loss: 18…Bg4 (brilliant, 2132) is 0.098 behind on it but 0.068 at 2132.
	 */
	nearBestRatedLoss: 1,
	/**
	 * 1 = a continuation is decisive only when it newly offers the moving piece (by capture, hung,
	 * or as an exchange). Leaving an already-attacked piece is the attack's momentum: 25…Qf3+ (an
	 * ignored threat, not brilliant) against 33.Rh7+ and 15…Rxh3+ (the rook itself, brilliant).
	 */
	decisiveNeedsMovedPiece: 1,
	/**
	 * 1 = only the piece that moved can be the sacrifice (hung, capturing, or given for the
	 * exchange): a move that merely leaves another piece to be taken (an indirect offer, an ignored
	 * threat) is not one. The owner (2026-09-15): brilliants were being badged on moves whose piece
	 * was not even attackable.
	 */
	movedPieceOffersOnly: 0,
	/**
	 * 1 = gate 2's illusion test applies to every offer, not only ignored threats: a piece the
	 * opponent takes and the mover wins straight back on the next move (within
	 * `illusionRegainTolerance`) was traded, not sacrificed (the owner, 2026-09-15).
	 */
	tradeRegainAnyShape: 0,
	/**
	 * 1 = gate 4 measures "already winning without it" against *plain* alternatives only — moves that
	 * do not themselves give material away. Another sacrifice is the same idea with another piece, so
	 * it never shows the win was there for free. The owner's 30.Rdxh5+ (2026-09-16), chess.com
	 * Brilliant and rated only `best`: both rooks take the h5 knight, so the runner-up Rhxh5+ is the
	 * identical sacrifice at 0.980 expected points and tripped both the `trivialAlternative` and
	 * `gratuitous` clauses; the one plain alternative, f4–f5, is 0.638. Only gate 4 reads this — the
	 * continuation gate's `sequenceDecisiveGap` still measures against every alternative, because a
	 * move is not decisive just because the moves matching it are sacrifices too.
	 */
	sacrificialAlternativeNotTrivial: 1,
	/**
	 * 1 = the concession must survive with the mover's own pawns priced at nothing: a piece traded
	 * evenly on its square whose recapturing pawn then falls is a pawn given up, not "a good piece
	 * sacrifice". The owner's 33.Bb4 (2026-09-18, 184035279236): the bishop steps to a square its
	 * a-pawn defends, Nxb4 axb4 Qxb4 is bishop for knight and then the pawn — a concession of 1 that
	 * is all pawn — and as the only winning move it passed every engine gate. The reported
	 * concession stays the real one; a rook given for a knight there is still an offer.
	 */
	pawnLossNotSacrifice: 1,
	/**
	 * From this mover rating up, a moved piece that cannot be taken is no sacrifice: accepting it
	 * loses at least its value elsewhere, to a capture that already won that much before the
	 * acceptance (a discovered attack). A deflection's regain exists only because the offer was
	 * accepted, and stays a sacrifice. The owner's 17.Nxd4 (2026-09-18, 184035634254, 2560): a knight
	 * for two pawns on d4, but leaving e2 unmasks Re1 on the queen at e7, so cxd4 loses her.
	 * Rating-gated because chess.com is "more generous" with newer players and the evidence says so:
	 * applied to everyone it removes 8 of the benchmark's 100 brilliants, every one played at 1117 or
	 * below (13.Nxc6 at 808 is the same discovered attack on a queen); from 1400 up it removes none
	 * of the benchmark's 33 or the owner's 11 reviewed brilliants. An unknown rating is judged at the
	 * reference rating, as everywhere else. 0 turns it off.
	 */
	standingThreatMinRating: 1_400,
} as const;
