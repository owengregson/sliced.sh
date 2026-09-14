# Session-side Maia wiring — 2026-09-13

The session's share of `docs/research/human-move-selection-ideas-2026-09-13.md`: H7.3 (pre-infer
the predicted position), H6.3 (one Maia size per game), H8 (Maia for the fast moves: the hold and
the premove gate), H14.1 (a persistent opening repertoire), H2's copy (the mistakes knob is an
accuracy offset) and §3.2's fidelity meters on the Engine view. Lane 2 owns the pipeline
(`recommendation.ts`, `move-selector.ts`, `maia-select.ts`); this lane feeds it and reads its
output. Offline coverage is listed per item; what only a browser can answer is in
`docs/qa-checklist.md` §B7.

## What changed, and why

### H7.3 — the predicted position is pre-inferred (`session.ts`, `maia-session.ts`)

`preAnalysePredicted` already built the predicted FEN and its history during the opponent's turn
and searched it at the own-move budget. It now also issues the Maia query for that position at
the same moment (`preInferPredicted`), with the inputs the own-move pipeline uses —
`predictedPolicyInputs`: the game's committed size, `maiaHistoryFens` over the history through the
expected reply, `selfElo` from the pipeline's own `ownMoveMaiaElo` over the same
`OwnMoveBudgetInput` the pre-analysis is sized by (the predicted position, the clocks as they
stand, `pressureTerms`, the slider offset, H5's context penalty), the opponent's rating (ours
when unknown). The answer is held as `predictedPolicy = { fen, result, selfElo,
historyPlies }` beside `predictedAnalysis`.

When the next position arrives, `onPosition` keeps the answer exactly when it is for that board
(`policyAnswerFor`: placement, side, castling and a usable en-passant square — the counters and
the bridge's en-passant spelling are not identity) and re-keys it to the page's FEN string, so the
pipeline's exact-match check hits; any other position drops it, and `cancelInFlight` aborts a
query still in flight. `runPipeline` passes it as `RecommendationInput.policyAnswer`.

**Lane 2 contract.** The pipeline consumes `policyAnswer` when `fen === snapshot.fen` (no
second query for that ply) and reads `maiaSize`; the pre-inference's `selfElo` is
`ownMoveMaiaElo` over the same `OwnMoveBudgetInput` the pre-analysis was sized by, so pressure,
the slider offset and H5's context penalty agree with the own-move query by construction (the
H15 prior's 79M and `topCalibratedElo` clamp included).

### H6.3 — one Maia size per game (`session.ts`, `maia-session.ts`)

`startGame` commits `gameMaia = commitMaiaSize(target)` — the band's size below `MAIA.eloMax`,
`MAIA.prior.size` (79M) from there to `LIMITS.eloMax`, none above — and every
`RecommendationInput` of the game carries it as `maiaSize`. The game's first pipeline run locks it
(`gameMaiaLocked`): from then on an opponent-matched target drifting across a band edge neither
re-warms nor changes the size the pipeline is told to use. Two deliberate exceptions:

* **Before the first move** the commitment follows the target. The opponent's rating arrives with
  the game, usually before ply 1, and that is still "game start"; `maia-warm.test.ts` pins the
  re-warm on that arrival.
* **An explicit settings change** of `strength.targetElo` or `matchOpponentRating`
  (`commitmentSuperseded`) re-commits from the current derived target and unlocks until the next
  move locks it again — the user asked for a different player.

Warming is unchanged in scope: only `usesMaia` targets warm (the prior's 79M above 2600 is not
pre-warmed; `maia-warm.test.ts` asserts no warm at or above the ceiling and that test is not this
lane's to change).

### H8 — Maia for the fast moves (`session.ts`, `premove.ts`)

* **The hold.** `readyMoveFrom` builds its `SelectionContext` as before, then
  `attachPredictedPolicy` sets `ctx.maia` when `predictedPolicy` is for the hold's position. The
  selector does the rest (rails, the draw); the rationale says "a Maia draw over the pre-analysed
  lines". `settleHold` is unchanged as a mechanism — the legality + hang check is the stale-hold
  check for a Maia-drawn hold too; its log line now says whether the hold was a Maia draw.
* **The premove gate.** `PREMOVE.maiaMinProb = 0.15` (`books.ts`). `maiaPremoveGate(fen, q,
  policy)` passes when there is no answer for that position, else requires `p_maia(q) ≥ 0.15`.
  `premoveCandidate` applies it through the optional `PremoveContext.policy`; because `armPremove`
  runs *before* the pre-inference (its own reply search is the prediction), the session applies
  the same gate after the answer lands (`gatePremoveWithPolicy`): an armed premove the model would
  not play is dropped, a premove already entered on the site is the site's and is left.

### H14.1 — a persistent opening repertoire (`book/repertoire.ts`, `repertoire-storage.ts`, `book-policy.ts`)

`LOCAL_KEYS.repertoire = "sl::repertoire"` holds `{ w, b, createdAt }` — one random 32-bit value
per colour from `crypto.getRandomValues`, created on first use. The book sampler's rng is now
`createRng(hash(key[colour], polyglotKey(fen)))` instead of the per-game `rng`, so the same
position draws the same book move every game for this profile; the weak-target early exit keeps
its per-game draw, and everything the opponent steers elsewhere varies as before. Without keys
(no storage, a failed read, the harness) the per-game `rng` decides exactly as before.
`BookPolicy.prepare()` reads the keys at `startGame`. The rationale carries "· repertoire".

**Not done:** a "Reset repertoire" control. It needs a new panel command in the `MSG` registry,
a handler and a settings row — not trivial inside this lane's file ownership.
`resetRepertoireKeys()` exists for it; the interim reset is removing `sl::repertoire` from
`chrome.storage.local` (DevTools › Application, or the extension's Reset in Advanced if it clears
all keys).

### H2 — the mistakes knob is an accuracy offset (`copy.ts`, `sections.ts`)

`strength.blunderScale` keeps its key and unit. The forced-row reason and the (currently
unrendered) row copy now describe an Elo offset around the target, `MAIA.slider.eloSpan ·
(blunderScale − 1)`, with the span read from `MAIA.slider.eloSpan` (`accuracyOffsetHelp`,
`accuracyOffsetForced`).

### §3.2 — fidelity meters on the Engine view (`engine.ts`, `engine.html`, `engine.css`, `copy.ts`)

The Human-model block gains a key/value list (`[data-meter=…]`) shown whenever `rec.maia` carries
the fields: history plies (`n/8 plies`), the rating asked at, and — when the selector drew from the
model (`rec.maia.meters`) — entropy, railed mass, unscored mass, KL from Maia, rank of survivors,
and `k @ depth d` for the generate-and-verify path. A warn-coloured line "History unavailable —
the model sees one frame" appears when `historyPlies < 8` past ply 8 (H7.1). Rows the answer does
not carry are hidden, not blank. An answer on a recommendation above `MAIA.eloMax` (H15's prior)
is shown too.

## Offline coverage

| Item | Test |
|---|---|
| H7.3 inputs (incl. the H15 prior clamp), position identity, hold attachment | `test/service/game-session/maia-session.test.ts` (9) |
| H7.3 on the simulator: query issued, carried into `policyAnswer`, aborted on another reply; H6.3 lock and re-commit; H8 gate after the arm | `test/service/game-session/session-maia.test.ts` (4) |
| H8 gate, pure and inside `premoveCandidate` | `test/core/strength/premove.test.ts` (+3) |
| H14.1 seed, determinism across sessions, divergence across keys, storage create/read/reset | `test/core/strength/book/repertoire.test.ts` (9) |
| Meters and the history warning | `test/panel/views/engine.test.ts` (+3) |
| H2 copy | `test/panel/views/settings.test.ts` (+1) |

## How to verify in a browser

`docs/qa-checklist.md` §B7 has the table. In short: the Engine view's Human-model block and the
worker log (`game-session: pre-inferred the predicted position`, `… premove dropped — the human
model would not play it here`, `ready move: a Maia draw …` in the rationale) are the observables;
the repertoire is verified by playing the same colour twice from the same opening and reading the
book rationale (`polyglot … · repertoire`).
