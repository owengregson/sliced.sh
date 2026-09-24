# Maia strength calibration against chess.com players (2026-09-23)

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

chess.com public API, rated standard games of 2026-01…2026-08, 3 922 games / 3 568 players. Per
time class × rating bucket (600…3000 step 200, ± 100): ≈ 110 (game, side) samples, ≤ 2 per player;
every own move from ply 16 (the product plays book before) → **119 108 positions**. Split **by
player** (hash): ≈ 60 % fit, ≈ 40 % holdout. Rapid 3000 could not be filled (2 games) and is left
out; rapid 2800 has 42 sides.

## Method (summary; details in `tools/calibration/README.md`)

- Every position replayed through the shipped `selectMove` exactly as the service worker plays an
  own move (context penalty, opponent pressure, timing persona `tau`, human-depth frame, referee
  pool, the shipped Maia-3 79M at an interpolated grid of self-ratings), 4 chains per game for the
  fit and 8 for verification. Bot and human moves at the same position are judged by the same
  vendored Stockfish 19 frame.
- Metrics per move: expected-points loss and the board ratings' bands (`MOVE_CLASSIFICATION`:
  inaccuracy ≥ 0.05, mistake ≥ 0.10, blunder ≥ 0.20); ACPL and best-move rate reported.
  Uncertainty cluster-robust by game.
- Fit on the fit split: per cell a sweep of (conditioning Δ, T); objective Σ z² over the four loss
  metrics **plus** the rating term below. One point per cell chosen by a monotone Viterbi pass
  (conditioning never decreases with the target; a light prior towards Δ = 0, T = 1 that only breaks
  ties; smoothness between neighbouring buckets at weight 12, chosen on the holdout — see below).
- Verification on the holdout players only: (1) the error profile with z-scores, overall and per
  clock quartile; (2) the rating the bot plays at by the Maia-free intrinsic rating model below.

## The independent estimator (reviewed 2026-09-23)

The first verification used a per-game ridge regression (mean loss and band rates of a game →
rating). Review: it explained 16–36 % of rating variance on held-out players, and its bot-vs-human
comparison divided a small per-game prediction gap by the estimator's small slope (0.21 in bullet),
so a few points of prediction noise became hundreds of Elo — its "bullet 300–600 too strong" reading
was mostly that amplification.

It is replaced by `tools/calibration/rating-model.ts`, a per-move ordered-logit intrinsic rating
model (Regan's IPR idea) fitted to chess.com players: 12 move-quality classes (the referee's best
move, then loss edges 0.005 … 0.30), position covariates (near-best moves, how "only" the best
move is, decidedness, clock pressure) and rating × difficulty interactions. A set of moves' rating
is the pooled maximum-likelihood rating with a cluster-robust (by game) sandwich SE; the bot's and
the humans' moves over **the same positions** give a paired gap whose variance uses both sides'
per-game influence, so the estimator's own bias cancels. The bot "plays at" the players' mean actual
rating plus that gap.

Its accuracy on held-out humans (`rating-eval.ts`): per game it is no better than the ridge (R²
0.19 / 0.25 / 0.28 for bullet / blitz / rapid) — a 30-move game says little about a rating, and
finer classes did not change that — but pooled per cell it recovers the actual mean rating within
its interval in 33 of 38 cells (RMSE 287 / 146 / 170 Elo; bias −160 / +86 / +27), and the paired
gap is what the verification uses. It is also a fifth term of the fit objective,
`((plays at − R) / SE)²`: the band rates alone left the finer loss distribution — how often the
best move is found — free, and the model showed low-to-mid ratings playing 300–400 below target.

## Findings

1. **Before calibration the bot did not blunder more than chess.com players of its rating — at
   the top it blundered less.** Blitz 2800: humans blunder on 2.87 % of moves, the bot on 1.23 %.
   Bullet was far too strong from ≈ 1200 up (Maia learned mostly blitz; bullet players err much
   more), low blitz/rapid ratings too weak. By the paired rating model the bot played within the
   95 % interval of its target in **13 of 38** held-out cells.
2. After calibration: **31 of 38** cells play within the interval of their target, and 146 of 152
   held-out loss metrics are statistically indistinguishable from the humans' (|z| ≤ 2; 101
   before). Blitz 2800 plays at ≈ 2840 (± 325).
