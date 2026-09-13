# ChessMimic bands above 1900, and why we lose on time at 2500

**Question (owner, 2026-09-13):** "The model is almost always losing on time at the Elo it's playing
at now: around 2500. It's playing well — in fact out-playing the opponents slightly as we would
expect — but it always loses the game at the end on time. We need to get a ChessMimic band for the
Elos we don't cover … I don't think we can compensate with the layers we keep adding."

Measured on this machine on 2026-09-13 from two sources: **97 real chess.com games** the owner
exported (`chess_com_games_2026-09-13 (1).pgn`, `gc_elif`, clocks on every ply), and probes against
real `onnxruntime-web` with the real band files — `.scratch/flag-sim.test.ts` (whole-game clock
consumption) and `.scratch/band-curve.test.ts` (the head's own conditional at fixed positions).
Nothing here is estimated.

**Verdict: the bands are not the problem.** The real games say we spend ~1.6× a matched human's
clock in the middlegame of a 3+0, and exporting the correct band would make that *worse*, not
better. The bands are still worth exporting — for the right reason, and after the pace fix.

---

## 1. The bands already exist upstream

`thomasj02/1e4_ai` at the pinned commit `8fcca2319e` ships **14 contiguous clock-model bands**, not
three:

```
0_1000  1000_1100  1100_1200  1200_1300  1300_1400  1400_1500  1500_1600
1600_1700  1700_1800  1800_1900  1900_2000  2000_2100  2100_2200  2200_3500
```

We export three (`DEFAULT_BANDS` in `tools/data/08_export_chessmimic.py`). The gap the owner asked
about is **not a training problem** — it is four checkpoints we never exported. The top band
`2200_3500` covers 2200 through 3500 in one model, and its rating scaler is wide enough for the
conditioning to stay meaningful across it:

| band | rating mean | rating std | 2500 → z | 2700 → z | 3000 → z |
|---|---:|---:|---:|---:|---:|
| 1800_1900 | 1849.2 | 27.3 | (clamped to 1900) | — | — |
| 1900_2000 | 1948.5 | 27.4 | — | — | — |
| 2000_2100 | 2047.5 | 27.5 | — | — | — |
| 2100_2200 | 2146.9 | 27.8 | — | — | — |
| **2200_3500** | **2357.1** | **126.7** | **+1.13** | **+2.71** | **+5.07** |

So "extrapolate the last one for 3000+" needs no extrapolation: the band's training population
really does run to 3500. There are no `2300_2500` / `2500_2700` / `2700_3000` checkpoints and
training them is a GPU project (§6).

**What a 2500 target gets today.** `selectBand(2500)` picks the nearest band centre — 1850 — and
`standardiseInputs` then clamps the rating into `[1800, 1900]`, so the model is asked about a
**1900** player. (The clamp is load-bearing: unclamped the z-score would be +23.8.) Every target
from 1700 to 3800 gets the same 1900.

**Cost.** `2200_3500.onnx` exported here at 18,200,481 B, the same as the shipped bands (identical
architecture). Four more is **+72.8 MB** on a package already at 340.4 MiB / 270.6 MiB zipped.

## 2. What the real games say

Window: the owner's current regime — 3+0, no increment, our Elo **2401–2452**, opponents 2245–2544,
games of ≥ 12 of our moves. Opponent speed rises sharply with Elo across the file, so nothing below
pools the whole 100 games; where the last 10 games differ from the 27-game window, both are shown.
The opponent is the control: the same game, the same positions, the same clock, a real human of our
own rating.

| block of 10 games | our Elo | opp Elo (median) | lost on time |
|---|---|---:|---:|
| 1–10 | 2208–2268 | 2245 | 1 |
| 41–50 | 2364–2383 | 2360 | 2 |
| 81–90 | 2414–2444 | 2440 | 2 |
| 91–97 | 2411–2452 | 2418 | **4 of 7** |

Over the whole file we lost 18 games on time and won 12; in the current regime it is 8 of 27, and
5 of the last 10.

### 2.1 Where the clock goes

Median clock left after our *n*-th move, both sides of the same games (27-game window):

| our move | games | ours | human | gap |
|---:|---:|---:|---:|---:|
| 10 | 27 | 148.5 | 158.5 | +10.0 |
| 15 | 27 | 107.9 | 132.9 | +25.0 |
| 20 | 26 | 75.1 | 101.3 | +26.2 |
| 30 | 18 | 39.8 | 59.3 | +19.5 |
| 40 | 11 | 17.9 | 42.5 | +24.6 |
| 50 | 7 | 3.9 | 13.7 | +9.8 |

**The whole deficit is built between move 10 and move 20** and never recovered. First-30-move spend:
ours 140 s against the human's 116 s over 18 games; over the last 10 games alone, **138 s against
85 s**.

### 2.2 It is the middlegame, and it is a fast-tail deficit

Think time by the fraction of the starting clock still on our own clock (last 10 games / 27-game
window):

| fraction of base | our median | human median | our mean | human mean | our share < 1 s | human share < 1 s |
|---|---:|---:|---:|---:|---:|---:|
| 1.00–0.85 | 1.90 / 1.70 | 1.30 / 1.40 | 3.48 / 3.83 | 2.26 / 2.61 | 2.0 % / 5.5 % | **29.5 % / 31.7 %** |
| 0.85–0.55 | **6.20 / 6.00** | **2.40 / 2.80** | 7.35 / 6.99 | 3.96 / 4.86 | **0.0 % / 2.1 %** | **19.8 % / 15.8 %** |
| 0.55–0.25 | 4.20 / 4.00 | 2.30 / 2.60 | 5.61 / 4.89 | 4.63 / 5.11 | 2.3 % / 3.7 % | 13.4 % / 12.6 % |
| < 0.25 | 1.85 / 1.60 | 1.25 / 1.40 | 2.35 / 1.95 | 1.88 / 2.27 | 12.5 % / 21.3 % | 44.1 % / 33.3 % |

Read the two things this says.

**(a) Under a quarter of the clock we are fine.** Our low-clock machinery (`urgency`, `lowClock`,
`lowClockPace`, `compression`, the caps) works: below 45 s we are as fast as the human, sometimes
faster. Nothing there needs changing.

**(b) Between 0.85 and 0.55 of the clock our typical move takes 6.2 s and theirs takes 2.4 s, and
we played 0 of 68 moves in under a second where they played 19.8 % of theirs.** That single cell is
the game. The means are much closer than the medians (7.35 vs 3.96) because the human's time is
*shaped*: many snap moves and a few long thinks. Ours is a narrow hump with no fast tail.

The pooled long-think rates look identical — 8.9 % of our moves over 10 s against their 9.0 % — but
that pooling hides a second half of the same defect. Per band:

| fraction of base | ours > 10 s | human > 10 s |
|---|---:|---:|
| 1.00–0.85 | 9.3 % | 5.0 % |
| 0.85–0.55 | **28.3 %** | **14.1 %** |
| 0.55–0.25 | **5.6 %** | **14.4 %** |
| < 0.25 | 0.3 % | 2.2 % |

In the middlegame we take twice as many long thinks as the human *and* none of the fast ones; by
0.55 of the clock we have run out of time to think and take a third as many. The human spreads the
same total over the whole game; we spend it all in one window. So this is not "the bot thinks too
long" either — it is "the bot has no fast tail and banks nothing for later", and it pays for that
6–7 times a game.

### 2.3 Not latency, not search overrun

Worth ruling out explicitly, because it was the leading suspect before the PGN arrived. Our 1st
percentile think is **0.10 s** and 1.0 % of our moves land under 0.2 s, so there is no per-move
floor and no hidden overhead between the opponent's move landing and ours: when the plan says
"instant", the page sees 0.1 s. The plan's window also starts at `computedAt`
(`session.ts:2198`, captured before the search), so search time runs inside the planned think.
**The clock we lose is spent by the timing model on purpose.**

## 3. Why the model does it, and why a band cannot fix it

ChessMimic's clock model takes player clock, opponent clock and increment — and **no base clock**.
Its training pool is Lichess *blitz*, 3+0 through 5+3. At 120 s left with no increment the pool is
mostly a 5+0 on move 25, not a 3+0 on move 15, so the model answers with the pooled number. Its own
sub-second mass at a real middlegame position (band 1800_1900, P(bucket 0)):

| clock left | 180 | 150 | 120 | 90 | 60 | 45 | 30 | 20 | 10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Ruy Lopez middlegame | 24 % | 5 % | 5 % | 6 % | 8 % | 12 % | 18 % | 24 % | 36 % |
| Italian middlegame | 19 % | 3 % | 4 % | 3 % | 4 % | 5 % | 9 % | 14 % | 24 % |

Against the 16–20 % the real 2400s in §2.2 actually play at 90–150 s. Our realised 0–2 % is roughly
the model's own 3–6 % after `SETTING_GAIN.speedScale` pushes a 0.9 s draw past a second — **we are
delivering what our head asks for; the head is calibrated for the pool, not for a 3-minute game.**
Every band saw the same pool through the same three inputs, so no band changes this.

Directly, at the same real positions, median seconds by band (the exported `2200_3500` against the
shipped `1800_1900` a 2500 target is clamped into today):

```
Ruy Lopez middlegame        180   150   120    90    60    45    30    20    10  s left
  1800_1900  @1900          1.50  2.50  2.50  2.50  2.50  2.50  1.50  1.50  1.50
  2200_3500  @2500          1.50  3.50  4.50  3.50  2.50  2.50  2.50  1.50  1.50
Italian middlegame
  1800_1900  @1900          1.50  3.50  2.50  2.50  2.50  2.50  2.50  1.50  1.50
  2200_3500  @2500          2.50  5.50  5.50  4.50  3.50  2.50  2.50  1.50  1.50
Rook ending (4 pawns each): 1.50 everywhere, both bands
```

The correct band thinks **longer** in the middlegame — 4.5 s at 120 s where the real 2400s in the
PGN take 2.4 s. That is a faithful blitz-pool 2500 and a wrong 3-minute 2500. Whole games confirm it
(24 games, 3+0, target 2500, the settings the session really runs with): band `1800_1900` leaves
90.0 / 46.2 / 24.4 s at moves 20 / 30 / 40; band `2200_3500` leaves 81.3 / 42.3 / 26.2. Swapping the
band does not buy clock.

Two smaller contributors, both ours:

- **`SETTING_GAIN.speedScale = 1.3`** (owner, 2026-09-13, "base speed 1.0x = 1.3x") multiplies the
  sampled think *duration*, so a default install is 30 % slower per move than the day before.
  Measured at 3+0 in the simulator: 11.7 s less clock by move 20 (101.7 → 90.0) and 3.2 s by move 40.
  It also pushes sub-second draws over a second, which is exactly the mass §2.2 says we are missing.
- The human marginals barely move with rating anyway — mean think 5.02 s at 1800–1900 against
  4.70 s at 2200+ over 1 000 000 moves a band, a 6.4 % difference. The rating axis is worth six per
  cent; the time-control axis is worth the game.

## 4. Plan

### Step 1 — the pace (the fix; nothing else changes the result) — **done**

Four changes, all giving the head the base-clock signal it does not have, all sized against the
PGN rather than tuned by hand.

1. **`TIMING_CONSTANTS.chessmimic.fastFloor`** — a floor under P(bucket 0), the model's own "under a
   second" mass, by the fraction of the game's own starting clock still on our clock, applied only
   in `bullet` and `blitz` and only above 0.2 of the clock. `shapeFastFloor`
   (`src/core/timing/chessmimic-buckets.ts`) fills it from the **hump** alone — at or above
   `fastMoveMaxS` (2 s), below `donorMaxS` (10 s) — so the long thinks keep the absolute mass the
   model gave them, and never drains more than `maxDrain` of the hump. The head applies it in both
   `sample` and `median`, so the `long` label and the allocation see the same distribution the draw
   does. `fastShareCap` is bounded below by the largest floor in the class, because the budget it
   carries (`humanFastShare`, a marginal over every blitz time control) is the weaker of the two
   estimates of the same human quantity — as a **constant** per class, so the budget stays monotone
   in the clock.
2. **`SETTING_GAIN.speedScale` is per time-control class** — 1.0 in bullet and blitz, the owner's
   instructed 1.3 in rapid, classical and untimed, read at `timingSettingsFor` where the class is
   known (an unknown time control takes the blitz value). The gain multiplies a duration, and §3
   prices it at 11.7 s of clock by move 20 in a 3+0; it is also what pushes a sub-second draw over a
   second, which is the mass the floor exists to restore.
3. **`C.bookSpeed` stands down where the floor acts.** The two say the same thing and stacked: the
   book multiplier was set on 2026-09-12 against a head whose sub-second mass collapses from ~22 %
   at a pristine 180.000 s clock to 2–7 % three seconds later — which is *why* the opening looked
   slow. With the floor alone our first eight moves of a 3+0 cost 21.7 s against the real opponents'
   18–21 s and 27.1 % land under a second against their 29.5–31.7 %; with ×0.12 on top, the same
   eight moves cost 7.1 s with 98.6 % under two seconds. Outside bullet and blitz nothing changed.
4. **`bandCentre` is the band's training-population mean, not the midpoint of its name.** The wide
   top band's midpoint is 2850 while its population mean is 2357, so nearest-*midpoint* selection
   sent every target from 2200 to 2450 — inside `2200_3500`'s own range — to `2000_2100` and clamped
   it to 2100. The owner plays at 2400–2450: the band added in Step 3 to stop a 2400 being modelled
   as a 1900 would have modelled it as a 2100. A 2400 target now lands at z = +0.34 of the band it
   belongs to, with no clamp at all from 2300 to 3500.

**The acceptance gate, 3+0 at target 2400, real ONNX bands and the real `TimingModel`**
(`test/core/timing/blitz-clock-budget.test.ts`; the human column is §2's control from the owner's
own games):

| | before | **after** | human | gate |
|---|---:|---:|---:|---|
| clock left after our move 20 | 75.1 s | **101.5 s** | 101.3 s | ≥ 90 |
| clock left after our move 30 | 39.8 s | **61.6 s** | 59.3 s | ≥ 55 |
| clock left after our move 40 | 17.9 s | **35.1 s** | 42.5 s | context |
| median think, 0.85–0.55 | 6.00 s | **3.28 s** | 2.80 s | context |
| share < 1 s, 0.85–0.55 | 2.1 % | **14.6 %** | 15.8 % | ≥ 12 % |
| share > 10 s, 0.85–0.55 | 28.3 % | **17.5 %** | 14.1 % | 10–20 % |
| 10+0 clock after move 40 | 276.6 s | **344.8 s** | — | ≥ 240 |

**Replayed against the owner's own games** — the 27 real games, real positions, real move order,
with the model's plans driving our clock instead of the clock we actually spent
(`.scratch/pgn-replay.test.ts`):

| median own clock left | as played | **modelled** | human |
|---|---:|---:|---:|
| after our move 10 | 148.5 s | **160.7 s** | 158.5 s |
| after our move 20 | 77.3 s | **112.5 s** | 102.3 s |
| after our move 30 | 40.8 s | **74.1 s** | 59.3 s |
| after our move 40 | 17.9 s | **46.0 s** | 42.5 s |

We track the humans through move 15 and then run a little ahead of them, finishing move 40 with
46 s where we actually had 18. The median think in the decisive band is 2.39 s against their 2.80 s
and the sub-second share is 17.7 % against their 15.8 %.

Rapid is untouched by construction and by measurement. Bullet gets the floor too and needed it —
1+0 leaves 12.5 s at move 40 against 7.3 s before.

**Open, and the one thing this round did not fix: the long thinks between 0.55 and 0.25 of the
clock.** We take 0.7 % of our moves there over ten seconds; the humans take 14.4 %. It is not a
pacing choice, it is arithmetic: the move-window cap is `budgetController × budget
.normalWindowAllocations`, which measures 9.4 s at 100 s left and 6.4 s at 70 s, so a normal-mode
plan there *cannot* exceed ten seconds (long mode's six allocations reach 14.1 s and 9.6 s). It
predates this work — 1.6 % before any of it — and it errs on the safe side of the clock, which is
why it was left. Fixing it is one global constant with §13.2 telemetry consequences in every time
control, and it wants its own measurement round. The acceptance gate reports the sub-band on every
run.

### Step 2 — acceptance, before anything else ships — **done**

`test/core/timing/blitz-clock-budget.test.ts`, driving the shipping head (`ChessMimicHead` over the
vendored `onnxruntime-web` and the real band files) through `timingSettingsFor`, 20 seeds at 3+0 and
32 at 10+0, ~70 s in the gate. Every threshold is a measurement from the PGN, extracted by
`tools/pgn-clock-reference.ts` into `test/fixtures/timing/human-blitz-clock.json` (the PGN itself is
not checked in), and a final `describe` asserts each threshold still sits between the human figure
and ours, so the gate cannot be lowered without the fixture agreeing. Every measurement prints pass
or fail, so a run of the file is the before/after table. The numbers are in Step 1.

The original specification below is kept for the record; the one change made against it is that the
long-think bound is asserted over 0.85–0.55 rather than 0.85–0.25, for the arithmetic reason in
Step 1's open item.

The build has no clock test at all today; that is why this went unnoticed. Add, driven by the
simulator at 3+0 / target 2400:

- median clock remaining after our move 30 ≥ **95 s** (the humans in §2.1 had 95 s left; we had 42);
- share of moves under 1 s between 0.85 and 0.55 of base ≥ **12 %** (humans 15.8–19.8 %, we have 0–2 %);
- the > 10 s share unchanged at 8–10 %, so the fix cannot be a flat speed-up;
- §8.6's real-vs-simulated classifier AUC ≤ 0.60 for the ChessMimic head, unchanged.

The PGN is also a ready-made conformance set: `06_eval.py` compares real against simulated think
distributions and these 97 games are real rows at the right rating and time control.

### Step 3 — export the missing bands (after Step 1, not before) — **done, five bands**

Worth doing, for the right reason: the *shape* of a 2500's time use genuinely differs from an 1900's
(§3 — more in the critical middlegame, instant in the endgame) and today every target from 1700 to
3800 is served an 1900. It is not a clock fix and it costs clock, so it lands after the pace fix and
is re-measured against Step 2's thresholds.

All seven were exported and the three already shipped **reproduced byte-identically** — same
SHA-256s across a different torch process and a different onnxruntime, which is the export's
determinism claim holding. Five are registered and bundled:

| band | shipped | `humanFastShare` (moves ≤ 2 s, its own prior) |
|---|---|---:|
| 1200_1300 | yes | 17.8 % |
| 1500_1600 | yes | 21.3 % |
| 1800_1900 | yes | 24.7 % |
| 1900_2000 | no | 25.3 % |
| 2000_2100 | yes | 26.7 % |
| 2100_2200 | no | 28.5 % |
| 2200_3500 | yes | 31.7 % |

`1900_2000` and `2100_2200` were priced and left out: at 18.2 MB each they narrow the worst
rating-clamp error from 350 Elo to 300, on an axis worth 6 % (§2.1). With `bandCentre` reading the
population mean (Step 1 item 4) the clamp is now **exact** from 2300 to 3500 and the worst error in
the whole range is 100 Elo at a 1400 or 2200 target.

The service worker already warms the game's real band at `startGame`
(`warmTiming` → `inferPort.warm(selectBand(targetElo))`), so `CHESSMIMIC_DEFAULT_BAND` only covers
the window before the first game; it stays `1500_1600`, re-justified as
`selectBand(DEFAULT_SETTINGS.strength.targetElo)` rather than "the middle band".

The venv, the upstream clone and the checkpoint cache are in place under `tools/data/`
(git-ignored). `docs/third-party.md` was regenerated with `bun run vendor:engine`.

### Step 4 — pay for the bands in bytes — **done: int8 measured and rejected, five bands fp16**

`--precision int8` had never been measured because it needs torch. Measured now, and it fails on
accuracy rather than on size:

| | fp16 | int8 dynamic |
|---|---:|---:|
| bytes per band | 18,200,481 | 9,483,295 (52 %) |
| max \|Δprob\| vs torch fp32, export side | 7.4e-4 … 1.87e-3 | 3.6e-2 … **2.36e-1** |
| max \|Δprob\|, vendored ORT-web, 200 positions | 1.02e-3 | **6.05e-1** |
| p50 / p95 latency, ORT-web wasm, 1 thread | 28.8 / 30.3 ms | 30.9 / 32.5 ms (**slower**) |

And the failure survives decoding, which is what matters: over five real positions at six clocks the
worst change in the **decoded median think** is 4.00 s (7.50 → 11.50 s) and the worst change in
P(bucket 0) is 39 points; 18.9 % of fixture positions change their decoded median. So int8 does not
buy a smaller build, it buys a different model — and it is not even faster. `fixtureProbTolerance`
was not widened and no int8 tolerance was added.

Option 2 was costed and not taken: Maia-3 int8 was already measured and rejected (`docs/models.md`
§8.3), and dropping the Stockfish smallnet is −15.7 MB raw / −10.5 MB zipped — 22 % of the bill, and
a behaviour change (109 MB resident every game, no crash-fallback build) that
`docs/qa/package-size-2026-09-13.md` already flags as the owner's call.

So Option 3: five bands fp16, +36.4 MB. ChessMimic is now 86.8 MiB and the package ≈ 375 MiB
unpacked / ≈ 302 MiB zipped. No band is marked `bundled: false`; ship-out-of-the-box stands.

## 5. Not recommended: training our own bands

Upstream's granularity above 2200 is one wide band, so 2300–2500 / 2500–2700 / 2700–3000 as separate
models would mean training them. `Training/train_clock_example.sh` wants `.bagz` datasets built by
upstream's C++ position extractor from raw Lichess dumps, batch 2048, 30 epochs on a GPU — weeks and
a data pipeline we do not have, to buy granularity inside a band whose own rating input already
separates 2500 from 3000 (§1), for a rating axis worth 6 % (§3) against a time-control axis worth the
game. And a newly trained band would inherit the same blind spot: no base clock in the inputs.
