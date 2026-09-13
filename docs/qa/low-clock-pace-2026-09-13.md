# Own-clock pace: earlier and harder from 45 s — 2026-09-13

The owner's request: "increase the amount of rapidness the bot wants to do as time
goes down … dont make it any more extreme than it already is just make it want to
move faster as we get towards the end — at times like 30s there should be noticable
changes (and especially at 20s)". Faster moves cost accuracy through the search, not
through any selection change: the search is sized by `estimatedThinkMs`, which now
carries the same factor as the plan, and `MAIA.context.thinkElo` already reads that
estimate. No selection code was touched.

## What was there

Four own-clock terms already acted on a plan, three of them in absolute seconds:

| Term | Written in | Acts |
| --- | --- | --- |
| `compression` (§3a.3) | seconds | under 30 s, panic under 12 s |
| `urgency` (fix C) | fraction of `base_s` | below 80 % of the base, floor 0.45 |
| `lowClock` (2026-09-13 #1) | seconds | ramp ×1 → ×0.45 from 20 s to 5 s, after the cap |
| move-window cap `alloc · 4` | seconds via the allocation | binds on most draws under ~25 s |

Measured before any change (200 seeds per point, the fixed middlegame of
`test/core/timing/helpers.ts`, both clocks equal, default persona, target 1650; "blind"
is the alloc-blind stand-in for the shipped ChessMimic head, "v1" the parametric head):
at 15 s and 10 s the planned think was already the hand's own orientation + approach
(≈ 0.6–0.85 s) in every speed. The 30 → 20 s region was the only one with think left
to shorten; "15 s ≈ today's 20 s" could not be met without making 15 s *slower*.

## The term

`TIMING_CONSTANTS.lowClockPace` — `[seconds left, factor]` knots `[45, 1] [30, 0.82]
[20, 0.62]`, linear between, 1 at and above 45 s, held at 0.62 under 20 s; and
`handS = 0.85`, the natural hand. `lowClockPaceFactor` (`src/core/timing/pressure.ts`)
is applied in the three places `speedScale` is, and only there:

1. the head's think in `planMove` (`tSec *= speedScale * lowPace`, never a premove);
2. the move-window cap in `capFor`: `max(budgetCap · g, min(budgetCap, handS))` —
   the cap scales with the factor but never under a natural hand, and a cap already
   under `handS` (the last ~15 s, where every draw is cap-bound and the plan *is* the
   hand) is left exactly as it was;
3. `estimatedThinkMs` (`src/service/game-session/recommendation.ts`), so the search
   budget the pipeline sizes agrees with the plan.

Not inside `budgetController`: the v1 head multiplies its allocation into its sample,
so a factor there would reach a v1 plan once through the head and again through the
think. Not inside `paceFactor`: where the §3a.3 compression binds, that factor is
still the compression alone (`clock-response.test.ts` pins this).

**Absolute seconds, by choice.** The request is in seconds; the term it extends
(`lowClock`) and the §3a.3 compression are in seconds; and in the last minute the
moves still to be made do not know what the base was — 30 s is 30 s of moves in a 1+0
and in a 10+0. The relative pacing of the rest of the clock is `urgency`'s job and is
unchanged. The 1+0 rows below show what that costs bullet: at 30 s (half its clock)
the factor is 0.82 on top of the 0.79 the relative term already applies, 2.47 s →
2.02 s; at 20 s, 1.71 s → 1.07 s (the hand). Neither is an extreme.

Derivations. 45 s: the last quarter of a 3+0, above where `lowClock` starts, so the
1:00 pace the relative term set on 2026-09-10 is not hurried twice. 0.82 at 30 s: the
asked-for 15–20 % (measured −18 % at 3+0 and 5+0). 0.62 at 20 s: the asked-for 30–40 %
on the uncapped think (−32 % at 3+0, where the plan reaches the hand; −10 % at 5+0,
where it already had). `handS` 0.85 s: `orientation.medianMs` (0.38) +
`motor.hoverMedianS` (0.22) + a two-square drag (`dragBaseS + dragLogS · log2 3` =
0.20) ≈ 0.80 s; the unhurried orientation + approach medians measured at 25–90 s are
0.81–0.87 s.

## Before → after

Median planned think in ms over the same 200 seeds per point (`lc-<tc>-<clock>-<i>`),
blind head; ratio in brackets; "seeds" = how many of the 200 planned a different think
at all, and the largest per-seed difference.

| tc | clock | before → after (blind) | v1 before → after | seeds differing (blind / v1) | max Δ ms |
|---|---:|---:|---:|---:|---:|
| 1+0 | 60 | 4233 → 4233 (1.00) | 1286 → 1286 (1.00) | 0 / 0 | 0 |
| 1+0 | 45 | 3576 → 3576 (1.00) | 1181 → 1181 (1.00) | 0 / 0 | 0 |
| 1+0 | 30 | 2468 → 2024 (0.82) | 999 → 954 (0.95) | 187 / 119 | 651 |
| 1+0 | 25 | 2030 → 1461 (0.72) | 948 → 904 (0.95) | 182 / 100 | 746 |
| 1+0 | 20 | 1710 → 1065 (0.62) | 952 → 924 (0.97) | 186 / 103 | 866 |
| 1+0 | 15 | 1015 → 738 (0.73) | 849 → 748 (0.88) | 185 / 97 | 569 |
| 1+0 | 10 | 733 → 723 (0.99) | 736 → 729 (0.99) | 96 / 77 | 370 |
| 1+0 | 5 | 484 → 482 (1.00) | 482 → 483 (1.00) | 25 / 3 | 178 |
| 3+0 | 90 | 3542 → 3542 (1.00) | 1725 → 1725 (1.00) | 0 / 0 | 0 |
| 3+0 | 60 | 2610 → 2610 (1.00) | 1120 → 1120 (1.00) | 0 / 0 | 0 |
| 3+0 | 45 | 2446 → 2446 (1.00) | 1054 → 1054 (1.00) | 0 / 0 | 0 |
| 3+0 | 30 | 1989 → 1637 (0.82) | 886 → 878 (0.99) | 164 / 75 | 524 |
| 3+0 | 25 | 1610 → 1164 (0.72) | 908 → 885 (0.98) | 178 / 65 | 749 |
| 3+0 | 20 | 1163 → 793 (0.68) | 852 → 756 (0.89) | 180 / 92 | 707 |
| 3+0 | 15 | 758 → 717 (0.95) | 746 → 719 (0.96) | 108 / 74 | 518 |
| 3+0 | 10 | 603 → 604 (1.00) | 607 → 607 (1.00) | 6 / 2 | 133 |
| 3+0 | 5 | 455 → 457 (1.00) | 473 → 474 (1.00) | 13 / 10 | 205 |
| 5+0 | 90 | 2682 → 2682 (1.00) | 1422 → 1422 (1.00) | 0 / 0 | 0 |
| 5+0 | 60 | 2201 → 2201 (1.00) | 1149 → 1149 (1.00) | 0 / 0 | 0 |
| 5+0 | 45 | 2373 → 2373 (1.00) | 965 → 965 (1.00) | 0 / 0 | 0 |
| 5+0 | 30 | 1594 → 1311 (0.82) | 910 → 892 (0.98) | 174 / 55 | 528 |
| 5+0 | 25 | 1098 → 853 (0.78) | 859 → 794 (0.92) | 175 / 63 | 753 |
| 5+0 | 20 | 792 → 713 (0.90) | 744 → 707 (0.95) | 132 / 69 | 641 |
| 5+0 | 15 | 614 → 615 (1.00) | 606 → 606 (1.00) | 11 / 7 | 190 |
| 5+0 | 10 | 607 → 607 (1.00) | 605 → 605 (1.00) | 2 / 1 | 82 |
| 5+0 | 5 | 473 → 483 (1.02) | 482 → 483 (1.00) | 20 / 5 | 228 |
| 10+0 | 90 | 2217 → 2217 (1.00) | 1526 → 1526 (1.00) | 0 / 0 | 0 |
| 10+0 | 60 | 1823 → 1823 (1.00) | 1041 → 1041 (1.00) | 0 / 0 | 0 |
| 10+0 | 45 | 2377 → 2377 (1.00) | 965 → 965 (1.00) | 0 / 0 | 0 |
| 10+0 | 30 | 1441 → 1185 (0.82) | 856 → 853 (1.00) | 160 / 37 | 482 |
| 10+0 | 25 | 971 → 797 (0.82) | 837 → 770 (0.92) | 173 / 77 | 531 |
| 10+0 | 20 | 699 → 663 (0.95) | 672 → 660 (0.98) | 80 / 41 | 556 |
| 10+0 | 15 | 601 → 603 (1.00) | 610 → 610 (1.00) | 5 / 1 | 172 |
| 10+0 | 10 | 608 → 610 (1.00) | 608 → 608 (1.00) | 4 / 0 | 103 |
| 10+0 | 5 | 485 → 485 (1.00) | 471 → 472 (1.00) | 14 / 4 | 199 |

The allocation the search is sized by (`estimatedThinkMs`, 3+0, same position):
650 → 533 ms at 30 s, 518 → 373 at 25 s, 368 → 228 at 20 s; unchanged at and above
45 s. Under 20 s the allocation is at its 0.15 s floor before the factor.

Reading the tail. At 10 s and 5 s the medians are the same and 2–25 seeds of 200
differ, by at most 0.2 s. The mechanism is a draw whose *shortened* think now falls
under a cap that used to bind it: that hand is then its own physical time instead of
`cap · U(0.75, 1)`, i.e. a little *less* compressed than before, never more — and at
5 s a cap that no longer binds does not consume its jitter draw, so the race window's
own uniform draw shifts (same distribution, different number). At 10 s in 1+0 the
budget cap (0.88 s) sits just above `handS` and comes down to it, −1 %. The v1 head
moves far less than the blind head everywhere: its allocation-driven plan is already
≈ 0.9 s at 30 s, within a hand of the floor, and the term does not hurry the hand.

What the request asked for that this does not do: "at 15 s about the same as today's
20 s". Today's 15 s (0.76 s at 3+0) is already well under today's 20 s (1.16 s), so
matching them would have meant planning 15 s *slower*. 15 s is instead −5 % and on the
hand. The ratio at 20 s in 5+0 and 10+0 (−10 %, −5 %) is small for the same reason:
those plans were the hand before this term.

## Tests

- `test/core/timing/low-clock-pace.test.ts` (new, 9 cases): the registry curve (knot
  values, saturation, monotone, untimed = 1, absolute across speeds, `paceFactor`
  untouched); the 3+0 and 5+0 sweeps against the frozen "before" medians above (30 s
  in [0.75, 0.90], 3+0 20 s ≤ 0.72, 15 s in [0.85, 1.03], 10 s and 5 s within ±3 %,
  never slower than the baseline on either head, monotone down the sweep); the cap
  formula on every seed at 30 s (all scaled) and 10 s (fewer than a quarter touched —
  the poor budgeters whose cap sits above `handS`); the rationale line; a premove is
  not paced.
- `test/service/game-session/recommendation.test.ts`: one case — `estimatedThinkMs`
  equals the unpaced allocation × the factor at 60/45/30/20 s.

Re-run one file per process after the change — green: every other file under
`test/core/timing/`, `test/behavioral/telemetry/` (`timing-shape` and
`timing-shape-speeds` — the §13.2 gate at bullet and blitz — included),
`test/behavioral/game/{clock-race, clock-tracking, time-control, timing-observation,
opponent-pressure-timing, scramble-hold}`, `test/service/game-session/{recommendation,
high-elo-budget}`, `tools/telemetry-conformance/{ac-model, bands, report-timing}`.

Findings, not moved:

1. `test/core/timing/clock-terms.test.ts` "from 20 s left the think shrinks toward
   the floor factor" — `twelve < twenty × 0.9` at 600+0 now reads 602 ms against a
   bound of 590 ms (20 s median 656 ms). This is the request: at 20 s of a 10+0 the
   think is now ×0.62 and the plan sits on the hand, so the 20 → 12 s step (which came
   from the cap shrinking 0.82 → 0.6 s) shows as −8 % instead of −14 %. The `lowClock`
   ramp itself is unchanged (the 5 s assertions in the same case pass). The assertion
   encodes the previous request's curve at a point this request moved; it is left as it
   is for the owner to re-anchor (25 s against 12 s, or a 3+0, would measure the ramp
   where the hand is not already the plan).
2. Pre-existing on the working tree, identical with the term neutralised (knots all 1,
   which makes the cap and the think byte-identical to before): `tools/telemetry-
   conformance/conformance.test.ts` (5 cases: `DidSelectMultiplePieces` 12.2 % (28/229)
   against the 4–12 % band on the 600+0 batch, where this factor is 1 throughout),
   `test/behavioral/telemetry/single-piece-select.test.ts` (13.3 %, 79/594, same
   band), and `test/core/timing/chessmimic-instant-cap.test.ts` ("no (speed class,
   game phase) cell exceeds the budget at the plan, on a full clock" — on a full clock
   this factor is 1).

The scratch measurement scripts (`measure-low-clock.ts`, `diff-seeds.ts`) and the
before/after JSON are in the session scratchpad, not the repository; the seeds are the
ones the new test reproduces.
