# Premove input regression

The clock-race shortcut treated every `mode: premove` timing plan as an emergency pointer path. A 20 ms reaction budget produced one pointer point for the approach and one for the held drag. Premoves now retain the ordinary `generatePath` / `rescalePath` approach and drag, including reactive fallback and retries marked `expected.premove`. Promotion selection uses the generated path too. Reaction delays remain short; pointer travel retains the motor profile's speed limit.

The hand-controller regression reproduced all five affected short-budget cases before the fix. After the fix, those cases verify intermediate approach/held-drag points, button state, origin/destination, per-point speed, and execution phases. A separate case covers the promotion picker. Game-session regressions cover ordinary and urgent opponent clocks, confirm the virtual cursor follows both legs, and verify that a queued premove subsequently fires on the site without another mouse gesture.

Native Chrome fixture QC used the production HandController, CdpInputBackend, and virtual cursor relay for queued, reactive, and instant-retry premoves. Each rendered 55 approach frames and 59 held-drag frames, with acknowledged press/release and an accepted destination. Observed elapsed time was 2.12–2.21 seconds including the fixture's per-point transport/rendering overhead; this is a smoothness check, not a production latency benchmark. The isolated browser was closed. Detailed results are in the ignored `build-logs/premove-review/native-results.json`.

## Ignored predictions

The queue allows at most two consecutive completed, ignored premoves for the same full move (origin, destination, promotion). Canceled or interrupted gestures do not consume an attempt. Another completed premove sequence, a landed premove, a correct prediction, or a new game resets the streak. Blocking the third queue entry preserves the reactive fallback if the expected position actually arrives.
