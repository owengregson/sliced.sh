# Strength selection investigation — 2026-09-11

The reported setting was around 1650, Hybrid/Balanced, opponent matching, 1× errors,
opening book on, and 3+0. The displayed pair (about 50% top-1 and 22–24 search loss)
does not establish a playing rating. The investigation found concrete reasons that
selection could remain too accurate even when top-1 agreement looked ordinary.

## Findings and corrections

- Ordinary blitz searches exposed six best moves. In several real searches, every
  candidate was within 23–37 cp of best. No sampler restricted to that pool could
  produce the displayed 45–60 average-loss band. The root task expands candidate
  discovery within the existing search time budget.
- The shallow-search fallback retained only two moves and halved temperature. On
  the captured positions this produced 53–59% top-1 with only 0–6.4 cp average loss.
  The root task removes this fallback and handles incomplete MultiPV results.
- Conversion previously returned one deterministic progress move within 25 cp,
  before applying rating or form. It now keeps non-drawing searched wins, bounds
  their loss with the existing rating-dependent gap, and uses a modest progress
  prior while the ordinary rating model selects the move. Immediate and searched
  forced mates, repetition avoidance, and stalemate/dead-position guards remain.
- Opponent clock pressure previously disabled injected errors and could replace a
  weaker move with a forcing move within 35 cp. Below ten seconds, a separate
  early return ignored rating altogether. Pressure now reduces effective selection
  strength by at most 100 Elo and adds a small forcing prior. It retains the
  selected rating's sampling and error model. The maximum setting still omits
  injected blunders; its clock-race variation remains near the strongest moves.
- The deliberate-error pool used jittered loss, so perception noise could label a
  harmless near-equal move as a blunder and activate the error damper. Eligibility
  and target matching now use unjittered loss.
- Reported loss and ranking used policy scores clamped to ±1000 cp. For example,
  +2500 to +1100 reported zero loss. Ranking and comparable loss now use raw engine
  scores. Explicit quality metadata excludes single-choice, mate, bound, missing,
  shallow, mismatched-depth, incomplete, and book rows from comparable session statistics.
- Normal request completion did not require a complete MultiPV iteration before
  caching. A deep two-line partial result could therefore satisfy a later request
  for twenty candidates. Cache reuse now requires `final.complete`; a partial
  result may still supply a legal immediate choice, but cannot supply a comparable
  quality sample.
- In native engine-Elo mode, a legal `bestmove` outside the completed scored pool
  fell back to the strongest scored move. That case now preserves the native
  choice without inventing a rank or loss. Existing searched mate, stalemate and
  repetition safeguards still take precedence; an already-vetoed scored move
  cannot re-enter through this fallback. The missing-native-choice case is a
  focused synthetic regression, not an observed failure in the eight captures.

The existing temperature, perception-noise, base-error, form, and agreement-band
tables were not retuned. Heuristic priors were a smaller influence in the probe:
the Hybrid bestmove preference multiplies odds by approximately 1.32 at 1650.
Changing that preference shifted top-1 by roughly 5–7 percentage points on the
captured six-move pools, with much smaller changes in average loss.

## Native engine probe

`test/fixtures/strength/stockfish18-blitz.json` preserves eight captured searches:
four legal positions, each at MultiPV 6 and 20. The vendored Stockfish 18 smallnet
ran with one thread, 32 MB hash, native UCI_Elo 1600, strength limiting enabled,
and `go movetime 600 depth 18`. The engine reported no errors. The fixture keeps
complete unique root-move cycles and each line's actual depth; different-depth
comparisons remain ineligible for session metrics.

Before the corrections, 2000 selector draws at target 1650 on each fixed search
gave these average raw score losses. The native engine requests remained at
UCI_Elo 1600; 1650 is the downstream selection target in this comparison, not a
claim that the recorded engine searches used native UCI_Elo 1650:

| Position | Six candidates | Twenty candidates |
| --- | ---: | ---: |
| Start | 18.4 | 42.7 |
| Ruy Lopez | 9.8 | 51.5 |
| Italian | 11.8 | 40.9 |
| Tactical middlegame | 40.9 | 71.7 |

