# Pipeline frames: the merged referee pool, one Maia rating, the human-depth frame — 2026-09-13

Lane 1b of the roadmap in
[`docs/research/human-move-selection-ideas-2026-09-13.md`](../research/human-move-selection-ideas-2026-09-13.md):
§7 A1–A4 (the merged extra-search frame), B2 + H2 + H5 (one rating for the query and the rails),
H7.3 / H6.3 (a held policy answer, a committed size), H4 (the human-depth frame), H15 (the
79M prior above 2600) and H14.2 (Maia plays the opening below 1700). Everything here is in the
pipeline (`src/service/game-session/recommendation.ts`), the quality module
(`src/core/strength/quality.ts`), the engine client / cache / controller and the constants
registries. The selector (`move-selector.ts`, `maia-select.ts`) is lane 1a's and is only *read*
here: the pipeline hands it `SelectionContext.contextEloPenalty`, `shallowLines` and
`shallowDepth`, and copies `chosen.maiaMeters` out.

Nothing about *when* or *how* a move is played changes (C7). The one timing-owner flag this lane
sets is `TimingContext.inBook`, described under H14.2.

## 1. The merged extra-search frame (§7 A1–A4)

The 2026-09-12 extra referee search (`go searchmoves` on Maia's unscored favourites, 260 ms over
up to six roots) produces a frame one to three plies shallower than the main one. Before this
change `mergeLines` interleaved the two by score, so a shallow optimistic line could become
`lines[0]` — `rec.eval`, the panel's PV, `timingCtx.lines[0]` and, through
`rankedLines(lines)[0]`, `topCpRaw` and therefore every candidate's `lossRaw` in the rails.

**What changed.**

