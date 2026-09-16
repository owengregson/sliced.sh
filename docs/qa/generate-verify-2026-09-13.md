# Generate-and-verify move selection — 2026-09-13

H3 + H4 of [`docs/research/human-move-selection-ideas-2026-09-13.md`](../research/human-move-selection-ideas-2026-09-13.md)
(§2, §3, H3, H4, §8.2, §8.3), roadmap step 5. This records the model as built in
`src/core/strength/generate-verify.ts`, every knob in `src/core/constants/generate-verify.ts`
and what it rests on, the fidelity budget, and the wiring from the Maia branch of `selectMove`.
**Wired 2026-09-13** (the "Wiring" section below records what was done and the verification
noise floor that was added at the same time — the top-band strength rise the first measurement
flagged is bounded by it).

Nothing about *when* or *how* a move is played changes (C7). The Maia models are run as
advertised — candidates are drawn from Maia's own distribution with no re-weighting and `T = 1`;
what changes is what happens *after* the draw, which the research doc's §2 identifies as the
missing stage ("generate a small candidate set … then verify").

## The model

The plain draw (`drawMaiaMove`) samples one move from Maia's distribution over the survivors of
the rails. A human (HvS §2.3, §5.2, §5.3, §10.1 steps 3–7) recognises a few candidates, checks
them at the depth their rating can manage, and plays the one that looks best. Three stages:

1. **Generate.** Draw `k(E)` *distinct* candidates without replacement from Maia's distribution
   over the survivors (`rng.weighted` on the raw `p`, the drawn item removed each time). With
   probability `pIntuition(E)` the move is played on recognition alone: `k = 1`, no
   verification, no noise — the pick's distribution is then exactly Maia's over the survivors
   (tested with a χ² at 4000 draws).
2. **Verify.** Score each candidate at the *human* depth: `shallowCp`, looked up from the same
   search's complete MultiPV frame at `humanDepth(E)` (`SelectionContext.shallowLines`,
   `shallowDepth`; H4's frame). A candidate the shallow frame did not rank falls back to its deep
   referee score (`deepCp`) and is marked `verified: false` in the table and the rationale.
3. **Compare.** Play the argmax of `cp + N(0, σ_verify(E))` with
   `σ_verify = max(sigmaFor(E), verifySigmaFloorCp(E))` (`verifySigmaFor`). `sigmaFor` is the §7.2
   step 3 perception noise (8 cp at 2400, 50 cp at 800) and was calibrated as the misperception of
   a *deep* referee score; a score a human forms at the end of a short line carries the shallow
   frame's own error on top of that (HvS §5.4), which is what the floor stands for. Without it the
   first measurement (below, "before") found the top band an argmax of the shallow score.

What this produces without a hand-written rule is the report's error taxonomy: *candidate
omission* (the best move was never among the k — Maia's own rate per rating), *truncation* (the
pick looks best at the human depth and loses to what the deep referee sees — the test "the pick
follows the SHALLOW score when it reverses the deep order"), and *evaluation error* (σ on the
shallow scores). The rails, the mate guard, repetition and conversion filters all run before
this on the deep lines, exactly as today.

`null` is returned — and the caller runs the plain draw — when the path is disabled
(`GENERATE_VERIFY.enabled`, overridable per call with `GvInput.enabled`) or when fewer than two
survivors carry Maia mass.

### Rng draw order

For one call: the intuition coin (`rng.chance`), then, unless intuition, the `k` jitter
(`rng.int(-1, 1)`), the `k` weighted draws, and one `rng.normal` per candidate. The order is
fixed so seeded replays stay reproducible; wiring the module changes the number of draws the
Maia branch consumes, so any existing test that asserts a *specific* seeded pick from the Maia
branch will shift (the maia-select suite asserts distributions and equalities between two calls
on the same seed, which survive).

## The tables

All in `GENERATE_VERIFY` (`src/core/constants/generate-verify.ts`).

