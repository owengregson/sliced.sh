/** The §8.4b item 6 ChessMimic head. */

import { CHESSMIMIC_BANDS } from "@core/constants/models";

/** §8.4b item 6 ChessMimic head. */
export const CHESSMIMIC = {
	sGameSigma: 0.2,
	arSigma: 0.2,
	arPhi: 0.35,
	temperature: 1,
	inferenceBudgetMs: 100,
	/** Timed-move rows inferred ahead of the choice (the pondered answer, Maia's top moves). */
	candidateRows: 3,
	bands: CHESSMIMIC_BANDS,
	recentMoves: 12,
	fenTokens: 78,
	sequenceLength: 92,
	moveVocabSize: 1968,
	nBuckets: 30,
	/**
	 * The open [40, ∞) bucket's empirical table (`buckets.json`) covers ≈ 75 % of its mass
	 * (40–59 s); the rest is drawn as 60 s + Exp(mean) with upstream's blitz tail mean
	 * (`clock_bucket_utils.py` `tail_means["blitz"]`).
	 */
	openBucketTailMeanS: 30,
	/**
	 * Max |Δ probability| allowed between the fp16-weight ONNX bands and the torch fp32
	 * reference (`test/fixtures/chessmimic-reference.json`). Measured 1.46e-3 over all
	 * 1 000 reference positions under the vendored onnxruntime-web wasm backend (and
	 * 1.458e-3 in Python onnxruntime at export time). The one partial-fp32 layout that
	 * reaches < 1e-3 costs +2.1 MB per band for a 5 % margin, so the export stays all-fp16
	 * and the bound is 2e-3 (measurements in docs/models.md).
	 */
	fixtureProbTolerance: 2e-3,
	/** The top 4 buckets (≥ 26 s, §3b.1) or `t > longMedianMultiple·median` label the sample `long`. */
	longBucketFrom: 26,
	longMedianMultiple: 6,
} as const;