| Item | Where | Rule |
| --- | --- | --- |
| A4 | `extraSearchMs(budget)` | The dead `elapsedMs` parameter is gone; the JSDoc says what the body does (its own budget, capped by the move's movetime, floored at `minMovetimeMs`). |
| A3 | `run()` | The extra frame is merged only when `extra.final.complete` is true; an incomplete frame is one `log.debug("recommendation: extra referee frame incomplete, ignored")` and the main set stands (same seed → same move as without the extra search). |
| A1 | `mergeLines(main, extra)` | The main frame first in its own order, the extra frame **appended** in its own order, `multipv` renumbered. No comparator is used. `lines[0]` is therefore always a main-search line. |
| A1 | `rankedLines(lines)` | The **reference** (rank 1) is the best line of the *primary frame* — the frame the first usable input line belongs to (the main frame after `mergeLines`) — chosen with `compareLines` inside that frame. A line from another frame can outrank it only by score *class* (a searched mate is a mate whichever search found it), never by centipawns. Every other rank is `compareLinesForMerge`. |
| A1 | `compareLinesForMerge(a, b)` (new, exported) | `compareLines` plus: two centipawn lines at different depths within `SEARCH_BUDGET.mergeTieCp` (15) are a tie broken towards the deeper line. Outside the band the scores order the lines. |
| A2 | `moveQuality` | `depth-mismatch` only when `\|best.depth − chosen.depth\| > SEARCH_BUDGET.qualityDepthTolerance` (4), both depths already ≥ `C.quality.minDepth`. Inside the tolerance the move is an eligible `cpLoss` sample measured against the pinned reference. |

**Which comparator each consumer uses.**

| Consumer | Comparator | Note |
| --- | --- | --- |
| `mergeLines` (pipeline) | none — input order, main first | The reference for `rec.eval`, the panel, `timingCtx.lines`. |
| `rankedLines` (quality) | pinned primary-frame best, then `compareLinesForMerge` | Feeds `moveQuality`'s `best`, the selector's `originalRanks` / `topCpRaw` / `rankInLines`, `lineFacts` (book trap check), `board-effects`. |
| `moveQuality` | via `rankedLines` | `cpLoss` against the pinned reference. |
| `selectMove`'s own `ranked` (selector, lane 1a) | `compareLines` | Its sort of the post-filter `usable` pool; not the reference. |
| Single-frame pools everywhere | identical to before | All lines share one depth, so the pin is the `compareLines` best and the tie band never fires. |

A known limit: frames are identified by depth. If the extra search happens to reach exactly the
main frame's depth the two are one frame to `rankedLines` and an optimistic extra line can rank
first. The engine's MultiPV at equal depth would have ranked that root inside the main set if it
really scored there, so this is a small window; `mergeLines`' order still protects `rec.eval`.

**Tests.** `test/core/strength/quality.test.ts` (8): the tolerance both sides of 4 plies, the
`shallow` precedence, `compareLinesForMerge` in and out of the band and across classes, the pinned
reference against an optimistic +99 shallow line (`cpLoss` of a main line stays 10, of the extra
line 0), the in-band tie, a deeper extra frame, a shallow mate as reference.
`test/service/game-session/recommendation.test.ts`: `extraSearchMs` one-argument, `mergeLines`
append order, "(A1) an optimistic shallow extra line never changes rec.eval nor the loss
reference" over 16 seeds, "(A3) an incomplete extra frame is ignored", and the 2026-09-12 (a)
test now expects an eligible sample with `cpLoss` 0 and `rankInLines` > 1 for the extra pick.

## 2. One rating: the query, the rails and the human frame (§7 B2, H2, H5)

`ownMoveMaiaElo(input: OwnMoveBudgetInput, settings)` (new, exported, pure) is the one place the
Maia rating is computed:

```
pressure   = pressureTerms({ fen, myClockMs, oppClockMs, baseMs, incrementMs })     // selection-elo.ts
context    = maiaContextPenalty({ myClockMs, baseMs, plannedThinkMs, tc })          // H5, below
selfElo    = maiaSelfElo({ targetElo, form, blunderScale, pressureReduction: pressure.pressureReduction,
                           contextEloPenalty: context.penalty })                      // selection-elo.ts
```

`run()` computes it once when `maia || prior` and passes `contextEloPenalty` into
`SelectionContext` (`choose`), so the selector's rails judge at the rating the query was issued
at. `maia-selection-2026-09-11.md` §Pipeline said the query used `effectiveElo(target, form)`,
"the same E the selector computes"; that was false under opponent clock pressure (up to 100 Elo
apart) and is corrected there with a dated note.

**H5's pipeline half — `maiaContextPenalty`.**

```
clockPressure = clamp(1 − myClockMs / baseMs, 0, 1)                    (0 when baseMs is 0 / unknown)
shortThink    = clamp(1 − plannedThinkMs / MAIA_CONTEXT_THINK_REF_MS[tc], 0, 1)   (0 when untimed)
penalty       = min(MAIA.context.maxPenalty,
                    clockElo·clockPressure + thinkElo·shortThink + interactionElo·clockPressure·shortThink)
```

`plannedThinkMs` is `estimatedThinkMs` — the plan-independent allocation the search budget is
already sized by (the design's "reads the timing model, changes none of it"). The ambiguity term
is the selector's (Maia's own entropy, lane 1a).

| Constant | Value | Set from |
| --- | ---: | --- |
| `MAIA_CONTEXT_THINK_REF_MS` (`search.ts`) | bullet 1 500 · blitz 5 000 · rapid 15 000 · classical 30 000 · untimed 0 | The fresh-game `estimatedThinkMs` measured 2026-09-13 at ply 20, default persona, `speedScale` 1: 1+0 ≈ 1.6 s, 2+1 ≈ 4.2 s, 3+0 ≈ 4.9 s, 3+2 ≈ 6.9 s, 5+0 ≈ 8.1 s, 10+0 ≈ 16 s, 15+10 ≈ 35 s, 30+0 ≈ 50 s — rounded down so an increment game reads as unhurried. Note a fresh 3+0 sits 3–4 Elo under the blitz reference. |
| `MAIA.context.*` | seeded (clockElo 120, thinkElo 100, interactionElo 130, maxPenalty 350, eloFloor 400) | Lane 0; the three weights sum to the cap, so an empty clock with no think is exactly the cap. |
| `MAIA.slider.eloSpan` | 250 (seeded) | H2: `selfElo` moves ∓ 250 for slider 0 / 2. |

**Observability (H7.1 / §7 D3).** `rec.maia` now carries `selfElo` (the rating the query was
issued at), `historyPlies` (positions the query carried, 1 = the degenerate no-history case) and
`meters` (copied from `chosen.maiaMeters` when the selector fills it). A query carrying fewer than
`MAIA_INPUT.history` positions at ply ≥ 8 logs
`recommendation: maia query carried a short history` at debug.

**Tests** (`recommendation.test.ts`, "one rating…"): `maiaContextPenalty` term by term, the
interaction, the cap, untimed and unknown-base cases; under opponent pressure (opponent at 12 s of
3+0 — pressure ≥ 0.35, not a race) the query's `selfElo` equals `maiaSelfElo` of the same
`pressureTerms`; slider 0 / 1 / 2 → 1750 / 1500 / 1250; a 30 s own clock lowers `selfElo` through
the context term and a 500 target under the worst context floors at `MAIA.context.eloFloor`;
`historyPlies` 8 with a validated history, 1 without.

## 3. A held answer and a committed size (H7.3, H6.3)

`RecommendationInput.policyAnswer = { fen, result, selfElo, historyPlies }` (seeded): when
`fen === snapshot.fen` **and** the move is in Maia or prior mode, it is used as the answer — no
query goes out, `rec.maia.selfElo` / `historyPlies` come from it. Any other `fen`, a clock race or
no port ignores it. `RecommendationInput.maiaSize` (seeded) is the size queried when present,
else `maiaSizeFor(targetElo)`; the H15 prior always asks `MAIA.prior.size`.

The rails still judge at the rating `run()` computes for *this* move (the held answer's own
`selfElo` is reported, not re-derived); a held answer inferred a few seconds earlier on the same
board differs from it only by the clock terms.

**Tests**: "H7.3: a held policy answer for exactly this board…" and "H6.3: the session's
committed size…".

## 4. The human-depth frame (H4)

`AnalysisRequest.featureDepth?: number` (default `LIMITS.featureDepth` = 10). The UCI client
captures `atFeatureDepth` as **the first complete MultiPV frame at or past the requested depth**,
refreshed while that same depth is re-emitted, never replaced by a deeper one. With the field
absent a complete frame at exactly 10 is captured as before; the one behavioural change to the
default is that a search which never completes depth 10 but completes 11 now captures 11 (it used
to capture nothing). The deepest-not-exceeding frame is deliberately *not* what is kept.

`humanDepth(selfElo)` (`depth-policy.ts`) reads the `HUMAN_DEPTH` knots in `search.ts`:
800 → 2, 1200 → 4, 1600 → 6, 2000 → 8, 2400 → 10; flat outside, linear and rounded between
(1500 → 6, 1800 → 7, 2200 → 9). The 2400 knot is `LIMITS.featureDepth`, so above it nothing about
the request or the cache key changes.

**Cache identity.** `cacheKey(..., featureDepth)` appends `|f<depth>` only for a non-default
depth (existing keys are byte-identical); `AnalysisCache.get(..., featureDepth)` requires the
stored request's frame to match; `EngineController.lookup` passes `req.featureDepth`. A result
carries only the one frame it was asked for, so this is a hard identity, not a "≥" gate.

**Where it is set.** `SearchBudget.featureDepth?: number`, filled by `ownMoveBudget` when
`input.maia` is true, as `humanDepth(ownMoveMaiaElo(input, settings).selfElo)`. `runSearch` copies
it onto the request. `ownMoveFeatureDepth(input, settings)` is the same computation on its own.
Because the session's `preAnalysePredicted` already calls `ownMoveBudget({ ...position, maia },
settings)`, **the pre-analysis asks for the same frame automatically** — provided it passes the
same `maia` (and now `maiaPrior`) it does today. Small drift: `selfElo` depends on the opponent's
clock through `pressureTerms`, which moves between the pre-analysis and the own move; a change
that crosses a rounding boundary of `humanDepth` (one depth per 200 Elo) is a cache miss for that
move, not a wrong answer.

**In `choose`.** When the move is in Maia mode and `analysis.atFeatureDepth.complete` is true,
`ctx.shallowLines = usableLines(atFeatureDepth.lines)` and `ctx.shallowDepth` are set, and one
debug row `recommendation: human-depth frame { shallowDepth, deepDepth, deepBest, shallowBest,
agree }` is written per move — roadmap step 4's "which engine-found tactics does a human at R
miss". The shallow frame never reaches `rec.eval`, `rec.lines` or `rec.depth`.

**Tests**: `depth-policy.test.ts` (`humanDepth` knots, interpolation, monotonicity, malformed);
`uci-client.test.ts` (5 in "atFeatureDepth": exact 10, skipped 10 → 11, nothing completed,
requested 4, skipped 4 → 6, re-emitted 4 refreshes and 5 does not replace);
`analysis-cache.test.ts` (key segment, frame-matched `get`); `engine-controller.test.ts` (a
human-frame request misses the default result and hits its own, and vice versa);
`recommendation.test.ts` ("the human-depth frame": the budget carries `humanDepth(selfElo)` only
in Maia mode, the slider moves it, the request carries it and the fallback path does not, the
shallow frame never reaches `rec.eval` / `rec.lines`).

## 5. Maia-79M as a prior above 2600 (H15)

`maiaPriorMode({ targetElo, policy, clockRace })` = `policy && !clockRace &&
usesMaiaPrior(targetElo)` (2600 ≤ target < 3800). `maiaSearchMode` is untouched below 2600 and
the two never overlap. In prior mode:

- the query is `size: MAIA.prior.size` (79M) at `selfElo = min(maiaSelfElo(...),
  MAIA.prior.topCalibratedElo)` (2700);
- the referee keeps the native strength (`refereeElo(target, maia = false)` → `UCI_Elo` up to
  3190, unlimited above) and asks for `SEARCH_BUDGET.priorCandidates` (12) roots — the six the
  native path asks for (`high-elo-selection-2026-09-11.md`, "Exact policy boundaries") leave
  nothing to break a tie among. `SearchBudgetInput.maiaPrior` / `OwnMoveBudgetInput.maiaPrior`
  carry the decision; `searchBudget` uses it only when the sampling breadth does not already
  apply, and never below a configured `engine.multiPv`;
- no extra referee search, no human frame (`humanDepth` ≥ 2400 is the default anyway);
- `rec.maia` is filled as below 2600. Whether the selector uses it is lane 1a's branch; the
  engine's `bestmove` path is unchanged when it does not.

`LIMITS.eloMax` (3800) stays the pure-engine escape hatch: no query of either kind.

**Tests**: `high-elo-budget.test.ts` (`maiaPriorMode` boundaries, disjointness from
`maiaSearchMode`, the 6 → 12 breadth on the native shape, no human frame);
`recommendation.test.ts` ("Maia-79M as a prior above 2600": 2600 / 2700 / 3000 query 79M at the
capped rating with the native referee at 12 roots, no extra search, 3800 asks nothing).

## 6. Maia plays the opening below 1700 (H14.2)

`maiaPlaysOpening({ targetElo, form })` = `usesMaia(target) && effectiveElo(target, form) <
BOOK.maiaOnlyElo` (1700, `src/core/constants/books.ts`). `run()` applies it **after** the policy
answer is in: with an answer, the book's move is discarded (`book = null`, one debug row) and
Maia draws the opening; without one (late, `null`, rejected, no port, clock race) the book answers
exactly as before. So the "engine-fallback keeps the book" case holds on the answer, not merely
on the port's existence.

**Timing-owner flag.** `TimingContext.inBook` is set when the book *would have answered*
(`bookAnswer !== null`, whether or not Maia overrode it) **or** — only when Maia overrode the
book — when `snapshot.ply ≤ BOOK.maxPly` (30) and the chosen move's Maia probability is ≥
`BOOK.maiaOpeningMinProb` (0.3). Above 1700 nothing changes. The timing model's
`bookSpeed` speed-up is therefore unchanged in behaviour for positions the book knows, and an
early move Maia is confident of gets it where the book had no entry. `RecommendationOutcome.fromBook`
stays "the book's move is the recommendation's basis" (false when Maia overrode it). The timing
features' own early-top-line rule (`bookMaxPly` 16) is untouched.

**Tests**: `recommendation.test.ts` ("Maia plays the opening below BOOK.maiaOnlyElo"):
`maiaPlaysOpening` by effective E and form; the book stands down for Maia at 1500 with
`in_book` 1 and `fromBook` false, answers at 1700, answers on a `null` policy answer and without
a port; out of book at ply 20 a 0.97 move is `in_book` 1, at ply 31 it is 0, and at 1800 it is 0.

## Constants added

| Registry | Name | Value |
| --- | --- | ---: |
| `SEARCH_BUDGET` | `priorCandidates` | 12 |
| `SEARCH_BUDGET` | `mergeTieCp` | 15 |
| `SEARCH_BUDGET` | `qualityDepthTolerance` | 4 |
| `search.ts` | `HUMAN_DEPTH` | [800, 2] [1200, 4] [1600, 6] [2000, 8] [2400, 10] |
| `search.ts` | `MAIA_CONTEXT_THINK_REF_MS` | bullet 1 500 · blitz 5 000 · rapid 15 000 · classical 30 000 · untimed 0 |
| `BOOK` | `maiaOnlyElo` | 1700 |
| `BOOK` | `maiaOpeningMinProb` | 0.3 |

## Verification

Each file in its own Bun process (2026-09-13): `test/core/strength/quality.test.ts` 8,
`test/core/engine/depth-policy.test.ts` 3, `test/core/engine/uci-client.test.ts` 51,
`test/core/engine/analysis-cache.test.ts` 17, `test/service/engine-controller.test.ts` 29,
`test/service/game-session/high-elo-budget.test.ts` 9,
`test/service/game-session/recommendation.test.ts` 75, all 40 files under
`test/behavioral/game/` (277 tests), `test/integration/strength-pipeline.test.ts` (the real
engine, 1). Read-only: `test/core/strength/move-selector.test.ts` 33 and
`test/core/strength/maia-select.test.ts` 22 pass unchanged. `bunx tsc --noEmit` is clean for
these files; `bunx biome check` on them is clean.

## 7. One Maia-shaped search (H10)

Lane 1b, second pass (2026-09-13, later the same day). Below `MAIA.eloMax`, with a port and no
clock race, the referee search is **one** search whose roots Maia chose — not a broad MultiPV
12–20 search followed, when ≥ 6 % of Maia's mass was unscored, by a 260 ms `go searchmoves` on six
roots. Every candidate is scored in one frame at one depth, so the merged-frame defects of §1
(A1: a shallow optimistic line as the reference; A2: `depth-mismatch` on exactly the moves the
extra search enabled) are unreachable on this path; §1's machinery is untouched and still guards
the fallback. Behind `MAIA_SEARCH.shaped.enabled` (`src/core/constants/search.ts`); `false`
restores the previous pipeline byte for byte.

**The shape.** `shapedRootSet(policy, fen, knownTopMoves)` (pure, exported from
`recommendation.ts`):

```
ranked   = Maia's legal moves for fen, p descending (ties by UCI), duplicates folded to the max
roots    = ranked[0..k]  until  Σp ≥ massCover (0.95) · Σ_all p,   at most maxRoots (12)
         ∪ the first knownTopMoves (3) legal entries of knownTopMoves not already in the set
         ∪ ranked[k..]   until  |roots| ≥ minRoots (4)