| Knob | Value | Rests on |
|---|---|---|
| `enabled` | `true` | The research doc says ship behind a flag; the flag is this constant plus `GvInput.enabled`. |
| `candidates.knots` | `[800, 2] [1400, 3] [2000, 4] [2500, 5]` (flat outside, linear between, rounded) — **2 through 2800 since 2026-09-15** | de Groot's masters generated few, relevant candidates; Connors, Burns & Campitelli (2011): breadth grows with skill only modestly. Recalibrated against chess.com humans (see "Recalibration" below). |
| `candidates.jitter` | `±1`, uniform, per move | "with a per-move jitter" (H3). |
| `candidates.min` / `max` | 2 / 6 | `k = 1` is reserved for the intuition path so the flag means one thing; the pool binds before 6 in practice. |
| `intuition` | 0.55 at 800 → 0.10 at 2500, linear (`eloRamp`), flat outside — **0.70 → 0.60 since 2026-09-15** | HvS §2.3: "the move played on recognition alone"; high at club level, never zero at master level. Recalibrated (see "Recalibration"). |
| `verifySigmaFloorCp` | `[800, 60] [1400, 45] [2000, 30] [2500, 20]` (flat outside, linear between) — **90 / 80 / 80 / 80 (80 at 2800) since 2026-09-15** | The floor on the compare stage's noise (added at wiring time): the shallow frame's own error is part of the human's misevaluation (HvS §5.4); `sigmaFor` alone made the top band an argmax. Originally chosen so the typical pool stayed inside the budget and the 2300–2500 strength rise was ≤ ~25 %; on real positions that still meant −43 % loss at 2300 (see "Recalibration"). |
| `meterSamples` | 400 | Monte Carlo samples for the per-move `klFromMaia` meter (≈ 1.4 µs a call). |

Realised values (`σ_verify` is what the compare stage uses; `σ` is `sigmaFor` alone):

| E | `candidateBase` | `pIntuition` | `σ(E)` cp | `σ_verify(E)` cp |
|---:|---:|---:|---:|---:|
| 900 | 2 | 0.52 | 47.4 | 57.5 |
| 1100 | 3 | 0.47 | 42.1 | 52.5 |
| 1300 | 3 | 0.42 | 36.9 | 47.5 |
| 1500 | 3 | 0.36 | 31.6 | 42.5 |
| 1700 | 4 | 0.31 | 26.4 | 37.5 |
| 1900 | 4 | 0.26 | 21.1 | 32.5 |
| 2100 | 4 | 0.21 | 15.9 | 28.0 |
| 2300 | 5 | 0.15 | 10.6 | 24.0 |
| 2500 | 5 | 0.10 | 8.0 | 20.0 |

The `candidates` knots were left alone: with the floor the typical pool meets the budget and the
strength bound without lowering `k` at the top. (Superseded — see below.)

## Recalibration against chess.com humans (2026-09-15)

**Why.** The owner reported the extension outplaying a chess.com "2500" bot at persona offset
−200 (target 2300). `.scratch/bot-strength/pipeline-strength.ts` measured the real
`RecommendationPipeline` (EngineController + SF18 smallnet under Bun, fresh Maia-3 79M queries,
V1 timing head, book off) on 180 positions from public chess.com blitz games — 60 per bucket, one
per game, the mover rated within ±100 of 1800 / 2300 / 2800, ply ≥ 16, clock ≥ 30 s — with 12
seeded draws per position. Every pick, the human's move and Maia's top moves were scored in one
SF18 full-network frame (depth 18 best move, depth 16 MultiPV over the union); loss = best − move,
cp clamped ±1000; 95 % intervals are bootstrap over positions, paired on the same positions.

**Before (the values above, live run).** Pipeline − human mean loss −28.0 [−64.0, +3.7] /
−20.6 [−36.9, −5.8] / −35.0 [−64.4, −13.1] cp at targets 1800 / 2300 / 2800; ≥ 100 cp errors
16 / 6.4 / 2.9 % against 25 / 18 / 13 % for the humans. Switching generate-and-verify off (the plain
Maia draw over the same rails) removed the gap: +1.0 [−12.5, +12.4] cp at 2300. The wrapper cut mean
loss by 43 % at 2300 on real positions (28.4 vs 49.9 cp) — the ≤ 25 % bound above held only on the
synthetic pool. Raw Maia at the queried rating matched the humans' error tail closely (≥ 100 cp
share 26.0 / 19.2 / 13.5 % vs 25.0 / 18.3 / 13.3 %), and turning the hang rail and loss cap off
changed the plain draw by only +1.1 cp at 2300 and +5.3 cp at 2800, so the rails were not the
cause and were left alone.

