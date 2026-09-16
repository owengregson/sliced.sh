# Maia selection ceiling and routing

> **Superseded in part on 2026-09-15** (owner: "lets just use stockfish big net at wherever the
> maia cutoff is … we just go straight from that to big net at 3000"). The 3000–3200 band below —
> Maia ranking a 12 → 4 cp engine pool on the small network — is removed, and so is the separate
> 3200 network cutoff. There is one division, `MAIA.eloMax` (3000, inclusive for Maia): above it
> the full network plays the strongest guarded continuation, the book is off and the automatic
> depth ceiling is the maximum. The rest of this note describes the 2026-09-14 state.

The active target now controls both selection and automatic network choice. Maia-led selection
continues through 3000 inclusive, with progressively stronger verification above 2800. Above
3000 through 3200, the engine limits the acceptable alternatives and Maia ranks that pool.
The allowance tightens linearly from 12 to 4 cp; missing-policy fallbacks retain the same bound.
Above 3200, selection uses the strongest guarded engine continuation and automatic routing
requests the full Stockfish network. Explicit Big remains available at lower targets.

These are engineering boundaries, not measured achieved Elo. The preceding investigation
queried the shipped 79M model 2,526 times across positions from the supplied games and an
independent elite-player reference. Raising model conditioning from 3000 to 3200 showed no
clear overall advantage. Self conditioning is therefore capped at 3000; the opponent rating
remains a separate input. No model weights were changed or retrained for this release.

## Corrections

- Network choice previously used the saved slider even when opponent matching changed the
  active target. Every session search now carries its target separately from UCI strength
  limiting, including preanalysis, pondering, premove evaluation, and board move ratings.
- The old secondary Maia policy continued almost to the maximum setting. It now stops at 3200,
  including prediction, ready moves, warmup, and reconnect preferences.
- Cached policy answers now identify model size, both ratings, selection mode, board history,
  and full repetition history. The actual self-rating input is rounded to whole Elo points
  (at most 0.5 Elo) so millisecond clock drift does not create meaningless cache misses.
  Settings/opponent changes invalidate asynchronous work so a
  late answer cannot republish a recommendation from the old configuration.
- An unrestricted referee answer cannot masquerade as a native strength-limited choice when
  Maia fails. Selection distinguishes the retained engine result's actual search mode. The assisted
  interval also rejects out-of-band or unscored native choices when policy inference fails.
- Ready moves retain the active target instead of subtracting 250 Elo and potentially crossing
  a routing boundary. They carry the validated history and original search provenance.
- A fresh restricted search must include independent engine candidates. A bounded unrestricted
  preliminary search supplies those candidates while Maia inference runs; an eligible held
  prediction can supply them without another search. If there is insufficient time or no usable
  engine evidence, search remains unrestricted. Failed narrowed searches retain a completed
  unrestricted result.
- Network changes invalidate cached frames. Request cancellation stops waiting immediately but
  keeps the requested network warming; changing the required network cancels obsolete loading.
  Cross-game resets preserve initialization/reset ordering. Actual Full-to-Small crash fallback
  invalidates Full frames and remains visible in the panel.

## Clock and verification behavior

All own-move preparation uses one deadline: 600 ms in an ordinary blitz position, shorter under
clock pressure. The unrestricted preliminary search uses at most 200 ms and one third of the
remaining preparation budget. Main searches, retries, and any extra candidate scoring consume
only the remainder. Tests cover model failure, cancellation, completed-result fallback, and
opponent-matched boundary transitions. Increasing verification does not increase that budget.

Above effective selection Elo 2800, candidate breadth rises from two to seven, intuition probability decreases from
60% to 3%, and evaluation noise decreases from 80 to 12 cp. (Through 2800 these were five, 10% and
20 cp when this note was written; the 2026-09-15 recalibration in
`docs/qa/generate-verify-2026-09-13.md` lowered the 2800 end after measuring the extension far
above its target against chess.com humans. The 3000 end is unchanged, so the 2800–3000 ramp is
now steeper and has not been re-measured against humans of that rating.) The requested comparison depth
rises from 10 to 14 while verification increasingly uses the final coherent frame. Missing
comparison frames use the available bounded evidence and report that fallback. Search depth
is a ceiling and is not guaranteed to be reached. The upper loss rail reaches 80 cp at 3000;
mate, repetition, conversion and piece-safety guards still apply.

The policy-only confidence shortcut no longer reduces search time above 2800. Existing
verification behavior through 2800 is preserved; adding independent engine evidence changes
which roots can be considered when the previous search would have used Maia alone.

## Validation

The offline comparison held the saved real Maia policy at input 3000 to isolate verification.
It reused 241 recorded positions, retaining 217 finite-score frames, and refreshed Stockfish
scores on 64 stratified positions with full history, retaining 60 finite-score frames. Frames
containing mate scores were excluded from this numeric comparison and covered by separate
selection tests. The refresh used Small, one thread, depth 18 / 800 ms limits and complete
intermediate frames. These scores do not measure the live pipeline's achieved strength.

| Effective selection Elo | Mean expected loss, 217 saved frames | Mean expected loss, 60 refreshed frames |
| --- | ---: | ---: |
| 2800 | 8.12 cp | 23.05 cp |
| 2900 | 5.03 cp | 6.13 cp |
| 3000 | 2.87 cp | 2.49 cp |
| 3050 | 1.08 cp | 0.64 cp |
| 3100 | 0.82 cp | 0.39 cp |
| 3200 | 0.28 cp | 0.18 cp |

These rows describe the generate-and-verify values of 2026-09-14. The 2026-09-15 recalibration
(`docs/qa/generate-verify-2026-09-13.md`, "Recalibration") lowered the path's strength through
2800 after it measured the extension far above its target against chess.com humans. Replaying
the same retained frames with the new values (`.scratch/maia-ceiling-implementation-2026-09-14/replay-recal.ts`,
parity check against the old draw removed because the lower range changes by design) gives
21.63 / 13.82 / 8.86 / 2.87 cp at 2800 / 2900 / 2950 / 3000 on the 217 saved frames and
32.30 / 16.83 / 9.30 / 2.49 cp on the 60 refreshed frames; 3000 and above are unchanged and the
curve is still non-increasing.

The original proposed 60-to-12 cp prior allowance caused a regression immediately above 3000;
the 12-to-4 allowance removed that reversal in these cohorts. This is a conservative quality
constraint, not proof of an optimal human-similarity cutoff. Exact old/new generate-and-verify
draws matched in 831 seeded comparisons at fixed inputs 2500, 2600 and 2800.

The final `bun run check` gate passed: **2,991 tests, zero failures, 1,257,845 assertions
across 310 files**. Two existing non-applicable placeholder tests remain skipped; both real
ONNX integration suites ran, as did both Stockfish networks. Typecheck, lint, constants,
source generation, and the full isolated-process test runner passed. This final run includes
the whole-Elo canonicalization fix. The independent pipeline deadline tests use real timers,
including stalled searches and cancellation before a move plan can be published.
A passing candidate probe does not establish human playing strength or predict the outcome of
an entire game after a changed move. Live clock and rating calibration still requires complete
paired games; no rated human games were started for this change.

A separate real-engine pipeline smoke completed 18/18 legal recommendations on four recorded
boards at targets 2800, 3000, 3100 and 3200, plus unavailable-policy cases at 3000 and 3200.
All requests preserved full engine history and the expected eight policy frames. The smoke
used immediate saved real 79M input-3000 policies, V1 timing, and the Small engine under Bun;
it tests pipeline mechanics, not fresh inference latency or the quality of the newly requested
conditioning inputs. The full network boots in a separate native integration test, while
controller tests cover its active-target routing and fallback behavior.

Search limits summed to at most 600 ms. Total pipeline completion was 603–689 ms (median
609 ms), including selection and other CPU work after engine preparation. The 600 ms budget
is therefore not a hard ceiling on total completion time. Final search depths were 12–16;
90-second clocks in a 180-second game reduced target 3000 to a conditioning input near 2851
(before additional selector ambiguity adjustments), so direct
comparison frames were depth 10–11. Both unavailable-policy cases returned a legal sampled
move with zero measured loss and no false native-limiter attribution. No runtime errors occurred.

## Release artifact

`bun run build` passed, including typecheck, constants/CSS checks, bundle limits, model hashes,
packaged-asset verification and ZIP creation. An independent ZIP check confirmed every CRC,
unique member names, 77 payload files and manifest version 2.0.0. `git diff --check` passed.

- ZIP: `release/sliced-2.0.0.zip`
- Size: 315,949,365 bytes (301.3 MiB), 2,978 bytes above the preceding package.
- SHA-256: `c173bbfe859999f1f6646a01ac07c3f5204676d32a54c20f4f243fca765767c5`
- Unpacked build: `dist/`, 354.2 MiB. Model assets remain unchanged.

The packaged build has not been tested in a new live Chrome game during this change. The
recorded evidence is automated lifecycle/UI testing, native model/engine execution, and the
bounded offline pipeline smoke described above.
