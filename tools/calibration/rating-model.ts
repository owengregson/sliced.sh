/**
 * tools/calibration/rating-model.ts — the intrinsic rating model (Maia-free), per time class.
 *
 * A per-move ordered-logit model of move quality given the mover's rating and how hard the
 * position is — the Regan "intrinsic performance rating" idea, fitted to chess.com players:
 *
 *   class y ∈ 0…11: the referee's best move; else the loss between successive `EDGES`
 *   x = [log(1 + near-best moves), second-best loss, decidedness, clock pressure, material on the
 *        board, log legal moves]                                                   (`PositionShape`)
 *   r = (rating − 1800) / 1000
 *   η = w·x + r·(β + v·x)                (error propensity; rating interacts with difficulty)
 *   P(y ≥ k) = σ(η − θ_k), θ_1 < … < θ_11
 *
 * A set of moves' rating is the maximum-likelihood `r` over all of them pooled (the log-likelihood
 * is concave in r), with a cluster-robust sandwich standard error by game. Two sets over the same
 * positions (the bot's draws and the humans' moves) give a **paired** difference whose variance
 * uses the per-game influence of both — the estimator's own bias cancels in it.
 *
 * Replaces the per-game ridge regression of the first verification (held-out R² 0.16–0.36), whose
 * per-game means discarded which positions the errors came from.
 *
 * The parts live in `rating-model/`: the model's form, its training and the estimators.
 */

export {
	type CellRating,
	cellRating,
	estimateRating,
	pairedDifference,
	type RatingEstimate,
} from "./rating-model/estimate";
export {
	CLASSES,
	covariates,
	EDGES,
	type ModelMove,
	moveClass,
	type RatingModel,
	toR,
	toRating,
} from "./rating-model/model";
export { trainModel } from "./rating-model/train";