The searches reach different depths under the same time limit; this table
demonstrates missing error diversity, not an optimal MultiPV setting or calibrated
playing strength. A separate regression truncates the same broader search to
isolate the candidate-pool effect without changing search depth.

In a fixed six-move diagnostic position at 1650 with 90 seconds of our 180-second
clock remaining, the old opponent-pressure layer changed average loss from 49.4
to 7.1 cp when the opponent reached one second. The corrected policy produced
49.1 normally and 52.3 at one second. This is a relative policy check on controlled
candidates, not a game-wide acceptance target.

## Validation and limits

Focused regressions cover raw score ranking/loss, quality exclusions, book
exclusions, retained Elo sensitivity in winning positions, bounded deterioration
under opponent pressure, honest error eligibility, and the real engine candidate
fixture. Existing mate, stalemate, repetition, prior, and strength tests also run.
The release task records the aggregate gate separately.

Replaying all eight captured UCI streams through the corrected parser yielded
complete coherent candidate sets, with each native bestmove present. Separate
pipeline regressions exercise partial frames and absent native choices.

`test/integration/strength-pipeline.test.ts` also boots the bundled engine and
runs the actual controller, UCI client, recommendation and timing pipeline on two
positions. A saved target of 2800 with an active persona target of 1650 sends
native UCI_Elo 1650, requests 20 candidates within the existing 600 ms budget,
and receives 20 distinct legal roots at one completed depth. Both positions
produce legal moves with no native engine errors. This verifies the integrated
request path independently of the earlier captured UCI_Elo 1600 fixture.

The active target now reaches native Elo requests. Network variant selection
still follows the saved fixed target, however: opponent matching across the 3200
network boundary can retain the wrong packaged variant. Correcting that requires
request-level arbitration across the shared engine and is deferred. It does not
explain the reported approximately 1650 game, which uses the small network on
both paths.

The original statistical coverage used fabricated lines. The telemetry report
test inserts an in-band quality pattern to test report parsing; it is not rating
validation. There was no implemented whole-game selection-calibration corpus.
The new fixed native examples close a regression gap but do not establish actual
1650 Elo or a win rate. Broad independent game evaluation remains necessary for
those claims.

Investigation scripts and detailed before/after results are retained locally in
`/tmp/sliced-strength-audit/`; the checked-in fixture and tests contain the durable
reproduction inputs.

## Search-quality statistics and diagnostic export

The reported 1650 target selects the existing 1600 reference knot: 47–53% top-1 and 45–60 cp loss. The reported 50% / 22 pair passes agreement and fails only the loss range. These are diagnostic reference bands, not measured playing Elo or a validated blitz/no-increment calibration. No bands were widened.

The old warning graded the cumulative global pair against the last game's current target. A reproduced sequence with one bad game followed by two individually in-band games still reached a three-game warning. Statistics now capture target and strength/time-control context at recommendation time, pool only settings sharing a reference rating band, and grade each finished game's own comparable choices. Targets 1650 and 1673 can share a cohort; different bands, modes, personas, blunder settings, book settings and base/increment controls cannot. Games with fewer than 20 comparable choices do not advance the diagnostic warning. For sufficient samples, an approximate uncertainty interval must lie wholly outside the reference before the game advances the warning; an uncertain game resets the streak. The point estimate remains visible without being marked outside solely because of sampling noise.

With 20 independent choices and true 50% top-1 agreement, the old 47–53% point check accepts only 10/20. Exact binomial enumeration gives an 82.3803% outside rate and a 55.9075% chance of three consecutive outside games. The new guard uses the [NIST Wilson score interval](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm) with nominal 95% critical value for top-1, plus a loss interval of mean ±2.1 standard errors from an online Welford squared-deviation accumulator. The 2.1 multiplier is slightly wider than a two-sided t critical value at n=20 and is conservative for larger samples. These are approximate noise guards: chess choices are correlated and loss distributions can be skewed, so neither guaranteed coverage nor measured Elo is claimed. The controlled independent 50% fixture produces a 4.1389% per-game outside rate with the guard; this is a regression result, not a real-game false-positive estimate.

