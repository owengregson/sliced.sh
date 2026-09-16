# Timing tails and a single turn window

## Findings

The current working tree already contained a substantial timing overhaul. This patch retains
its rating bands, clock allocation, recognition rules, parametric fallback and emergency
policy. No weights, game assets or existing migration edits were replaced.

Three additional defects remained:

1. ChessMimic learns elapsed clock time, including executing the move. Its subsecond bucket
   was decoded into a 50–250 ms reaction delay, then orientation and hand duration were added
   again. A continuous subsecond target became a roughly one-second gesture.
2. The budget scaled all of a learned duration, including its physical lower endpoint, then
   restored a 250 ms floor. Short windows accumulated at exactly that floor. Recognition
   allocations below the physical minimum had the same issue.
3. After scaling the learned distribution by its mean, the policy additionally capped every
   draw to three to six routine allocations and 16% of the clock. At 72 seconds remaining,
   the four-position probe produced no moves over ten seconds at any tested rating. The
   humans in the local expert 3+0 sample still used long decisions at that stage.

The independent executor findings are documented in
[`timing-execution-contract-2026-09-16.md`](timing-execution-contract-2026-09-16.md).
The parent owns executor, session, recommendation and actual-release telemetry integration.

## Changes

`HeadSample.includesExecution` distinguishes an elapsed clock label from a parametric reaction
delay. ChessMimic normal, long and instant samples carry it. The parametric fallback retains
its existing semantics; queued premoves retain their separate session path.

The learned subsecond draw is conditioned on feasible support: uniform `[0,1)` seconds becomes
uniform `[0.21,1)`. The lower endpoint is the existing 150 ms orientation plus 60 ms motor
minimum. This retains the entire feasible subsecond range without clamping probability onto
one duration or charging the gesture twice. The novice model's first bucket spans two
seconds; its learned fraction above one second remains in the normal channel.

Mean calculation now uses this actual fast decoding, including the novice bucket's mixture,
instead of multiplying the fast component by the body's persona/residual. Budget scaling
acts on duration above its feasible endpoint. When the target itself is subphysical, a
monotone bounded transform makes a compact 210–420 ms reaction window; it does not report
an impossible zero-duration move or a repeated 250 ms floor. The existing clock emergency
policy may shorten this further when the real clock requires it.

Learned totals retain their mean-based allocation, but rare draws use the existing
`longThinkCapSec` envelope (25% of current clock and a time-control-specific maximum),
subject to tighter hard clock caps. Recognition caps still make a known forced recapture
quick. Fallback caps are unchanged. This removes the extra allocation-sized truncation; it
does not prescribe a universal percentage of long moves or assert that every long sample
can fit any clock.

Drag and promotion durations scale together inside the reserved approach. Optional fake-outs
are omitted if the complete gesture cannot fit. `remainingMoveWindow(plan, now, reserve)`
reports elapsed time, remaining time, latest execution start, optional-action allowance and
unavoidable overrun without changing the original deadline or adding a new wait floor.

## Evidence and reproduction

Run:

```sh
bun tools/timing/distribution-report.ts /tmp/timing-report.json \
  'chess_com_games_2026-09-13 (1).pgn' chess_com_games_2026-09-14.pgn
bun test --timeout 30000 test/core/timing
```

The machine-readable before/after results are in
[`timing-distributions-2026-09-16.json`](timing-distributions-2026-09-16.json).
The baseline is the intentional dirty working tree before this patch, including the existing
SF19 changes. There are 48 diagnostic cells: Elo 800/1600/2400/2800; 1+0, 3+0, 3+2, 10+5;
70%, 40%, 15% of starting clock. Each cell contains 1,024 plans from four recorded expert
positions, using real ONNX inference, its actual returned band, and the same deterministic
seeds. These fixed-position rating/control substitutions expose software behavior; they
are **not human calibration data for the substituted ratings or controls**.

Human aggregates use both local PGNs, deduplicate games by link, exclude our own account,
exclude each player's first two moves, and group by opponent rating and clock fraction.
Examples from expert 3+0 opponents:

| Opponent Elo | Clock fraction | Games | Moves | Median | Under 1 s | Over 10 s |
|---|---|---:|---:|---:|---:|---:|
| 2000–2399 | .85–.55 | 84 | 852 | 2.9 s | 12.1% | 13.5% |
| 2000–2399 | .55–.25 | 68 | 668 | 2.3 s | 12.1% | 9.9% |
| 2400–2799 | .85–.55 | 35 | 362 | 3.3 s | 14.6% | 13.8% |
| 2400–2799 | .55–.25 | 32 | 256 | 2.9 s | 12.5% | 14.8% |

Do not compare these marginals as though they were labels for the four fixed probe positions.
The complete-game replay uses eight real games and two seeds, coherent recorded engine
features, and an execution cost estimate. Its matched human middle-clock sample has 115
moves; whole-game bootstrap intervals are wide. The replay is a regression check rather
than an independent held-out population validation. The initial comparison below used
preparation plus fitted executor time for both columns.

| Complete-game replay | Before | After |
|---|---:|---:|
| 3+0 middle-clock median | 2.41 s | 2.29 s |
| 3+0 middle-clock under 1 s | 11.9% | 17.8% |
| 3+0 middle-clock over 10 s | 6.2% | 10.8% |
| 3+0 median clock after move 30 | 82.14 s | 81.34 s |
| 3+0 median clock after move 50 | 52.22 s | 49.37 s |
| 3+0 flagged games | 0/16 | 0/16 |

