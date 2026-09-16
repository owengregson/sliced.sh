# SF19 Brilliant detection and review evidence — 2026-09-16

The main result is **94/100 on the original evidence**. The SF19 full-network run recognized 94 of Chessigma's 100 pinned Brilliant moves,
compared with 89 from the pre-change classifier on **the identical engine frames**. Repeating
three searches that had stopped at depth 14–15, with the same depth-18 / 5-second limit,
produced depth-18 frames and raised this to 96. These are separate measurements, not a claim
that every live search will reach 18. The second run is a sensitivity check, not a holdout.

Machine-readable results, misses, tuning, engine identity, and evidence-file checksums are in
[`tools/move-review/results/sf19-2026-09-16.json`](../../tools/move-review/results/sf19-2026-09-16.json).
No exact Chess.com parity or production precision is claimed. The follow-up inventory, explicit
labels, additional SF19 frames, and local classifier profile are preserved in
[`sf19-negative-audit-2026-09-16.json`](../../tools/move-review/results/sf19-negative-audit-2026-09-16.json).

## Follow-up: exhaustive local annotation audit

The original six non-Brilliant labels were exhaustive for the ten-game owner export, **not
for all local PGNs**. A follow-up inventory under Documents, Downloads, and `/private/tmp`,
including ignored scratch directories, found 11 PGN files containing 1,333 game entries before
deduplication. The older two-game and Nestoker exports duplicate games in the ten-game export.
Eleven distinct games have explicit review annotations: 15 Brilliant, four GreatFind,
four Mistake, and two Blunder labels. End-of-game board markers are excluded. All NAGs in these
files coincide with the explicit review annotations; clock/evaluation comments alone do not
constitute a reviewed classification. This is exhaustive within the inventoried local files,
not a claim about other devices, archives, or remote reviews.

The additional game is `.scratch/rdxh5/game.pgn`. Its four non-Brilliant labels were evaluated
with the shipped full SF19 engine and the same settings documented below, without retuning. All 11 collected
frames reached depth 18 within the five-second cap:

| Move | Explicit PGN label | Our display | Brilliant false positive |
| --- | --- | --- | --- |
| 29...Qxb5 | Mistake | Excellent | No |
| 32.f5+ | GreatFind | Great | No |
| 33.Qd5+ | GreatFind | Great | No |
| 34.Qe6+ | GreatFind | Great | No |

The game's explicit 30.Rdxh5+ Brilliant was also detected. The aggregate is therefore **0/10
false Brilliant calls on explicit non-Brilliant labels**, separately from **0/12 constructed
controls**. The 0/10 sample comes from only five games and contains errors and Great Finds;
there are still no explicitly labelled Best, Excellent, Good, or Inaccuracy moves. It does not
establish production precision or a population false-positive rate. The Qxb5 disagreement also
shows that correct rejection of Brilliant does not imply agreement on the ordinary quality band.
The game was already present in local debugging material, so this is additional coverage,
not a new independent holdout. Unlabelled neighboring moves are excluded from the negative count.

Remaining false-positive risks include a plain winning alternative outside MultiPV 3,
off-square material recovery beyond the short PV check, the fastest-mate exception in an
already winning position, and the approximate Elo-dependent expected-points/near-best thresholds.
The added GreatFind checks improve coverage of strong tactical moves but do not cover the
ordinary-move population. A meaningful next evaluation requires fully reviewed complete games,
with explicit ordinary labels, selected independently of whether they contain a Brilliant.
No additional ordinary labels can honestly be inferred from these PGNs.

The **94/100** original-frame comparison remains the headline. **96/100 is conditional on
replacing three selected shallow searches**, not the same-evidence result, a fresh 100-position
rerun, or deployment accuracy. No classifier or executor code changed during this follow-up.

## Review scheduling and continuous-play validation

Review uses a separate full-network SF19 instance with its own UCI state, WASM heap and hash
table. CPU and memory bandwidth remain shared with playing SF19, ONNX and browser work.
Search admission therefore pauses review during foreground move preparation while allowing it
to use the remaining thinking and mouse-activity time. Synchronous classification has a separate
input gate because it runs in the service worker that also schedules executor input.

`ReviewEngine.setPlayBusy(owner, busy)` maintains idempotent preparation leases across tabs.
While any owner is preparing, queued requests retain their priority and no new review search
starts. Cooperative stop preserves valid completed iterations and returns the final usable
frame with `superseded` status. The active slot remains occupied until stop settles, and the
engine stays warm. Request ID, root, history, full-network and engine-version identity must
match; explicit release still invalidates undrained results.

