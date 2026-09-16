# Maia recognition and verification, 2026-09-16

This change corrects probability distortion in the wrapper around Maia. It does not retrain the
79M model or claim to reproduce human cognition exactly. The ordinary verification range uses
two independent recognition proposals and comparable shallow evidence. The existing upper
verification band (effective rating above 2800), routing above target 3000, max-strength mode,
mate/safety/repetition guards, and Maia's history encoder remain in place.

## Evidence and implementation decisions

The [original Maia paper](https://arxiv.org/abs/2006.01855) distinguishes human move prediction
from engine strength and evaluates prediction across skill levels. [Maia-2](https://arxiv.org/abs/2409.20553)
conditions on both players' ratings. [Chessformer / Maia-3](https://arxiv.org/abs/2605.19091)
provides the policy and history-based architecture already shipped here. These support preserving
the model's rating-conditioned move probabilities. They do not support treating engine
centipawn agreement as the sole measure of human similarity.

The previous implementation sampled two or three **distinct** moves and chose a noisy score
maximum. Distinct proposals are not distribution preserving: for probabilities 0.9 and 0.1, a
two-candidate comparison with equal scores and symmetric noise returns 0.5/0.5. Mixing this with
60% intuition returns 0.74/0.26, even though no chess evidence favored the unlikely move.
It also substituted a deep engine score whenever a move lacked a shallow score. That gave
unsearched human candidates more knowledge than the purported human-depth verification had.

`generate-verify.ts` now starts with one Maia draw. On the existing non-intuitive share, it draws
a second proposal independently **with replacement**. Recognizing the same candidate twice is
allowed. Two different candidates are compared only when both have finite shallow scores; if
either is unavailable, the initial proposal stands. No extra search or inference is required.
The comparison probability is logistic in the shallow score difference, using the existing
rating-dependent comparison scale. This is a bounded engineering model, not an established
psychological law. The audit below tests its predictive consequences rather than assuming them.

Let `p_i` be Maia's normalized probability on the surviving candidate set, `I` the existing
intuition probability, and `A_ij = sigmoid((s_i-s_j)/sigma)` when both shallow scores exist,
otherwise `A_ij = 1/2`. The exact marginal distribution is

```
q_i = p_i + 2 (1-I) p_i sum_{j != i} p_j (A_ij - 1/2)
```

Consequences checked directly:

- Equal scores or absent comparison evidence preserve Maia exactly.
- Missing shallow scores never borrow deep scores in the ordinary range.
- `I <= q_i/p_i <= 2-I`: a tiny prior cannot become a large engine-selected tail event.
- Pairwise transfers conserve mass, and every positive candidate retains positive probability.
- The runtime sampler matches this law; the ordinary-range KL meter uses the exact law instead
  of 400 simulated choices per move.
- The previous upper-band algorithm produces identical results for identical inputs and seeds.

Separately, `maia-select.ts` now normalizes a tie-band adjustment by its **probability-weighted**
mean. The old arithmetic mean changed the band's total mass whenever its probabilities differed;
global normalization then changed unrelated moves too. The corrected adjustment preserves the
band's mass exactly. This is a probability-accounting fix, not a new strategic preference.

## Audit protocol

The new `tools/human-match/verification-audit.ts` consumes the existing public Chess.com blitz
archive `.scratch/books/chesscom-games.jsonl`. Sampling and the split are fixed before model
inference. There is one position per game, after ply 16 and at least ten plies before its end,
with at least 30 seconds on the mover's clock and at least two legal moves. Five rating bands
center on 900, 1400, 1900, 2400 and 2700; the mover must be within 150 points and at most 2800.
All 176 distinct game IDs found in the previous strength-tuning store are excluded.

There are 300 distinct games: 77 development and 223 held out by a separate game hash. No
coefficient was fit to either split. The shipped Maia-3 79M model receives the actual two ratings
and eight consecutive board positions. Stockfish 19 full network scores all legal roots in
complete MultiPV frames: a rating-dependent shallow depth, and a depth-12 reference with a
1500 ms cap. A shallow search has a 3000 ms cap; achieved depth is recorded. These generous
offline budgets isolate the verification correction, rather than imitate runtime scheduling.

Comparisons use the same recorded probabilities and scores:

- Raw Maia, over all legal moves.
- Previous distinct-candidate verification, with 20,000 seeded comparison draws per position
  plus its **exact** intuition component. This avoids false zero probabilities in rare tails.
- Corrected recognition verification, using the exact marginal law above.

Report negative log likelihood (NLL, lower is better), multiclass Brier score, modal move match,
and probability assigned to the actual human move. Differences are paired within position;
95% bootstrap intervals resample whole games rather than individual moves. Players may recur across games. A zero human
probability causes an explicit failure rather than being silently smoothed or omitted.

The capture cache records model answers and both engine frames per game/ply. The report includes
the archive SHA-256, sampling manifest, per-position results, and achieved shallow depths.
Re-running with changed model inputs in the same cache fails. To capture different weights or
engine builds, use a new cache directory.

```sh
bun tools/human-match/verification-audit.ts \
  .scratch/books/chesscom-games.jsonl .scratch/human-verification-2026-09-16 60
```

## Measured result

The saved [audit report](maia-recognition-verification-2026-09-16.json) contains all 300 paired
rows and hashes of the model, engine program, compressed NNUE, source archive and verifier.
All 223 held-out positions reached the requested shallow depth.

| Held-out metric (223 games) | Raw Maia | Previous verifier | Corrected verifier |
|---|---:|---:|---:|
| Human-move NLL, lower better | 1.22364 | 1.22069 | 1.21021 |
| Multiclass Brier, lower better | 0.55271 | 0.55461 | 0.55110 |
| Modal move match | 56.05% | 56.95% | 56.95% |
| Mean probability of actual human move | 44.31% | 42.80% | 45.26% |

Against the previous verifier, expected sampled move agreement improves **2.46 percentage
points**, 95% paired bootstrap interval **[1.72, 3.22]**. Modal agreement is unchanged. NLL
changes **-0.01048 nats**, interval **[-0.02960, +0.00953]**; this sample does **not** establish
a statistically clear NLL improvement over that verifier. Against raw Maia, the NLL change is
**-0.01343**, interval **[-0.02402, -0.00182]**. Brier improvement versus the old verifier is also
uncertain (interval includes zero). These are modest predictive changes, not an Elo calibration.

| Held-out band | Games | Previous NLL | Corrected NLL | Previous modal match | Corrected modal match |
|---|---:|---:|---:|---:|---:|
| 900 | 47 | 1.57449 | 1.57804 | 46.81% | 48.94% |
| 1400 | 44 | 1.22208 | 1.22983 | 43.18% | 47.73% |
| 1900 | 44 | 1.33779 | 1.31226 | 61.36% | 59.09% |
| 2400 | 46 | 0.97500 | 0.94251 | 69.57% | 69.57% |
| 2700 | 42 | 0.96976 | 0.96433 | 64.29% | 59.52% |

The development subset has 77 games: NLL 1.00866 -> 0.98634; its paired interval versus the
old verifier also includes zero. No constants were changed after either result was inspected.
The shipped change is justified by exact probability invariants plus modest aggregate evidence;
the per-band tradeoffs are reasons to retain the measurements and avoid claiming universal gains.

## Candidate support and remaining limitations

The audit scores all legal moves so candidate omission cannot masquerade as verification gain.
It separately reports human moves below the existing 0.005 search-priority threshold and outside
the runtime `shapedRootSet`, using the independently searched best move as the known continuation.
That root-set audit is approximate: a live preliminary search can find a different continuation.
The held-out shaped roots cover **96.83%** of Maia probability on average; **4/223** actual human
moves fall outside them (three in the 900 band, one in the 1900 band). One human move has raw
probability below 0.005. Increasing mass coverage could recover these human moves, but needs a
same-deadline runtime comparison before changing search budgets. The verifier improvement above
does not repair those omissions.
The runtime still selects only candidates it has scored; this change does not invent scores
for unsearched moves or silently bypass safety guards. The plain-draw probability floor also
remains unchanged. These losses of support are distinct from the corrected verifier.

This is an isolated verifier evaluation, not a complete live pipeline or playing-strength
evaluation. Book routing, conversion and tactical guards, time pressure, per-game form, and
platform rating conversion can still change the final behavior. Human games are sampled from
Chess.com while Maia was trained on Lichess; equal rating numbers are not a validated mapping.
This is a game holdout, not a player holdout. Small per-band samples cannot justify precise Elo claims or threshold tuning. The upper
2800–3000 verification region is intentionally not recalibrated from this lower-range evidence.

## Next ideas, with acceptance criteria

1. **Learn small residual corrections to a frozen Maia policy.** Use relative shallow/deep
   disagreement, coverage, phase, clock context and both ratings; initialize the residual at
   zero, keep the full legal distribution, and optimize human-move NLL on temporal and player
   holdouts. [Matilda v3](https://arxiv.org/abs/2606.25176v3) supports this architecture at elite
   levels; its current abstract reports unchanged Maia performance below 2500 where search
   annotations were unavailable. Do not extrapolate its elite gains to club players or copy
   the earlier abstract's broader claims.
2. **Budget search by missing human probability.** Start with a Maia nucleus, then spend spare
   compute on unscored human mass rather than repeatedly refining the engine favorite. Require
   higher held-out human-support coverage at the same overall move deadline. A rejected move
   should be distinguished from a move the engine never evaluated.
3. **Preserve a learned style across a game.** A small game-level style latent or personalized
   residual could encode actual opening and piece-activity preferences. The
   [personalized Maia work](https://arxiv.org/abs/2008.10086) provides evidence that individual
   style is predictable. Fit this from repeated human games and test player-held-out likelihood;
   arbitrary aggressive/passive multipliers or a fresh random style each move are not substitutes.
4. **Calibrate context without pretending it is rating.** Train a small clock/phase-conditioned
   residual to distinguish rushed tactical oversights from normal ambiguity. Compare against
   the current entropy/clock Elo penalties on game-held-out data before changing them. High
   uncertainty alone does not establish that the player temporarily lost rating points.
5. **Keep exact probability accounting at module boundaries.** Report raw, scored, guarded and
   final move mass separately, and evaluate both full-support NLL and support coverage. This
   prevents apparent improvements caused solely by excluding the human's actual move from the
   denominator. Extend the audit to live-shaped searches before deploying a learned residual.

## Checks and integration boundaries

- 134 focused tests across strength selection, the Maia query/session contract, and audit
  sampling pass. This includes 60,000 stochastic draws checked against the exact law and
  seed-identical upper-band results.
- TypeScript, scoped Biome checks, and the constants checker pass.
- The standalone full-engine audit helper needed a migration fix: plain Stockfish 19 glue asks
  for `sf_19.wasm` by its own filename. Its tool-only resolver now maps that request to the
  installed package, while leaving the extension's relaxed-SIMD runtime paths alone.
- No native Chrome/live-game validation or full-pipeline playing-strength evaluation is claimed.
