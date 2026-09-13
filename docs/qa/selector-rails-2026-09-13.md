# Selector rails, meters and the one Maia rating — 2026-09-13

The selector side of `docs/research/human-move-selection-ideas-2026-09-13.md`: H1, H2, H5
(ambiguity), H9, H11, H12, H15, H16, the §3.2 fidelity meters, and the §7 fixes B2, B3, C1, C2,
D1, D2. Everything here is in `src/core/strength/move-selector.ts`, `src/core/strength/maia-select.ts`,
`src/core/policy/maia-policy.ts` and the `MAIA` registry in `src/core/constants/maia.ts`; the
pipeline side (the query's `selfElo`, `contextEloPenalty`, the ≥ 2600 query) is another change.
No model was calibrated: every number below is a wrapper knob, and every claim is pinned by a
seeded unit test that runs on `bun run check`.

## One rating for a Maia move (B2, H2, H5, H12)

`selectMove` now takes its pressure arithmetic from `pressureTerms` (`selection-elo.ts`) — the
same function the pipeline calls — and, when `ctx.maia` is present below `MAIA.eloMax`, computes
**one** rating for everything Maia-related:

```
maiaE = maiaSelfElo({ targetElo, form, blunderScale, pressureReduction,
                      contextEloPenalty: ctx.contextEloPenalty,
                      ambiguityEloPenalty: MAIA.context.ambiguityElo · policyEntropy(ctx.maia.moves)
                                         + (tilted ? MAIA.tilt.elo : 0) })
```

It feeds `lossCapFor`, the hang rail's ramp and view, the deep-mated allowance, the mate ramp and
the draw itself. The base-policy paths keep `E` / `baselineE` exactly as before, and the injected
blunder channel keeps reading `blunderScale` as a probability scale — the slider is the storage
unit, both meanings derive from it.

* **H2 — the slider is an Elo offset.** `maiaTemperature` and `MAIA.blunderScaleFloor` are gone;
  the draw runs at `MAIA.temperature = 1` always. `sliderEloOffset(blunderScale)` (±250 Elo across
  the knob) reaches the Maia branch only through `maiaE`. Pinned: `maia-select.test.ts` "(b) the
  mistakes slider no longer heats or cools the draw" (same seed, same sequence at slider 0/1/2
  when no rail binds) and `selector-rails.test.ts` "H2": mean raw loss over 2000 draws is monotone
  non-decreasing in the slider on a fixed pool, and the share drawn from a `p = 0.008` move stays
  under 0.02 at every position (the old `T = 1.5` draw gave it ≈ 0.04).
* **H5 — ambiguity.** `policyEntropy(moves)` (`maia-policy.ts`): `−Σ p log p / log(#moves)`,
  renormalised first, 0 for one move. `MAIA.context.ambiguityElo` (120) × entropy is the
  selector's term; the pipeline's clock/think terms arrive as `ctx.contextEloPenalty`. Together
  they never exceed `MAIA.context.maxPenalty` (350) — `maiaSelfElo` caps the sum.
* **H12 — tilt.** `SelectionState.lastPickCp` (set in `finish()` from the pick's `cpRaw`; cleared
  after an unscored pick) and `tiltMovesLeft`. At the start of the Maia branch, when
  `topCpRaw ≤ lastPickCp − MAIA.tilt.swingCp` (150) and not already tilted, with probability
  `tiltProbability(maiaE)` = `probAtFloor` (0.5) at/below `probFullElo` (800) falling to 0 at
  `probFloorElo` (1400), the state takes `tiltMovesLeft = MAIA.tilt.moves` (3); while it is > 0 the
  rating carries `MAIA.tilt.elo` (100) more through the capped context channel, and `finish()`
  counts it down on every path. Rationale rows `tilt: eval fell N cp since our last move (p=…)`
  and `, tilt −100 (k left)` on the `maia E=` row.