**Tuning.** Engine results and Maia answers were recorded once and replayed (`PS_STORE`) so only
selection changed between variants. Raising `intuition` alone (0.80 → 0.70) left 2800 at
−20.3 [−46.9, −0.7]; more noise with fewer candidates alone left 2300 / 2800 at
−13.0 / −26.7 cp. The chosen set — `intuition` 0.70 → 0.60, `candidates` 2 through 2800,
`verifySigmaFloorCp` 90 at 800 and 80 from 1400 to 2800 — replayed at −19.0 [−55.2, +13.2] /
−0.6 [−13.7, +11.1] / −16.9 [−43.5, +2.6] cp, ≥ 100 cp share gaps −4.9 / −2.8 / −3.5 pp (all
intervals include 0), verified-vs-plain-draw −2.9 / −0.6 / +0.3 cp, and the untimed-vs-2500
configuration −2.0 [−7.9, +4.9] cp against the game clock. The live re-measurement with the values in
source is recorded at the end of this section. The 3000 knots (k 7, σ 12, intuition 0.03) are
unchanged, so nothing at 3000+ became stronger; the 2800 → 3000 ramp is now steeper and has no
human sample of that rating behind it.

Realised values after the recalibration:

| E | `candidateBase` | `pIntuition` | `σ(E)` cp | `σ_verify(E)` cp |
|---:|---:|---:|---:|---:|
| 900 | 2 | 0.69 | 47.4 | 88.3 |
| 1500 | 2 | 0.66 | 31.6 | 80.0 |
| 2100 | 2 | 0.62 | 15.9 | 80.0 |
| 2300 | 2 | 0.61 | 10.6 | 80.0 |
| 2500 | 2 | 0.60 | 8.0 | 80.0 |
| 2800 | 2 | 0.60 | 8.0 | 80.0 |
| 2900 | 5 | 0.32 | 8.0 | 46.0 |
| 3000 | 7 | 0.03 | 8.0 | 12.0 |

On the typical pool below the wrapper is now within Monte Carlo noise of Maia alone at every
rating through 2500 (20 000 samples: KL 0.001–0.004, mean deep loss 33.7–34.5 against 34.55); the
KL ceilings and the ≤ 30 % bound in the test still hold with wide margins. The QA tables below
are the 2026-09-13 measurement of the former values.

**Live re-measurement (values in source, fresh searches, same 180 positions and seeds).**

| Target | Pipeline − human, all | competitive | ≥ 100 cp share, pipeline vs human | ≥ 300 cp |
|---:|---|---|---|---|
| 1800 before | −28.0 [−65.3, +2.9] | −0.7 [−28.6, +29.1] | 16.0 vs 25.0 % (−9.0 [−18.9, +0.1]) | 3.3 vs 6.7 % |
| 1800 after | −18.7 [−51.8, +11.3] | +4.2 [−22.5, +34.4] | 21.1 vs 25.0 % (−3.9 [−13.8, +5.7]) | 3.9 vs 6.7 % |
| 2300 before | −20.6 [−36.5, −5.5] | −14.4 [−29.5, −1.4] | 6.4 vs 18.3 % (−11.9 [−21.5, −3.3]) | 1.0 vs 1.7 % |
| 2300 after | −1.6 [−14.6, +10.0] | +6.7 [−3.5, +16.8] | 15.3 vs 18.3 % (−3.1 [−11.5, +4.9]) | 1.7 vs 1.7 % |
| 2800 before | −35.0 [−62.8, −13.3] | −30.9 [−62.6, −9.2] | 2.9 vs 13.3 % (−10.4 [−19.6, −2.1]) | 0.1 vs 3.3 % |
| 2800 after | −19.6 [−45.7, −0.9] | −15.9 [−47.0, +4.5] | 9.3 vs 13.3 % (−4.0 [−12.5, +3.2]) | 0.1 vs 3.3 % |

Untimed-vs-2500 at target 2300: −24.6 → −3.1 [−15.9, +8.8] cp against the humans; untimed − game
−4.0 [−9.1, +0.5] → −1.5 [−5.9, +3.3]. The residual at 2800 (all positions, the interval misses 0
by under 1 cp) is the plain Maia draw's own gap, −17.2 [−45.6, +4.8] on the replayed searches: the
wrapper is neutral there, and what remains is the rails removing the human ≥ 300 cp tail
(0.1 vs 3.3 %) — turning the hang rail and the loss cap both off added +5.3 cp to the plain draw at
2800, either alone nothing. A moderate loosening of both (hang rail certain only from 3200, loss
cap 0.45 from 2000) replayed at −2.4 [−7.6, +2.3] cp against the chosen values at 2800 — no
measurable gain. Closing that residual means letting a 2800 hang pieces as often as the humans
did, which is a product decision rather than a verification knob, so the rails were left unchanged.