Quality version 3 discards old clipped/mixed-target loss, agreement and streak values while retaining historical game/move counts, average timing and finished-game receipts. The panel labels the result as search loss, shows its scored-move count, and hides unrelated or legacy cohort warnings. Exported telemetry includes search eligibility/reason, depth, candidate count, actual target and cohort when available; premove/book/forced/mate/bounded/shallow/incomplete evaluations do not silently become zero-loss quality samples.

Game end now drains the cancelled executor's final verification before finalizing the quality sample. A behavioral regression seeds 19 valid choices, ends the game while the next accepted move is being verified, and confirms exactly 20 scored choices, one eligible game and one execution receipt. Matchmaking scheduling remains ahead of that wait.

The empty-export defect was independent: the export handler read only persisted storage, while current rows remained in the live writer until a five-minute flush alarm. The documented game-end flush was missing. Export now flushes and reads the live writer; Clear updates both the buffer and storage; game end flushes after the final receipt. Writes are serialized and revision-checked so appending or clearing during storage I/O cannot lose or resurrect rows. Startup reads merge already-arrived moves and honor a concurrent Clear.

Focused validation: 5 uncertainty-helper tests, 11 statistics tests, 24 live-panel tests, 2 reactive-premove tests, 26 queued-premove tests, 15 game-end tests, 2 verification-race tests, 9 telemetry tests, 10 timing-writer tests and 9 log-handler tests passed in separate Bun processes. Typecheck and scoped Biome checks passed. Independent peer review reran 42 helper/statistics/panel/verification tests and checked Welford against a two-pass calculation over 200 samples and interleaved games. No public match was played for this work.

## Timing diagnostics and keyboard isolation

The separate [timing investigation](timing-integration-2026-09-11.md) records the missing inference call, timeout under simultaneous Stockfish load, incorrect elapsed-time feedback, native model comparisons and corrected timing-average migration.

The Engine view had a timing-log subscription but no production publisher. The live writer now publishes new plans and receipt updates through the panel broadcaster. The view replaces rows by game and ply, merges initial history with arriving updates, and displays the actual timing head, model band or fallback reason, effective target, opponent clock and timing rationale. Exports retain this provenance; old entries without it remain readable. Actual turn time and hand execution time are separate fields.

Keyboard isolation previously depended on visible cursor state and only consumed matched shortcuts on keydown. An explicit service-to-content ownership command now survives hidden cursor graphics and reconnects. While owned, keydown, keypress and keyup are consumed; bot shortcuts still execute. Stop consumes the remainder of its own press before restoring page input. Sidebar text editing and shortcut recording remain usable. Keyboard-generated clicks also obey input ownership.

Native Chrome validation installed the actual compiled key listener in an isolated world before page listeners. Real trusted q, ArrowLeft and Enter presses during ownership produced no page key events, input text or button activation. Space reached the bot, Shift+X stopped ownership, its release remained suppressed, and subsequent typing worked after stop and disposal. This ran on a local fixture without touching an active public game. The keyboard lane passed 79 focused checks; diagnostic writer, panel rendering and production port tests additionally cover streamed receipt replacement and provenance.

The separate [ordinary move pacing investigation](timing-integration-2026-09-11.md)
documents the missing model preparation, hand-only feedback defect, native model
probe, corrected receipt timestamps and controlled clock-feature checks. Timing
weights and global speed multipliers were not retuned in this repair.

## High-Elo audit after the reported 2700-versus-2800 game