The rationale row `maia E=… (pressure −a, slider ±b, context −c, ambiguity −d [entropy h], tilt …)`
shows every term.

## Rails that scale with the rating (H1, H9, H16)

| Rail | Before | Now |
|---|---|---|
| hang rail (`hangsPiece`) | flat, every rating, deep-PV view | `MAIA.hangRail`: off below `offElo` 1100; fires with `hangRailProbability(maiaE)` linear to 1 at `fullElo` 2000, **one `rng.chance` per move**; from 2000 always. Below `cheapViewElo` 1600 "hangs" is `hangsOutright(fen, uci)` (one ply, `src/core/chess/safety.ts`), from 1600 the deep-PV `hangsPiece`. Both views still require `lossRaw ≥ hangPieceLoss` (0.25) — the rail is "never hang a piece *for nothing*"; a gambit pawn the engine scores at −5 cp is not a hang. `lossCap` stays the absolute backstop. Row: `maia hang rail: off (E<1100)` / `fired (p=0.5), one-ply view` / `skipped (p=0.5)` / `on, deep-PV view`. |
| searched forced mate | every searched mate played, every rating (B3: six constants dead) | H9: an **immediate** board mate is still unconditional. A searched mate-in-N ≤ `mateInMax` (3) is played with `mateRampProbability(E)` — 1 from `mateAlwaysElo` (1400), else `mateProbBase + mateProbBase·(E − 800)/600` (0.5 at 800), one `rng.chance` only when p < 1 so seeds above 1400 are unchanged. Deeper mates, and a declined one, fall through to the ordinary draw (Maia or base) with every line of `lossRaw ≥ throwWinLoss` (0.4) removed from `ranked` — and the native-bestmove-outside-the-scored-set path is closed while that filter is on, since an unscored move's loss cannot be judged. `E` is `maiaE` in Maia mode, `baselineE` otherwise. Rows: `mate: preserving forced mate-in-3 (p=0.75 at E=1100)`, `mate: mate-in-3 declined (p=…)`, `mate: mate-in-8 is beyond 3, ordinary policy`, `mate: throw-win filter, lines with loss ≥ 0.4 excluded`. |
| mated lines | Maia branch excluded every mated line | H16: `matedLineFilter` is one helper for both paths — below `matedAllowBelowElo` (1000) a mated line ≥ `matedMinDepth` (2) deep is allowed with `matedAllowProb` (0.25), drawn once per move. The base policy judges at `baselineE`, the Maia branch at `maiaE`. |
| `lossCap` | 0.55 → 0.25 by E | unchanged; now judged at `maiaE`. |

Pinned in `selector-rails.test.ts`: at E = 900 a candidate that hangs a queen with `lossRaw ≈ 0.27`
is drawn at Maia's mass; at 2200 never; at 1550 the rail fires in 50 % ± 5 % of 2000 seeded moves
and only then excludes it; the mate-in-3 ramp lands within ±4 % of 0.5 / 0.83 / 1 at 800 / 1200 /
1600 (base policy) and at 0.75 at `maiaE` = 1100 (Maia); immediate mate always; mate-in-≤ 3 always
from 1400; a mate-in-4 never carries `source: "mate"` and the −300 cp throw is never drawn at 800
with the slider at 2, in either path; a mate −3 line is drawn ≈ 0.25 · 0.9 of the time at
`maiaE` = 900 and never at 1050.

## The technique prior as a tie-break (H11, C1, C2)

The heuristic prior is no longer computed for every line up front (C1). `selectMove` builds a lazy
`boostedPriors(subset)` — `resolvePriorsDetailed` plus the conversion-progress and clock-forcing
boosts — and calls it over the whole usable set only on the base-policy path. In the Maia branch
`drawMaiaMove` receives a `tieBreak` resolver: after the weights are computed, the survivors with
weight ≥ `MAIA.tieBandRatio` (0.7) × the top weight form the band; only when the band has ≥ 2
members is the prior resolved, for those lines (plus the best usable line, which the prior's
environment is relative to), and each band member's weight is multiplied by its prior normalised to
mean 1 over the band. Nothing outside the band moves; a flat prior moves nothing and reports
`tieBand = 0`. The KL the tie-break introduces lands on the meters.