→ sorted (the cache keys on the set; the same inputs give the same `searchmoves` whatever order
  Maia's list arrived in)
```

`shapedSearchPlan(policy, fen, knownTopMoves, budget)` wraps it: `searchmoves` = the set,
`multiPv` = its size, `movetimeMs` = the class budget's (H17 below), `depthCap` and
`featureDepth` as `ownMoveBudget` set them. Full strength (`refereeElo(…, maia = true)` →
no `elo`), `priority: "move"`, `AnalysisRequest.shaped = true`.

**When.** In `run()`, once `maia` is decided: a held answer for exactly this FEN
(`input.policyAnswer`, H7.3) shapes at once; otherwise the fresh query is waited on for
`policyFirstMs` (120 ms) from the moment it went out, and a miss leaves the query running for the
selector (`awaitPolicy(query, signal, withinMs)` does not abort on this bound; the final
`MAIA.inferenceBudgetMs` wait is unchanged). Fallback = the broad search + the extra-search path,
exactly as before. A clock race (`maia` false) and the H15 prior (`prior`, 12-root native search)
never shape.

**The known top moves.** The panel's eval must come from a root set that contains the engine's
best move. The session forces it in: `knownTopMovesFor(ponderLines, reply, extra)`
(`maia-session.ts`) takes the continuation of every ponder line on the opponent's position that
starts with `reply` (`pvUci[1]`) and the §7.4 premove's own pick for the predicted position, at
most 3. They travel on the held answer — `PredictedPolicyAnswer.knownTopMoves` /
`RecommendationInput.policyAnswer.knownTopMoves` — and are present **exactly when the
pre-analysis was shaped with them**, so the own-move set is the identical set (the pre-analysis
symmetry below). Without them (a fresh answer on our turn; a late pre-inference) the search runs
over Maia's roots alone and one debug row says so
(`recommendation: shaped search over maia roots only`). The brief's `input.knownTopMoves` became
a field of `policyAnswer`: the two are only meaningful together (the root set is a function of
both) and it needs no change at the session's `pipeline.run` call site.

**Cache identity.** `cacheKey(…, searchmoves)` appends `|sm:<sorted csv>` only for a restricted
search (existing keys byte-identical); `AnalysisCache.get(…, searchmoves)` requires the stored
request's set to be the same set (`sameSearchmoves`: order-insensitive; an unrestricted result
never answers a restricted request and vice versa); `AnalysisCache.set` stores a restricted result
only when `request.shaped === true`; `EngineController.lookup` answers a restricted request only
when it is flagged. The extra referee search (unflagged) keeps the never-cached rule.

**Pre-analysis symmetry (the proof that a correct prediction is still a cache hit).**
`preAnalysePredicted` (`session.ts`) computes, for the predicted position:

1. `budget = ownMoveBudget({ …position, maia, maiaPrior })` — as before (same `multiPv`,
   `movetimeMs`, `depthCap`, `featureDepth` the own move computes; §4's small `humanDepth` clock
   drift is unchanged);
2. `knownTopMoves = knownTopMovesFor(ponderer.latestLines(opponentFen), reply, premovePick)`;
3. `preInferPredicted(...)` now returns the held answer; the pre-analysis waits on it for
   `preInferWaitMs` (300 ms, their clock) via `settledWithin`;
4. with an answer: `shaped = shapedSearchPlan(answer.result, predicted, knownTopMoves, budget)`,
   the request gets `searchmoves` / `multiPv` / `limit.movetimeMs` from the plan and
   `shaped = true`, and the held answer is re-held as `{ …answer, knownTopMoves }`.

On our move, `policyAnswerFor` re-keys that same object to the page's FEN and the pipeline calls
`shapedSearchPlan(held.result, snapshot.fen, held.knownTopMoves, ownMoveBudget(sameInputs))`
— the same pure function on the same `PolicyResult`, the same known moves and the same budget, so
`searchmoves`, `multiPv`, `limit.movetimeMs` and `featureDepth` are identical, `elo` is absent on
both, and `lookup` hits on `(position, moves) | multiPv | full | featureDepth | sm:<set>` with
`final.depth ≥ depthCap − 2`. Verified end to end in `session-maia.test.ts` ("H10 — the
pre-analysis is shaped exactly as the own-move search"): one `go … searchmoves` on the wire for
the whole exchange, the own move's `policyAnswer.knownTopMoves` equal to the ponder continuation,
and the recommendation's lines exactly the pre-analysis's roots. Why the known moves must be
*carried* rather than recomputed from `predictedAnalysis`'s top-3: the pre-analysis's own top-3
need not contain the ponder's guess, so a recomputation could differ by one root and miss.

**Timing / `preInferWaitMs` vs `policyFirstMs`.** The brief asked for the same bound on both
turns. On our turn 120 ms covers the 5M (≈ 20 ms) and 23M (≈ 50 ms) queries; the 79M
(≈ 180–300 ms) would then never get a shaped pre-analysis, and the 2000–2600 band would lose the
cache hit it has today. The opponent-turn bound is therefore its own constant (300 ms): it costs
pre-analysis depth on their clock, not ours. A pre-inference that lands after it is still held
(the own move then shapes over Maia's roots alone, a fresh search — the cold-path cost).

**Fallback test harness.** The 2026-09-12 extra-search tests are now the fallback path by
construction (`fallbackPipeline` in `recommendation.test.ts`): the port answers only once the
engine has been asked — an `async` port settles in a microtask, before the 0 ms fallback timer —
and the clock steps past `policyFirstMs` on every reading. `ScriptedEngineTransport` honours
`go … searchmoves` (a real engine reports only those roots; without this the UCI client rejects
every frame of a restricted search and it never completes).

**H17 item 2 — a confident Maia shortens the search.** In `shapedSearchPlan`, when Maia's top
move carries `p ≥ MAIA_SEARCH.shaped.confidentProb` (0.8): `movetimeMs = max(minMovetimeMs,
movetimeMs − confidentTimeFraction · (movetimeMs − minMovetimeMs))` (0.5; 600 → 375 for blitz,
150 stays 150). The panel still gets an eval from the shaped frame at the floor. Only the
**search** time changes — the timing model's planned think, the executor and every C7 property
are untouched (`ShapedSearchPlan.confident` records it; `RecommendationOutcome.budget` is the
plan's budget). Because the shrink is inside the plan, the pre-analysis applies it identically
and the cache key's `t<ms>` segment agrees.

**Constants added (`MAIA_SEARCH.shaped`, `src/core/constants/search.ts`).**

| Name | Value |
| --- | ---: |
| `enabled` | true |
| `policyFirstMs` | 120 |
| `preInferWaitMs` | 300 |
| `massCover` | 0.95 |
| `minRoots` | 4 |
| `maxRoots` | 12 |
| `knownTopMoves` | 3 |
| `confidentProb` | 0.8 |
| `confidentTimeFraction` | 0.5 |

`AnalysisRequest.shaped?: true` (`src/core/engine/types.ts`) is the only type change outside
this lane's files.

**Tests.** `recommendation.test.ts` (82; "one Maia-shaped search": the root set — cover, fill,
forced known moves, cap and the known moves riding over it, sorted determinism, empty; the plan
and the H17 shrink and floor; a held answer with known moves → exactly one shaped request, no
extra search, one frame at one depth, `quality.eligible`, b1c3 drawable over 12 seeds; a fresh
answer inside the bound shapes over Maia's roots, a slow one takes the broad search + extra
search and still reaches the selector; a clock race and the prior untouched; H17 in `run()` and
the outcome's budget; the 2026-09-11 breadth test now asserts the shaped request),
`analysis-cache.test.ts` (19; the `sm:` key segment, a `shaped` result stored and answered by
the same set only, unflagged still never stored), `engine-controller.test.ts` (30; a flagged
request cached and answered in another root order, another set / unrestricted / unflagged all
reach the engine, the unflagged one not stored), `session-maia.test.ts` (5; the symmetry test
above). All 40 files under `test/behavioral/game/` pass (226 tests, each file its own process);
`test/service/game-session/*`, `uci-client.test.ts` and `test/integration/strength-pipeline.test.ts`
(the real engine, 1) pass unchanged. `bunx tsc --noEmit` is
clean for every file here (the one error in the tree is
`test/core/strength/generate-verify-wiring.test.ts:253`, lane 1a's); `bunx biome check` on the
12 touched files is clean; `bun scripts/check-constants.ts` exits 0.

**Not done.** `enabled = false` has no test (the registry is `as const`; a test would need to
mutate it). The panel's search-time observability (`rec.depth` / `nps` already show the shaped
frame) got no new field. The "deep on the top, shallow on the tail" half of H17 is not
implemented — the single MultiPV search over the union already orders the engine's effort, and
the research doc makes the split conditional on measurement.

## Open items

1. ~~The frame-by-depth limit in §1 (an extra frame at exactly the main depth).~~ Unreachable on
   the shaped path (§7); still the fallback's limit when the answer misses `policyFirstMs`.
2. The `humanDepth` cache drift in §4 is expected to be rare; the debug row
   `engine-controller: cache hit` against the pre-analysis row in a live Maia-mode game is the
   measurement.
3. `MAIA_CONTEXT_THINK_REF_MS` is a design table, not a calibration: H5's validation is the
   per-clock-quartile comparison against human games in the research doc's §8.
