# Input, feedback, and verification corrections — 2026-09-11

Space and the play button remain available while the hand analyses, hovers, previews, or
approaches the chosen piece. The service publishes `canPlayNow` during preparation and disables
it before committed mouse-down dispatch, including the acknowledgement wait. Repeated requests
coalesce and cannot abort a live drag.
The scheduled countdown and Escape cancellation remain available during preparation. The main
button always plays now, including while its countdown is running.

The physical system cursor uses `not-allowed` while virtual pointer ownership is active. Input
and hover suppression remain in place, and the virtual cursor is still visible. Native Chrome
fixture evidence in `build-logs/input-feedback/native-input.json` covers the cursor appearance,
one Space action, and a smooth accepted drag.

An accepted board update could cancel post-drop verification and produce a false
`verification-unavailable` failure. A cancelled check now gets one bounded fresh evidence check,
with no further input dispatch. The real adapter receives the original FEN and proves the legal
successor or the exact move in complete current game history. It does not infer success just
because the source is empty or the destination is occupied. Tests exercise the real canvas
adapter, including a rapid reply, and retain failure on missing or contradictory evidence.
Canvas proof requires fresh bridge evidence, so a stale move list cannot corroborate itself
or override a conflicting board position.
Late completion reports cannot overwrite a newer turn's recommendation or state.

Sidebar snapshots now refresh on active tab/window changes, and a failed route switch does not
permanently block later switches. Both stuck-view paths have regressions; the user's exact live
sidebar incident did not include a captured exception, so its specific trigger is unconfirmed.

Evaluation is a horizontal White-relative bar in a full-width card, with score and WDL retained
through turn changes. The rating ceiling is 3800. Opponent matching disables and dims the fixed
target in Settings and the live popover, cancels an active slider drag, and preserves its saved
value. The rating row has no network explanation beneath it. The network divider and minor gray
ticks use the same horizontal scale and a 200-Elo grid, including both endpoints and a tick
directly beneath the NNUE divider; minor ticks sit 4 px below the track.
The refined rating track is 6 px with a matte 16 px
thumb, a distinct warm flowing highlight and a low-opacity ember glow matching the slider's
current color. The glow subtly changes height and blur, strengthens near maximum Elo, and fades
on both entry and exit from high strength.
Reduced motion disables continuous effects.

Slider drag feedback uses short quiet samples, maps pitch to value, and enforces a shared
130 ms minimum interval plus a minimum value change. Releasing plays one final slider sample at
the current value's pitch, bypassing the scrub throttle. It pauses the previous sample to prevent
layering. View-switch clicks use the existing control sound. All are gated by Control sounds;
executed moves remain silent.

Focused behavioral, component, real-adapter, native input, and browser preview checks precede
the full `bun run check` gate and packaged release verification. The local release report under
`build-logs/input-feedback/` records the final gate and archive results. Bundled NNUE and board
motion have separate QA notes in this directory. No public matchmaking was started for QC.
