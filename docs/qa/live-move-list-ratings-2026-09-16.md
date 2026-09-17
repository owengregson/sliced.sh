# Live move-list ratings — 2026-09-16

Move ratings now append the bot's category icon beside each main-line move in Chess.com's move log. The existing Move ratings switch controls both the board badges and the log; the side picker controls board badges and sounds, while the log includes both players. Existing site annotations remain visible.

The reporter retains unresolved older moves for low-priority catch-up searches, backfills validated session history when attaching midgame, and finishes pending log reviews after game over. Foreground preparation still pauses review; classification still yields around critical input. Only the two fresh landed plies can receive board effects or audio. Board-drop diagnostics remain separate from continued log review. Completed log verdicts can supply a live board badge if its last-move metadata arrives later.

Log messages carry game identity, zero-based ply, SAN and the classification; the page wire carries numeric category indexes. The content relay rejects old-game messages, retains ratings through board clears, and restores them when its page bridge reconnects. The MAIN-world renderer matches main-line node IDs and SAN, observes rerenders, and appends the existing SVG artwork without changing notation, timestamp nodes, native icons, selection, or move clicks. Badges clear when ratings are disabled or a new game starts.

Validation:

- Supplied annotated and blank HTML preserved as fixtures. Every fixture move gets one badge; notation and selected move are identical before/after rendering and cleanup.
- Page tests cover ratings arriving before rows, rerenders, recycled nodes, variation rejection, figurines, castling, clicks, and cleanup.
- Reporter tests cover catch-up beyond the two-ply live window, hidden board sides, game-end completion without late effects, history deduplication, live-work preemption, cancellation, and late metadata reuse.
- Session, content, codec, move parser, board rating, premove, and blitz-cadence checks pass. Two focused runs passed 93 and 92 tests respectively (overlapping coverage).
- Focused Biome checks and git diff whitespace check pass. Production build passes constants/CSS checks, TypeScript, bundling, distribution verification, and packaging.
- Artifact: `release/sliced-2.0.0.zip` (84 files, 300.9 MiB). Changes remain uncommitted.

Native Chrome live-game validation was not performed. Ratings fill as review evidence becomes available; exhausted searches below the minimum grading depth remain unlabelled rather than receiving an invented verdict. Classifications remain the bot's own, not Chess.com's proprietary review results.

## Follow-up: badge order, color, fast openings, and animation

- Place the bot badge before the notation and remove the site's empty annotation offset while it is present. Paint the notation with the badge's background fill; restore the original inline color, priority and offset on cleanup or row reuse.
- Reuse the board badge's 200 ms scale/fade entrance, including its 0.55 → 1.08 → 1 scale and overshoot timing. Fade text from its current computed color to the badge fill in 160 ms. Each newly displayed rating animates once; DOM replacement and repeated updates retain settled ratings. Reduced-motion mode renders immediately.
- When the exact board leads the move list, derive the snapshot ply from the FEN and reject the stale list's last move/history. Republish changed move metadata even when the board and clocks remain unchanged. The session sends newly validated late history to log review without restarting move selection, including after game over.
- Validate live effects' replay and ply before assigning a rating index. Schedule archived real moves ahead of speculative replies, with current-position and foreground-play priority preserved.
- Regression validation: 296 tests across the page renderer, adapter suite, session metadata/effects, and reporter; a further 135 tests across board animations, bridge, content boot, review cadence, and reporter (overlapping coverage). Added checks for a board ahead of the list, four skipped opening plies recovered from a same-timestamp history update, animation timing/deduplication, reduced motion, color restoration, and catch-up priority. Focused lint, whitespace checks and production TypeScript checks pass.
- Native Chrome live-game validation remains unperformed.
