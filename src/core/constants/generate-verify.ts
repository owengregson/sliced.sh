/**
 * Verification controls for `src/core/strength/generate-verify.ts`.
 * The 2026-09-16 ordinary-range verifier preserves recognition probabilities and compares two
 * independent proposals using available shallow evidence. Its comparison/intuition scale reuses
 * the constants below without fitting new Elo noise. Above 2800 the existing distinct-candidate
 * path is retained. Historical tuning: `docs/qa/generate-verify-2026-09-13.md`; current evidence:
 * `docs/research/maia-recognition-verification-2026-09-16.md`.
 *
 * The Maia models stay as advertised: candidates are drawn from Maia's own distribution without
 * re-weighting (T = 1), and nothing here touches *when* a move is played (C7).
 */
export const GENERATE_VERIFY = {
	/**
	 * The ship flag (§4 H3 "ship it behind `MAIA.generateVerify.enabled`"). `GvInput.enabled`
	 * overrides it per call; `false` makes `generateAndVerify` return `null` so the caller runs the
	 * plain Maia draw.
	 */
	enabled: true,
	/**
	 * Upper-band/baseline distinct candidates, `k(E)`: `[E, k]` knots, flat outside and
	 * linear between, rounded to the nearest integer. de Groot's masters generated few, relevant
	 * candidates; Connors, Burns & Campitelli (2011) found breadth grows with skill only modestly.
	 *
	 * 2026-09-15 recalibration (was 2 / 3 / 4 / 5 / 5 at 800 / 1400 / 2000 / 2500 / 2800): measured
	 * against real chess.com blitz humans with `.scratch/bot-strength/pipeline-strength.ts` (the
	 * real `RecommendationPipeline`, 60 positions per bucket, 12 seeded draws, full-net depth-16/18
	 * reference). With the old breadth the wrapper played the argmax of up to five of Maia's moves at
	 * the human depth and was far stronger than the rating it imitates: pipeline − human mean loss
	 * −28.0 / −20.6 / −35.0 cp at targets 1800 / 2300 / 2800, ≥ 100 cp errors 16 / 6.4 / 2.9 % against
	 * 25 / 18 / 13 % for the humans, while Maia's own draw over the same rails matched them (+0.0 cp
	 * at 2300). Two candidates below 2800, together with `intuition` and `verifySigmaFloorCp` below,
	 * put the path within noise of both (docs/qa/generate-verify-2026-09-13.md, "Recalibration").
	 * The 3000 knot is unchanged: the upper verification above 2800 still ramps to it.
	 */
	candidates: {
		knots: [
			[800, 2],
			[1400, 2],
			[2000, 2],
			[2500, 2],
			[2800, 2],
			[3000, 7],
		] as ReadonlyArray<readonly [number, number]>,
		/** Per-move uniform jitter on the rounded knot value: `k ± jitter` (each offset equally likely). */
		jitter: 1,
		/** Below this the draw is not a comparison; `k = 1` is reserved for the intuition path. */
		min: 2,
		/** Ceiling on `k` after the jitter (the pool is usually smaller and binds first). */
		max: 8,
	},
	/**
	 * `pIntuition(E)`: the probability the move is played on recognition alone (`k = 1`, no
	 * verification — HvS §2.3), a linear ramp from `loProb` at `loElo` to `hiProb` at `hiElo`, flat
	 * outside, then toward `upperProb` across the upper verification band (2800 → 3000).
	 *
	 * 2026-09-15 recalibration (was `loProb` 0.55, `hiProb` 0.10): most blitz moves are played on
	 * recognition. Measured with `.scratch/bot-strength/pipeline-strength.ts` (see `candidates`), the
	 * shipped values beat the paired humans by −28.0 / −20.6 / −35.0 cp at 1800 / 2300 / 2800; with
	 * 0.70 → 0.60 plus two candidates and the 80 cp floor, replaying the same recorded searches gave
	 * −19.0 [−55.2, +13.2] / −0.6 [−13.7, +11.1] / −16.9 [−43.5, +2.6] cp, ≥ 100 cp error share within
	 * −4.9 / −2.8 / −3.5 pp of the humans (all 95 % intervals include 0), and the untimed-vs-bot
	 * configuration −2.0 [−7.9, +4.9] cp against the game clock. Raising intuition alone (0.80 →
	 * 0.70) still left 2800 at −20.3 [−46.9, −0.7]. `upperProb` at 3000 is unchanged.
	 */
	intuition: { loElo: 800, loProb: 0.7, hiElo: 2500, hiProb: 0.6, upperProb: 0.03 },
	/**
	 * The floor on the perception noise applied to the *shallow* scores in the compare stage,
	 * `[E, cp]` knots (flat outside, linear between): `σ_verify(E) = max(sigmaFor(E), floor(E))`.
	 * `sigmaFor` (§7.2 step 3) was calibrated as the misperception of a *deep* referee score; a
	 * human's estimate at their own depth carries the shallow frame's own error on top of it (HvS
	 * §5.4 — the evaluation a player forms at the end of a short line is itself noisy). Without the
	 * floor the top band's σ of 8–11 cp made the path an argmax of the shallow score (the QA doc's
	 * "at 2300+" finding: −40–60 % mean deep loss against Maia alone); with it the wrapper stays
	 * inside its stated KL budget and the strength rise is bounded (measured in
	 * `docs/qa/generate-verify-2026-09-13.md`).
	 *
	 * 2026-09-15 recalibration (was 60 / 45 / 30 / 20 / 20 cp at 800 / 1400 / 2000 / 2500 / 2800):
	 * the old floor bounded the rise on a synthetic pool to ≤ 25 %, but on real positions it still
	 * cut mean loss by 43 % at 2300 against the plain Maia draw (28.4 vs 49.9 cp), which is what made
	 * the extension outplay its rating. A human's shallow read in blitz is coarse; 80–90 cp together
	 * with two candidates and the `intuition` share above leaves the verified move −0.6 [−6.2, +4.5]
	 * cp from the plain draw at 2300 and +0.3 [−5.7, +6.4] at 2800 on the same recorded searches
	 * (`.scratch/bot-strength/pipeline-strength.ts`, see `candidates`). The 3000 knot is unchanged.
	 */
	verifySigmaFloorCp: [
		[800, 90],
		[1400, 80],
		[2000, 80],
		[2500, 80],
		[2800, 80],
		[3000, 12],
	] as ReadonlyArray<readonly [number, number]>,
	/**
	 * Upper-band samples for the `klFromMaia` meter. Ordinary recognition verification has an exact
	 * distribution and does not simulate extra choices in the service worker.
	 */
	meterSamples: 400,
} as const;
