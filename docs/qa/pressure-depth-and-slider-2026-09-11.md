# Opponent-clock pacing, automatic depth and slider motion — 2026-09-11

## Release boundary

The requested immediate test package is `release/sliced-2.0.0-pre-endgame.zip`.
It was built from `/tmp/sliced-pre-endgame-build`, containing the completed
strength-selection, timing-inference, receipt/statistics and exclusive-keyboard
repairs before the new opponent-clock changes. All files in that ZIP match its
isolated `dist/`; CRC and all three bundled NNUE hashes passed. The release build
also ran TypeScript and `verify-dist`. Its SHA-256 is
`3ed9d316eebeaf942b613ff12b5f0bfa47ee90f6e0056e9636d2cad1e9ed77e1`.

The changes below belong to the subsequent batch and are excluded from that
named package. The named package is preserved even after rebuilding the standard
`release/sliced-2.0.0.zip` with the next batch.

## Opponent-clock pacing

The previous race policy applied `min(model draw, race window)`, so a tiny draw
could remain near 100 ms regardless of the intended race window. Opponent-only
rushing now samples an independent bounded reply window, approximately 309–564 ms
at one second left for the opponent and 381–672 ms at nine seconds, with no
increment and a comfortable own clock. Binding own-clock limits take priority;
own-clock emergencies and existing premoves retain their dedicated paths.

The hand also uses the full opponent-only gesture allocation instead of waiting
in place and compressing every approach/drag into 300 ms. Its path still has one
press, held movement and one release. Simulator tests exercise twelve distinct
seeds from the service pipeline through accepted board input, including a timing
head returning one millisecond, and verify varied release times and receipt
attribution. Separate tests cover cached versus 90 ms setup, 16 ms CDP
acknowledgements and 330/470/650 ms allocations. No public game was started.

The accompanying [rush-strength investigation](opponent-rush-strength-2026-09-11.md)
records the stronger ordinary candidate sampling, its native short-search probe
and winning-endgame fixture. Rushed choices retain raw diagnostics while being
excluded from normal-target quality warnings. The explicit large-error channel
is not increased by the additional rush penalty.

## Automatic depth

Depth is a resource ceiling derived from the active target, including opponent
matching. It rises from 6 at 400 to 28 at 3200, then uses the extension maximum of
30 above 3200. At active 1650 the cap is 16. Search time remains bounded by the
existing clock budgets, so the requested ceiling is not a claim that a search
reaches that depth or that the displayed target is a calibrated playing Elo.

Settings now displays a read-only automatic depth value and updates it when the
active target or matching mode changes. Legacy persisted depth values remain
compatible but no longer determine the search ceiling. The panel regression
uses a saved target of 3800, legacy depth 6 and active matched target of 1650,
then changes the active target and switches to fixed mode without writing a
manual depth setting.

The same depth policy covers own-move analysis, predicted-position analysis,
premove lookahead, opponent pondering and panel deepening. Pondering uses a
finite depth/time request and reuses an already completed matching result.
Cache reuse respects the requested depth ceiling rather than silently supplying
an unrestricted deeper result.

Focused integration checks cover all time-control classes, matched versus stored
ratings, explicit depth-6 cache hits, rejection of deeper cached results, and
completion at depth 6 or 7 without a redundant shallow-search retry. A ponder
that finishes before its time limit clears its timer, retains its result and
does not stop or resubmit when the same request is repeated. A changed target
starts a new search. Fixtures that specifically require a search in flight now
explicitly hold the long bounded ponder; ordinary finite scripted searches
continue to finish immediately and honor their requested depth.

The native integration test passed two 600 ms, 20-root requests at active 1650
with saved target 2800, requesting depth 16 and returning depths no greater
than 16. It also exercises native timing inference concurrently. Across the
focused depth/cache/controller/budget and affected session suites, 193 tests
passed in isolated Bun processes; TypeScript and the constants check passed.
This includes 26 queued-premove cases, three reactive-premove cases and two
full input traces for opponent pressure. These are implementation checks, not
evidence that the depth curve is calibrated to playing Elo.

## Slider motion

Five small flame wisps rise and sway with different periods and phases. The
steady halo keeps its previous approximately 0.28 maximum opacity and follows
the slider's orange-to-red color. The yellow sweep accelerates continuously:
2.304 seconds at 3400, 1.646 seconds at 3600 and 1.280 seconds at 3800.

Native Chrome review used a local settings fixture, with dark and light themes,
320/360 px panel widths, disabled opponent-matching controls and reduced motion.
The effect fades out over 480 ms below the high-strength range. Reduced motion
hides the decorative wisps and sweep, leaving a subtle static halo; disabling
the control hides the glow and pauses its animations. Screenshots at several
animation phases and computed transforms are retained in
`/tmp/sliced-strength-motion/`, including `results.json`. The automatic depth
row was visually checked in the same fixture. No active user game was changed.