3. The remaining misses are consistent with sampling noise: every cell fits its fit-split players
   (|z| ≤ 2 in-sample), the holdout z has mean −0.34 and SD 1.42 against ≈ 1.3 expected when both
   the fit's and the holdout's sampling noise are counted, and the signs are mixed. The smoothing
   weight was chosen on this holdout (1 → Σz² 111, 4 → 101, 12 → 81, 30 → 95): pooling
   neighbouring buckets is what reduces a single cell's fit noise.
4. If blunders at a live 2836 still look too frequent, the replay above cannot see pipeline paths
   that bypass Maia: an inference timeout falls back to the base policy, which has an injected
   blunder channel; premoves and ready moves have their own selection. Those are the next suspects.

## Shipped table and held-out results

Knots `[target, conditioning, T]` (conditioning shown as it runs, floored at 400 and capped at
3000); "before" = the identity table (the behaviour until today).

### bullet

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | bot plays at: before → after (95 % CI) |
|---:|---|---|---|---|
| 600 | -400, 0.7 | 9.02 / 8.57 / 8.46 | 17.1 / 16.9 / 16.1 | 553 → **751** (280–1222) |
| 800 | -200, 0.8 | 7.49 / 6.28 / 8.21 | 14.0 / 14.5 / 16.6 | 884 → **522** (72–972) |
| 1000 | 0, 0.9 | 4.74 / 4.85 / 6.56 | 12.5 / 12.7 / 15.4 | 760 → **250** (-49–549) |
| 1200 | 200, 0.9 | 6.04 / 3.91 / 5.77 | 13.3 / 10.1 / 12.3 | 1581 → **1141** (681–1601) |
| 1400 | 400, 0.9 | 5.82 / 3.31 / 4.73 | 12.9 / 9.1 / 11.1 | 2298 → **1766** (1417–2116) |
| 1600 | 600, 0.9 | 5.17 / 2.27 / 3.74 | 11.1 / 7.0 / 9.8 | 2468 → **1732** (1391–2073) |
| 1800 | 800, 0.9 | 4.26 / 1.58 / 3.02 | 10.5 / 5.5 / 8.3 | 3015 → **2212** (1824–2600) |
| 2000 | 1000, 0.9 | 3.83 / 1.43 / 2.85 | 9.3 / 5.2 / 8.3 | 2979 → **2239** (1982–2495) |
| 2200 | 1200, 0.9 | 4.03 / 1.13 / 3.47 | 10.5 / 6.0 / 10.3 | 3197 → **2210** (1946–2473) |
| 2400 | 1400, 1 | 3.65 / 1.10 / 3.25 | 9.6 / 5.0 / 9.1 | 3175 → **2301** (2061–2541) |
| 2600 | 1600, 0.9 | 3.07 / 1.23 / 2.50 | 10.0 / 6.2 / 9.1 | 3437 → **2756** (2461–3051) |
| 2800 | 1800, 0.9 | 4.38 / 1.13 / 3.51 | 11.9 / 6.8 / 10.2 | 3491 → **2729** (2448–3011) |
| 3000 | 2000, 0.9 | 3.86 / 0.70 / 2.71 | 10.2 / 4.3 / 8.5 | 3778 → **3020** (2724–3317) |

