# Cached strength audit near 2450 — 2026-09-16

The latest two-proposal verifier has a small measured severe-error regression against the
Sep 15 recalibrated verifier on this sample, alongside better prediction of human moves.
Most of the difference from the older HEAD verifier comes from the Sep 15 recalibration,
not the latest change. This audit does **not** establish the extension's playing Elo or
explain an observed loss to a particular 2200 opponent.

No production code, constants, settings, or weights were changed. No engines or models were
started; no browser or coordination tools were used for this run.

## Reproduction and scope

```sh
bun tools/human-match/strength-audit-2450.ts \
  .scratch/human-verification-2026-09-16 \
  docs/research/strength-audit-2450-2026-09-16.json 20000
bun test test/core/strength/strength-audit-2450.test.ts
```

The [JSON report](strength-audit-2450-2026-09-16.json) includes per-position measurements,
every exclusion, source and cache hashes, the original model/engine capture hashes, and
paired game-bootstrap intervals. It reads the earlier [verification audit](maia-recognition-verification-2026-09-16.md)
cache: Maia-3 79M policies conditioned on each human's actual rating and opponent rating,
with SF19 full-network shallow and deeper MultiPV frames. All methods receive identical
policies and scores. The three historical configurations are applied to these same SF19
frames; this is not a replay of historical engine versions or the complete recommendation pipeline.

The prior manifest has one position per game, excludes 176 earlier calibration games, and
splits games before inference. Its high-rating subset has 120 positions; 67 held-out games
have actual mover ratings from 2300 through 2700. This uses the existing held-out split,
which was already evaluated in the earlier prediction audit; it is not a new untouched test set.

**Cache integrity finding:** 17/120 high-rating frames lack some deep root scores despite
`complete: true`. That flag does not guarantee full root coverage. Nine are in the 2300–2700
held-out subset. One missing root is the actual human move (`173907481398-53`, rated 2452,
`h7g8`, prior probability 9.67%). Entire affected positions are excluded, never assigned a
zero score or renormalized over a smaller candidate set. This leaves **58 primary held-out
games**, and only **10** within 2400–2500. Excluding incomplete positions can introduce
selection bias. The JSON records all omissions, including the missing roots and their priors.

All remaining candidates have finite shallow and deep scores. In the primary 58 games, the
deep frame reached depth 12 in 53 cases, 11 in four, and 10 in one. Loss is the best scored
legal root's `cpEffective` minus the candidate's `cpEffective`: ordinary evaluations are
clipped to ±1000 cp, and mate distances use the production conversion. These shallow reference
searches and score conventions are limitations, not ground truth about long-term outcomes.

Means average positions equally. Error rates are expected probability mass at loss ≥100/300 cp;
the human reference uses the actual recorded move. Distinct samplers use 20,000 conditional
comparison draws per position plus the exact intuition component. Independent samplers use
exact marginals. Intervals are percentile intervals from 4,000 paired bootstrap resamples of
games. They do not account for recurring players, engine error, exclusion bias, or multiple
exploratory comparisons. A second Sep15 seed changed primary mean loss by only +0.045 cp,
≥100 rate by +0.017 percentage points, and ≥300 rate by +0.003 points.

## Three baselines

The HEAD reference is commit `4d93134ad4e678d7fe6e76b9c23cf8024325f447`. At effective E=2450:

| Configuration | Non-intuitive proposals | Intuition share | Comparison noise |
|---|---|---:|---:|
| HEAD, before Sep15 recalibration | 4, 5, or 6 distinct | 11.32% | Gaussian σ=21 cp per candidate |
| Sep15 recalibrated | 2 with probability 2/3; 3 with probability 1/3, distinct | 60.29% | Gaussian σ=80 cp per candidate |
| Current | Two independent proposals, with replacement | 60.29% | Pairwise logistic scale=80 cp |

Those counts are capped by support for distinct sampling. The current path can propose the
same move twice. Across the primary sample, the prior collision probability averages 49.35%:
only **20.09% of all current draws** actually compare two different moves, versus approximately
40% for the Sep15 distinct path. More proposals, replacement, intuition share, and the comparison
law are separate changes; the comparison noise numbers are not equivalent distribution scales.