`BoardEffectsReporter.setPlayBusy(busy)` pauses search and classification during preparation.
`setInputBusy(busy)` blocks only new synchronous classification, so background SF19 continues
searching and caching during mouse activity and holds. `setAvailableUntil(number | null)` sets
an absolute scheduler-clock admission boundary, already 300 ms before approach; the reporter
adds no second reserve. Each timer turn rechecks admission and runs at most one expensive
classification. Rays, board-known forced/checkmate marks and already computed verdicts publish
immediately through either gate. Cached engine frames still require admitted classification.

Only the latest two landed plies remain eligible, including while paused. New searches and
classification prioritize fresh work while retaining an equally useful active search.
Same-square premove captures classify their predecessor first to preserve chip order.
Interrupted complete iterations remain nonterminal unless they independently reached target
depth, allowing shallow interrupted searches to resume. Cancellation and disposal invalidate
pending jobs and timers. Resumption yields between classifications rather than flushing a
synchronous backlog.

### Final validation

| Checks | Passed | Assertions |
| --- | ---: | ---: |
| Review engine and reporter focused tests | 62 | 312 |
| Board rating depth/publication and fake-engine lifecycle | 6 | 30 |
| Board-effects behavioral tests | 29 | 142 |
| Continuous-play behavioral tests | 3 | 96 |

The final fixture-validation run passed **38 tests with 268 assertions** across the last three
rows. All three original rating-depth tests retain their safety assertions: target-depth
publication, no publication below the ordinary depth threshold, and no shallow publication
before the landed wait expires. The manually fed review fixture acknowledges stop with
`bestmove` only; it cannot manufacture unearned evaluation depth. Added lifecycle tests verify
empty stops, retention of completed depth 12 despite a partial depth-13 iteration, and rejection
of stale stop callbacks against a newer search.

Continuous-play coverage verifies ratings during active think windows, frame caching during a
pressed gesture with classification deferred until input ends, and a two-ply live queue after
six fast arrivals. Focused coverage also includes multiple owners, warmup, cooperative stop,
engine-identity changes, strict cancellation, timer-turn admission and same-square capture order.
The final typecheck, scoped Biome and diff whitespace checks **pass**. These are focused and
behavioral results; the complete integration gate is recorded in
[`extension-overhaul-2026-09-16.md`](extension-overhaul-2026-09-16.md).

### Remaining limits

Search admission is shared across tabs, but classification admission is local to each session.
Another tab can therefore classify on the shared service-worker thread during this tab's
protected input window. Yielding between jobs limits bursts without providing a cross-tab CPU
budget. Admission also cannot preempt a classifier already running or guarantee release latency.

A local cost probe of 500 classifier calls on the 100 pinned-positive inputs, after warmup,
measured **21.2 ms median, 124.7 ms p95 and 363.3 ms maximum** under Bun 1.3.11. Searches and
input construction were excluded; book and recent-sacrifice flags were false. This tactical
sample under uncontrolled machine load establishes possible scheduling cost, not average-game
cost or Chrome latency. Global SF/ONNX resource budgeting and classification in a separate worker
remain outside this implementation.

Native Chrome and live extension validation remain **unverified** and were not attempted.
Classifier thresholds and the primary **94/100 same-evidence** recall claim are unchanged;
**96/100** remains conditional on the selected deeper reruns described above.

## Criteria and calibration

The detector keeps all five sacrifice shapes: indirect offers, ignored threats, deliberately
hanging pieces, sacrifices by capture, and exchange sacrifices. It enumerates **legal captures**
and solves the bounded same-square exchange using legal recaptures, including promotions and
x-rays. The move's capture/promotion gain is subtracted from the concession. A pinned pawn or
a king that cannot legally capture is not a sacrifice. Pawn-only offers and equal trades are
excluded. Another legal move must concede less material: being forced to lose a piece is not
volunteering it. Exhausted exchange searches now explicitly abstain; they cannot supply a
fictitious safe alternative. Forced recaptures cannot use SEE's usual option to stop exchanging.

The full-strength evaluation must leave the mover in an acceptable position and near the best
move. Soundness now uses expected points at the **mover's rating**, as near-best loss already
did. This fixes the 941-rated benchmark's Nxg4: reference points were 0.447, rated points 0.462.
The expected-points model remains a local logistic approximation; no human-game probability
curve was retrained in this work.

