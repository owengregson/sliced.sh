# Timing renovation and release validation

The [move-rating follow-up](board-rating-updates-2026-09-14.md) records the subsequent fix and
validation for the accumulated commit batch. The artifact and Git status below describe the
earlier timing-renovation handoff.

This change addresses early clock overspending, rating-specific timing, unbounded preparation
latency, model storage, and duplicated native-input code. The checkout already contained a large
unfinished change set; unrelated work was preserved. No commit or push was made for this task.

## Why the previous fix was insufficient

The supplied export contains 97 games. The 27-game 2401–2452 window includes eight losses on
time; its middle-clock median was 6.0 seconds against the opponents' 2.8 seconds. Adding a fast
quota and more low-clock multipliers treated the resulting distribution without establishing a
sustainable whole-game allocation. The earlier simulation also paired random legal moves with
unrelated evaluation features and stopped before the long endings where the problem matters.

[Timing design](../research/timing-overhaul-2026-09-14.md) documents the replacement, including
the specific recognition, complexity, and clock-discipline priors at ratings 400 through 3800.
These coefficients are engineering choices, not a claim of measured human behavior at each Elo.
Six upstream ChessMimic checkpoints now cover novice through expert play. No model was retrained.

## Clock accounting through the service

- Running snapshot clocks are aged before budgeting and again when the selector reads them.
- Policy preparation, the primary search, retries, and optional extra evaluation share one
  absolute preparation deadline. Time spent queued behind engine work is included.
- A search is stopped at that deadline. A bounded 50 ms receipt window preserves Stockfish's
  native rating-limited choice; missing native bestmove receipts never become a full-strength
  top-PV choice. A coherent full-strength partial frame is marked incomplete and cannot receive
  move-quality credit.
- Ponder stopping no longer blocks outside the turn deadline; the existing engine queue still
  serializes the stop receipt and next search.
- Familiar-opening timing requires the move actually selected to match the book, or an explicit
  confident Maia opening decision. A vetoed book answer cannot accelerate an unrelated move.
- Sustainable search allocations are compared with the same rating and position at a healthy
  clock when deriving Maia's context penalty, so the new faster default does not automatically
  lower the requested playing strength.

Native QA also exposed missing clocks on Chess.com's timed computer page: its countdown uses
`move-time-*` elements instead of the live board's `clock-*` elements. The site reported 3+2,
but missing clock readings became zero and compressed plans to an emergency window. The scoped
adapter fallback accepts those elements only with a positive site time control, uses the timer's
dark class for black, reconciles the running side with the legal position, and observes countdown
updates. Untimed per-move elapsed displays remain excluded.

The same live run exposed a separate late-reattach stall. The Reattach handler armed the executor
but omitted the session callback used by the ordinary Auto-play toggle. A recommendation prepared
while disarmed therefore remained at `Awaiting command`. Reattach now notifies the session, and a
regression reproduces the original failure after ten seconds on our turn, then verifies exactly
one legal reply even when Reattach is requested twice.

Restart testing found three related lifecycle faults: the page bridge retained an old game object
when Chess.com reused the board element; explicit null result/time-control values were discarded,
leaving the finished result cached; and an aborted one-ply game could reuse the same identity.
The bridge now reconnects and removes old subscriptions, decoded null values clear cached state,
and ended-game identity detection handles a skipped starting-position snapshot or an identical
opening. Regression coverage includes stale callbacks, timed-to-untimed transitions, and repeated
snapshots without duplicate starts.
Publication follows the board/restart generation, rather than the pathname alone: navigating
from analysis to a computer page must not publish the old retained board as the new game.

## Recorded-game regression

`tools/timing/build-pgn-corpus.ts` builds `test/fixtures/timing/pgn-replay.json` from the supplied
PGN. It selects the last eight 3+0 games with the account rated at least 2400 and at least 60 plies.
The games contain 63–112 plies. Stockfish 18 smallnet supplies coherent decision frames using the
complete legal history, one thread, MultiPV up to six, and depth 10 / 80 ms limits. The fixture
records its source SHA-256; player identifiers are omitted from the game records.

`test/core/timing/blitz-clock-budget.test.ts` replays all eight sequences with two fixed seeds,
the actual ONNX timing models, current clocks, and recorded moves. Every move is charged an
uncached search budget plus `fitTiming`'s remaining executor window. No opening familiarity or
cache hits are invented. This is an offline timing regression, not live engine move selection or
a prediction that future games cannot flag.

Final six-band model replay:

| Measurement | Result |
|---|---:|
| 3+0 completed replays | 16 / 16 |
| 3+0 simulated flags | 0 |
| Median clock after own move 20 | 112.29 s |
| Median clock after own move 30 | 82.14 s |
| Median clock after own move 40 | 63.10 s |
| Median clock after own move 50 | 52.22 s |
| Middle-clock move median | 2.41 s |
| Same-corpus human opponent median | 2.30 s |
| Middle-clock moves under 1 s | 11.95% |
| Middle-clock moves over 10 s | 6.19% |
| 10+0 simulated flags | 0 / 16 |
| 10+0 median clock after own move 40 | 346.32 s |