This section records the policy before the subsequent high-Hybrid correction.
The current behavior and captured native regression are documented in
[High-rating selection probe](high-elo-selection-2026-09-11.md#bounded-correction).
The later endgame and automatic-depth changes are a separate release batch.

A reported win as Black does not establish either bot's playing rating or identify
a selection defect. First distinguish the saved slider from the active target:
`GameSession.targetElo()` uses the opponent's reported rating plus the persona
offset when opponent matching is enabled. The defaults are matching on and +50,
so a saved 2700 can yield an active target of 2850 against a reported 2800. Whether
that happened in the reported game is still unconfirmed; the opponent identity,
time control and active target need to accompany the game record.

The read-only audit found a concrete limitation in the high-range model. At
effective Elo 2500 and above, the ordinary selector's parameters are constant:
perception noise is 8 cp, temperature 0.02, gap 60 cp, prior exponent 0.2, and base
error probability 0.005. The rating-dependent heuristic priors have also reached
their upper ranges. Form and opponent pressure can move an effective target below
that boundary, but they do not create a distinct curve above it. This is a
missing high-range differentiation, not evidence that any particular setting has
a measured playing rating.

An identical-seed replay isolates this effect using all four checked-in native
MultiPV-20 positions, 500 choices per position, form 0, Hybrid, identical native
bestmove, equal 90-second clocks in 3+0, and unchanged candidates. Targets 2600,
2700, 2800, 3000, 3190 and 3200 produced exactly the same 2000-move/source sequence:
31.9% top-1, 9.923 cp mean searched loss, and 12 error-channel choices. These
numbers describe only those repeated fixed inputs; the fixture's native searches
used UCI_Elo 1600 and this experiment does not simulate native high-Elo searches
or whole games. Reproduction is retained in `/tmp/sliced-high-elo-audit.ts` and
`/tmp/sliced-high-elo-audit.json`; run with
`bun --preload ./test/setup.ts /tmp/sliced-high-elo-audit.ts`.

Actual high-target games can nevertheless differ for several reasons:

- The active target reaches native `UCI_Elo` through 3190. `engine-elo` uses that
  native choice subject to the existing mate/draw guards. Hybrid instead favors
  the native choice by a prior factor of 2, then raises that prior to 0.2 at high
  targets: approximately 1.149 times the sampling weight, before normalization.
  It therefore does not preserve the native limiter's output distribution.
  Persona sampling ignores native bestmove. Native Elo and downstream selection
  are separate mechanisms, not two independently calibrated rating controls.
- Ordinary 600 ms blitz requests ask for 12 candidates at 2600 but only 6 above
  2600 with default settings. Other budgets use the adaptive 3/6/8 ladder, with
  the configured MultiPV as a floor. This changes both the candidate population
  and available search depth. The boundary is deliberate code, but its effect on
  playing strength has not been calibrated.
- Native limiting turns off above 3190. The current product maximum is 3800 and
  requests the strongest retained searched move; intermediate high settings
  retain the same downstream sampling curve. The 3200 network boundary is a
  product policy boundary, not an experimentally measured small-network ceiling.
  The already-recorded bug remains: variant selection follows the saved fixed
  target while opponent matching changes the active target, so crossing that
  boundary can run a different network than the active target implies.
- Diagnostic reference knots stop at 2800. A target of 2700 uses the 2400 knot
  (58–66% agreement, 15–25 cp loss); 2800 and higher use the 2800 knot
  (68–75%, 8–15 cp). They cannot distinguish nearby high ratings. Cohorts also
  pool 2600 and 2700 despite their different default candidate breadth. Engine
  network/depth/thread settings are not in the cohort key, so these diagnostics
  should not be used as calibration across changing engine configurations.

The idea of selecting a lower-ranked searched move already describes both the
ordinary sampling path and the rare error channel. The latter selects from
evaluated candidates by a target loss; it does not invent an unsearched board
move. Removing a 0.5% base-probability channel alone would not address the flat
high-Elo curve or establish a rating. The initial read-only probe changed no
selector tables, filters, candidate counts or error probabilities; the bounded
correction linked above followed the reproducible native-choice defect.

Validation should first capture the actual game and settings, including active
and saved target, form, native Elo, native bestmove, selected move/rank, candidate
scores and completed depth, network, time control, and search budget. Use fixed
candidate replays to isolate the selection policy from search changes, then run
the production pipeline against a fixed opponent pool with paired colors and
openings, repeated independent seeds, fixed hardware and separate time controls.
Predefine a sample size or sequential stopping rule and report score uncertainty;
do not stop when a few results fit the desired rating. Independently analyse the
saved PGNs more deeply to measure mistakes, since the move-time search is not an
independent quality judge. Hold out positions and opponents when fitting any new
curve, and validate nearby targets for ordered strength as well as move quality.

The [official Stockfish FAQ](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#the-elo-rating-of-stockfish)
likewise explains that Elo depends on the opponent pool, time control, opening
conditions and a known rating anchor. A comparison against another bot's displayed
number does not create a human-Elo calibration. Its
[limiter description](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#how-do-skill-level-and-uci_elo-work)
confirms that native weakening itself chooses among searched candidate moves.