C2: `conversion: retaining the win with rating-sensitive progress` is pushed only where the boosted
prior reaches the chooser — the base-policy path, and the Maia branch when a band member carries
the `conversion-progress` term. The engine-elo / native / pure-engine paths no longer claim it.

Pinned: the direct `drawMaiaMove` test (band {0.4, 0.35} of a 0.25 third: shares 0.205 / 0.538 /
0.256 ± 0.03 over 4000 draws, `klFromMaia` equal to `klDivergence` of those shares, the resolver
called with exactly the band), the one-member / flat / absent cases (KL 0, no row), and end to end
on a rook ending where black keeps a pawn (pawn push progress 2 vs 0): the push takes 0.6 ± 0.035
of 2000 draws, its rationale carries `conversion-progress ×1.5`, and a Maia distribution with no
band produces neither the row nor a `prior:` line.

## Practical difficulty inside the tie band (H13, the free approximation)

`MAIA.practical = { behindCp: −200, minReplyLoss: 0.25, forcingReplyWeight: 0.5, enabled: true }`.
When the position's top raw score (`topCpRaw`, side-to-move POV) is ≤ `behindCp`, the Maia branch
hands `drawMaiaFromSurvivors` a `practical` resolver alongside the H11 `tieBreak`; both act on the
same band (`tieBandOf`: survivors with weight ≥ `tieBandRatio` × the top weight) and both are
normalised to mean 1 over it, so they compose and neither moves mass outside the band. The
band's weights are multiplied by `1 + trickiness`.

`trickiness` is a proxy read off the lines already on hand — H13's full form (Maia conditioned on
the opponent's rating over the replies) needs 2–3 extra queries and engine scores for the replies,
which the selector does not have. Per band member `L`:

```
sharpness  = |winProb(cpRaw(L)) − winProb(cpRaw(best other survivor))|
trickiness = clamp(sharpness / minReplyLoss, 0, 1) × (PV reply forcing ? forcingReplyWeight : 1)
```