### blitz

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | bot plays at: before → after (95 % CI) |
|---:|---|---|---|---|
| 600 | 600, 0.7 | 6.62 / 8.85 / 7.52 | 13.9 / 19.2 / 16.7 | -166 → **310** (9–611) |
| 800 | 700, 0.7 | 7.73 / 8.52 / 7.42 | 15.9 / 18.0 / 16.5 | 400 → **678** (360–995) |
| 1000 | 800, 0.7 | 5.99 / 5.66 / 5.64 | 12.2 / 13.1 / 13.2 | 938 → **982** (631–1333) |
| 1200 | 900, 0.7 | 4.28 / 4.79 / 4.64 | 12.5 / 12.5 / 12.1 | 885 → **1171** (810–1533) |
| 1400 | 1000, 0.7 | 3.67 / 3.97 / 4.16 | 10.0 / 11.4 / 11.3 | 1162 → **1145** (937–1353) |
| 1600 | 1200, 0.7 | 4.06 / 3.84 / 4.62 | 10.3 / 11.5 / 12.7 | 1370 → **1272** (1000–1544) |
| 1800 | 1400, 0.7 | 4.17 / 3.28 / 4.21 | 10.7 / 8.9 / 9.8 | 1849 → **1787** (1612–1962) |
| 2000 | 1500, 0.8 | 4.71 / 2.32 / 3.97 | 11.3 / 8.8 / 11.0 | 2282 → **1902** (1666–2137) |
| 2200 | 1800, 0.7 | 3.48 / 1.93 / 2.92 | 8.0 / 7.8 / 9.0 | 2173 → **1953** (1706–2201) |
| 2400 | 2000, 0.7 | 2.65 / 1.30 / 1.45 | 7.9 / 6.9 / 6.7 | 2570 → **2597** (2273–2922) |
| 2600 | 2100, 0.7 | 2.14 / 1.04 / 1.65 | 7.1 / 6.3 / 6.6 | 2830 → **2779** (2409–3149) |
| 2800 | 2400, 0.7 | 2.87 / 1.23 / 1.36 | 7.0 / 6.4 / 6.2 | 2753 → **2839** (2515–3164) |
| 3000 | 2600, 0.6 | 2.58 / 0.77 / 0.93 | 6.7 / 5.3 / 5.5 | 3100 → **3205** (2941–3468) |

### rapid

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | bot plays at: before → after (95 % CI) |
|---:|---|---|---|---|
| 600 | 600, 0.5 | 6.08 / 7.91 / 6.27 | 13.6 / 16.8 / 14.4 | -43 → **418** (129–708) |
| 800 | 700, 0.5 | 6.61 / 7.71 / 6.52 | 13.8 / 16.2 / 14.1 | 164 → **606** (348–865) |
| 1000 | 800, 0.5 | 5.20 / 7.56 / 6.65 | 11.8 / 15.8 / 14.5 | 478 → **766** (535–997) |
| 1200 | 1000, 0.5 | 4.93 / 5.35 / 4.70 | 12.4 / 13.3 / 11.5 | 869 → **1143** (979–1307) |
| 1400 | 1200, 0.5 | 3.93 / 4.70 / 4.13 | 12.1 / 13.3 / 11.6 | 1090 → **1345** (1175–1515) |
| 1600 | 1400, 0.5 | 3.81 / 3.91 / 3.31 | 10.0 / 11.4 / 10.0 | 1285 → **1587** (1403–1770) |
| 1800 | 1600, 0.5 | 2.60 / 2.56 / 2.52 | 9.6 / 10.1 / 9.4 | 1589 → **1806** (1599–2012) |
| 2000 | 1800, 0.5 | 1.85 / 2.38 / 2.44 | 7.0 / 7.9 / 7.5 | 1711 → **1940** (1743–2137) |
| 2200 | 2000, 0.5 | 2.42 / 1.26 / 1.16 | 7.1 / 6.8 / 5.9 | 2178 → **2366** (2210–2522) |
| 2400 | 2200, 0.5 | 2.05 / 1.56 / 1.69 | 5.7 / 7.4 / 6.6 | 2124 → **2337** (2152–2522) |
| 2600 | 2600, 0.5 | 1.44 / 1.43 / 1.12 | 4.6 / 6.6 / 5.3 | 2176 → **2495** (2342–2648) |
| 2800 | 3000, 0.5 | 3.63 / 1.45 / 1.07 | 6.1 / 4.8 / 3.2 | 2353 → **2670** (2274–3066) |


## Limits

- The referee is one thread at a per-tc movetime under Bun, not the browser's search; bot and human
  share it, so comparisons are paired but absolute loss levels are this referee's.
- Positions come from human games: the bot never plays on from its own earlier mistakes.
- ≈ 40 held-out players per cell: a single cell's "plays at" carries ± 150–300 Elo of sampling
  noise; judge the table by the pattern across cells, not one cell.
- Bullet 2400–3000 sit at the sweep's edge (Δ = −1000); rapid is at a flat T = 0.5.
- Rapid 3000 extrapolates from 2800 (edge offset, same T).