After the parent integrated immutable deadlines and overrun attribution, the replay cost
was updated to `max(sampledTotal, searchMs + reservedApproachMs)`, with pace adaptation
disabled for preparation overruns. An expired optional window must not make the still-owed
physical gesture free. The refreshed result is:

| Current reservation replay | Result |
|---|---:|
| 3+0 middle-clock moves | 213 |
| 3+0 middle-clock median | 2.21 s |
| 3+0 middle-clock under 1 s | 15.5% |
| 3+0 middle-clock over 10 s | 9.9% |
| 3+0 median clock after move 30 | 82.29 s |
| 3+0 median clock after move 50 | 50.44 s |
| 10+0 median clock after move 40 | 366.20 s |
| Flagged games | 0/16 for each control |

The refreshed replay changes both cost accounting and adaptation, so its difference from
the initial table is not an isolated estimate of sampler improvement. The matched humans'
median is 2.30 s. Their whole-game bootstrap rate intervals are 6.7–34.9% under one second
and 2.9–19.4% over ten seconds; both current tails remain inside those regression intervals.
The fixed-position report measures the timing model without executor code. Neither replay
measures live browser transport or the observed time of actual mouse release.

## Research basis and limits

The primary ChessMimic paper defines observed time as pre-clock minus post-clock plus
increment, which supports including movement in the same window. Its clock model conditions
on both remaining clocks and increment, without starting time control. It also reports weaker
per-position timing prediction than ALLIE and locates the shortfall in distribution sharpness.
Changing decoding and budget semantics does not fix that model limitation.
[ChessMimic, sections 4.1 and 5.6(C)](https://arxiv.org/html/2606.04473v1).

Sigman et al. found long-tailed, phase-dependent response times and correlations across moves
in three-minute games. This supports preserving variation and the existing game residual;
it does not identify an Elo-specific percentage of mouse actions or license inventing one.
[Original study](https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2010.00060/full).

The learned head remains a Lichess blitz model. The local human controls are Chess.com expert
3+0 opponents. Novice, increment, rapid and classical population calibration still needs
appropriately matched held-out games. No new model was trained. Validation used local model
replays and the simulated input pipeline. Per the user's constraint, no native Chrome or
existing browser tabs were used, and no live extension testing was performed. Native execution
remains unverified, including source approach, promotion, premoves and transport overhead.

## Fixed-position diagnostic comparison

Each row has 1,024 plans. Values are before → after, in seconds or percentages.
The full JSON also includes the remaining clock and time-control cells.

| Elo | Time control | Clock left | Under 1 s | Over 10 s | p10 | p95 |
|---:|---|---:|---:|---:|---:|---:|
| 800 | 3+0 | 72 s | 37.7% → 50.2% | 0.0% → 0.0% | 0.74 → 0.49 | 4.11 → 3.69 |
| 1600 | 3+0 | 72 s | 47.1% → 54.6% | 0.0% → 0.7% | 0.65 → 0.36 | 5.11 → 4.56 |
| 2400 | 1+0 | 42 s | 54.1% → 66.7% | 0.0% → 0.0% | 0.68 → 0.30 | 2.86 → 2.49 |
| 2400 | 3+0 | 126 s | 27.1% → 27.5% | 7.4% → 6.3% | 0.73 → 0.63 | 11.23 → 10.96 |
| 2400 | 3+0 | 72 s | 43.1% → 48.8% | 0.0% → 1.2% | 0.71 → 0.36 | 5.94 → 5.51 |
| 2400 | 3+2 | 126 s | 26.6% → 28.1% | 11.9% → 12.1% | 0.77 → 0.62 | 15.15 → 16.35 |
| 2400 | 10+5 | 420 s | 22.1% → 33.5% | 13.6% → 13.3% | 0.84 → 0.44 | 19.84 → 19.91 |
| 2800 | 3+0 | 72 s | 48.5% → 51.4% | 0.0% → 0.7% | 0.66 → 0.38 | 4.57 → 5.04 |

The affordable long tail is no longer structurally absent in the 72-second expert cells.
Other cells can have lower long-think rates after correcting the decoded mean; the policy
does not boost the tail indiscriminately. Low-clock fixed probes remain faster than the
pooled expert human marginals, which is another reason not to claim population parity.

## Validation

- `bun test --timeout 30000 test/core/timing`: **175 passed, 0 failed**, 25 files, 124 seconds.
  This includes real ONNX complete-game replays, quick replies, forced/recognized moves,
  all registered bands, low-clock safety, premove guards, replan behavior and the new total-window
  regression tests. The initial default-timeout run hit six timeout-only failures in existing
  3,000–6,000-sample probes while other agents were using CPU; their assertions were not weakened.
- `bun run typecheck`: passed again after the integration tests and fixture correction.
- After executor integration: **11 behavioral checks passed**, including two new slow-search
  release regressions, existing release attribution, base speed and opponent pressure.
  The new fixture delays worker processing by 300 ms before a 1.4-second search and asserts
  that first snapshot capture still anchors the sampled deadline and release observation,
  including when a same-position clock update refreshes the stored snapshot during search.
- First-arrival follow-up: **6 checks passed** across slow-search release, same-position
  clock readings and timing observation, each file run separately; typecheck passed again.
- Refreshed complete-game reservation replay: **3 passed, 0 failed**, 60 seconds; no flags
  across 16 games per control. These tests retain their existing human and clock thresholds.
- Biome check on changed timing, report and test files: passed.
- `bun scripts/check-constants.ts` and scoped `git diff --check`: passed.

No commit, push, stash, reset, clean, model download, model replacement or service/motor edit
was performed by this timing workstream.