All shallow scores exist in the retained frames, so **removing the old deep-score fallback has
zero effect in this audit**. The separate
[runtime coverage probe](runtime-shallow-coverage-2450-2026-09-16.md) measures that narrower
question on twelve positions; it is not part of these all-legal paired comparisons.

## Measured paired results

Primary held-out sample: 58 games, mover rating 2300–2693, mean 2514.4. Lower loss and NLL are
better; NLL measures prediction of the human move, not engine playing strength.

| Method | Expected loss, cp | ≥100 cp | ≥300 cp | Human-move NLL | Mean probability of human move |
|---|---:|---:|---:|---:|---:|
| Actual human move | 22.76 | 5.17% | 1.72% | — | — |
| Raw Maia | 50.99 | 12.20% | 4.37% | 0.88495 | 52.80% |
| HEAD distinct | 15.81 | 2.25% | 0.53% | 1.24245 | 45.31% |
| Sep15 distinct | 41.52 | 10.17% | 2.88% | 0.89374 | 50.28% |
| Current two proposals | 43.11 | 10.23% | 3.26% | 0.86069 | 54.03% |

Paired differences, with 95% intervals:

- Sep15 minus HEAD: **+25.71 cp [17.08, 36.05]**, ≥100 **+7.91 pp [5.00, 11.29]**,
  ≥300 **+2.35 pp [1.07, 3.91]**. The older strong verifier also has substantially worse human
  likelihood: Sep15 improves NLL by −0.34871 [−0.54870, −0.15510].
- Current minus Sep15: **+1.59 cp [−0.58, 4.55]**, ≥100 **+0.06 pp [−0.59, 0.70]**,
  ≥300 **+0.38 pp [0.10, 0.76]**. The mean-loss difference is uncertain; the severe-error
  increment is positive on these cached frames. Human-move probability improves **+3.74 pp
  [2.10, 5.45]**; NLL changes −0.03305 [−0.06503, +0.00011].
- Current minus actual human: **+20.35 cp [6.27, 36.87]**. Sep15 already has **+18.76 cp
  [5.88, 33.08]**. This sample indicates a quality gap in the isolated policy/verifier at these
  ratings, not a gap created primarily by the newest two-proposal change.

The current law reduces probability assigned to moves with original prior below 0.5%:
**1.60% for Sep15 → 0.72% current** (raw prior mass 0.89%). Mean KL from the prior is
**0.05172 → 0.00457 nats**. The severe-error increase is therefore not caused by inflating
rare proposals. Retaining more of the prior also retains some errors the distinct tournament
used to reject. Returning to HEAD would improve this engine-loss metric while substantially
worsening human-move likelihood.

Sensitivity checks in the JSON:

- Excluding all five positions with any deep mate score leaves 53 games: current minus Sep15
  **+0.25 cp [−1.19, 1.80]**; ≥300 **+0.20 pp [0.03, 0.43]**. The current-minus-human loss
  gap remains +20.10 cp [9.46, 32.76].
- The original 2400 bucket, spanning 2250–2550, has 37 complete held-out frames: current minus
  Sep15 **+4.31 cp [0.85, 8.77]**; ≥300 **+0.57 pp [0.15, 1.15]**. The 2700 bucket has 39:
  **+0.84 cp [−1.07, 2.75]**, ≥300 **+0.03 pp [0.007, 0.058]**.
- The narrow 2400–2500 subset has only ten complete games: human loss 42.10 cp, Sep15 28.99,
  current 28.55. Current minus Sep15 is **−0.44 cp [−3.02, 2.72]**. Current minus human is
  −13.55 cp [−44.90, 5.25]. It does not establish understrength specifically at 2450.
- The separate development subset has 18 complete 2300–2700 games. Current minus Sep15 is
  +5.07 cp [0.42, 10.78], but current minus human is −15.12 [−104.64, 47.35]. This variation
  reinforces the limits of rating conclusions from small human samples.

## Independent K proposals: offline counterfactual

The proposed alternative was also evaluated, without any production modification or parameter
fit. Draw each proposal independently from the original prior, compare it against the current
incumbent using the current logistic law, and mix the final result with the same Sep15 intuition
share. The exact marginal is a finite Markov update, not simulated choices. Missing evidence
keeps the incumbent. Equal scores or entirely missing evidence preserve the original prior for
every K. Two proposals reproduce the current exact law, including partially missing evidence.

