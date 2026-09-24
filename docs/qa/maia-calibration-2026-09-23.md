# Maia strength calibration against chess.com players (2026-09-23, v2 2026-09-24)

Owner: "the mistake probability seems a bit too high for certain elos … it is still blundering some
games at rated 2836 … use actual games … mathematically verify we are playing at the right elo,
making mistakes at the rate that a player of that elo would make."

This note records what was measured, what shipped (`MAIA_CALIBRATION` in
`src/core/constants/maia-calibration.ts`) and how it was verified. The harness is
`tools/calibration/` (its README has the pipeline and the commands); every number below is
reproducible from it. It supersedes the 2026-09-11 ruling to run Maia at face value (T = 1,
conditioned at the target).

## What changed in the product

- For each chess.com time class (bullet / blitz / rapid, chess.com's own rule on `base + 40·inc`,
  verified on 30 611 games) and advertised rating, the table gives **the rating Maia-3 is
  conditioned at** and **the temperature its whole answer is reshaped at** (`temperPolicy`) before
  the rails, verification and draw. `maiaSelfElo` maps the target (less the mistakes slider's
  offset) through the table, then applies the context terms as before; the pipeline query and the
  selector read the same time class from the game's clock.
- The slider, persona offset and opponent matching are unchanged: they move the *target*, and the
  target now means a chess.com rating in the game's time class.
- Unknown time control → blitz. Above `MAIA.eloMax` (3000) nothing changes (full network).

## Corpus

chess.com public API, rated standard games of 2026-01…2026-08. v1 had 3 922 games / 3 568 players
and every own move from ply 16 (119 108 positions). v2 adds new sides, each contributing a window of
20 consecutive own moves from ply 16 (`build-corpus.ts --window`), so a cell covers more players
per position: **10 792 games, 244 561 positions**, ≈ 300 (game, side) samples per time class ×
rating bucket (600…3000 step 200, ± 100), ≤ 2 per player. Rapid 2800 has 44 sides and rapid 3000
two (left out; it extrapolates from 2800). Split **by player** (hash): ≈ 60 % `fit`, ≈ 40 %
`holdout`.

## Method (summary; details in `tools/calibration/README.md`)

- Every position replayed through the shipped `selectMove` exactly as the service worker plays an
  own move (context penalty, opponent pressure, timing persona `tau`, human-depth frame, referee
  pool, the shipped Maia-3 79M at an interpolated grid of self-ratings), 4 chains per game for the
  fit and 8 for verification. Bot and human moves at the same position are judged by the same
  vendored Stockfish 19 frame.
- Metrics per move: expected-points loss and the board ratings' bands (`MOVE_CLASSIFICATION`:
  inaccuracy ≥ 0.05, mistake ≥ 0.10, blunder ≥ 0.20); ACPL and best-move rate reported.
  Uncertainty cluster-robust by game.
- Fit per cell: a sweep of (conditioning Δ, T); objective Σ z² over the four loss metrics **plus**
  the rating term `((plays at − R) / SE)²` from the intrinsic rating model below. One point per
  cell chosen by a monotone Viterbi pass (conditioning never decreases with the target; a light
  prior towards Δ = 0, T = 1 that only breaks ties; smoothness weight 12).
