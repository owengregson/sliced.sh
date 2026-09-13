# Maia-3 move selection below 2600 — 2026-09-11

The owner's brief: "begin implementation of Maia as the model for move selection (not timings)
below 2600 elo … ensure the system is extremely carefully calibrated and slots in super neatly
with what we have." This records what was built in the selector and the recommendation
pipeline, every knob and what it rests on, what the existing diagnostics are expected to show,
and what only a browser can answer. The feasibility study is
[`docs/research/maia3-feasibility-2026-09-11.md`](../research/maia3-feasibility-2026-09-11.md)
(§5 what Maia adds, §6 "Option B" is the design implemented here); the calibration this
supersedes below 2600 is
[`strength-selection-2026-09-11.md`](strength-selection-2026-09-11.md).

Nothing about *when* or *how* a move is played changes: the timing model and the executor read
the chosen move as before (C7). Above 2600 by target Elo, with the human model off, on a clock
race, or without a policy port, selection is byte-for-byte what it was.

## Where Maia selects

`maiaSearchMode` (`src/service/game-session/recommendation.ts`) is the one decision everything
downstream agrees on. Maia selects when all three hold (there is no user-facing switch — the
owner's ruling: the Elo slider alone decides which model plays):

- the *target* Elo is strictly below `MAIA.eloMax` (2600) — the target, not the form-adjusted E,
  so the switch sits where the strength slider already draws its Elite line;
- the session was built with a policy port (`RecommendationPipelineDeps.policy`);
- the position is not a clock race (`clockRacePolicy` null): the engine is faster there.

Stockfish remains the referee. The mate guards (immediate and searched forced mates), the
repetition and conversion filters, the never-play rails and the quality accounting all run on
the engine's lines exactly as before; Maia only supplies the distribution over what survives.

Maia chooses over its **whole** legal-move distribution (2026-09-12, the owner: "the maia model
should be able to more freely choose what move we will make"). The rails need an engine score
for every move they judge, so the pipeline makes sure the engine has scored what Maia is likely
to draw: the referee search's MultiPV set is widened by one extra `go searchmoves` on Maia's
unscored favourites (below). A favourite the MultiPV set did not rank is therefore scored, railed
and drawable like any other candidate.

## Pipeline

At the moment `timing.prepare` is issued, the pipeline issues
`policy.infer({ size, fen, historyFens, selfElo, oppoElo }, { budgetMs: MAIA.inferenceBudgetMs, signal })`:

- `size = maiaSizeFor(targetElo)` (`MAIA.sizeBands`: 5M under 1400, 23M under 2000, 79M under 2600);
- `historyFens` = the last `MAIA_INPUT.history` (8) positions oldest → newest, replayed from the
  validated game history (`matchingHistory`) with chess.js and ending with the board's own FEN
  string; `[fen]` when no history reaches the board (`maiaHistoryFens`);
- `selfElo = effectiveElo(targetElo, form)` — the same E the selector computes for the move;
  **correction 2026-09-13 (§7 B2 of the research doc):** this was false whenever ordinary
  opponent clock pressure applied — the selector judged its rails at
  `effectiveElo(targetElo − pressureReduction, form)`, up to 100 Elo below the query. Both now
  come from `maiaSelfElo` in `src/core/strength/selection-elo.ts` (the pressure reduction, the
  mistakes slider as an Elo offset and H5's clock/think context penalty), computed once by the
  pipeline's `ownMoveMaiaElo` and handed to the selector as `SelectionContext.contextEloPenalty`.
  See [`pipeline-frames-2026-09-13.md`](pipeline-frames-2026-09-13.md) §2;
- `oppoElo = input.opponentElo ?? selfElo` (`MAIA.oppoFallbackSelf`: a mirror match when the
  opponent's rating is unknown; the session/stack wiring that fills `opponentElo` is separate work).

The query runs in parallel with the search. After the search resolves the pipeline waits for
the answer only for what is left of `MAIA.inferenceBudgetMs` measured from the moment the query
went out — never longer, and the timing-preparation window is not shortened. A late, `null`,
rejected or aborted answer is one `log.debug` and the engine's own policy for that move; the
query's signal is aborted so the host can drop it.

**The referee search in Maia mode** (`refereeElo`, `searchBudget`'s `maia` input):

- full strength — no `elo` on the request. `UciEngine` turns an absent `elo` into
  `UCI_LimitStrength false` when the previous search had it on (`uci-client.ts`), and
  `EngineController.analyse` passes the request through untouched, so nothing needed changing
  there. The analysis cache keys on `elo ?? "full"`, so a limited and a full-strength search of
  the same position never alias;
- always the sampling breadth (`SEARCH_BUDGET.selectionCandidates`: 20 roots under 1800, 16 under
  2200, 12 under 2600), whatever `selectionMode` says — the human policy needs the alternatives a
  native `engine-elo` search would not score;
- the same depth cap (`automaticDepthForElo`) and the same movetime bounds.

**The extra referee search on Maia's unscored favourites (2026-09-12).** Once the referee
search and the policy answer are both in, `run()` lists Maia's **unscored** moves
(`maiaUnscoredMoves`): legal moves with `p ≥ MAIA.minProb` that start no line in the referee
result, most likely first. The trigger (`maiaExtraSearchmoves`) is

```
Σ p(unscored) ≥ MAIA.extraMassMin (0.06)   or   max p(unscored) ≥ MAIA.extraTopProb (0.12)
```

(at these values the second rule is implied by the first — a single move at 0.12 already carries
0.06 — and is kept so the two can be re-tuned apart). When it fires, exactly one more
`AnalysisRequest` goes out, `priority: "move"`:

- `searchmoves`: the top `MAIA.extraCandidates` (6) unscored moves, `multiPv` = their count;
- the same root as the main request — the same `fen` and validated `moves` history;
- full strength (`refereeElo(target, true)` → no `elo`) and the same `depth` cap, so its scores
  are directly comparable with the main lines';
- `movetimeMs = max(SEARCH_BUDGET.minMovetimeMs, min(MAIA.extraSearchMs (260), budget.movetimeMs))`
  (`extraSearchMs`): its own budget, not the main search's leftover — a fresh full-length referee
  search leaves nothing over, and a 150 ms floor on six roots is not a referee. Never longer than
  the class's own movetime; the clock is protected by `clockBoundSearch` before it is spent.

The extra lines are merged into the pool handed to `selectMove` (`mergeLines`: one line per root,
the main line kept on a duplicate, engine order, `multipv` renumbered so the merged set reads as
one frame) and into `rec.lines`, so the panel and the timing features see the same candidates
the draw did; `ctx.maiaExtra` names the roots the extra search added, for the rationale only. The
extra search is **not** spent on a clock race (Maia mode is off there), when the clock fraction
bound the main movetime (`clockBoundSearch`: `0.05 · myClockMs ≤ budget.movetimeMs`), or once the
position has moved on (an aborted signal). A failed, refused or empty extra answer leaves the
main set exactly as it was, and the draw is the 2026-09-11 draw over it.

Cache hygiene: a `searchmoves` result is not an analysis of the position. `EngineController.lookup`
never answers a `searchmoves` request from the cache, and `AnalysisCache.set` never stores one
(`test/core/engine/analysis-cache.test.ts`, `test/service/engine-controller.test.ts`).

`ownMoveBudget` takes the same `maia` flag so the §4.5 pre-analysis of the predicted position
asks for exactly the shape the own-move search will ask for: `GameSession.preAnalysePredicted`
(`session.ts`) makes the same `maiaSearchMode(...)` decision for the predicted position and takes
its `elo` from `refereeElo`, so a correct prediction is a cache hit in Maia mode as it is
outside it. The hold candidate that is built on that pre-analysis (`holdCandidate`, the piece
picked up during the opponent's turn) still draws with the engine's own selector at
`targetElo − SCRAMBLE_HOLD.eloPenalty`: a hold is a weaker, provisional move by design, and it is
chosen before the reply exists, so there is no Maia query for it.

The result is exposed on the recommendation as `rec.maia = { size, wdl, ms }` whenever an answer
arrived in budget, whether or not the selector used it; `rec.wdl` stays the engine's.

## Selector

`selectMove` (`src/core/strength/move-selector.ts`) runs the Maia branch after the mate return
and the repetition/conversion filtering, before the native-selection and base-policy branches,
when `ctx.maia` is present and `usesMaia(ctx.targetElo)` holds. The branch is
`drawMaiaMove` in `src/core/strength/maia-select.ts`:

1. **Candidates** — the usable engine lines (scored, legal, past the conversion/repetition
   filters): the referee search's MultiPV set plus the lines the extra `searchmoves` search added
   (`ctx.maiaExtra`), drawn over alike. There is no perception jitter (`σ(E)`) in this mode; every
   number below is on the raw engine score.
2. **Never-play** — a candidate is excluded when it is a mated line while an unmated alternative
   exists (no E < 1000 "deep mated allowed" draw here: Maia carries the population's mistakes and
   that rule would spend a second random number on them), when `hangsPiece` holds (the PV shows
   the opponent capturing next and the raw loss is ≥ 0.25), or when its raw win-fraction loss
   against the best raw line exceeds `lossCap(E)` — linear between the `MAIA.lossCap` knots, flat
   outside, on the effective E *including* the opponent-clock-pressure reduction.
3. **Probabilities** — Maia's `p` over the scored candidates. The scored mass (the sum of Maia's
   `p` over the *combined* scored set *before* the rails) is reported together with how many
   candidates the extra search added; below `MAIA.minScoredMass` a rationale row says the engine's
   set covered only that share, and selection still proceeds from what is scored. If no survivor
   carries `p ≥ MAIA.minProb`, the branch returns `null` and the move falls through to the
   existing base policy (the rationale says so).
4. **Draw** — `T = MAIA.temperature · (MAIA.blunderScaleFloor + (1 − MAIA.blunderScaleFloor) · blunderScale)`,
   weights `w = p^(1/T)` renormalised over the survivors with `p ≥ minProb`
   (`temperedWeights`), one `rng.weighted` draw. Exactly as implemented:

   ```
   T      = 1 · (0.5 + 0.5 · blunderScale)             # 0.5 at scale 0, 1 (Maia's own) at 1, 1.5 at 2
   w(m)   = p(m)^(1/T) / Σ_{m' ∈ S} p(m')^(1/T)        # S = scored ∧ ¬mated ∧ ¬hangs ∧ lossRaw ≤ lossCap(E) ∧ p ≥ 0.005
   ```

5. **No injected blunder channel** — §7.2 step 6 does not run; one rationale row records the `b`
   that would have applied (same `blunderTerms` inputs, `cpStd` over the raw scores) for the log.
   The opponent-pressure Elo reduction still reaches the draw through E (`selfElo` and
   `lossCap`); the opponent-only "rush" widening (τ lift, gap extra, expanded loss cap) does not
   apply, because there is no gap or τ in this mode.
6. **Finish** — through the existing `finish()`/`finishPick()`: `source: "maia"`, `rankInLines`
   is the engine rank, `top1Streak`, `previousOwnMoves`, the blunder damper countdown, `cpLoss`
   and `quality` behave as for `sampled` (a rush still marks the sample `opponent-rush`).

Rationale rows: `maia: <size> T=<T> p=<p of pick> rank <k>/<n scored> scored mass <mass> (+<e> from searchmoves) <ms> ms`
(`k` is the pick's rank in *Maia's* ordering of the scored set; the engine rank is
`rankInLines`; the `(+e …)` suffix appears only when the extra search added lines), `maia wdl: L/D/W`, `maia: no injected blunder channel (b=… would have applied)`,
plus `maia never-play: <n> line(s) excluded (loss cap …)` and the two fallback rows when they apply.

`ChosenMove["source"]` gained `"maia"`; `COPY.move.sources` in `src/panel/copy.ts` carries one
label per source (typed against the union, so a new source cannot ship without a label).

## Knobs (`MAIA` in `src/core/constants/maia.ts`)

| Knob | Value | Set from | To re-tune |
| --- | ---: | --- | --- |
| `eloMax` | 2600 | The product's Elite band edge; the paper's largest model is still measured at 2600 and the native `UCI_Elo` path is what the 2026-09-11 high-Elo probe calibrated above it. | Move only with the strength bands; `usesMaia` and the 79M size band read it. |
| `sizeBands` | 5M < 1400, 23M < 2000, 79M < 2600 | The strength slider's Club / Expert / Master lines and the feasibility study's latency ladder (≈ 20 / 50 / 180 ms single-threaded, §3.5). | Shift a band edge when the in-browser latency (open item 1) shows the larger model fits the smaller band's search window. |
| `defaultSize` | 5M | Cheapest to warm before settings are known. | — |
| `inferenceBudgetMs` | 1500 | Above the ≈ 200–300 ms 79M query and the 0.5–1 s cold session load measured in the study, so a size change mid-game costs at most one fallback move. | Lower once open item 1 confirms warm latency; it caps how long a recommendation can trail the search. |
| `temperature` | 1 | The owner's ruling (2026-09-11): run the models as advertised and take the rating they are conditioned on at face value — the draw is Maia's own distribution, neither cooled nor heated, and no calibration sweep is run against it. (An earlier draft cooled it to 0.85 on the Maia-1 observation that independent draws compound the population's mistakes; that was dropped.) | Leave at 1 unless the owner asks; the mistakes slider is the user's own heat control. |
| `blunderScaleFloor` | 0.5 | Keeps the user's mistakes slider meaningful: 0 → half as hot (near-argmax human play), 1 → `temperature`, 2 → one and a half times. | The slider's range is 0–2; change together with `temperature` so scale 1 stays the calibrated point. |
| `minScoredMass` | 0.35 | With 12–20 roots scored below 2600 plus the extra `searchmoves` lines, the combined set normally covers nearly all of Maia's mass; a position where it covers under a third is one where the extra search was skipped (clock-bound) or failed. Diagnostic threshold only — selection proceeds either way. | Raise if the rationale row appears often in logs when the extra search did run; the fix would then be a larger `extraCandidates`, not a threshold change. |
| `extraMassMin` | 0.06 | The unscored mass at which one extra referee search is worth its wall clock: a 6 % chance the human plays outside the MultiPV set is one move in sixteen — a game's worth of positions at blitz. Under it the unscored tail is renormalised away as before. | Lower to fire more often (a search per move at the floor costs 150 ms); raise if the extra search's `log.debug` shows it firing on nearly every move at a breadth of 20. |
| `extraTopProb` | 0.12 | A single unscored move carrying an eighth of the mass earns the search on its own. Implied by `extraMassMin` at the current values (0.12 ≥ 0.06); kept as its own knob so the mass rule can be raised without losing the single-favourite case. | Only meaningful once `extraMassMin` is above it. |
| `extraCandidates` | 6 | Maia's mass outside a 12–20-root set is concentrated on a handful of moves; six roots at 150–260 ms is a depth the rails can read (`hangsPiece` needs a two-ply PV) without the search costing more than the timing model's shortest holds. | Raise together with `extraSearchMs`; the count is the extra request's `multiPv`, so each root shares the movetime. |
| `extraSearchMs` | 260 | Its own budget (the main search's leftover is nothing after a fresh full-length referee search, and 150 ms on six roots is not a referee), under the shortest class base (400 ms bullet) so the extra search never outlasts a main one; never over the class's own movetime, floored at `SEARCH_BUDGET.minMovetimeMs` (150), and not spent at all when the clock fraction binds. | Measure the realised `MoveHoldTime` left tail (§13.2) with the extra search firing; if the search becomes a floor on the hold, lower it. |
| `lossCap` | 0.55 @ 800 · 0.45 @ 1400 · 0.35 @ 2000 · 0.25 @ 2600 | A hard tail guard in raw win-fraction loss, decreasing with E. Maia already plays the rating's mistakes; this only stops the one move a game that turns a won game into a lost one being drawn *because* it had 3 % of the mass. The 2600 knot equals the base policy's hang-a-piece rail (`neverPlay.hangPieceLoss`, 0.25); the 800 knot leaves room for the mistakes an 800 does make. | Compare drawn-loss tails against the engine selector's blunder channel (`C.blunder.blunderLoss` is U(0.30, 0.70)) at the same E; tighten a knot if Maia's tail is heavier than that channel's at that rating. |
| `minProb` | 0.005 | Noise floor of the masked softmax over ~30 legal moves. | — |
| `oppoFallbackSelf` | true | Maia-3 conditions on both ratings; without an opponent rating a mirror match is the neutral assumption. | Off would need a different fallback (the target, or a rating from the site). |

## Expectations against `AGREEMENT_BANDS`

`AGREEMENT_BANDS` (`src/core/strength/constants.ts`) are the §13.6 reference knots for top-1
agreement with the engine's best move and search-time ACPL. Two things change what they measure in
Maia mode and neither has been measured:

- **The root is now full strength.** `cpLoss` and `rankInLines` compare the pick against the
  best line of a full-strength search, not a `UCI_Elo`-limited one. For the same played move the
  reported loss can only go up and top-1 can only go down relative to the 2026-09-11 calibration,
  which was done on limited searches (the fixture in `test/fixtures/strength/stockfish18-blitz.json`
  is `UCI_Elo 1600`). The bands were not retuned here.
- **Top-1 is Maia's mass on the engine's best move.** At `T = 1` (the default) the expected top-1
  rate is the average over positions of Maia's `p` on the engine's first line; the mistakes slider
  moves it either way. The paper reports Maia-3's agreement with *humans* (55.4 / 56.6 / 57.1 %
  for the three sizes, §2.2 of the study), which is not the same statistic.

The owner's ruling is that the models are taken at their word: a rating asked for is the rating
played, and no sweep tunes the draw against the bands. The session strip's bands therefore
report against Maia-mode play as a diagnostic, not as an acceptance test.

## Fallbacks

Each of these is exactly today's selection for that move plus one `log.debug`; nothing in the
Maia path throws out of `selectMove` or `run()`:

| Case | Search shape | Selection |
| --- | --- | --- |
| No policy port on the pipeline | unchanged (`UCI_Elo`, native breadth per mode) | unchanged |
| Target ≥ 2600 | unchanged | unchanged (the selector ignores `ctx.maia` too, same seed → same move) |
| Clock race | unchanged | unchanged; the policy is not queried |
| Port answers `null`, rejects, throws, or is aborted | full strength, sampling breadth | engine policy on the full-strength lines; `rec.maia` absent |
| Answer later than the budget | full strength, sampling breadth | engine policy; the query is aborted |
| Nothing scored with `p ≥ minProb`, or the rails empty the set | full strength, sampling breadth | base policy (§7.2 steps 6–7) with a rationale row |
| Unscored mass under `extraMassMin` (and no single move at `extraTopProb`) | full strength, sampling breadth; no extra search | the draw over the main set |
| Main movetime bound by the clock fraction | full strength, sampling breadth; no extra search | the draw over the main set |
| The extra search fails, is refused, or answers no usable line | full strength, sampling breadth + one `searchmoves` request | the draw over the main set, exactly as without the extra search (same seed → same move) |
| Book move | full strength, sampling breadth | the book still wins first (§7.3 trap check unchanged); `rec.maia` is still set |
| Mate available | full strength, sampling breadth | `mate`, as before |

The one asymmetry worth knowing: when the port exists but the answer does not arrive, the engine
policy runs on a full-strength, broad search rather than a limited one. That is the same
candidate set the persona sampler has always been calibrated against (the fixture searches
were MultiPV 20), at a different root strength.

## Verification

Focused, all in separate Bun processes: `test/core/strength/maia-select.test.ts` (20 tests: the
tempered draw at `T = 1` and the default `T` over 2 000 draws within 3.5 points, the mistakes
slider's concentration/spread, a mated line, a hanging piece and a loss over `lossCap(E)` never
drawn with 90 % of the mass, the `lossCap` ramp with E and with opponent clock pressure,
`minScoredMass`, an unscored Maia move never returned, both fallbacks, the target ≥ 2600
identity, the mate guards, `source`/streak/quality accounting);
`test/service/game-session/recommendation.test.ts` (+12: `maiaSearchMode`, `refereeElo`,
`searchBudget`'s Maia breadth, `maiaHistoryFens`, query gating, query inputs, referee shape in
every selection mode with and without a port, `null`/rejected/never-answering ports, clock race,
book and mate precedence). The whole `test/core/strength/` suite (214) and
`test/integration/strength-pipeline.test.ts` (the real engine; still sends `UCI_Elo 1650` because
that pipeline has no policy port) pass. `bun run typecheck` is clean for these files;
`bun scripts/check-constants.ts` passes.

## Open QA items

1. **In-browser latency and memory per size.** The study's numbers are Node/onnxruntime on a
   development machine. Needed: warm p50/p95 per size in the offscreen document with Stockfish
   searching at the same time (the timing head's own measurements showed inference under
   engine load is the case that matters), and resident memory with one session loaded — the 79M
   session is the one that could not fit next to a large hash.
2. **What the session strip's bands read in Maia mode** at a few targets, as a diagnostic only —
   the owner has ruled out tuning the draw against them (the models play the rating they are
   told); if the bands are to stay meaningful below 2600 it is the bands that would move.
3. **Opponent-Elo sensitivity in the extension's regime.** `opponentElo` is wired (the session
   passes the §13.6 rating estimate when it has one) and the predicted-position pre-analysis asks
   for the referee shape; what is unmeasured is how much the second rating moves the drawn move
   against bots and against humans whose card rating is stale.
4. **How often the extra referee search fires, and what it costs.** The `recommendation: maia
   extra referee search` debug row per move (its `searchmoves` and movetime) against the
   `minScoredMass` row: at a breadth of 20 the extra search should be the exception in the opening
   and common in tactical middlegames. Its wall clock lands between the referee answer and the
   recommendation, so the §13.2 `MoveHoldTime` left tail is the thing to re-measure with it on.
5. **A cold size switch mid-game** (target crossing 1400 or 2000 by opponent matching): confirm
   it costs exactly one fallback move and that `warm` is issued from the waiting view.

## Addendum 2026-09-13 — one size ships (79M)

The owner: "remove all the maia models except the largest one (and use that for all elos — but
of course still request moves at the elo we choose etc.)". What changed against the design above,
and what did not:

- `MAIA.sizeBands` is one band (`< eloMax` → 79M); `defaultSize` and `prior.size` are 79M;
  `maiaSizeFor` answers `"79m"` for every target. The `sizeBands` and `defaultSize` rows of the
  Knobs table are therefore historical; `inferenceBudgetMs` stays 1,500 ms (below).
- **The query is byte-for-byte what it was apart from `size`**: `selfElo` is still `maiaSelfElo`
  (pressure, slider offset, context penalty), `oppoElo` the opponent's estimate or ours, the
  history window the last 8 positions. The rating is a model input; the Elo slider still decides
  whom the model imitates. `recommendation.ts` `queryPolicy` and `maia-session.ts`
  `predictedPolicyInputs` were re-read for this and not changed.
- The size never changes during a game, so the H6.3 commitment never re-commits to a different
  size, `warmPolicyFor` dedupes every warm after the first on the size, and the offscreen host
  never evicts (open item 5 above is moot; item 1's "per size" is now one measurement).
- The cold load is paid once, at the engine's first `configure` (`game-stack.ts` sends
  `warmPolicy: MAIA.defaultSize` = 79M on connect), so it precedes the waiting view rather than
  landing in it; the game-start warm (`startGame` → `warmPolicyFor(target, true)`) then finds the
  session resident and is answered with `loadMs: 0`.

Per-move cost and the browser measurements this leaves open:
[`maia-79m-only-2026-09-13.md`](maia-79m-only-2026-09-13.md).
