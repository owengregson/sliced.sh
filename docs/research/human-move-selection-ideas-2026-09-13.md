# More accurate human move selection — ideas, 2026-09-13

A design brainstorm on top of the Stockfish 18 + Maia-3 selector that shipped on 2026-09-11/12.
**Scope: which move a human of the target rating would play. Timing is out of scope** (the owner's
line) — every idea here reads the timing model's numbers but changes none of them.

The primary source for the *behaviour* half is the owner's report **"Humans vs. Stockfish —
Attention, Search, Evaluation, and the Anatomy of Mistakes"** (cited below as **HvS §n**; the
markdown extraction is `humans_vs_stockfish_deep_report.docx` in the repository root). The
*implementation* half is the code as it stands today plus
[`docs/qa/maia-selection-2026-09-11.md`](../qa/maia-selection-2026-09-11.md),
[`maia-batch-2026-09-11.md`](../qa/maia-batch-2026-09-11.md),
[`strength-selection-2026-09-11.md`](../qa/strength-selection-2026-09-11.md),
[`high-elo-selection-2026-09-11.md`](../qa/high-elo-selection-2026-09-11.md),
[`opponent-rush-strength-2026-09-11.md`](../qa/opponent-rush-strength-2026-09-11.md),
[`maia3-feasibility-2026-09-11.md`](maia3-feasibility-2026-09-11.md), `docs/models.md` §8 and the
plan's Appendix E (move selection) / §7.2 (normative selection policy).

**The owner's standing constraint is assumed throughout: the Maia models are run as advertised.**
Nothing below re-weights, fine-tunes, distils or sweeps the models against an accuracy target. What
the ideas *do* change is (i) which rating we ask the model about, (ii) which moves the engine scores
so the model can choose among them, (iii) which of the model's choices our own rails veto, and
(iv) what happens on the moves Maia never sees (premoves, holds, book, ≥ 2600). Where an idea does
touch the model's output distribution, it says so and carries its own fidelity meter (§8).

---

## 1. What exists today, in one screen

| Stage | Where | What it does |
|---|---|---|
| Mode decision | `maiaSearchMode` — `src/service/game-session/recommendation.ts:166` | Maia selects iff target < 2600, a policy port exists, and the position is not a clock race. |
| Referee search | `searchBudget` — `recommendation.ts:284`, `refereeElo` — `:175` | Full strength (no `UCI_Elo`), MultiPV 20/16/12 by target band (`SEARCH_BUDGET.selectionCandidates`), `movetimeMs` = min(class base 400–1500, 0.6·planned think, 5 % of clock), depth cap `automaticDepthForElo`. |
| Policy query | `RecommendationPipeline.queryPolicy` — `recommendation.ts:680` | `{ size: maiaSizeFor(target), fen, historyFens: maiaHistoryFens(...), selfElo: effectiveElo(target, form), oppoElo: opponentElo ?? selfElo }`, budget 1500 ms, issued in parallel with the search. |
| Extra referee pass | `maiaUnscoredMoves` `:204`, `maiaExtraSearchmoves` `:225`, `extraSearchMs` `:237`, `mergeLines` `:259` | When Maia's unscored legal moves carry ≥ 6 % of the mass, one more `go searchmoves` over its top 6 unscored moves for 260 ms, merged into the pool. |
| Filters before the draw | `avoidRepetition`, `conversionPool` — `src/core/strength/move-selector.ts:246–258` | Repetition avoidance and won-position conversion narrow `usable` before anything else. |
| Mate guard | `move-selector.ts:299–311` | Any immediate mate, else the shortest searched forced mate, returned unconditionally at every rating. |
| Maia draw | `move-selector.ts:354–386` → `drawMaiaMove` — `src/core/strength/maia-select.ts:83` | Rails (`mated`, `hangsPiece`, `lossRaw > lossCap(E)`), then `w = p^(1/T)` over survivors with `p ≥ 0.005`, `T = 1·(0.5 + 0.5·blunderScale)`. |
| Everything else | `move-selector.ts:388–546` | ≥ 2600 / no policy / clock race / Maia fallback: σ-jitter, blunder channel, `G(E)` gap, `exp(−loss/τ)·prior^β` over the heuristic prior. |

Facts worth keeping in view while reading §4:

* **The models' own numbers** (feasibility §2.2, §3.5): move-match 55.4 / 56.6 / 57.1 % for 5M / 23M / 79M — the larger models are better **everywhere**, not "better at high ratings"; latency 20 / 51 / 184 ms p50 single-threaded wasm; history ablation costs 1.4 pp on 5M.
* **The search window** is 400 ms (bullet) to 1500 ms (rapid/classical), so a 5M or 23M query is entirely hidden and a 79M query uses a third to a half of a bullet window.
* **`AnalysisResult.atFeatureDepth`** (`src/core/engine/types.ts:68`, captured in `src/core/engine/uci-client.ts:291` at `LIMITS.featureDepth = 10`) already gives a **complete MultiPV frame at a fixed shallow depth from the same search, for free**. Several ideas below are cheap only because this exists.
* `SelectionState` (`src/core/strength/types.ts:15`) already carries per-game state across moves (`top1Streak`, `blunderDamperLeft`, `previousOwnMoves`), and `form` is already a per-game AR(1) latent that enters Maia through `selfElo`.

---

## 2. The gap, stated in the report's own terms

HvS §10.1 breaks the human move into seven stages. Mapping them onto the selector shows where the
modelling actually lives and where there is nothing:

| Human stage (HvS §10.1) | Modelled today by | Gap |
|---|---|---|
| 1. Perceive / orient attention | Maia's policy (learned salience) | Nothing outside Maia — and Maia is off for premoves, holds, book moves and ≥ 2600. |
| 2. Recognise chunks / motifs | Maia | Same. |
| 3. Generate a small candidate set | **Nothing.** Maia gives a distribution over *all* legal moves; we sample from it directly | The report's central claim (HvS §5.2, §15) is that *the best move often never becomes a candidate*. A one-shot draw from a smooth distribution is a different object from "generate 2–5 candidates, then verify them". |
| 4. Allocate time by criticality | Timing model (out of scope) — but its output never reaches selection | Selection is blind to how long "the human" is about to think (HvS §2.8, §5.7). |
| 5. Calculate lines, maintain board state | **Nothing.** Our rails run on a full-strength deep search | The bot's notion of "this hangs a piece" is the engine's, not the rating's (HvS §5.3 truncation, §8 "hanging piece"). |
| 6. Evaluate the resulting position | Engine NNUE, via `lossRaw` / `lossCap` | No rating-dependent misevaluation (HvS §5.4). |
| 7. Compare, decide; practical/opponent factors | Maia's `oppoElo` input only | No "difficulty for the opponent" objective (HvS §2.9, §11.3), no tilt, no plan persistence (HvS §5.6, §8). |

The single biggest structural observation: **the current design is Maia-generates / engine-vetoes.**
The report says the human pipeline is closer to **recognition-generates / calculation-verifies**
(HvS §1, §2.3, §15: "Recognition supplies a compressed representation … Search then verifies").
Our rails are a *veto*, which is the right shape for safety and the wrong shape for realism: a veto
can only remove bad moves, and at 800–1400 the moves it removes are exactly the ones the rating
plays. Several of the highest-value ideas below are the same structural change from veto to verify.

---

## 3. Two framing decisions that most of the ideas depend on

### 3.1 Prefer conditioning on Elo over re-shaping the distribution

Maia-3 takes the rating as a **continuous** input (`e = (elo/5000)·e_low + (1 − elo/5000)·e_high`,
feasibility §2.3), so "play like a 1350 on this move" is a *query*, not a calibration. Temperature
is not: `temperedWeights` (`src/core/policy/maia-policy.ts:68`) computes `p^(1/T)` and therefore
heats the *whole* distribution uniformly, including the tail of moves the population essentially
never plays. Concretely at the slider's top (`blunderScale = 2` → `T = 1.5`, `maia-select.ts:69`):

```
p = 0.50 → w ∝ 0.63      p = 0.002 → w ∝ 0.0159
relative odds top : tail  250 : 1  before,  40 : 1  after — a 6.3× boost of the never-played tail
```

That is engine-style noise, not human error: HvS §8.3 ("error size is not the same as error type")
and §9 (attenuating a good model along one axis does not produce a weaker human) are exactly this
failure. Asking the model for a lower rating instead moves *which* moves gain mass, in the direction
the population actually moves. **Rule of thumb for every idea below: shape by Elo, not by T.**