- **Cross-fitting (v2).** v1 fitted on the fit players and verified on the holdout, but chose the
  smoothing weight on that same holdout. v2 verifies every player exactly once, by a table *and* a
  rating model that never saw them: direction A fits both on `fit` and verifies on `holdout`,
  direction B the reverse; `crossfit.ts` pools each cell's two "plays at" gaps by inverse variance
  and the loss z-scores as `(z_A + z_B)/√2`. The shipped table is then fitted on all players
  (`fit.ts --split all`), so the cross-fit numbers are its out-of-sample accuracy, slightly
  conservative (each direction's table saw half the players).

## The independent estimator (reviewed 2026-09-23, extended 2026-09-24)

The first verification used a per-game ridge regression (mean loss and band rates of a game →
rating). Review: it explained 16–36 % of rating variance on held-out players, and its bot-vs-human
comparison divided a small per-game prediction gap by the estimator's small slope (0.21 in bullet),
so a few points of prediction noise became hundreds of Elo.

It is replaced by `tools/calibration/rating-model.ts`, a per-move ordered-logit intrinsic rating
model (Regan's IPR idea) fitted to chess.com players: 12 move-quality classes (the referee's best
move, then loss edges 0.005 … 0.30), position covariates (near-best moves, how "only" the best
move is, decidedness, clock pressure, and since v2 material on the board and the number of legal
moves) and rating × difficulty interactions. A set of moves' rating is the pooled
maximum-likelihood rating with a cluster-robust (by game) sandwich SE; the bot's and the humans'
moves over **the same positions** give a paired gap, so the estimator's own bias cancels. The bot
"plays at" the players' mean actual rating plus that gap.

Accuracy on players it was not trained on (`rating-model-{fit,holdout}-eval.md`), pooled per cell,
bullet / blitz / rapid:

| trained on → scored on | RMSE (Elo) | bias | interval covers the actual mean |
|---|---|---|---|
| fit → holdout | 129 / 134 / 149 | −73 / +39 / +51 | 13/13, 12/13, 8/12 |
| holdout → fit | 188 / 174 / 249 | +73 / −47 / −29 | 10/13, 10/13, 7/12 |
| v1 (fit → holdout) | 287 / 146 / 170 | −160 / +86 / +27 | 33/38 overall |

Per game it remains weak (R² 0.17 / 0.23–0.25 / 0.26–0.27): a 30-move game says little about a
rating. Only the pooled, paired gap is used.

## Findings

1. **Before calibration the bot did not blunder more than chess.com players of its rating — at
   the top it blundered much less.** Bullet was far too strong from ≈ 1000 up (+500 to +1200 Elo:
   Maia learned mostly blitz, and bullet players err much more), low blitz/rapid ratings too weak.
   Cross-fitted, the identity table plays within the 95 % interval of its target in **7 of 38**
   cells, and 61 of 152 loss metrics match the humans' (|z| ≤ 2).
2. **v2, cross-fitted: 30 of 38 cells within the interval, 142 of 152 loss metrics |z| ≤ 2**;
   median interval ± 124 Elo. (v1 reported 31/38 and 146/152 on a single holdout whose data also
   chose the smoothing weight; v2's numbers have no such reuse.) Rapid and blitz are within ≈ ± 120
   Elo everywhere except blitz 2000 (+120 ± 99) and rapid 2800 (44 sides).
3. **The remaining bias is systematic, not noise: the bot does not crack under time pressure.**
   The gap z has mean −0.88 and SD 1.39; bullet 1600–3000 sits 50–250 Elo *below* target by the
   rating model while its blunder rate is *below* the humans' (bullet 3000: 2.40 % vs 3.60 %).
   Per clock quartile the reason is plain: with < 25 % of the clock left, bullet 2600–3000 humans
   blunder on 3.7–6.7 % of moves and the bot on 1.4–2.5 %; with plenty of clock the bot makes
   slightly *more* inaccuracies than they do. The rating model conditions on clock pressure, so it
   reads the bot's errors as falling in easy positions. One (Δ, T) per cell cannot move errors
   between clock states; that needs the clock-pressure context term (`maiaSelfElo`'s clock
   penalty) fitted per time class — the next step, and it requires a refit.
4. If blunders at a live 2836 still look too frequent, the replay cannot see pipeline paths that
   bypass Maia: an inference timeout falls back to the base policy, which has an injected blunder
   channel; premoves and ready moves have their own selection.

## Shipped table and cross-fitted results

Knots `[target, conditioning, T]` of the shipped table (fitted on all players; conditioning shown
as it runs, floored at 400 and capped at 3000). The rates and gaps are the cross-fitted
verification — every player scored by the direction-A or -B table that never saw them, pooled —
"before" is the identity table (the behaviour before 2026-09-23) scored the same way.

### bullet

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | plays at − target: before → after (± 1.96 SE) |
|---:|---|---|---|---|
| 600 | 400, 0.6 | 8.63 / 9.07 / 8.81 | 16.92 / 18.22 / 17.37 | -457 → **-181** (± 175) |
| 800 | 400, 0.7 | 7.17 / 6.79 / 7.94 | 16.00 / 16.12 / 17.09 | -30 → **-132** (± 178) |
| 1000 | 400, 0.9 | 6.67 / 5.33 / 6.61 | 15.01 / 13.60 / 15.49 | +298 → **-61** (± 153) |
| 1200 | 400, 0.9 | 6.97 / 4.66 / 6.59 | 14.55 / 11.76 / 14.56 | +495 → **-95** (± 156) |
| 1400 | 600, 0.9 | 5.95 / 3.57 / 5.39 | 13.11 / 10.24 / 12.99 | +502 → **-80** (± 141) |
| 1600 | 800, 1 | 6.28 / 3.55 / 5.78 | 13.68 / 10.11 / 13.87 | +657 → **-149** (± 128) |
| 1800 | 900, 1 | 5.83 / 2.73 / 5.58 | 13.19 / 8.80 / 13.30 | +965 → **-184** (± 155) |
| 2000 | 1100, 1 | 4.37 / 1.75 / 4.46 | 10.71 / 6.82 / 11.36 | +987 → **-50** (± 140) |
| 2200 | 1200, 1.1 | 4.85 / 1.27 / 4.46 | 11.57 / 6.17 / 11.95 | +1221 → **-53** (± 148) |
| 2400 | 1400, 1.1 | 4.04 / 0.99 / 3.58 | 9.76 / 5.05 / 9.86 | +1084 → **-114** (± 136) |
| 2600 | 1700, 1 | 3.43 / 1.19 / 3.19 | 9.53 / 6.07 / 9.95 | +840 → **-184** (± 133) |
| 2800 | 1800, 1 | 3.73 / 1.04 / 3.14 | 10.52 / 6.52 / 10.57 | +790 → **-199** (± 124) |
| 3000 | 2000, 1 | 3.60 / 0.60 / 2.40 | 9.63 / 4.04 / 9.06 | +1054 → **-251** (± 129) |

### blitz

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | plays at − target: before → after (± 1.96 SE) |
|---:|---|---|---|---|
| 600 | 600, 0.7 | 7.09 / 9.19 / 7.44 | 15.65 / 19.51 / 16.43 | -751 → **-117** (± 162) |
| 800 | 800, 0.7 | 6.79 / 8.45 / 6.70 | 14.86 / 18.44 / 15.86 | -549 → **-80** (± 131) |
| 1000 | 800, 0.7 | 5.73 / 6.00 / 5.82 | 13.31 / 14.19 / 13.86 | -187 → **-55** (± 134) |
| 1200 | 1000, 0.7 | 4.98 / 5.54 / 5.50 | 12.80 / 14.31 / 13.56 | -279 → **-65** (± 134) |
| 1400 | 1100, 0.7 | 4.40 / 4.18 / 4.15 | 11.61 / 12.06 / 11.63 | -98 → **+10** (± 107) |
| 1600 | 1200, 0.6 | 4.37 / 4.00 / 4.23 | 11.04 / 11.35 / 11.29 | -95 → **+5** (± 119) |
| 1800 | 1400, 0.6 | 3.55 / 2.73 / 3.62 | 9.94 / 9.17 / 10.21 | -38 → **-97** (± 100) |
| 2000 | 1400, 0.7 | 4.00 / 2.20 / 3.66 | 10.75 / 8.77 / 10.61 | +347 → **+120** (± 99) |
| 2200 | 1700, 0.7 | 3.55 / 1.87 / 3.24 | 9.38 / 8.02 / 9.84 | +260 → **-19** (± 109) |
| 2400 | 1800, 0.7 | 2.74 / 1.48 / 2.50 | 8.28 / 7.00 / 8.56 | +166 → **-82** (± 97) |
| 2600 | 2000, 0.7 | 2.43 / 1.42 / 2.09 | 7.67 / 7.02 / 7.65 | +147 → **+20** (± 103) |
| 2800 | 2300, 0.7 | 2.17 / 1.32 / 1.70 | 7.02 / 6.59 / 6.75 | -3 → **-27** (± 99) |
| 3000 | 2500, 0.7 | 1.98 / 0.68 / 1.15 | 5.97 / 4.71 / 5.82 | +67 → **-82** (± 99) |

### rapid

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | plays at − target: before → after (± 1.96 SE) |
|---:|---|---|---|---|
| 600 | 400, 0.3 | 7.57 / 9.21 / 7.63 | 15.84 / 18.72 / 16.07 | -457 → **+66** (± 156) |
| 800 | 600, 0.4 | 6.67 / 7.69 / 6.55 | 14.58 / 16.64 / 14.25 | -432 → **-31** (± 119) |
| 1000 | 700, 0.4 | 5.83 / 6.74 / 5.85 | 13.24 / 15.10 / 13.44 | -310 → **-13** (± 113) |
| 1200 | 800, 0.4 | 4.80 / 5.09 / 4.51 | 12.03 / 13.17 / 11.72 | -179 → **+66** (± 93) |
| 1400 | 900, 0.4 | 4.16 / 4.36 / 3.97 | 11.52 / 12.17 / 11.15 | -216 → **+19** (± 81) |
| 1600 | 1100, 0.3 | 3.70 / 3.80 / 3.45 | 10.49 / 11.36 / 10.23 | -189 → **+57** (± 89) |
| 1800 | 1400, 0.3 | 3.03 / 2.74 / 3.08 | 9.21 / 9.48 / 9.12 | -207 → **-28** (± 95) |
| 2000 | 1600, 0.3 | 3.12 / 2.52 / 3.00 | 9.33 / 9.16 / 9.14 | -92 → **+13** (± 88) |
| 2200 | 1800, 0.4 | 2.65 / 2.02 / 2.68 | 8.96 / 8.72 / 8.94 | -23 → **+24** (± 82) |
| 2400 | 2000, 0.4 | 2.44 / 1.65 / 1.87 | 7.22 / 7.55 / 7.02 | -150 → **+27** (± 89) |
| 2600 | 2300, 0.3 | 1.39 / 1.44 / 1.21 | 5.03 / 6.73 / 5.40 | -395 → **-72** (± 74) |
| 2800 | 2600, 0.3 | 1.68 / 1.15 / 1.09 | 3.58 / 4.85 / 3.96 | -686 → **-391** (± 184) |

## Limits

- The referee is one thread at a per-tc movetime under Bun, not the browser's search; bot and human
  share it, so comparisons are paired but absolute loss levels are this referee's.
- Positions come from human games: the bot never plays on from its own earlier mistakes.
- ≈ 300 sides per cell: a single cell's "plays at" carries ± 75–180 Elo of sampling noise.
- Bullet 600–1200 run at the 400 conditioning floor (Δ = −1000 at the sweep's edge would go lower).
- Rapid 3000 extrapolates from 2800 (edge offset, same T).