The middle-clock band is 85% down to 55% of the starting clock: 226 replay moves and 115 human
opponent moves. Frequency checks resample whole games, preserving within-game dependence. The
matched sample's retrospective 95% bootstrap envelopes are 6.72–34.93% for moves under one
second and 2.86–19.44% for moves over ten seconds. These deliberately broad intervals are
regression references, not population calibration. The earlier arbitrary 12% fast-move floor
was removed; the matched interval still excludes the original observed 2.1% fast rate.

The 10+0 run scales the same recorded positions and opponent clock trajectory; it checks clock
behavior, not agreement with a separate human rapid dataset. Clock stress across all rating
knots and controls is reported separately from this high-rating timing comparison.

A separate real-model diagnostic completed **45 / 45** combinations of nine rating knots and
five controls (1+0, 3+0, 3+2, 10+0, 30+0), with zero simulated flags through 56 own moves.
It used 2,394 model queries and 126 intentional clock-race bypasses. The identical expert move
sequence across cells tests clock safety; it cannot establish novice or classical population
realism. The large unused classical clocks remain a limitation of the blitz-trained model.
The complete method and end-clock table are in the timing design document.

## Model size and cleanup

[Model packaging validation](model-packing-2026-09-14.md) records exact sizes, numerical parity,
native Chrome inference, and cold-load cost. Packing is lossless relative to the canonical ONNX
files. Adding the novice checkpoint and retaining several 1500-band matrices at original fp32
precision are separate model changes; the latter fixes a failed numerical parity case without
weakening the tolerance.

The input cleanup shares new-game and resignation gesture lifecycle handling, reducing those
two implementations plus their shared helper from 537 to 376 source lines. It preserves target
revalidation, cancellation, smooth gestures, and cursor/focus ownership. Obsolete timing
controls and resampling state were removed. Historical implementation commentary was shortened
in the recommendation pipeline. The test runner excludes downloaded upstream training trees;
local PGNs, documents, and scratch experiments are ignored without deleting them.

This is a focused renovation of the timing, preparation, model-loading, and native-control
paths, not a claim that all feature debt in the repository has been eliminated.

## Native extension QA

The verified package was loaded in Chrome on a 3+2 game against the Expert 2000 computer,
with requested strength 2150. Live readings learned the site's 180,000 ms base and 2,000 ms
increment; the panel clocks tracked the visible countdowns at their one-second text resolution.
Late Reattach played the existing c5 recommendation. Auto-play continued through six legal
replies (c5, d6, cxd4, Nf6, a6, e6); the five subsequent replies showed 1.0–1.7 seconds in the
site's move list. Pausing aborted the next gesture and left h5 unplayed.

After stopping and detaching the native hand, same-tab rematch and one-ply-abort checks advanced
identities from #0 to #1 to #2. The last two games both began with d4, and the new game produced
its own e6 recommendation with valid 3+2 clocks. Auto-play was left off and the QA tab closed.
Browser control was used for site setup after detaching the extension; native move execution was
validated with the extension owning its debugger session. This short smoke test is not a live
rating calibration or a full-game outcome test.

## Check pipeline integrity

An existing build-tool fault made an early live recheck misleading: the check command's page
script generation overwrote `dist/js/page/chesscom-bridge.js` with development-seeded tokens,
while the bundled content script still used the release seed. A file-by-file comparison found
that single mismatch against the ZIP. Restoring the exact package restored bridge communication.
The check command now requests source-only generation, which still validates programs while
leaving packaged entries byte-identical. Regression tests cover both existing and absent dist
entries; normal full builds retain their original generation behavior.

The full Stockfish integration now runs the actual shipped relaxed-SIMD module under Node/V8
with the production loader and NNUE store. It retains all original search/asset assertions,
adds runtime/module checks, and fails clearly on a missing runtime, crash, or timeout. This
removes Bun's intermittent pthread trap from the gate without retrying or skipping the check.

## Final gate and artifact

- `bun run check`: passed; **2,941 tests passed, zero failures, across 306 files**. Two
  missing-asset placeholder cases were skipped (`skipped: undefined`); both actual ChessMimic
  tests (809 assertions) and both actual Maia tests (250 assertions) ran and passed.
- `bun run build`: passed, including typecheck, constants/CSS checks, asset verification,
  bundle limits, and packaging. `git diff --check` also passed.
- Final ZIP: `release/sliced-2.0.0.zip`, **315,946,300 bytes (301.3 MiB)**, 77 payload files,
  371,408,971 unpacked bytes. ZIP CRC passed; every packaged file matched `dist` exactly.
- ZIP SHA-256: `072e9b2a2230b3031d3296308a3a4edeb12044c2dbecc82db4dd0b80fefed1f1`.
- Installed model payload is **21,985,890 bytes (20.97 MiB) smaller** than the original six-model
  baseline, despite the added novice checkpoint and 1500-band precision correction. The full
  ZIP is 933,738 bytes smaller than the original 316,880,038-byte release.

Separate final-package inference checks passed 200 timing positions across all six bands
(maximum probability error 0.000561) and 60 Maia positions (60/60 argmax and top-five agreement,
maximum probability error 0.000599). Native Chrome inference checks and cold-load/memory costs
are detailed in the linked model packaging report.

The final post-suite build was reloaded in native Chrome and again executed native replies from
a valid timed-game recommendation. Subsequent move-list timings included 1.1, 4.7, and 6.6 seconds.
The test was stopped and its tab closed. No production source changes were made after the passing
suite. Changes remain local and uncommitted; the preexisting worktree changes and original
alternate release archive were preserved.