"Forcing" is the PV's reply (`pvSan[1]` containing `x`, `+` or `#`, else `classifyMove` on
`pvUci[1]` after `L`: capture or check). The reading: the opponent's precise reply is what holds
`L` to `cpRaw(L)`; the further the alternatives are apart, the sharper the line; and a forcing
only-reply is found on autopilot, a quiet one is the trick (HvS §2.9, §11.3). Its weakness is
plain — for a two-member band the sharpness is the same for both, so the term differentiates on
the reply's forcingness alone, and nothing on hand measures how *many* replies hold. It is gated
(`enabled`) because it changes results, not only realism (the research note's warning). The pick's
quality sample is left as it is: no `quality.reason` literal fits (`opponent-rush` means something
else) and `src/types/game.ts` was not to be edited for one — add `"practical"` there when the
cohort should exclude these picks.

Rows: `maia practical: 2 near-equal survivors weighted by 1 + trickiness (g1f3 1, d2d4 0.5)`;
`MaiaDraw.practicalBand` is the band size when the term moved anything, and `klFromMaia` picks
the movement up. On the generate-and-verify path (a human-depth frame present — see
`generate-verify-2026-09-13.md`) the term is skipped with H11: the verification decides among
the candidates, and the rationale says so.

Pinned (`generate-verify-wiring.test.ts`, "H13"): after 1. e4 e5, Nf3 (−200, PV reply the quiet
Nc6) against d4 (−700, PV reply exd4) at equal Maia mass and a target of 1000 (the Maia rating
880 keeps the hang rail off and both lines under the cap): trickiness 1 vs 0.5, factors 2 : 1.5,
Nf3 drawn 0.571 ± 0.035 of 2000 seeded moves with the row and a positive KL; the same band at
+50 / −350 (ahead) draws 0.5 ± 0.035 with no row and KL 0; a decided Maia (0.8 / 0.2) has no
band and draws 0.8 ± 0.035; two forcing replies at equal sharpness are a flat proxy (no row, KL 0)
while a quiet one moves; with a frame the skip row appears and no `maia practical` row.

## Meters (§3.2, D1, D2)

`drawMaiaMove` — now `maiaSurvivors` (rails and masses) + `drawMaiaFromSurvivors` (the weighted
draw), joined by `maiaDrawRecord`, so generate-and-verify can replace the draw and keep the
record — returns, and `selectMove` copies into `ChosenMove.maiaMeters` (`MaiaMeters` in
`src/types/game.ts`):

| Field | Meaning |
|---|---|
| `selfElo` | `maiaE` (the prior path: `min(E, MAIA.prior.topCalibratedElo)`) |
| `entropy` | `policyEntropy(ctx.maia.moves)` |
| `railedMass` | Σ p over scored candidates the rails (mated, hang, loss cap) excluded |
| `unscoredMass` | Σ p − the mass on the lines the search scored, measured over **all** `lines` before the repetition/conversion guards (D2) |
| `klFromMaia` | `klDivergence(final weights ‖ p renormalised over the drawn set)`: 0 unless the tie-break, the practical term (or a T ≠ 1) moved mass — the exact amount the wrapper, not Maia, chose. On the generate-and-verify path it is `gvKl(drawDistribution(…))`, the module's own Monte Carlo meter |
| `rank` | the pick's 1-based rank by p among the **survivors** (D1) |
| `survivors` | the set the draw was over |
| `candidates`, `verifyDepth` | generate-and-verify only (H3): candidates drawn (1 on intuition) and the depth they were verified at; absent when the plain draw ran |

The `maia:` row is now
`maia: <size> E=<maiaE> p=<p> rank <k>/<survivors> survivors scored mass <before>[ (guards left <after>)][ (+n from searchmoves)] unscored <u>[ railed <r>][ KL <kl>] <ms> ms`,
and the `minScoredMass` diagnostic keys on the pre-guard mass, so it speaks about the search and not
about conversion removing lines. `MaiaDraw` carries `scoredMass` (after the guards) and
`scoredMassBefore` separately.

## Above `MAIA.eloMax`: Maia-79M as a prior (H15)

Between `MAIA.eloMax` (2600) and `LIMITS.eloMax` (3800), when `ctx.maia` is present
(`usesMaiaPrior(target)`), the branch after the pure-engine escape builds the engine's pool — the
unmated, non-hanging lines within `gapFor(E)` (60 cp there) of the best — and draws with weights
`max(MAIA.prior.floorWeight = 0.02, p)`, so a line Maia never plays is still played when it is
alone in the gap. Source `maia`, `maiaProb`, meters and the row
`maia prior: 79m E=<min(E, 2700)> pool k/n within 60 cp, p=… rank …`. `LIMITS.eloMax` stays pure
engine; the native/hybrid path is untouched when no policy came. Pinned: at 2600 / 2800 / 3000 the
draw follows `max(floor, p)` renormalised (±0.035), differs from the native pick, tracks a different
policy per target for the same seed, plays a `p = 0` line alone in the gap, and keeps mated and
hanging lines out of the pool.

## Constants added (`src/core/constants/maia.ts`)

| Constant | Value | Role |
|---|---|---|
| `MAIA.hangRail.offElo` | 1100 | hang rail off below |
| `MAIA.hangRail.fullElo` | 2000 | always on from |
| `MAIA.hangRail.cheapViewElo` | 1600 | one-ply `hangsOutright` view below, deep-PV `hangsPiece` from |
| `MAIA.tieBandRatio` | 0.7 | survivors within this fraction of the top weight form the tie band |
| `MAIA.tilt.swingCp` | 150 | adverse swing that can tilt |
| `MAIA.tilt.elo` | 100 | penalty while tilted |
| `MAIA.tilt.moves` | 3 | moves tilted, the triggering one included |
| `MAIA.tilt.probFloorElo` | 1400 | tilt probability 0 at/above |
| `MAIA.tilt.probAtFloor` | 0.5 | tilt probability at/below `probFullElo` |
| `MAIA.tilt.probFullElo` | 800 | where the probability reaches `probAtFloor` |
| `MAIA.practical.behindCp` | −200 | H13 applies only when the top raw score is at or under this |
| `MAIA.practical.minReplyLoss` | 0.25 | win-fraction sharpness at which trickiness saturates (H13's "second-best reply loses ≥ 0.25") |
| `MAIA.practical.forcingReplyWeight` | 0.5 | trickiness multiplier when the PV reply is a capture or check |
| `MAIA.practical.enabled` | true | the gate |

Removed: `MAIA.blunderScaleFloor` and `maiaTemperature` (H2). The six `SELECTION_CONSTANTS.neverPlay`
mate constants are live again (H9). Nothing in `SELECTION_CONSTANTS` changed value. The
generate-and-verify registry (`GENERATE_VERIFY.verifySigmaFloorCp`) is recorded in
`generate-verify-2026-09-13.md`.

## Behavioural changes an existing test had to follow

* `move-selector.test.ts` "rejects illegal unscored native moves and preserves searched mates":
  the fixture is now a mate-in-3 (within `mateInMax`); a mate-in-5 with an unscored native move
  now stays on the scored mating line via the top-line fallback.
* `move-selector.test.ts` "preserves searched mates … including longer mates": split into the
  ≤ 3 case (every mode, 1400 / 1500 / 3800) and an H9 case (mate-in-8 falls through; the pure-engine
  path still converts it, the 800 base policy sometimes takes +700 instead).
* `maia-select.test.ts`: the (b) temperature test became the slider-as-offset test; rationale
  regexes follow the new row; "(f) at target ≥ 2600 the Maia context is ignored" now holds only at
  `LIMITS.eloMax`, with a new (f) case for the prior at 2600 / 2700; "(g)" uses a mate-in-3; the
  hang-rail case runs at a target that puts `maiaE` above `fullElo`.

## Tests

`test/core/strength/selector-rails.test.ts` (34), `test/core/strength/maia-select.test.ts` (22),
`test/core/strength/move-selector.test.ts` (33), `test/core/policy/maia-policy.test.ts` (14, with
`policyEntropy` and `klDivergence`), `test/core/policy/maia-size.test.ts` (4, with `usesMaiaPrior`),
and since the H3/H13 wiring `test/core/strength/generate-verify-wiring.test.ts` (16) and
`test/core/strength/generate-verify.test.ts` (23). Every other file under `test/core/strength` and
`test/core/policy` passes unchanged. The split of `drawMaiaMove` is draw-for-draw identical. The
H13 term fires on two of the 60 Maia-fixture positions (#22 and #49, at every target — behind
with a tie band), so their seeded picks in `maia-fixture.test.ts` and `consistency.test.ts`
moved; both suites assert statistics (monotone mean loss, `railedMass` ceilings, ranges) and
stayed green without any threshold change.

## Open

* The hang rail's ramp shape and `cheapViewElo` are guesses (the research note says so); the human
  move-match harness (§8.1) is the instrument, and `railedMass` per band is the number to watch.
* H15's strength cost at the top of the range is a result claim: paired-colour matches, as
  `strength-selection-2026-09-11.md` describes.
* Tilt and the blunder damper (`blunder.damperMultiplier`, the opposite sign, inert in Maia mode)
  are still two separate mechanisms rather than the rating-dependent mixture H12 suggests.