### 3.2 Fidelity meters, so a wrapper change is never invisible

Two numbers, computable per move with no extra work, should exist before any of §4 lands
(see §8 for the harness):

* **Rail-removed mass** — Σ p over candidates the rails excluded in `drawMaiaMove`
  (`maia-select.ts:105`), and the mass Maia put on moves the engine never scored
  (`scoredMass` is already computed at `:96`, and `maiaUnscoredMoves` already lists the rest).
* **KL(final draw ‖ Maia)** — the tempered, railed, renormalised weights against `policy.moves`.
  At `T = 1` with no rail firing this is 0 by construction; it is the exact amount by which our
  wrapper, not Maia, is choosing the move.

Both belong on the Engine view's Human-model block next to `rec.maia.p`, and both are the accept/
reject signal for every change here. Neither requires calibrating anything.

---

## 4. The ideas

Each carries: the human mechanism and its source; the plug-in point; the data already on hand;
expected effect; cost; risk; and validation that does not calibrate Maia. The letter in brackets is
the owner's brief item.

---

### H1 — Rating-ramp the `hangsPiece` rail, and use a one-ply view below ~1600  [f, d]

**Human mechanism.** HvS §5.1 (missed relation), §8 ("hanging piece … can result from visual/
tactical oversight"), §12 (beginner/early-club: "perception and candidate-generation failures
dominate; hanging pieces"). McIlroy-Young et al. (KDD 2020) report that Maia predicts human
*blunders* substantially better than baselines — i.e. hanging a piece at 900 is a *predictable,
learned* event, and the model already carries it.

**What is wrong today.** `move-selector.ts:369` applies `hangsPiece(line, lossRaw, fen)`
(`:130`) unconditionally in the Maia branch: any candidate whose PV shows the opponent capturing
next and whose raw win-fraction loss is ≥ `C.neverPlay.hangPieceLoss` (0.25) is removed. At
E = 800 the *other* rail, `lossCap`, is 0.55 — so the hang rail binds first and strictly, and the
knot the QA doc describes as "leaves room for the mistakes an 800 does make"
(`maia-selection-2026-09-11.md`, `lossCap` row) never gets to apply. The net effect is a 900-rated
bot that never drops a piece to a two-move tactic, which is the single most recognisable
non-human trait in the rating band the 5M model serves.

**Plug-in.** `move-selector.ts:358–378`: replace the flat `hangs` flag with

```
hangRail(E) :  off below hangOffElo (≈1100)
               probabilistic between hangOffElo and hangFullElo (≈2000): the rail fires with
               probability ramp(E), drawn once per move from ctx.rng
               on from hangFullElo
```
plus a **cheap-view swap**: below ≈1600 judge "hangs" with `hangsOutright(fen, uci)`
(`src/core/chess/safety.ts:16` — already written for exactly this purpose: "a human in time trouble
does not search either"), and only above it with the deep-PV `hangsPiece`. Constants go in
`MAIA.hangRail` (`src/core/constants/maia.ts`).

**Data on hand.** `hangsOutright` exists and is unit-tested; `E`, `rng` and `lossRaw` are all in
scope at the call site.

**Effect.** Large realism gain below 1600; a real strength *drop* of maybe 50–150 Elo in that band,
which is the point. Above 2000 nothing changes.

**Cost.** ~30 lines, zero latency (one `hangsOutright` call is a single chess.js move-gen).

**Risk.** Losing a piece per game where the rating says one every three; the ramp's shape is a
guess. Mitigated by the probabilistic form (one `rng.chance` per move, not per candidate) and by
keeping `lossCap` as the absolute backstop.

**Validation.** Offline harness (§8): the bot's **piece-hang rate per 40 moves** against the human
rate per rating bucket from the Lichess sample, plus the "rail-removed mass" meter — today it
should show the hang rail eating a visible share of Maia's mass at 800–1200, and after the change
it should not. No Maia calibration: the target statistic comes from human games.

---

### H2 — Make the "mistakes" slider an Elo offset, not a temperature  [a, f]

**Human mechanism.** §3.1 above; HvS §8.3, §9, §15 ("lower-rated human chess is not well described
as optimal chess plus more random noise").

**Plug-in.** `maiaTemperature(blunderScale)` (`maia-select.ts:69`) and the `selfElo` built in
`queryPolicy` (`recommendation.ts:685`). Keep `T = 1` always; map the slider to
`ΔE = MAIA.slider.eloSpan · (blunderScale − 1)` with `eloSpan ≈ 250`, applied to `selfElo` in the
query **and** to the `E` that feeds `lossCapFor`. Slider 0 → "plays like 250 Elo above the target",
slider 2 → "250 below". The panel copy (`src/panel/copy.ts`) changes from "mistakes" heat to
"accuracy offset".

**Data on hand.** Everything; `blunderScale` already reaches the pipeline.

**Effect.** The knob keeps its user-visible meaning (more/fewer mistakes) while the *kind* of
mistake stays the population's. Removes the 6.3× tail boost computed in §3.1.

**Cost.** Small (S). One caveat: `selfElo` is now a function of a setting the user can change
mid-game, which is already true of the target.

**Risk.** The slider's dynamic range shrinks — ±250 Elo is a smaller behavioural swing than
`T ∈ [0.5, 1.5]`. If the owner wants a wider range, widen `eloSpan` rather than reintroducing T.
Second risk: `blunderScale` also scales the injected blunder channel outside Maia mode
(`blunder-model.ts:57`); the two meanings must not drift — keep `blunderScale` as the storage unit
and derive both.

**Validation.** Monotonicity regression (the shape the `high-elo` probe used): fixed candidate
pools, 2000 seeded draws per slider position, assert mean `lossRaw` is monotone in the slider and
that the mass drawn from moves with `p < 0.01` does **not** rise with the slider (it does today).

---

### H3 — Generate-and-verify: k candidates from Maia, verified at a human depth  [d, e, f]

**The flagship idea, and the one that changes the pipeline's shape.**

**Human mechanism.** HvS §1 ("expertise changes the distribution of attention before it changes the
amount of calculation"), §2.3 (candidate funnel), §5.2 ("deeper calculation cannot repair a move
that was never searched"), §5.3 (truncation, branch omission), §10.1 steps 3–7, §15. Empirically:
de Groot's masters generated few, relevant candidates; Connors, Burns & Campitelli (2011) found
masters chose better moves and generated nodes faster with much smaller differences in breadth and
depth; Charness (1981) found depth grows with skill but does not explain elite performance.

**The model.** Replace the single draw from Maia with a two-stage process:

1. **Candidate generation** — draw `k(E)` distinct moves **without replacement** from Maia's
   distribution (as advertised: no re-weighting, just sampling). `k(E)` ≈ 2 at 800, 3 at 1400,
   4 at 2000, 5 at 2500, with a per-move jitter. With probability `pIntuition(E)` (high at low
   ratings, low at master level) `k = 1` — the move played on recognition alone, HvS §2.3.
2. **Verification** — score those `k` candidates **at the human's depth**, not the referee's:
   use the shallow complete frame the same search already produced
   (`AnalysisResult.atFeatureDepth`, depth 10) for strong targets, and a shallower frame for weak
   ones (see H4).
3. **Comparison** — pick the argmax of the shallow score plus the existing perception noise
   `σ(E)` (`elo-map.ts:22`, 8–50 cp), i.e. reuse §7.2 step 3 rather than inventing a new noise term.

What this produces, for free, is the report's taxonomy rather than a smooth softmax:

* *Candidate-omission* errors (HvS §5.2) — the best move was not among the `k`; the frequency is
  Maia's own, per rating.
* *Truncation* errors (HvS §5.3) — the chosen move looks best at the human's depth and loses to the
  refutation the deep referee sees; this is the only mechanism in the whole design that produces a
  **tactical oversight for the right reason**.
* *Evaluation* errors (HvS §5.4) — `σ(E)` on the shallow scores.
* Correct rating scaling: `k` and depth both grow with E, exactly the two axes the expertise
  literature separates.

**Plug-in.** A new `src/core/strength/generate-verify.ts` called from the Maia branch
(`move-selector.ts:354`) in place of, or wrapping, `drawMaiaMove`; it needs the shallow frame
threaded through `SelectionContext` (a new `ctx.shallowLines?: readonly EvalLine[]`) from
`RecommendationPipeline.choose` (`recommendation.ts:850`), which already has
`analysis.atFeatureDepth`.

**Data on hand.** Maia probabilities; `atFeatureDepth`; `sigmaFor`; `rng`; the deep lines for the
rails (unchanged).

**Effect.** The largest single realism gain available without new models, and the only idea that
gets *error type* right rather than error size. Expect measured strength to rise slightly versus a
plain Maia draw at a given rating (picking the best of k by shallow eval is a mild argmax), which
`σ(E)` and `pIntuition` exist to offset.

**Cost.** Medium–large (L). No extra engine time and no extra inference — `atFeatureDepth` is
already produced. The work is the module, the threading, and the tests.

**Risk.** The highest-risk item here, because it puts our own procedure between Maia and the board:
KL(final ‖ Maia) will be materially non-zero by construction. Two mitigations: (i) ship it behind
`MAIA.generateVerify.enabled` with the fidelity meters (§3.2) on the Engine view; (ii) validate on
human-move likelihood (§8), where the whole point is that a *good* cognitive wrapper should
**raise** agreement with humans, not lower it. If it lowers it, the idea is wrong and the meter says
so in one overnight run.

---

### H4 — A rating-dependent "human depth" frame from the same search  [d, k]

**Human mechanism.** HvS §1, §5.3, §12 (error mix shifts from one-move oversights to "complex branch
selection" with rating). Also HvS §7.1: Stockfish's own handicap picks at `depth = 1 + int(level)`,
which is the one place the engine's mechanism accidentally resembles a depth model — and §7.2/§9
explain why depth alone is not sufficient, which is why this idea is a *component* of H3, never the
whole model.

**Plug-in.** `LIMITS.featureDepth` is a constant 10 and `uci-client.ts:291` captures the frame only
when `captured.depth === FEATURE_DEPTH`. Generalise: add `featureDepth?: number` to
`AnalysisRequest` (`src/core/engine/types.ts:31`), default `LIMITS.featureDepth`, and have
`RecommendationPipeline.runSearch` (`recommendation.ts:799`) set it to `humanDepth(E)` —
e.g. 2 at 800, 4 at 1200, 6 at 1600, 8 at 2000, 10 at 2400 — in Maia mode. Cache identity must
include it (`src/core/engine/analysis-cache.ts`), or a cached result from a different feature depth
will answer.

**Data on hand.** The engine already streams every iteration; the capture is one comparison.

**Effect.** Makes H3's verification stage rating-correct, and gives every other rail an honest
"what the human sees" score. Also the cleanest answer to "which engine-found tactics does a human at
R miss": the ones whose shallow and deep scores disagree.

**Cost.** Small–medium (M): a request field, a cache-key field, and the capture condition
(`>=` with a "first complete frame at or past d" rule, since a low depth may complete before
MultiPV settles).

**Risk.** At very low `humanDepth` the frame may be incomplete or mate-blind; require
`complete === true` and fall back to the deep frame. Do not let the shallow frame reach `rec.eval`
or the panel.

---

### H5 — Position- and clock-conditioned `selfElo`  [a, b]

**Human mechanism.** HvS §2.8 (the clock as an attentional variable), §5.7 (time-management
errors), §12 (elite errors "concentrate in difficult, ambiguous, novel, or time-pressured
positions"); Cüvitoğlu (2026, *Sci. Rep.*) on **non-linear** error amplification under the
*combination* of low clock and positional ambiguity; the "intuition and deliberation" 2026 result
that elite players spend time unevenly rather than adopting one speed.

**The model.** A human's effective strength on *this* move is their rating minus a penalty for the
resources they are giving it:

```
selfElo_move = effectiveElo(target, form)
             − wClock   · clockPressure          // 0…1, from the clock and the base clock
             − wTime    · shortThink             // 0…1, from estimatedThinkMs vs the class base
             − wAmbig   · ambiguity              // 0…1, see below
             + wFamiliar· familiarity            // in book / a repeated structure: HvS §5.5
```
with a **multiplicative interaction** on the first three (Cüvitoğlu's finding is that the product,
not the sum, is what explodes), capped at ≈ −350 Elo so it stays inside Maia's calibrated range.

**Ambiguity** should be the model's own uncertainty, not a hand-rolled proxy: the **entropy of
Maia's legal-move distribution**, `H = −Σ p log p`, normalised by `log(#legal)`. It is free, it is
rating-conditioned (the same position is ambiguous for a 1200 and obvious for a 2400 — the model
says so), and it needs no calibration. Cross-check candidates already on hand: `populationStd` of
the raw scores (already computed at `move-selector.ts:360`), the count of lines within 50 cp, and
**Maia's WDL vs the engine's eval disagreement** (`policy.wdl` and `lines[0].score`) — a large
disagreement is "this position is harder than it looks for a human at this rating".

**Ordering problem, and its answer.** Selection happens *before* `timing.planMove`
(`recommendation.ts:647`), so the final planned think time is not available. But
`estimatedThinkMs` (`recommendation.ts:99`) — the plan-independent allocation that already sizes
the search budget — is computed first and is exactly the right quantity. **This reads the timing
model; it does not change it.**

**Plug-in.** `queryPolicy` (`recommendation.ts:680`) for `selfElo`, and the same value must reach
`lossCapFor` — which today it does not (see B2 in §7).

**Effect.** Errors cluster where the report says they cluster, without a single hand-written
heuristic about *which* move goes wrong. This is the cheapest way to get "context-sensitive rather
than IID noise" (HvS §9.1).

**Cost.** Small (S) if entropy is the only ambiguity input; the query already carries a rating.

**Risk.** Double-counting: Maia conditions on the position already, so a position-driven Elo
penalty is a second application of position information. Keep the weights small (≤ 150 Elo each
before the cap) and prove the effect with the harness rather than by feel.

**Validation.** Split the offline human sample by clock-remaining quartile and by ambiguity
quartile; the bot's per-bucket ACPL and blunder rate should track the humans' per-bucket numbers.
That is a *conditional* calibration of our wrapper against human data, with the model untouched.

---

### H6 — Size by latency, not by Elo; commit per game  [b]

**What is wrong today.** `maiaSizeFor` (`src/core/policy/maia-size.ts:16`) hard-switches
5M → 23M → 79M at 1400 and 2000 (`MAIA.sizeBands`). The paper's accuracies are **aggregate and
uniformly ordered** (55.4 / 56.6 / 57.1) — the bigger models are better at *every* rating, not
better at high ratings. So the bands encode a compute decision as if it were a fidelity decision,
and they buy a **style discontinuity**: a target of 1399 and 1401 are different players, and an
opponent-matched target that drifts across an edge changes player mid-game (plus one fallback move
while the new session loads).

**Ideas, in order of preference.**

1. **Pick the largest size the move window affords.** The offscreen host already reports `ms`
   (`PolicyResult.ms`), so the session can keep a running p95 per size and choose the largest whose
   p95 fits `min(budget.movetimeMs, MAIA.inferenceBudgetMs) · safety`. Bullet → 5M, blitz → 23M,
   rapid/classical → 79M, adapted to the actual device. Elo stops selecting the model entirely.
2. **If the bands must stay:** blend across an edge. Within ±150 Elo of a band edge, run both sizes
   and draw from `(1 − λ)·p_small + λ·p_big`. Cost is both inferences (≈ 70 ms at the 1400 edge,
   ≈ 235 ms at 2000) — affordable at blitz and up, not at bullet.
3. **Commit per game either way.** HvS §8.1 and McIlroy-Young et al. (KDD 2022, individual models
   and behavioural stylometry) say human behaviour has persistent *individual* structure. Choosing
   the size once at game start and never switching (`warmPolicyFor`, `session.ts:616`, already
   dedupes on size) is closer to "one player played this game" than a mid-game switch is.

**Effect.** Removes a discontinuity that has no justification, and gets the better model into the
sub-1400 band where the population's errors are hardest to fake. Also closes open QA item 5 (the
mid-game cold switch) by making it rare.

**Cost.** Option 1 small (S) plus the measurement; option 2 medium.

**Risk.** 79M resident memory (≈ 0.9 GB in the Bun measurement) next to Stockfish — this is
feasibility blocker #4 and open QA item 1, and it gates option 1 more than latency does.

**Validation.** The existing latency/memory QA item, plus a same-position, same-seed comparison of
the three sizes' top-5 on a fixture set to document the style difference the bands currently create.

---

### H7 — Feed the real history everywhere, and prove it  [c]

**Answer to the question as asked: yes, the real last 7 plies are fed** — `maiaHistoryFens`
(`recommendation.ts:184`) replays the validated history with chess.js and returns the last
`MAIA_INPUT.history` = 8 positions, oldest → newest, with the caller's own `fen` string as the last
entry. The encoder (`src/core/policy/maia-encoder.ts:106`) pads a short window by repeating the
earliest frame and mirrors **each frame on its own side to move**, which is bit-exact against
`maia3.dataset.get_historical_tokens` (the fixture is generated from upstream in
`tools/data/09_export_maia3.py:326`). That convention is verified, not assumed.

**Three gaps.**

1. **Silent degradation to a single frame.** If `matchingHistory` fails, `maiaHistoryFens` returns
   `[fen]` and the encoder repeats it eight times — the history-ablation case the paper prices at
   **1.4 pp** on 5M, and behaviourally worse than that, since repetition context, plan context and
   "what just moved" all vanish. This happens whenever the move list is unavailable, and CLAUDE.md
   says exactly when that is: on chess.com's live WebGL board the move list **does not exist in the
   DOM until the first move is played**, and history is otherwise recovered only through
   `historyFromSan(snapshot.moveHistory, …)`. There is no counter, no rationale row and no log line
   for it today.
   **Fix (S):** record `historyFens.length` on `rec.maia`, surface it on the Engine view's Human
   model block, and add a rationale row when it is < 8. Then the QA question "how often do we
   actually feed history?" is answerable from one game.
2. **Premoves and holds never get a history-conditioned query at all** — see H8.
3. **The predicted position is pre-analysed but never pre-*inferred*.** `preAnalysePredicted`
   (`session.ts:1727`) already builds the predicted FEN and its history (`historyFor(fen).moves`
   plus the predicted reply) during the opponent's turn. Issuing a Maia query for that position at
   the same moment costs nothing on our clock and makes the answer instant when the reply is
   correct — a prerequisite for H8 and H10.

---

### H8 — Maia for the fast moves: premoves, scramble holds, and the ready move  [c, e, f]

**Human mechanism.** HvS §2.3 (forcing moves are considered first, reflexively), §5.7 (under time
pressure humans rely on first impressions and reduce opponent-reply checking). The fast moves are
where human play is *most* stereotyped, so they are where a model of human play is most valuable —
and they are precisely where the current design falls back to the engine.

**What is wrong today.** `readyMoveFrom` (`session.ts:1623`) builds a `SelectionContext` with no
`ctx.maia` and runs the ordinary §7.2 policy at `targetElo − SCRAMBLE_HOLD.eloPenalty`; the premove
module (`src/core/strength/premove.ts`) is a pure engine/heuristic construction (recapture, only
move, `loss_2nd ≥ 0.25`). At bullet and low blitz a large share of a game's moves come from these
two paths, and none of them is drawn from the human policy.

**Plug-in.** With H7 item 3 in place, `this.predictedPolicy` sits next to `this.predictedAnalysis`
(`session.ts:1596`); pass it into `readyMoveFrom`'s context so the hold is a Maia draw over the
pre-analysed lines. For premoves, use Maia as the *gate*, not the chooser: require
`p_maia(q | predicted position, selfElo) ≥ PREMOVE.maiaMinProb` before arming — a human premoves a
move they would have played anyway.

**Effect.** Removes a systematic style seam between slow and fast moves. Also fixes an asymmetry
nobody has measured: today the bot's fastest moves are its most engine-like.

**Cost.** Medium (M). One extra inference per opponent turn, paid on their clock.

**Risk.** The predicted reply is often wrong; the policy answer is then for the wrong position. The
existing `settleHold` logic (`session.ts:1663`) already handles a stale hold with a legality and
hang check — extend it rather than inventing a second path.

---

### H9 — Restore "weak players miss mates", and make winning greedy  [i, f]

**Human mechanism.** HvS §5.2 and §12: at beginner level, basic mating patterns are a *strength*
but longer forced mates are candidate-generation failures; §2.9/§11.3: humans play for what is easy
to execute, not for the shortest mate.

**What is wrong today.** The mate guard at `move-selector.ts:299–311` returns **any** immediate
mate and otherwise the shortest searched forced mate, **at every rating, unconditionally** — and
`SELECTION_CONSTANTS.neverPlay.mateInMax` (3), `mateAlwaysElo` (1400), `mateProbBase` (0.5),
`mateProbEloFloor` (800), `mateProbEloSpan` (600) and `throwWinLoss` (0.4) are defined in
`src/core/strength/constants.ts:139–146` and referenced **nowhere else in `src/` or `test/`**
(verified). §7.2 step 5's "weak players miss mates" rule is therefore not implemented, and a 700-Elo
bot converts every mate-in-5 the referee finds, perfectly, forever. That is the exact "too spiky
tactical competence" pattern of HvS §11.1.

**Plug-in.** `move-selector.ts:299–311`: keep the unconditional return for an **immediate board
mate** (the current comment's reason is sound — never randomly decline mate-in-1), and gate longer
searched mates by the existing constants: play a mate-in-≤3 with p = 1 for E ≥ 1400 and with
`mateProbBase + mateProbBase·(E − 800)/600` below; for mates deeper than `mateInMax`, fall through
to the Maia draw with the `throwWinLoss` filter applied (a missed mate must not become a thrown
win). In Maia mode this is mostly free: Maia will usually put mass on the mating move anyway, so the
"miss" is the population's miss rather than a coin flip.

**Greed when winning** is the same code path: when `bestCp` is large and no mate exists, HvS §2.9
says humans take the *simple* conversion, not the engine's fastest. That is the existing
`conversion-progress` prior — which is inert in Maia mode (see H11).

**Cost.** Small (S). **Risk.** Low; it is restoring a specified behaviour. **Validation.** A fixture
position with a searched mate-in-4, 2000 seeded draws at 800/1200/1600, asserting the ramp.

---

### H10 — One Maia-shaped search instead of two mismatched ones  [k]

**The problem.** Today the pipeline runs a broad full-strength MultiPV 12–20 search, then — if
Maia's unscored mass clears 6 % — a **second** `go searchmoves` for up to 260 ms on 6 roots, and
merges the two frames (`mergeLines`, `recommendation.ts:259`). `compareLines`
(`src/core/strength/quality.ts:11`) orders **by score only, ignoring depth**, so the merged pool
mixes a deep frame with a shallow one. Consequences (all of them real, see §7 A1/A2):

* a shallow, optimistic extra line can become `lines[0]`, which is `rec.eval`, the panel's PV, the
  timing model's `lines`, and `originalRanks[0]` → `topCpRaw` → **the reference for every
  candidate's `lossRaw`**, which is what `lossCap` and `hangsPiece` judge;
* `moveQuality` marks any depth disagreement `depth-mismatch` and `eligible = false`
  (`quality.ts:47`), so the session's diagnostic bands go blind on exactly the moves the extra
  search enabled;
* 260 ms of a 400–600 ms window is spent on a second search whose result cannot be cached
  (`searchmoves` results are deliberately never cached).

**The better shape.** Run **one** search whose root set is chosen by Maia:

```
opponent's turn:  pre-analyse predicted position  +  pre-infer Maia for it   (H7.3)
our turn, t=0:    if a policy answer for this exact FEN is already in hand → use it;
                  else issue the query and wait at most MAIA.policyFirstMs (≈120 ms)
t≈0…120ms:        searchmoves = { Maia's top-k covering MAIA.massCover (≈0.95) }
                              ∪ { the ponder/pre-analysis top-3 }      ← keeps the true best move
                  multiPv = |that set|,  full strength,  the whole class budget
fallback:         no answer in time → today's broad MultiPV search, today's path, unchanged
```

**Why it is better.** Every candidate is scored in one frame at one depth (the rails and `cpLoss`
become sound); the budget concentrates on ~8–12 roots we might actually play instead of 20 the
engine ranked, so each root is searched deeper; the second search disappears; and Maia's whole mass
is covered by construction rather than by a 6 %-threshold patch.

**The one cost to handle.** `EngineController.lookup` never answers a `searchmoves` request from
the cache and `AnalysisCache.set` never stores one, so this would lose the §4.5 pre-analysis cache
hit. Two answers, and the second is better: (i) include the sorted `searchmoves` in the cache key so
an identical restricted search can hit; (ii) have `preAnalysePredicted` (`session.ts:1727`) compute
the **same** Maia-shaped root set for the predicted position — which it can, because H7.3 gives it
the policy answer — so a correct prediction is a cache hit exactly as it is today. The comment at
`recommendation.ts:160` already states this contract ("the pre-analysis has to ask for exactly the
shape the own-move search will ask for"); this extends it from `elo` + breadth to the root set.

**Cost.** Large (L) — it is a restructuring of `run()` plus a cache-key change plus the pre-analysis
symmetry. **Risk.** A cold or slow policy answer delays the search; the `policyFirstMs` fallback
bounds it. The panel's eval must keep coming from a root set that contains the engine's best move —
hence the forced inclusion of the ponder's top-3.

**Validation.** Latency regression in the simulator (search start time, realised depth per root
before/after), plus the existing behavioural suites — the merged-frame bugs in §7 should become
unreachable, which is a test each.

---

### H11 — Endgame technique and conversion inside Maia mode  [h]

**Human mechanism.** HvS §5.4 (misjudging endgame transitions), §6.4 (engines are exact where
tablebases apply and approximate outside), §12 (strong club players know elementary endgames).
Practically: humans convert by the simplest path — trade into a won pawn ending, push the passer,
walk the king — while an engine finds the fastest, often bizarre, line.

**What is wrong today.** Three separate technique mechanisms exist and **none of them runs below
2600**:

* `endgameTauFor` (`move-selector.ts:47`, τ ×1.5 below 1200 / ×0.7 from 1800) is only read by
  `selectionParams` (`:58`), which the Maia branch never reaches;
* the `won-endgame-technique` prior (`prior.ts:244`) and the `conversion-progress` boost
  (`move-selector.ts:321–329`) are written into `priors.values`, which the Maia branch never reads;
* the `clock-forcing` boost (`:330–335`) is in the same position.

So `selectMove` computes a full heuristic prior over up to 20 lines — each walking a PV with
chess.js — and then discards it (see §7 A4).

**Plug-in.** Do **not** multiply Maia's probabilities by the prior (that is the re-weighting §3.1
warns about). Use it as a **tie-break among near-equal Maia candidates**: after the tempered
weights are computed in `drawMaiaMove` (`maia-select.ts:114`), if two or more survivors are within
`MAIA.tieBandRatio` (≈ 0.7) of the top weight, prefer the one with the higher conversion progress /
technique prior. This changes the draw only where Maia is close to indifferent, which is exactly
where a human's technique habits decide.

**Second half — Maia's endgame weakness.** The Maia line is trained on whole human games, so
long forced endgame sequences are its thinnest data. The rails already catch catastrophe, but a
rating ramp is cheap and honest: in a `conversionPool.active` position with overwhelming material,
shift authority toward the engine's conversion pool as E rises (a 2400 does convert R+P vs R
technique-correctly; an 800 does not). The state is already computed — `conversionPool`
(`conversion.ts:47`) returns `active` and a per-line `progress` map.

**Cost.** Small (S) for the tie-break, medium for the authority ramp. **Risk.** The tie-break is a
place a hand-written table can creep back into the human model; keep the band narrow and put the
resulting KL on the meter. **Validation.** The rook-and-pawn conversion fixture pattern the
`opponent-rush` doc already used (`/tmp/sliced-pressure-audit/endgame.ts` is described there):
600 samples per rating, report mean searched gap and the rate of "still winning" continuations.

---

### H12 — Plan persistence, fixation and tilt as per-game state  [e, i]

**Human mechanism.** HvS §2.4 (plans as search organisers), §5.6 (**Einstellung** — Bilalić, McLeod
& Gobet 2008 showed a familiar-but-inferior solution blocks discovery of the better one even in
masters; Sheridan & Reingold 2013 showed their gaze kept returning to the familiar region while they
believed they were looking elsewhere), §8 ("plan persistence … human may continue an obsolete plan
because it frames attention"; "recovery after error — human may become tilted, overcorrect").

**What exists.** `SelectionState` already carries per-game state and `previousOwnMoves` (4 deep),
but only one rule reads it: `back-and-forth` (`prior.ts:229`), and that is inert in Maia mode.
Maia's 8-frame history gives it *some* implicit persistence, which is a reason to measure before
adding.

**Three concrete additions, all in `SelectionState`:**

1. **Plan latch.** Record the region (file band / wing) and the piece of our last 2–3 moves; among
   near-equal Maia candidates (same tie-break band as H11) prefer continuation. **Measure first:**
   compute the bot's current "same piece as the previous own move" and "same wing" rates from the
   offline harness and compare against the human rates in the same sample. If Maia already matches,
   skip this — that is the honest outcome and it costs one query of the harness.
2. **Einstellung.** When a `threatAnswered`-style idea or a sacrifice line is latched, apply a
   small, *temporary* reduction of `selfElo` (H5's channel, not a prior) for 2–3 moves — the
   fixation costs attention, which is exactly what an Elo reduction encodes.
3. **Tilt.** The session already tracks `this.timing.state.lastEvalOurPov`, so a large adverse eval
   swing after our own move is detectable at zero cost. After one, with a rating-dependent
   probability (high below 1400, near zero at master), apply `−MAIA.tilt.elo` (≈ 100) for
   `MAIA.tilt.moves` (2–4). Note this is the **opposite sign** to the existing
   `blunder.damperMultiplier` (0.3 for 3 moves, "humans who just blundered tend to concentrate"),
   which is itself unsourced and inert in Maia mode; the literature supports both, so make it a
   rating-dependent mixture rather than picking a side.

**Cost.** Small each (S). **Risk.** Double-counting against Maia's history frames — hence the
"measure first" instruction on item 1. **Validation.** Autocorrelation statistics on the bot's own
games versus the human sample: lag-1 correlation of per-move loss, run-lengths of same-piece moves,
and the conditional blunder rate given a blunder on move *n*−1. All computable from PGNs; no model
calibration.

---

### H13 — Practical difficulty: choose the move the *opponent* is likely to answer wrong  [i]

**Human mechanism.** HvS §2.9 ("selecting a line that is objectively second-best but difficult to
meet over the board"), §11.3 ("difficulty for the opponent is not the same as objective score
loss"), §14 (a human-like bot should model the conditional probability of *the opponent's* moves).
This is the one objective a pure move-imitation model cannot express, and the extension already has
the machinery to compute it: Maia conditioned on the **opponent's** rating.

**The model.** For each of the top 2–3 Maia candidates `m`:

```
trickiness(m) = Σ_r  p_maia(r | position after m, selfElo := oppoElo, oppoElo := ours)
                     · max(0, loss_engine(r))
```
i.e. the opponent's *expected* loss under their own rating's move distribution. Pick among near-
equal candidates by `trickiness` when we are behind (`bestCp ≤ −200`), and by its inverse (choose
the move that is *easy to answer only one way*) when we are converting.

**Cost.** This is the expensive idea: 2–3 extra Maia queries (40–150 ms at 23M, 370–550 ms at 79M)
**plus** engine scores for the opponent's replies. Restrict it to rapid and classical, where the
window is 1000–1500 ms, and to positions where we are behind — i.e. a few moves per game.

**A free approximation.** With no extra inference at all, "trickiness" can be read off the engine
lines we already have: after `m`, how narrow is the opponent's path? The pipeline already searches
the *predicted* position during their turn (`preAnalysePredicted`) and the PV of every candidate
carries the reply. A move after which the second-best opponent reply loses ≥ 0.25 is a practical
try; a move after which ten replies are equal is not. Ship the approximation first.

**Risk.** It makes the bot *stronger in results* at a fixed rating, which is a product question, not
just a realism one — the 2026-09-11 investigation's warning about opponent-pressure changes silently
raising strength applies here. Gate it and keep it out of the quality cohort (the
`quality.eligible = false` / `reason` mechanism at `move-selector.ts:341` is the precedent).

**Validation.** Paired-colour matches against a fixed opponent pool with and without the term,
reporting score with uncertainty (the methodology paragraph in
`strength-selection-2026-09-11.md` §"Validation should first capture…" is the template) — this one
genuinely needs games, because its whole claim is about results.

---

### H14 — Opening: a persistent repertoire, and let Maia play the opening at low ratings  [g]

**Human mechanism.** HvS §5.5 (knowledge and retrieval errors; forgetting a move order), §8
("opening error: memory confusion, incomplete knowledge"), §8.1 (errors are semantically coherent,
individual structure persists — McIlroy-Young et al. 2022).

**Two problems today.**

1. **No repertoire.** The book (`src/core/strength/book/`) samples by frequency with
   `γ(E)` flattening, freshly per position per game, with `input.rng` seeded per position. A human
   plays 1.e4 for a year. **Fix (S):** derive the book sampler's seed from a persisted per-profile
   repertoire key (one value in `chrome.storage.local`, per colour), so the same first moves recur
   across games while deeper positions still vary. This is the cheapest single change in this
   document that makes a bot "feel like a person".
2. **The book overrides Maia entirely** (`recommendation.ts:887`, the book returns before
   `selectMove`), and it is a *stronger* human-opening prior than a low rating deserves: an 800 does
   not play book moves weighted by master-game frequency, they play the four moves they know. Maia
   is trained on exactly the right distribution and conditions on rating — it will play a 900's
   opening at 900 and a 2400's at 2400 without a book at all. **Proposal:** below
   `BOOK.maiaOnlyElo` (≈ 1600–1800) skip the book and let Maia play the opening; above it keep the
   book, which is where "theory the player has actually studied" starts to be the right model.
   Rating-ramp the book exit depth too (an 800 leaves at ply 4–6; a 2400 at 16–20).

**Interaction to watch:** `in_book` drives the timing model's book speed-up
(`TIMING_CONSTANTS.bookSpeed`, documented in `maia-batch-2026-09-11.md`). Removing the book below
1800 removes the fast-opening behaviour with it — the timing feature must then derive `in_book`
from "an early move with high Maia probability", which it partly already does ("the session's book
answer, **or an early top-line move**"). Flag for the timing owner; do not change the timing model
here.

---

### H15 — Above 2600: Maia-79M as a prior so the engine's moves look human  [j]

**Human mechanism.** HvS §11.1 ("tactical competence can be too spiky"), §7.2, §11.2, §11.4. Also
the repo's own evidence: at E ≥ 2500 the selector's parameters are *constant*
(`high-elo-selection-2026-09-11.md`, "Exact policy boundaries"), and an identical-seed replay at
targets 2600, 2700, 2800, 3000, 3190 and 3200 produced **exactly the same 2000-move sequence**. The
2600–3200 band is one player wearing six labels.

**Proposal.** Keep the engine as the chooser, but let Maia-79M break ties, in the branch at
`move-selector.ts:396` (`usesNativeSelection`):

1. Query Maia-79M at `selfElo = min(target, MAIA.topCalibratedElo)` — 2600–2800, the top of the
   in-distribution range (feasibility §2.4: "Below 2800 is in-distribution"; above ≈ 3000 it
   extrapolates, and asking for 3800 is not "as advertised").
2. Build the pool of lines within a small gap of the native/best choice — the existing `gapFor(E)`
   is 60 cp at ≥ 2200, which is the right width.
3. Draw from that pool weighted by Maia's probability, floored so a move Maia has never seen can
   still be played when it is clearly best.

This also needs the referee shape Maia mode already uses above the switch: full strength with the
sampling breadth, otherwise there is nothing to choose among (the same doc records that 2600+
searches ask for only six roots by default).

**Effect.** The "computer-only quiet move" disappears without a hand-written computer-move detector;
2600, 2900 and 3200 stop being byte-identical.

**Cost.** Medium (M): 79M is 184 ms p50, affordable in a ≥ 400 ms window; plus the branch and the
breadth change. **Risk.** A measurable strength loss at the top of the range, which is the trade the
idea is making; keep `LIMITS.eloMax` (3800) as a pure-engine escape hatch, as it is today
(`move-selector.ts:388`).

**Validation.** The identical-seed replay from `high-elo-selection-2026-09-11.md`, re-run: targets
2600/2800/3000/3200 must now produce *different* move sequences, and the top-1 agreement with the
full-strength best move must fall monotonically as the target falls.

---

### H16 — Rails that scale with rating, as one table  [f, d]

H1 is one rail; the general point is that **every** rail is currently rating-flat or nearly so, and
the report's §12 says the *mix* of error mechanisms shifts continuously with rating. Collect them
into one `MAIA.rails` table indexed by E:

| Rail | Today | Proposed shape |
|---|---|---|
| `hangsPiece` | flat, loss ≥ 0.25 + PV capture | off < 1100, probabilistic to 2000, on above (H1) |
| `lossCap` | 0.55 → 0.25 by E (`maia-select.ts:49`) | keep; it is the only rail with the right shape |
| mated lines | always excluded when an alternative exists | keep for mate-in-1; allow deep mated lines below 1200 the way the non-Maia path already does (`move-selector.ts:486–498` has the rule; the Maia branch deliberately drops it) |
| forced mate | always played (H9) | rating ramp for mates deeper than 3 |
| repetition / conversion | applied before the draw, rating-independent | rating-ramp the conversion window (H11) |
| back-rank / pins / one-move threats | not modelled | **do not add.** Maia has them; hand-coding them is the double-counting trap. Use them only in the ≥ 2600 fallback policy where Maia is absent |

The last row is the discipline this document keeps returning to: every motif a hand-written rule
adds inside Maia mode is a motif Maia already learned, applied twice.

---

### H17 — Ambiguity- and mass-aware search allocation  [k]

Beyond H10's single Maia-shaped search, two refinements that are cheap once H10 exists:

* **Deep on the top, shallow on the tail.** The top-3 Maia moves carry most of the decision; the
  rest only need a score good enough for the rails. One search with MultiPV over the union already
  gives this implicitly (the engine orders its own effort), but an explicit two-request split
  — `searchmoves` top-3 at the full budget, `searchmoves` tail at `minMovetimeMs` — is available if
  measurement shows the tail eating the budget.
* **Spend the budget where it changes the answer.** When Maia's entropy is low (one move at
  p > 0.8) the search cannot change the outcome: shrink `movetimeMs` toward the floor and give the
  time back to the clock. When entropy is high *and* the top candidates' scores disagree, spend the
  full class budget. This is the search-side twin of H5 and uses the same free entropy number.
  Guard: the panel still needs an eval, so never go below `SEARCH_BUDGET.minMovetimeMs`.

---

### H18 — Things deliberately **not** proposed

* **No calibration sweep of any kind against the Maia models** — the owner's ruling, and §3.1 is the
  design that makes it unnecessary.
* **No re-weighting of Maia's probabilities by the heuristic prior.** The prior table
  (`prior.ts`, 25 rules) is a hand-written approximation of exactly what Maia learned from 2023–2025
  Lichess games. Multiplying them is double-counting with unknown sign. Keep the prior for the
  fallback path and for ≥ 2600, use it only as a narrow-band tie-break (H11, H12) inside Maia mode.
* **No int8 quantisation** (feasibility §3.4: top-5 ordering breaks in 10–20 % of positions — for a
  distribution model that is a behavioural change).
* **No personalised/individual Maia models** (McIlroy-Young et al. 2022) — they would need per-player
  data we neither have nor want.

---

## 5. Ranking

Realism gain and feasibility are each scored 1–5 (feasibility folds in engineering size, latency
headroom and blast radius). Rank is the product.

| # | Idea | Brief item | Realism | Feasibility | Score | Size |
|---:|---|---|---:|---:|---:|---|
| 1 | **H1** Rating-ramp `hangsPiece`, one-ply view below 1600 | f, d | 5 | 5 | **25** | S |
| 2 | **H2** Slider as an Elo offset, `T = 1` always | a, f | 4 | 5 | **20** | S |
| 3 | **H5** Position/clock-conditioned `selfElo` (Maia entropy as ambiguity) | a | 4 | 5 | **20** | S–M |
| 4 | **H9** Mate-miss ramp + dead constants | i, f | 4 | 5 | **20** | S |
| 5 | **H3** Generate-and-verify (k candidates, human-depth verification) | d, e, f | 5 | 3 | **15** | L |
| 6 | **H7** History observability + pre-infer the predicted position | c | 3 | 5 | **15** | S |
| 7 | **H14.1** Persistent opening repertoire seed | g | 3 | 5 | **15** | S |
| 8 | **H11** Endgame technique / conversion inside Maia mode | h | 3 | 5 | **15** | S–M |
| 9 | **H4** Rating-dependent `featureDepth` frame | d, k | 4 | 4 | **16** | M |
| 10 | **H6** Size by latency, commit per game | b | 3 | 4 | **12** | S–M |
| 11 | **H10** One Maia-shaped search (fixes the depth-mixing bugs) | k | 3 | 4 | **12** | L |
| 12 | **H15** Maia-79M prior above 2600 | j | 4 | 3 | **12** | M |
| 13 | **H8** Maia for premoves / holds | c, e | 3 | 3 | **9** | M |
| 14 | **H12** Plan latch, Einstellung, tilt | e, i | 3 | 3 | **9** | S each |
| 15 | **H14.2** Maia plays the opening below ~1700 | g | 3 | 3 | **9** | M |
| 16 | **H17** Ambiguity-aware search allocation | k | 2 | 4 | **8** | S–M |
| 17 | **H13** Practical difficulty (opponent-conditioned Maia) | i | 4 | 2 | **8** | L |

H4 scores above H3 on feasibility but is listed after it because it is H3's dependency in practice;
the roadmap sequences them correctly.

---

## 6. Roadmap

Seven steps. Each ends green on `bun run check` and leaves a measurable meter behind.

**Step 0 — Fidelity meters and the offline harness (M).**
`rec.maia` gains `historyPlies`, `railedMass`, `entropy`, `klFromMaia`; the Engine view's Human
model block shows them; `tools/data/10_human_match.py` (or a Bun script beside it) builds the
replay corpus of §8. Nothing about play changes. Without this, every later step is an opinion.

**Step 1 — The cheap rating-shape fixes (S).**
H1 (`hangsPiece` ramp + `hangsOutright` below 1600), H2 (slider → Elo offset, `T = 1`), H9 (mate
ramp, dead constants used), plus the §7 B2 fix (one `E` for the query and the rails). Together these
are the bulk of the low-rating realism gain and they touch ~120 lines.

**Step 2 — Observability and the free context inputs (S–M).**
H7 (history counter + rationale row + pre-infer the predicted position), H5 (position/clock
`selfElo` with Maia entropy as the ambiguity term), H14.1 (persistent repertoire seed). Re-run the
harness; H5's weights are chosen from the per-bucket human statistics, not from feel.

**Step 3 — Fix the merged-frame defects (M).**
§7 A1–A3: make `mergeLines`/`compareLines` depth-aware or keep the extra frame out of `rec.eval`,
`timingCtx.lines` and `originalRanks`; carry the extra search's `complete` flag; kill the dead
`elapsedMs` parameter. This is a prerequisite for trusting anything the rails say.

**Step 4 — The human-depth frame (M).**
H4: `featureDepth` on the request, in the cache key, `humanDepth(E)` in Maia mode. Ship it with the
frame *unused by selection* first, logging the shallow-vs-deep score disagreement per move — that
log alone answers "which engine-found tactics does a human at R miss" with real data.

**Step 5 — Generate-and-verify (L).**
H3, behind `MAIA.generateVerify.enabled`, using Step 4's frame. Accept only if human move-match
likelihood (§8) improves at 1100 / 1500 / 1900 / 2300 and `klFromMaia` stays inside a stated budget.
This is the step that changes what the bot *is*; everything before it is hygiene.

**Step 6 — Search shape and the fast moves (L).**
H10 (one Maia-shaped search, pre-analysis symmetry, cache key) then H8 (Maia for holds and premove
gating) and H17 if the measurements ask for it.

**Step 7 — The ends of the range and the practical objective (M–L).**
H15 (79M prior above 2600), H11's conversion authority ramp, H6 (size by latency), H14.2, H12, and
finally H13's free approximation. H13's full form only if the owner wants a bot that plays for
tricks and accepts the strength question that comes with it.

---

## 7. Bugs and oversights found while reading

Ordered by consequence. Line numbers are against the working tree of 2026-09-13.

### A. The merged extra-search frame

**A1 — A shallow extra line can become the reference for every rail and for the panel's eval.**
`mergeLines` (`src/service/game-session/recommendation.ts:259`) sorts with `compareLines`
(`src/core/strength/quality.ts:11`), which compares mate class then cp and **ignores `depth`**. The
extra search runs `MAIA.extraSearchMs` = 260 ms over 6 roots (`recommendation.ts:605–616`) while the
main search runs 400–1500 ms over 12–20, so its lines are systematically shallower and its scores
noisier — and frequently *more optimistic*, because a shallow search has not yet seen the
refutation. The merged array is then used as:
* `rec.eval = best?.score` and `rec.lines` (`recommendation.ts:654–664`) → the panel's eval bar and
  line preview;
* `timingCtx.lines = lines` (`recommendation.ts:645`) → the timing model's complexity features;
* `selectMove(pool, ctx)` → `originalRanks = rankedLines(lines)` and
  `topCpRaw = cpEffective(originalRanks[0]?.score …)` (`src/core/strength/move-selector.ts:273–274`)
  → `winTopRaw` → **`lossRaw` for every candidate** (`:291`), which is what `lossCapFor` and
  `hangsPiece` judge in the Maia branch.

So one over-optimistic 260 ms line inflates every other candidate's loss and can veto moves the
deep search says are fine. Fix: make `compareLines` (or a merge-specific comparator) prefer the
deeper line on a tie-band, or keep the extra lines out of the *reference* set while still allowing
them as candidates — the latter is closer to the intent, since the extra search exists to make
Maia's favourites *drawable*, not to re-rank the position.

**A2 — Diagnostics go blind on exactly the moves the extra search enabled.**
`moveQuality` (`quality.ts:47`) sets `reason = "depth-mismatch"` and `eligible = false` whenever
`best.depth !== chosen.depth`. With a merged pool that is the normal case, so the session strip's
top-1/ACPL sample silently loses every move where the extra search mattered. Combined with A1, the
`AGREEMENT_BANDS` diagnostics under-report exactly the population they were meant to observe.

**A3 — The extra search's completeness is never checked.** `run()` tests
`analysis.final.complete` for the main search only (`recommendation.ts:632`); `extra.final.lines`
are merged with no such test (`:618–626`), so an incomplete MultiPV frame's lines can enter the
pool with partially-searched scores.

**A4 — `extraSearchMs(budget, _elapsedMs)` has a dead parameter and a doc/code mismatch.**
`recommendation.ts:237`: the JSDoc says "bounded by what is left of the move's own search budget
after `elapsedMs`", the body ignores `_elapsedMs` entirely (deliberately, per the inline comment),
and the call site computes `this.now() - searchStarted` to pass into it (`:608`). Delete the
parameter and fix the JSDoc.

### B. Rating plumbing

**B1 — `hangsPiece` is the binding rail at low Elo and contradicts `lossCap`'s stated intent.**
`move-selector.ts:369`. At E = 800 `lossCap` is 0.55 but `hangsPiece` fires at 0.25 with a PV
capture, so the "room for the mistakes an 800 does make" that `MAIA.lossCap`'s 800 knot is
documented to leave is taken away by a different rail. See H1.

**B2 — The Maia query's `selfElo` and the rails' `E` disagree under opponent clock pressure.**
`queryPolicy` uses `effectiveElo(input.targetElo, input.form)` (`recommendation.ts:685`), with no
pressure reduction. `selectMove` computes `E = effectiveElo(targetElo − pressureReduction, form)`
(`move-selector.ts:245`) and hands *that* to `drawMaiaMove` → `lossCapFor(E)`. Ordinary opponent
pressure (up to −100 Elo, `C.opponentPressure.eloReduction`) is active in Maia mode — only a clock
*race* disables Maia — so the two disagree by up to 100 Elo on those moves. `maia-selection-2026-09-11.md`
states they are the same E ("`selfElo = effectiveElo(targetElo, form)` — the same E the selector
computes for the move"), which is false in that regime. Either pass the reduction into the query
(preferred; it is the same behavioural claim) or stop applying it to `lossCapFor`.

**B3 — §7.2 step 5's mate rules are dead code.** `SELECTION_CONSTANTS.neverPlay.mateInMax`,
`mateAlwaysElo`, `mateProbBase`, `mateProbEloFloor`, `mateProbEloSpan` and `throwWinLoss`
(`src/core/strength/constants.ts:139–146`) are referenced **nowhere** in `src/` or `test/` outside
their own declaration (verified by grep). The mate guard at `move-selector.ts:299–311` plays every
searched forced mate at every rating. The change was deliberate (the comment at `:297` explains the
`engine-elo` bug it fixed) but it silently deleted a normative rule and left six constants
unreferenced — which `check-constants` does not catch, because it polices duplication, not
liveness. See H9.

### C. Work done and thrown away

**C1 — The heuristic prior is computed and discarded in Maia mode.**
`resolvePriorsDetailed` (`move-selector.ts:276`) runs `heuristicPriorDetailed` over every usable
line; each line walks up to 8 PV plies through chess.js (`prior.ts:68`, `:155`) plus
`isDefended` (another `applyMoves` + `legalMoves`, `:100`). With 20 lines that is a meaningful
per-move cost inside a 400 ms window, and in Maia mode **none of it is read** — the branch at
`:354` uses only `cands`' rails and Maia's probabilities. Either skip the prior computation when
the Maia branch will be taken, or use it (H11's tie-break).

**C2 — Three situational mechanisms are inert below 2600.** The `conversion-progress` boost
(`move-selector.ts:321–329`), the `clock-forcing` boost (`:330–335`) and `endgameTauFor` /
`selectionParams` (`:47`, `:58`) never reach the Maia path, yet the rationale still pushes
"conversion: retaining the win with rating-sensitive progress" (`:314–315`) on moves where nothing
rating-sensitive happens. The rationale row is misleading in Maia mode.

### D. Diagnostics and documentation

**D1 — `drawMaiaMove`'s rank is over the pre-rail set.** `maia-select.ts:122–123` sorts *all*
`candidates` (including railed-out ones) and reports `rank k/candidates.length`, while
`maia-selection-2026-09-11.md` describes `k` as "the pick's rank in Maia's ordering of the scored
set" and `n scored` as the survivors. `MaiaDraw.scored` has the same ambiguity. Cosmetic, but it is
the row an engineer will read when something looks wrong.

**D2 — `scoredMass` is measured after the repetition/conversion filters, not before.**
`drawMaiaMove` sums `prob` over the candidates it is given (`maia-select.ts:95–98`), which are the
post-`avoidRepetition`/`conversionPool` `usable` lines (`move-selector.ts:246–258`). So in a won
endgame the `minScoredMass` warning can fire because *conversion* removed lines, not because the
search failed to score them — and the documented remedy ("a larger `extraCandidates`") would not
help. Report the two separately.

**D3 — The history window has no telemetry.** See H7.1: the degenerate `[fen]` case is invisible.

**D4 — An unverifiable input column in the export.** `tools/data/09_export_maia3.py:205` pads the
tokens with a zero 97th feature before calling the upstream model, and the fixture generator
(`:326`) truncates the upstream tokeniser's output to 96 columns *before* computing the torch
reference. The ONNX graph and the parity reference are therefore both fed the same zeroed column,
so `test/integration/maia-onnx.test.ts` **cannot detect** a wrong value there. With
`include_time_info = False` the column is almost certainly the disabled time feature and the pad is
correct — but that is an assumption, not a measurement. One-line check: assert the dropped column is
all-zero in the upstream tokeniser's output for the 60 fixture positions and record the result in
`docs/models.md` §8.4.

**D5 — `maiaSizeFor`'s bands encode a compute decision as a fidelity decision.** See H6. Not a bug;
an unexamined design choice with an observable behavioural cost at the band edges.

---

## 8. Validating any of this without calibrating Maia

The owner ruled out tuning the models. Everything here is validated against **human games** or
against **internal consistency**, never against a model-accuracy target.

### 8.1 The human move-match harness (the backbone)

Build `tools/data/` job that answers one question: *does our wrapper make the bot's move
distribution more or less like a human's at that rating?*

1. **Corpus.** Lichess open database, blitz and rapid, months held out from Maia-3's training window;
   5–10 k positions per rating bucket (1000/1300/1600/1900/2200/2500), with both players' ratings
   and the per-move clock. Games with `[%eval]` are preferable but not required — we produce our own
   referee scores.
2. **Replay.** For each position, run the *full selection wrapper* — referee search at the
   production budget, Maia at `selfElo = the player's rating`, `oppoElo = the opponent's`, the rails,
   the draw — and record the final sampling distribution `q(m)` (not just the sampled move).
3. **Primary metric.** Mean log-likelihood of the **actual human move** under `q`,
   `E[log q(m_human)]`, plus top-1 agreement `E[1(argmax q = m_human)]` and the expected agreement
   `E[q(m_human)]`. Baselines: raw Maia (`p`), Maia + rails, Maia + rails + each proposed change.
   *Any wrapper step that lowers `E[log q(m_human)]` is making the bot less human and is rejected,
   whatever it does to the rating bands.*
4. **Secondary metrics, per bucket and per condition** (clock quartile, ambiguity quartile, phase):
   ACPL, Lichess inaccuracy/mistake/blunder rates (≥ 10/20/30 % win-probability drop), piece-hang
   rate per 40 moves, mate-found rate, same-piece-as-last-move rate, lag-1 autocorrelation of loss.
   Each is computed for the humans in the same bucket, so every one is a *target*, not a guess.
5. **Cost.** Dominated by the referee searches: at 600 ms × 8 k positions × 6 buckets ≈ 8 CPU-hours
   per full sweep, trivially parallel and run overnight. Cache by `historyKey`.

This harness is also the only honest way to answer the questions the QA docs leave open
(`maia-selection-2026-09-11.md` open items 2 and 3) without playing hundreds of rated games.

### 8.2 Fixed-pool replays (fast, per-change)

The pattern the `high-elo` and `opponent-rush` probes already established: a checked-in fixture of
real Stockfish MultiPV frames (`test/fixtures/strength/*.json`), N seeded draws per rating, report
top-1 / mean rank / mean raw loss / source counts. Every idea in §4 should land with one of these
so a future change that silently reverts it fails a test. Add a **Maia fixture**: the 60-position
parity set already carries real policy outputs, so a `MaiaCandidate[]` + `PolicyResult` fixture
makes the whole draw testable with no engine and no model.

### 8.3 Internal consistency assertions (free, run every `bun run check`)

* `klFromMaia` below a stated budget for each configuration.
* Monotonicity: mean raw loss must be non-increasing in target Elo across 800…2500 on a fixed pool
  with a fixed seed (today's plateau above 2500 is a *failure* of this assertion and should become a
  test once H15 lands).
* Rails: `railedMass` per move, averaged over a fixture game, below a stated ceiling per band.

### 8.4 What still needs a browser or real games

In-browser latency and memory per size (open item 1 — and H6 depends on it), the mid-game size
switch (item 5), the extra search's realised cost (item 4), and H13's strength effect, which is a
result claim and therefore needs paired-colour matches with a predefined stopping rule, per the
methodology paragraph in `strength-selection-2026-09-11.md`.

---

## 9. Sources

Chess cognition, as cited by the owner's report: Chase & Simon (1973) chunks; Gobet & Simon (1996)
templates and the recognition/look-ahead trade-off; Charness (1981) search depth and skill;
Charness, Reingold, Pomplun & Stampe (2001) and Reingold, Charness, Pomplun & Stampe (2001)
fixations, visual span and relevant empty squares; Connors, Burns & Campitelli (2011) the modern
de Groot replication; Bilalić, McLeod & Gobet (2008) and Sheridan & Reingold (2013) the Einstellung
effect; Cüvitoğlu (2026, *Scientific Reports*) non-linear error amplification under time pressure ×
positional ambiguity; "Intuition and deliberation in elite expertise" (*Cognitive Research*, 2026).

Human-move modelling: McIlroy-Young, Sen, Kleinberg & Anderson, *Aligning Superhuman AI with Human
Behavior* (KDD 2020) — depth-limited Stockfish matches human moves ≈ 35–40 % while Maia-1 exceeds
50 % at its target band, each model peaking at the rating it was trained on, and human blunders are
predictable well above baseline; McIlroy-Young, Wang, Sen, Kleinberg & Anderson, *Learning Models of
Individual Behavior in Chess* (KDD 2022) — per-player models and behavioural stylometry; Maia-2
(arXiv 2409.20553) — skill-aware attention with `elo_self` / `elo_oppo`; Maia-3 / Chessformer
(Monroe et al., ICLR 2026) as recorded in
[`maia3-feasibility-2026-09-11.md`](maia3-feasibility-2026-09-11.md).

Engine behaviour: the Stockfish FAQ on `Skill Level` / `UCI_Elo` (intentional suboptimal move
selection at `depth = 1 + int(level)` among ≥ 4 root candidates) and on selective search and
quiescence; the plan's Appendix E §0 for the verified `Skill::pick_best` source and the Lichess
win-probability / accuracy formulas; Appendix E §1.6 for the agreement/ACPL bands, with its own
caveat that the ACPL-by-rating table is a practitioner summary (the one academic regression found
R² ≈ 0.05–0.07 between ACPL and rating, so ACPL is a weak target on its own).