The additional small-sacrifice gratuitous-win cutoff changed from 0.90 to **0.95** on the
reference curve. At SF19's scores, 0.90 was excluding nontrivial Bxg4, Bb3, Nxc6, Nxf6+, Bf6,
and Bxd4 sacrifices. The higher cutoff still rejects the existing Rxd4 regression at +8.5
when a plain move keeps essentially the same advantage. The absolute 0.97 trivial-alternative
gate remains. Other sacrificial alternatives are not treated as a free, already available win.
The original near-best allowances (0.12 novice / 0.07 expert) remain; the evidence did not justify
loosening them. Consecutive-sacrifice and faster-mate rules remain, including the owner's
existing Mate display precedence and sound behavior.

Brilliant and Great now require depth **16** or more, comparable before/after depths (within
two plies), and at least one legal scored alternative. A shallow candidate reports
`insufficient-evidence`; ordinary ratings can still use their existing lower depth floor.
The live reporter waits for an ongoing candidate review instead of freezing its ordinary badge
at depth 12. If the bounded search finishes shallow, it publishes an ordinary verdict.
This intentionally trades some recall and latency for evidence quality.

## Full-strength correctness fixes

- Before searches, during update delivery, and after results, the reviewer checks the actual
  loaded full-network filename set, readiness, errors, and fallback status. An empty network
  list or a small-network substitute cannot grade moves.
- Review lines must belong to the frame's declared exact iteration. Bound, incomplete,
  malformed, illegal-root, or mixed-depth lines cannot silently become the played score.
  Missing evaluations stay unknown when negated; they no longer turn into draws.
- Cancelling a reporter invalidates late final results as well as streamed updates. Cache keys
  include the halfmove clock, so a repeated board or a position near the fifty-move rule does
  not reuse a frame with a different clock. Existing UCI move-history transmission is retained.
- These changes remain on the dedicated review engine. They do not use the strength-limited
  playing engine or change the Maia selection path.

## Measured evaluation

Every fresh search used the installed `sf_19_relaxed-simd.js` / `.wasm` under Node v25.6.1,
the full `nn-1a298aa575a0.nnue` network, two threads, 64 MiB hash, MultiPV 3,
`UCI_LimitStrength=false`, Skill Level 20, depth cap 18, and movetime cap 5,000 ms.
The network's decoded SHA-256 was verified at load. Engine version, WASM checksum, full network
checksum, dataset checksum, runtime, and search settings are attached to every frame.

| Data | Initial evidence | Selected shallow searches repeated |
| --- | --- | --- |
| Chessigma's 100 pinned positives, 300 frames | 94/100 gates passed; baseline 89/100 | 96/100 after three depth-18 replacements |
| Owner's ten reviewed games, 14 explicit positives, 50 frames | 13/14 gates passed | 13/14; the remaining move changes from shallow to trivial-win |
| Six explicit non-Brilliant PGN marks | 0 false Brilliant calls | 0 |
| Twelve constructed negative controls | 0 false Brilliant calls | Not repeated |

“Gates passed” includes sacrifices displayed as **Mate**, because that pre-existing user-requested
category outranks Brilliant. The initial public benchmark has 87 Brilliant displays and seven
Mate displays among its 94 passing sacrifices. The scorer reports both.

The public download pins one positive per game. Its other moves are **unlabelled**, not known
negatives. Two additional calls among 170 scored surrounding moves are therefore reported as
unconfirmed calls, never a false-positive rate or precision estimate. The owner PGN export
likewise has only 20 explicit move labels, not a complete classification of all 529 plies.
Six human-labelled negatives and twelve hand-built controls are too small and too selective to
estimate production precision. This is a calibration/development result, not unseen validation.

One initially proposed negative (`Ne6` in knight-versus-pawn) turned out to preserve a drawable
king-and-pawn ending. It remains in `negative-controls.json` **without a negative label** and
is reported as an unlabelled sacrifice. A separate position with two connected opposing pawns
tests a genuinely losing knight offer. The fixture notes record this correction.

