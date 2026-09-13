/**
 * Generate-and-verify move selection (H3 + H4 of
 * `docs/research/human-move-selection-ideas-2026-09-13.md`, 2026-09-13): the knobs behind
 * `src/core/strength/generate-verify.ts`. A human of rating E does not sample one move from a
 * smooth distribution — recognition proposes a *few* candidates, calculation checks them at the
 * depth the rating can manage, and the best-looking one is played. Every number here is a
 * calibration knob; `docs/qa/generate-verify-2026-09-13.md` records what each rests on.
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
	 * How many distinct candidates recognition proposes, `k(E)`: `[E, k]` knots, flat outside and
	 * linear between, rounded to the nearest integer. de Groot's masters generated few, relevant
	 * candidates; Connors, Burns & Campitelli (2011) found breadth grows with skill only modestly —
	 * hence 2 at 800 to 5 at 2500 rather than a wide range.
	 */
	candidates: {
		knots: [
			[800, 2],
			[1400, 3],
			[2000, 4],
			[2500, 5],
		] as ReadonlyArray<readonly [number, number]>,
		/** Per-move uniform jitter on the rounded knot value: `k ± jitter` (each offset equally likely). */
		jitter: 1,
		/** Below this the draw is not a comparison; `k = 1` is reserved for the intuition path. */
		min: 2,
		/** Ceiling on `k` after the jitter (the pool is usually smaller and binds first). */
		max: 6,
	},
	/**
	 * `pIntuition(E)`: the probability the move is played on recognition alone (`k = 1`, no
	 * verification — HvS §2.3), a linear ramp from `loProb` at `loElo` to `hiProb` at `hiElo`, flat
	 * outside. High at club level, small but never zero at master level.
	 */
	intuition: { loElo: 800, loProb: 0.55, hiElo: 2500, hiProb: 0.1 },
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
	 */
	verifySigmaFloorCp: [
		[800, 60],
		[1400, 45],
		[2000, 30],
		[2500, 20],
	] as ReadonlyArray<readonly [number, number]>,
	/**
	 * Samples `drawDistribution` takes per move for the `klFromMaia` meter (§3.2): the path's
	 * `q(m)` has no closed form, so the meter is Monte Carlo on a separate seeded rng. One call is
	 * ≈ 1.4 µs, so this costs well under a millisecond in the service worker.
	 */
	meterSamples: 400,
} as const;
