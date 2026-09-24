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
  metrics. One point per cell chosen by a monotone Viterbi pass (conditioning never decreases with
  the target; mild prior towards Δ = 0, T = 1 that only breaks ties; smoothness between buckets).
- Verification on the holdout players only: (1) the error profile with z-scores, overall and per
  clock quartile; (2) a Maia-free intrinsic-rating estimator (ridge regression from per-game
  move-quality features to rating, trained on the fit split's humans), applied to the bot's and the
  humans' moves over the same positions → the bot's implied rating with a game-bootstrap interval.

## Findings

1. **Before calibration the bot did not blunder more than chess.com players of its rating — at
   the top it blundered less.** Blitz 2800: humans blunder on 2.87 % of moves, the bot on 1.23 %;
   the estimator put it at ≈ 3020. Bullet was far too strong from ≈ 1200 up (Maia learned mostly
   blitz; bullet players make many more errors). Low blitz and rapid ratings (600–1000) were too
   weak. So the calibration makes the high-rated bot *slightly more* error-prone in blitz, and
   much more in bullet, because that is what real players of those ratings do.
2. After calibration, **154 of 156** held-out loss metrics are statistically indistinguishable from
   the humans' (|z| ≤ 2), against 105 of 156 before.
3. The implied rating's interval contains the target in 24 of 38 cells (21 before). The estimator
   is weak (held-out R² 0.16 bullet, 0.25 blitz, 0.36 rapid; a 30-move game says little about a
   rating), so its intervals are wide and its point estimates noisy; where it still disagrees —
   bullet 1600–3000 reads 300–600 too strong — the gap is in ACPL (humans' very large centipawn
   losses in decided positions, and moves the engine never ranked, which the selector cannot play),
   not in the blunder bands the board shows.
4. If blunders at a live 2836 still look too frequent, the replay above cannot see pipeline paths
   that bypass Maia: an inference timeout falls back to the base policy, which has an injected
   blunder channel; premoves and ready moves have their own selection. Those are the next suspects.

## Shipped table and held-out results

Knots `[target, conditioning, T]`; "before" = the identity table (the behaviour until today).

### bullet

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | EPL z before → after | implied rating before → after (95 % CI) |
|---:|---|---|---|---|---|
| 600 | 600, 0.9 | 9.02 / 8.57 / 8.32 | 17.1 / 16.9 / 16.2 | -0.4 → -0.7 | 622 → 742 (176–1264) |
| 800 | 600, 0.9 | 7.49 / 6.28 / 7.17 | 14.0 / 14.5 / 15.5 | -1.1 → -0.5 | 1143 → 837 (274–1410) |
| 1000 | 600, 1.1 | 4.74 / 4.85 / 6.90 | 12.5 / 12.7 / 16.1 | -0.1 → +1.8 | 1107 → 263 (-131–614) |
| 1200 | 600, 1.1 | 6.04 / 3.91 / 6.46 | 13.3 / 10.1 / 13.8 | -2.3 → -0.2 | 1977 → 1150 (548–1754) |
| 1400 | 800, 1.1 | 5.82 / 3.31 / 5.21 | 12.9 / 9.1 / 12.2 | -3.3 → -1.4 | 2446 → 1803 (1499–2092) |
| 1600 | 1000, 1.1 | 5.17 / 2.27 / 4.14 | 11.1 / 7.0 / 10.7 | -3.6 → -1.1 | 2948 → 2148 (1803–2512) |
| 1800 | 1100, 1.1 | 4.26 / 1.58 / 3.22 | 10.5 / 5.5 / 9.1 | -3.9 → -1.5 | 3230 → 2661 (2224–3221) |
| 2000 | 1200, 1.1 | 3.83 / 1.43 / 2.91 | 9.3 / 5.2 / 8.7 | -4.0 → -1.4 | 3273 → 2507 (2088–2978) |
| 2200 | 1400, 1.1 | 4.03 / 1.13 / 3.47 | 10.5 / 6.0 / 10.6 | -3.7 → -0.6 | 3338 → 2656 (2329–2982) |
| 2400 | 1400, 1.1 | 3.65 / 1.10 / 3.46 | 9.6 / 5.0 / 9.7 | -6.0 → -0.4 | 3282 → 2558 (2271–2836) |
| 2600 | 1600, 1 | 3.07 / 1.23 / 2.80 | 10.0 / 6.2 / 9.9 | -4.2 → -1.1 | 3974 → 3344 (2898–3820) |
| 2800 | 1800, 1 | 4.38 / 1.13 / 3.54 | 11.9 / 6.8 / 10.9 | -6.5 → -1.8 | 4066 → 3430 (3161–3741) |
| 3000 | 2000, 1.1 | 3.86 / 0.70 / 2.94 | 10.2 / 4.3 / 9.6 | -5.4 → -1.3 | 3843 → 3263 (3006–3516) |

### blitz

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | EPL z before → after | implied rating before → after (95 % CI) |
|---:|---|---|---|---|---|
| 600 | 800, 0.7 | 6.62 / 8.85 / 6.07 | 13.9 / 19.2 / 14.1 | +1.6 → -1.0 | 150 → 905 (499–1277) |
| 800 | 800, 0.7 | 7.73 / 8.52 / 6.63 | 15.9 / 18.0 / 15.4 | +1.1 → -0.8 | 663 → 1100 (712–1521) |
| 1000 | 800, 0.9 | 5.99 / 5.66 / 6.52 | 12.2 / 13.1 / 14.4 | -0.3 → +0.5 | 1091 → 794 (451–1166) |
| 1200 | 1000, 0.9 | 4.28 / 4.79 / 5.17 | 12.5 / 12.5 / 13.3 | +0.5 → +0.8 | 1061 → 1009 (794–1225) |
| 1400 | 1200, 0.9 | 3.67 / 3.97 / 4.37 | 10.0 / 11.4 / 12.0 | +0.3 → +0.9 | 1458 → 1357 (1181–1553) |
| 1600 | 1400, 0.9 | 4.06 / 3.84 / 4.57 | 10.3 / 11.5 / 12.8 | +0.2 → +1.1 | 1490 → 1293 (1000–1579) |
| 1800 | 1600, 0.9 | 4.17 / 3.28 / 4.04 | 10.7 / 8.9 / 9.7 | -1.4 → -0.5 | 2165 → 1992 (1687–2286) |
| 2000 | 1600, 0.9 | 4.71 / 2.32 / 3.88 | 11.3 / 8.8 / 11.3 | -3.0 → -0.7 | 2681 → 2286 (1994–2577) |
| 2200 | 1800, 0.7 | 3.48 / 1.93 / 2.92 | 8.0 / 7.8 / 9.0 | -1.0 → +0.5 | 2330 → 2087 (1861–2319) |
| 2400 | 2000, 0.9 | 2.65 / 1.30 / 1.54 | 7.9 / 6.9 / 7.6 | -1.9 → -1.2 | 3036 → 2849 (2521–3214) |
| 2600 | 2000, 0.9 | 2.14 / 1.04 / 2.20 | 7.1 / 6.3 / 8.1 | -2.1 → +0.0 | 3310 → 3009 (2660–3450) |
| 2800 | 2300, 0.8 | 2.87 / 1.23 / 1.81 | 7.0 / 6.4 / 7.1 | -1.4 → -0.8 | 3024 → 2907 (2682–3139) |
| 3000 | 2400, 0.6 | 2.58 / 0.77 / 1.26 | 6.7 / 5.3 / 6.1 | -1.9 → -1.3 | 3538 → 3422 (3143–3707) |

### rapid

| R | knot (cond., T) | blunder % human / before / after | mistake-or-worse % human / before / after | EPL z before → after | implied rating before → after (95 % CI) |
|---:|---|---|---|---|---|
| 600 | 600, 0.7 | 6.08 / 7.91 / 6.94 | 13.6 / 16.8 / 15.6 | +0.8 → +0.3 | 464 → 609 (419–788) |
| 800 | 800, 0.7 | 6.61 / 7.71 / 6.61 | 13.8 / 16.2 / 14.4 | +0.6 → -0.4 | 645 → 877 (726–1039) |
| 1000 | 1000, 0.7 | 5.20 / 7.56 / 6.51 | 11.8 / 15.8 / 14.1 | +1.7 → +0.7 | 806 → 1000 (744–1273) |
| 1200 | 1200, 0.8 | 4.93 / 5.35 / 4.75 | 12.4 / 13.3 / 12.4 | +0.2 → -0.5 | 1059 → 1177 (965–1385) |
| 1400 | 1400, 0.7 | 3.93 / 4.70 / 4.05 | 12.1 / 13.3 / 11.2 | +1.6 → -0.2 | 1250 → 1488 (1295–1683) |
| 1600 | 1400, 0.6 | 3.81 / 3.91 / 3.44 | 10.0 / 11.4 / 10.1 | +0.3 → -0.4 | 1667 → 1836 (1589–2074) |
| 1800 | 1400, 0.5 | 2.60 / 2.56 / 3.46 | 9.6 / 10.1 / 10.6 | +0.4 → +1.0 | 1771 → 1757 (1593–1932) |
| 2000 | 1600, 0.4 | 1.85 / 2.38 / 3.15 | 7.0 / 7.9 / 8.5 | +1.0 → +1.5 | 1899 → 1893 (1671–2130) |
| 2200 | 1900, 0.4 | 2.42 / 1.26 / 1.63 | 7.1 / 6.8 / 6.4 | -1.0 → -1.0 | 2396 → 2432 (2241–2630) |
| 2400 | 1900, 0.4 | 2.05 / 1.56 / 2.32 | 5.7 / 7.4 / 7.8 | +0.3 → +1.0 | 2434 → 2363 (2141–2589) |
| 2600 | 2500, 0.4 | 1.44 / 1.43 / 1.16 | 4.6 / 6.6 / 5.3 | +1.6 → -0.3 | 2463 → 2692 (2512–2883) |
| 2800 | 3000, 0.4 | 3.63 / 1.45 / 1.13 | 6.1 / 4.8 / 3.1 | -0.6 → -1.2 | 2821 → 3121 (2718–3658) |

## Limits

- The referee is one thread at a per-tc movetime under Bun, not the browser's search; bot and human
  share it, so comparisons are paired but absolute loss levels are this referee's.
- Positions come from human games: the bot never plays on from its own earlier mistakes.
- Bullet 2400 and 3000 sit at the sweep's edge (Δ = −1000): the data would take them weaker still.
- Rapid 3000 extrapolates from 2800 (edge offset, same T).