The four public misses after the depth repeat are Qd5 (immediate off-square material regain),
Bxd5 and Rf1+ (no smaller material concession available), and e1=Q+ (already trivially winning).
The remaining owner miss is Rxf7: deeper SF19 evidence finds a plain alternative already above
the trivial-win cutoff. These disagreements are retained rather than adding move-specific
exceptions. MultiPV 3 and same-square exchange analysis also remain limited: a quiet fourth
alternative or a longer off-square material recovery can escape the special-label checks.

## Reproduction and regression checks

```sh
bun tools/move-review/collect.ts --out /tmp/sf19-public.jsonl --games 0-99 --threads 2
bun tools/move-review/score.ts --frames /tmp/sf19-public.jsonl --json /tmp/sf19-public-score.json
bun tools/move-review/pgn-labels.ts <reviewed-games.pgn> /tmp/reviewed-labels.json
bun tools/move-review/collect.ts --dataset /tmp/reviewed-labels.json --mode marked --out /tmp/sf19-owner.jsonl --games 0-9 --threads 2
bun tools/move-review/score.ts --dataset /tmp/reviewed-labels.json --frames /tmp/sf19-owner.jsonl
bun tools/move-review/collect.ts --dataset tools/move-review/negative-controls.json --mode all --out /tmp/sf19-controls.jsonl --games 0-12 --threads 2
bun tools/move-review/score.ts --dataset tools/move-review/negative-controls.json --frames /tmp/sf19-controls.jsonl
```

The collector now runs the shipped V8 engine instead of the broken plain-SIMD Bun mapping.
It supports FEN-rooted PGNs and `--mode marked` for explicit positive **and negative** marks.
Restricted `--mode accept` probes never overwrite unrestricted position evaluations in the
scorer. Old SF18/unknown evidence requires explicit `--allow-legacy`; that switch does not make
it SF19. Wrong dataset, network, or WASM provenance is rejected. Only a truncated final JSONL
append can be recovered, never an interior corrupt record.

Focused regressions: 102 tests passed across Brilliant, move-quality, expected-points,
evidence-provenance, review-engine, and board-effects reporter tests. They cover all five
sacrifice shapes, pins, defended king-capture squares, unavoidable losses, exhausted exchanges,
malformed scores, shallow/mixed/incomplete frames, NNUE identity, late cancellation, cache
clock separation, waiting for tactical depth, and stopping after an exhausted shallow search.
All 29 game-stack board-effects tests also passed, including premove double arrivals and
independent effects/rating switches. The shared harness's only changes in this workstream are
the engine-file import and the fake review backend's full-network filename list. Typecheck,
scoped Biome, and constants checks passed. No live Chrome game was played by this workstream.

## Primary evidence

- [Chess.com move classification](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc): public qualitative requirements and ordinary loss bands; special thresholds and the fitted rating model remain unpublished.
- [Chessigma Brilliant benchmark](https://www.chessigma.com/benchmarks/brilliant): five sacrifice shapes, four qualitative gates, public pinned-positive dataset. Its authors' proprietary precision measurements cannot be reconstructed from that download alone.
- [Stockfish evaluation interpretation](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html): normalized centipawns and WDL describe engine self-play. They are not a human Elo-conditioned expected-points model; this change does not equate the two.

## Changed paths in this workstream

Runtime:

- `src/core/constants/review.ts`
- `src/core/engine/brilliant.ts`
- `src/core/engine/expected-points.ts`
- `src/core/engine/move-quality.ts`
- `src/service/review-engine.ts`
- `src/service/game-session/board-effects.ts`

Evaluation and documentation:

- `tools/move-review/collect.ts`
- `tools/move-review/evidence.ts`
- `tools/move-review/score.ts`
- `tools/move-review/engine.ts` (new)
- `tools/move-review/engine.node.ts` (new)
- `tools/move-review/negative-controls.json` (new)
- `tools/move-review/results/sf19-2026-09-16.json` (new)
- `tools/move-review/results/sf19-negative-audit-2026-09-16.json` (follow-up)
- `docs/qa/sf19-brilliant-review-2026-09-16.md` (new)

Regression tests:

- `test/core/engine/brilliant.test.ts`
- `test/core/engine/expected-points.test.ts`
- `test/core/engine/move-quality.test.ts`
- `test/core/engine/review-evidence.test.ts` (new)
- `test/service/review-engine.test.ts`
- `test/service/game-session/board-effects-chips.test.ts`
- `test/behavioral/game/harness.ts` (only full-NNUE metadata/import)

Existing dirty migration work was preserved. No commit, push, reset, clean, or stash was made.
