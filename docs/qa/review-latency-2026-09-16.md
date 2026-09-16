# Continuous-play rating latency — 2026-09-16

The owner reported that ratings stopped during active play and then appeared in a burst for
roughly five to ten old moves once the game became quiet. This is a regression in review
scheduling, not evidence that the rating thresholds themselves need to be relaxed.

## Diagnosis

The first timing integration held the review lease from recommendation preparation through
the complete scheduled move. Hand phases such as orientation and exploration can contain
seconds of waiting, so those phase names did not identify actual critical work. That policy
denied review useful time while the extension was deliberately waiting to move.

Two reporter behaviors amplified the delay. Paused jobs bypassed the normal two-landed-move
freshness window, creating an old-rating backlog. Pausing also invalidated completed search
iterations arriving from a cooperative stop, even though the position and full-network
identity had not changed. Resumption synchronously attempted every deferred classification.

## Required scheduling contract

Foreground move selection has priority over competing review search. Planned thinking time
and executor activity are review opportunities: Stockfish review runs independently during
them, including during mouse gestures. Synchronous rating classification has a separate
admission rule because it runs in the service worker and can delay input dispatch.

Critical input and the lead into its reserved approach temporarily defer that classification,
while completed review frames can continue to be collected. A long ordinary wait is not a
critical-input lease. Stationary pressed holds remain input-sensitive, but they do not stop
background Stockfish review. Neither kind of review work may extend the sampled release
deadline or make the executor wait for review to stop.

Valid complete iterations survive preparation pauses. Network changes, disposal, game
cancellation and incomplete/mixed frames retain their existing rejection rules. Only the
most recent two landed moves remain eligible for live feedback; old work cannot escape that
limit merely because it was paused. Expensive classifications must yield between jobs and
respect the next input boundary. Board-known forced/checkmate outcomes and already prepared
verdicts remain cheap immediate feedback.

## Executor integration and validation

Admission follows actual movement, including unpressed preview approaches, opponent-turn
exploration and post-drop travel. Stationary waits expose time only up to 300 ms before their
next action. Committed gestures, button holds, recovery and cancellation retain protection until
their input settles. Tokens belong to one execution, so late cleanup cannot release a newer one.

Promotion reserves its expected picker interaction before scheduling the pawn drop. Its final
picker release uses the original deadline; an expected auto-queen keeps the pawn release at that
deadline. Underpromotion requires a picker even when auto-queen is the timing input. An unexpected
picker, slow geometry response or physical speed limit can overrun; the actual final release is
recorded without extending the plan. Urgent picker motion also obeys the profile speed cap.

Focused regressions cover ratings appearing during an active long think, review frames arriving
during protected input, the two-ply backlog cap, preserved cooperative-stop evidence, network and
frame rejection, travel/wait admission, cancellation cleanup, and promotion timing. The twelve
review behavioral cases and seven opponent-exploration integration cases pass after integration.
The fake review transport now stops at evidence it actually produced rather than synthesizing a
completed depth-18 frame when stopped. Existing shallow-evidence rejection assertions remain.
The complete repository gate and final archive are recorded in the
[integration report](extension-overhaul-2026-09-16.md).

The search lease is shared across sessions, while classification guards remain local to each
session. Another concurrently active tab can still consume service-worker classification time;
one-job timer yielding is not a global cross-tab computation budget. This is a remaining multi-tab
limitation. No further testing in the owner's Chrome is authorized or performed.