`shallowDepth` is the pipeline's (H4: `humanDepth(E)` ≈ 2 at 800, 4 at 1200, 6 at 1600, 8 at
2000, 10 at 2400); the module only reports it as `verifyDepth` (0 when no frame existed).

## Measured behaviour and the fidelity budget

`drawDistribution` gives the empirical `q(m)`; `gvKl(q, p)` is `KL(q ‖ Maia)` in nats over the
survivors (Maia renormalised over the same set — 0 when the wrapper changed nothing, `Infinity`
if a move without Maia mass were ever drawn, which the draw cannot do). 20 000 samples per cell
on three synthetic pools (scratch harness; the typical pool is checked in as the budget fixture
in `test/core/strength/generate-verify.test.ts`), each at the rating-correct `humanDepth(E)`.

**Typical** — 6 survivors, Maia `p` = .42/.25/.14/.09/.06/.04, deep cp = 30/55/−40/20/5/−60,
shallow cp = 35/45/30/−10/0/−50 (one move refuted only at depth, one underrated at the human
depth). *Before* is `σ = sigmaFor(E)` (the module as first built); *after* is with
`verifySigmaFloorCp` (as wired):

| E | KL before | KL after | top-1 = Maia's favourite (after) | top-1 = referee's best (after) | mean deep loss before | after | drop vs Maia alone (34.5) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 900 | 0.009 | 0.007 | 0.40 | 0.29 | 32.9 | 33.3 | 4 % |
| 1100 | 0.019 | 0.014 | 0.38 | 0.30 | 32.5 | 33.2 | 4 % |
| 1300 | 0.026 | 0.018 | 0.39 | 0.31 | 31.7 | 32.6 | 6 % |
| 1500 | 0.045 | 0.030 | 0.38 | 0.33 | 30.5 | 31.7 | 8 % |
| 1700 | 0.077 | 0.050 | 0.35 | 0.35 | 30.2 | 32.2 | 7 % |
| 1900 | 0.117 | 0.072 | 0.35 | 0.37 | 27.9 | 30.9 | 10 % |
| 2100 | 0.169 | 0.096 | 0.34 | 0.40 | 25.2 | 29.8 | 14 % |
| 2300 | 0.312 | 0.151 | 0.31 | 0.44 | 19.3 | 29.3 | 15 % |
| 2500 | 0.479 | 0.215 | 0.30 | 0.48 | 13.5 | 26.5 | 23 % |

