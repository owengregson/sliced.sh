# Board ratings: review startup failure

The reported symptom was no move-rating chips during Chess.com game 180008354566, with ratings
enabled. The earlier offline check correctly classified 16.Nxg6 as Brilliant, but bypassed the
live engine host and transport and therefore did not validate delivery during a game.

## Reproduced cause

The offscreen host initially publishes the full engine's module filename as its version. During
the UCI handshake, `id name Stockfish 19` updates the host's version, but the host did not publish
that updated status. The remote reviewer consequently finished warming with the module filename
still cached as its engine identity.

The first search publishes a `searching` status containing the actual engine name. The reviewer's
identity guard interpreted this delayed handshake update as an engine change during analysis,
rejected the evidence, and discarded the engine. A fresh boot repeated the same sequence. This
can suppress all ordinary engine-rated moves independently of settings or available think time.

`EngineHost` now publishes the identity status during the UCI handshake, before `uciok` can finish
warming. Full-network, exact-network-name and mid-search identity checks remain intact. No move
classification thresholds, timing weights, or executor behavior changed in this repair.

## Delayed move metadata

The parallel audit also reproduced four normal ratings becoming zero when `lastMove` metadata
arrived after each board position. Same-position deduplication kept clock updates but ignored the
later move metadata, so those arrivals never created rating jobs even with healthy review searches.

The session now retains only the current unreported arrival and recovers its effects/rating report
when matching metadata arrives. Recovery verifies the game, board, ply and legal replay before
accepting the correction. It preserves the current recommendation and execution deadline, does
not restart the playing pipeline, and cannot replay an older game's pending reports.

## Validation

The regression uses the production `ReviewEngine`, `RemoteEngine`, runtime port router,
`EngineHost`, and `UciEngine`; only WASM output is scripted. Before the fix its first search
returned `failed` despite a complete depth-18 MultiPV answer. After the fix, first and subsequent
searches succeed across two fresh boots. Existing tests still reject actual mid-search network or
engine-identity changes.

A second port regression starts from a landed move with a cold reviewer, obtains both required
position frames, and verifies the exact board-rating command is delivered with zero dropped
verdicts. It checks the reporter output, beyond merely accepting an engine result.

Eight metadata regressions cover consecutive recovery, duplicate delivery, stale-but-legal
markers, active foreground preparation, an active executor plan, mismatched ply/FEN counters,
and expiration across moves and games. They verify that metadata recovery preserves existing
recommendations, input plans and deadlines.

A separate cadence regression drives six rounds of 1–3 second turns, 150 ms foreground searches,
600 ms review responses and opponent mouse activity. Ratings continue increasing for both sides
while autoplay remains armed; no total input-gate starvation was reproduced in that fixture.

No personal Chrome session was inspected or operated. The source-level failure is reproduced;
the exact original session's logs were not available to establish whether any additional fault
occurred in that game.

`bun run check` passes: 3,301 tests across 340 files, zero failures, 1,972,121 assertions.

## Release artifact

- `release/sliced-2.0.0.zip`: 315,481,649 bytes; 84 files.
- SHA-256: `d5064e36c4175cf22f3facc2638e0d5424cd15de36f71e6e3bda68e342657840`.
- Release build and packaging checks pass. ZIP CRC passes; every archived file matches `dist/`.
- Previously requested blunder/mistake sound assignments are preserved and their hashes verified.
