# Move ratings from ongoing analysis

Move-quality markers could wait for another move even though the engine had already produced
the scores needed to classify them. The overlay accepted late markers immediately; the missing
connection was between the session's ongoing analysis and its move-quality reporter.

`PonderController` now publishes complete frames from the current search, with the actual reached
position and the search's strength provenance. `GameSession` supplies them to the existing
position-indexed rating cache. This includes opponent-turn pondering and unarmed panel analysis,
so a move outside the earlier MultiPV can receive the following position's score without waiting
for the next board update. Complete final results also follow this path.

This adds no engine searches and changes no search priority or clock allocation. The reporter
retains its depth, legality, full-strength, landed-window, and square-ownership checks. Partial
frames are excluded, and disposed sessions or disabled effects do not receive new ratings.

## Regression evidence

`test/behavioral/game/board-rating-updates.test.ts` covers two stationary-board cases:

- Our played move lies outside the earlier MultiPV; the opponent-turn ponder supplies its score.
- The opponent's move lies outside the earlier MultiPV; our initial search is too shallow, and
  ongoing panel analysis supplies a sufficiently deep score with Auto-play off.

Both fixtures reject shallow and partial deeper frames before accepting a complete frame. Both
assert that the same move history and position remain on the board when the rating is delivered.
Disabling only the new session callback makes both tests fail at marker delivery; restoring it
passes both tests with 35 assertions. The ponder unit tests additionally cover reached-position
identity, strength provenance, wrong-search frames, and disposal.

The earlier [timing renovation report](timing-renovation-2026-09-14.md) records the larger change
set and its previous release. This follow-up is included with that accumulated work for the
owner-requested commit and push.

## Final validation

- `bun run check`: passed, 2,948 tests passed and zero failed across 307 files. The two
  missing-asset placeholder cases were skipped; the actual ChessMimic and Maia ONNX tests ran.
- `bun run build`: passed, including typecheck, packaging, and distribution checks.
- ZIP: `release/sliced-2.0.0.zip`, 315,946,387 bytes; 77 files, 371,409,248 unpacked bytes.
  CRC validation passed and every file matched `dist` byte for byte.
- ZIP SHA-256: `48dc40f73b5c5687baf683c0a0afd051c13aefdc7c3a89461a24cefbb81ba92c`.
- `git diff --check`: passed. The 410-file accumulated change set is grouped into seven
  thematic commits; validation covers the combined final tree. Author and committer dates
  are distributed across the preceding two days at the owner's explicit request.

The stationary-board delay was reproduced and verified in the behavioral harness. Native Chrome
input/model smoke tests for the broader renovation are recorded in the earlier report; this
follow-up did not reload or alter the owner's current browser games.