Before the floor the 2300 / 2500 cells dropped mean deep loss by 44 % / 61 % against Maia alone
(the "mild argmax" strength rise H3 itself predicts, with the depth-10 frame at 2400 close enough
to the referee that "verification" was nearly the engine's opinion). With it the drop is 15 % /
23 % — inside the ~25 % the integration brief allowed — and the per-band KL is at most half the
budget below.

**Peaked** (4 survivors, `p` = .80/.10/.06/.04): KL before 0.07 / 0.19 / 0.40 / 0.79 / 1.07 at
900 / 1500 / 1900 / 2300 / 2500, after 0.07 / 0.18 / 0.35 / 0.54 / 0.64; mean deep loss after is
*above* Maia alone (27.1) at every rating but 2500 (26.0) — a distinct draw from a peaked
distribution mostly costs the favourite's mass. **Flat** (4 near-equal `p`): KL before 0.01 /
0.06 / 0.14 / 0.36 / 0.53, after 0.01 / 0.04 / 0.09 / 0.18 / 0.25; loss drop after 2 % → 28 %.

Two things to read off this:

* **Below ~1700 the wrapper barely moves from Maia** (KL < 0.1 on every pool): k is 2–3, half
  the moves are intuition, and σ_verify of 37–58 cp swamps most shallow-score gaps. This is the
  band the research doc most wanted to fix, and here the change is mostly *which* error is made,
  not how many.
* **At 2300+ the floor is what keeps the path a comparison rather than an argmax.** `k = 5`
  still covers a 4–6 move pool almost entirely and intuition is 10–15 %, but σ_verify of 20–24 cp
  leaves 10–15 cp shallow gaps undecided. The other knobs (lower `candidates.knots` at the top,
  raise `intuition.hiProb`, a shallower `humanDepth` for the top band) are all in the registry and
  untouched. **Decide with the human-move harness (§8.1), not by feel** — H3's acceptance test
  is that move-match likelihood improves at 1100 / 1500 / 1900 / 2300, and the 2300 cell is
  the one to watch.

**The budget, asserted** (`test/core/strength/generate-verify.test.ts` "the fidelity budget on
the typical pool", §8.3 "klFromMaia below a stated budget for each configuration"): the typical
pool with a fixed seed and 4000 draws per cell — measured × ~1.5 at the time of the first
measurement, rounded, kept as it was so a silent re-tune of a knot trips it:

| Band (E) | `klFromMaia` ceiling (nats) | measured after |
|---:|---:|---:|
| ≤ 1100 | 0.03 | 0.007–0.014 |
| 1300–1500 | 0.06 | 0.018–0.030 |
| 1700–1900 | 0.17 | 0.050–0.072 |
| 2100 | 0.25 | 0.096 |
| 2300 | 0.45 | 0.151 |
| 2500 | 0.65 | 0.215 |

The same suite asserts monotonicity (§8.3: mean raw deep loss non-increasing in E, 1 cp
tolerance, and below Maia alone from 1500), that the 2300 and 2500 cells drop mean deep loss by
≤ 30 % (measured 15 % / 23 %; the ceiling leaves ~2σ of Monte Carlo room at 4000 draws), and
that the intuition-only draw's KL < 0.01.

## Wiring from the Maia branch (done 2026-09-13)

`drawMaiaMove` in `maia-select.ts` is now two exported halves plus the record they share:

* `maiaSurvivors(candidates, policy, E, rationale, { scoredMassBefore })` — Maia's `prob` map,
  the rails (`!mated && !hangs && lossRaw ≤ lossCapFor(E)`), the `p ≥ MAIA.minProb` check and the
  masses the meters report (`scoredMass`, `scoredMassBefore`, `unscoredMass`, `railedMass`,
  `extra`); `null` (with the row) when the base policy must decide.
* `drawMaiaFromSurvivors(set, policy, E, rng, rationale, { tieBreak, practical })` — the single
  weighted draw at `MAIA.temperature`, with the H11 tie-break and the H13 practical term applied
  inside the tie band (`tieBandOf`).
* `maiaDrawRecord(set, policy, E, uci, { klFromMaia, tieBand, practicalBand }, rationale)` — the
  pick's rank among the survivors, the `maia:` and `maia wdl:` rows and the `MaiaDraw` record, so
  a pick from either stage carries identical meters.

`drawMaiaMove` is `maiaSurvivors` + `drawMaiaFromSurvivors` (pinned equal, rows and record, in
`generate-verify-wiring.test.ts`). In the Maia branch of `selectMove`
(`src/core/strength/move-selector.ts`), after the survivors are known:

* **`GENERATE_VERIFY.enabled && ctx.shallowLines !== undefined`** (a complete frame at
  `ctx.shallowDepth`): the survivors become `GvCandidate[]` with `deepCp = cpRaw` and `shallowCp`
  looked up from the frame by `pvUci[0]` via `cpEffective` (spread conditionally — never
  `shallowCp: undefined` under `exactOptionalPropertyTypes`); `generateAndVerify({ survivors, E:
  maiaE, shallowDepth, rng })` runs on the game rng. On a result the module's rows are pushed,
  then `generate-verify: tie-band terms (technique prior, practical difficulty) skipped — the
  verification decides among the candidates` (the module leaves no tie, so neither H11 nor H13
  runs on this path), then `maiaDrawRecord` with `klFromMaia = gvKl(drawDistribution(input,
  meterSamples, createRng(\`gv-meter:${ctx.fen}\`)), prob)` — a separate seeded rng, so the
  Monte Carlo never advances the game's and every pick on a position reports the same number —
  and `tieBand = practicalBand = 0`. `finishPick(pick, "maia")`, `chosen.maiaProb = p`, and the
  meters carry `candidates = gv.k` (1 on the intuition path) and `verifyDepth`. `null` (fewer
  than two survivors with mass) falls through to the plain draw.
* **No `shallowLines`** (the engine never completed the human-depth frame, or a non-Maia search):
  the row `generate-verify: no human-depth frame for this search, plain draw` and today's
  weighted draw; `candidates` / `verifyDepth` stay absent from the meters. A `shallowDepth`
  without a frame is not a frame. Generate-and-verify is deliberately *not* run against the deep
  scores alone — that would be an argmax on the referee, the opposite of the idea.

The rails, the mate guard, repetition and conversion filters all run before this on the deep
lines, exactly as before; the `b` logging row is unchanged. The shallow frame reaches nothing
but the compare stage (H4's risk note: never `rec.eval` or the panel).

Rng consumption on the Maia branch changed only where a frame is present: the intuition coin, the
`k` jitter, the `k` weighted draws and one normal per candidate replace the single weighted
draw. No checked-in test hands the selector a frame except the wiring suite, so this path left
the Maia fixture replay (`maia-fixture.test.ts`) and `consistency.test.ts` untouched; the H13
term (recorded in `selector-rails-2026-09-13.md`) moved the seeded picks on two fixture
positions, and both suites' statistical assertions stayed green — 6 and 7 tests, no threshold
changed.

## What the tests cover

`test/core/strength/generate-verify.test.ts`, 23 tests, seeded: the knots and monotonicity of
`candidateBase`, `candidateCount` (± jitter, ≥ min, monotone mean), `intuitionProb` and
`verifySigmaFor` (the floor binds everywhere in range, flat outside the knots); distinct
candidates with `k` per the table; the k = 1 draw equals Maia's (Pearson χ², 3 d.f., 4000 draws,
critical 16.27); the intuition coin's frequency; the pick follows the shallow score when it
reverses the deep order; a missing shallow score falls back to deep and is marked unverified
(table and rationale); no-frame → `verifyDepth` 0; the argmax bias (5 equal-`p` candidates,
best +300 cp: since the 2026-09-15 recalibration 0.22–0.40 at 2300 and at 900 and > 0.60 at
2900 in the upper band — formerly > 80 % at 2300 — KL ordered 900 < 2300 < 2900); rationale shape
for both paths (σ = 80 at 2000, the floored value); `null` on disabled / < 2 survivors / no mass;
a massless survivor is never drawn; `drawDistribution` sums to 1 and falls back to Maia's
renormalised mass when the path is off; `gvKl` identities; and the fidelity budget above on the
typical pool (KL per band, monotone loss, the ≤ 30 % top-band drop, intuition-only KL < 0.01).

`test/core/strength/generate-verify-wiring.test.ts`, 16 tests, end to end through `selectMove`:
with a frame the meters carry `candidates` / `verifyDepth`, the rationale the stages and the
skip row, `maiaProb` and `rank` are Maia's, and `klFromMaia` equals `gvKl(drawDistribution(…))`
recomputed in the test on the fen-seeded rng; the verification lifts the shallow favourite (a
0.05-mass move the frame rates +300 cp is drawn ≈ 11 % at ≈ 2200, ≈ 9 % at ≈ 900 and ≈ 25 % at
≈ 2850 since the 2026-09-15 recalibration — formerly ≈ 62 % at ≈ 2200 — and < 9 % on the plain draw);
without a frame the plain draw runs with Maia's frequencies (±0.035 over 2000 draws) and no
`candidates`; a `shallowDepth` alone is not a frame; an unranked survivor is verified against
its deep score and marked; a railed line is never a candidate; determinism per seed; the split
halves reproduce `drawMaiaMove`; and the H13 cases recorded in
`docs/qa/selector-rails-2026-09-13.md`.

## Open items

1. Done in part on 2026-09-15 (see "Recalibration"): the paired chess.com-human measurement showed
   the top band over-correcting and all three knots were lowered together. Still open: a
   move-match likelihood run (§8.1) at 1100 / 1500 / 1900, and any human sample at 2900–3000,
   where the unchanged 3000 knots now sit at the top of a steeper ramp.
2. The recalibration used `intuition`, `candidates` and `verifySigmaFloorCp` together; no single
   knot reached the goal on its own (intuition alone left 2800 at −20.3 [−46.9, −0.7] cp).
3. `ctx.shallowLines` is the pipeline's `atFeatureDepth` frame at `humanDepth(maiaE)`; the
   selector trusts `shallowDepth` as reported and only echoes it as `verifyDepth`.