| Method, same 58 games | Expected loss, cp | ≥100 cp | ≥300 cp | Human NLL |
|---|---:|---:|---:|---:|
| Current fixed two | 43.11 | 10.23% | 3.26% | 0.86069 |
| Independent Sep15 count (2/2/3) | 42.23 | 9.99% | 3.15% | 0.85853 |
| Independent HEAD rating-dependent count | 38.82 | 9.02% | 2.76% | 0.85220 |

The minimal 2/2/3 change reduces loss by **0.88 cp [0.44, 1.46]** and ≥300 by **0.11 pp
[0.04, 0.20]** versus current. Its NLL change is −0.00216 [−0.00542, +0.00098]. Historical
rating-dependent counts reduce loss by **4.29 cp [2.09, 7.15]**, ≥300 by **0.50 pp [0.17, 0.93]**;
NLL changes −0.00849 [−0.02646, +0.00919]. Both NLL intervals include zero. Historical-count NLL
worsens on the ten-game 2450 subset (0.55503 → 0.57852); it is not a universal improvement.

This supports independent K as a candidate that restores deliberation while retaining the
neutral-evidence probability invariant. It does not validate restoring the old counts or fix
the whole observed quality gap: even that counterfactual averages 16.06 cp more loss than these
humans. The current minimal count schedule is flat below 2800; restoring only its jitter does
not restore the older rating-dependent growth.

## Relation to Sep15 calibration and recommended next step

The [Sep15 calibration](../qa/generate-verify-2026-09-13.md) used the **real RecommendationPipeline**,
SF18 smallnet searches with a deeper SF18 full-network reference, effective rating deductions,
runtime candidate sets and rails, twelve draws per position, and different human games. Its
target-2300 replay reported −0.6 cp [−13.7, 11.1] relative to humans; the subsequent fresh-search
measurement was −1.6 cp [−14.6, 10.0], ≥100 15.3% versus human 18.3%, and ≥300 1.7% versus 1.7%.
Those results cannot be subtracted from this all-legal SF19 audit as an estimate of a regression.

Here, no fixed-2450 policy was queried. The cached policies use actual human ratings, without
the live clock/think/form deductions. This does not measure the effect of a nominal 2450 query
being conditioned near 2300, the removed accuracy offset, model/platform rating equivalence,
book choices, candidate truncation, mate/hang/repetition/loss safeguards, or tie-band changes.
All those runtime effects are outside this isolated paired experiment.

**Release recommendation: retain the current verifier.** Do not restore HEAD wholesale, remove
the context penalty, or raise the Elo offset from these results. The smallest supported verifier
candidate is the independent 2/2/3 proposal law; it recovers
some severe-error rejection without the neutral-score distortion. Keep it experimental until
the same comparison is replayed on actual runtime survivor pools and effective ratings. The
larger apparent gap deserves runtime-path calibration, because it is already present in raw
Maia/Sep15 on this sample and is not evidence that the newest verifier alone causes large Elo loss.

The separate runtime probe first recorded 8/12 moves with verification, four without a shallow
frame, and mean query rating 2355.6 versus selector rating 2318.6. A cached-policy control then
recorded 11/12 verifier entries and complete survivor coverage. These passes are not pooled
because same-process inference scheduling affected the initial probe. They are not part of this cache.
That roughly 37-point selector deduction is a consistency concern to trace, not a measured cause
of weak play. At those ratings the current verification noise stays at 80 cp and this difference
changes intuition by only about 0.22 percentage points; the policy was already queried at the
higher rating. No-frame moves bypass ordinary verification. Neither observation supports changing
the context tax wholesale, and neither is reproduced by these complete-shallow-frame comparisons.

Validation: four focused audit tests pass (19 assertions), including exact seeded agreement
with the preserved Sep15 distinct sampler, current-law equivalence, neutral-evidence preservation,
and mass/positive-tail invariants. Scoped Biome and project TypeScript checks pass. Native
extension behavior and playing-strength outcomes remain unverified.
