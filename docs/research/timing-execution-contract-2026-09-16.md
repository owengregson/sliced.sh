# Timing and executor integration contract

Timing work owns `src/core/timing/**`. Executor/session wiring remains with the parent.

`TimingContext.nowMs` is the original opponent-position arrival timestamp, not the time
analysis completes. The session records `positionArrivedAt` once when it accepts a position,
bounded by the current time. The own-move pipeline uses that saved timestamp for both
`TimingContext.nowMs` and `rec.computedAt`. Same-position clock updates may refresh
`snapshot.capturedAt` and the displayed clocks; they must not reset `positionArrivedAt`.
`TimingPlan.thinkMs` means the entire turn through mouse release.
`deadlineMs = nowMs + thinkMs`; orientation, scan, preview, decision and approach are
partitions of this total. Search, policy inference, transport, preview cleanup and hand
movement spend this same window. Optional actions are dropped when there is no room.

The timing patch exposes `remainingMoveWindow(plan, nowMs, executionReserveMs)` in
`src/core/timing/move-window.ts`. It reports elapsed/remaining time, latest execution start,
optional-action allowance and unavoidable overrun. The reserve is a caller estimate of the
**complete mandatory executor path**, including source approach, press, drag, release,
promotion and observed transport overhead. It is not added to the sampled duration.

`accountPreparation` now keeps the sampled duration, deadline and window unchanged after
search. It records `preparationMs` and `preparationOverrunMs`; the latter is the shortfall
against the reserved complete gesture, so it can be positive before the deadline expires.
An expired normal plan has no optional execution window. A positive remainder is preserved,
even below 250 ms. Optional actions must fit that remainder after reserving the gesture.

For an already-late pipeline, execute immediately with physically feasible movement and
report the overrun. The mandatory gesture still takes real time; keep its natural speed
limits rather than interpreting search latency as clock emergency. Do not restore orientation,
add a new 250 ms wait, or extend the sampled deadline to conceal that time. If move selection
cannot finish inside short windows, precompute or bound preparation against `executeByMs`;
the timing sampler cannot make a finished search retroactively shorter.

Observe `mouseReleaseAt - opponentArrivalAt`, excluding post-release verification, in the
timing log. Keep planned duration and observed overrun separate so latency is not learned
as the player's preference for longer thinking. The executor marks a pace override when
preparation has a reserve shortfall or mouse release misses the original deadline by more
than the existing 10 ms fitting tolerance. The session then passes `adaptPace: false` to
`observe`, while retaining actual duration in the log. Existing manual/retry overrides remain.

`test/behavioral/game/slow-search-release.test.ts` verifies this through the simulated input
pipeline: a snapshot waits 300 ms before worker processing, then a 1.4-second search misses
a normal sampled deadline. A same-position clock snapshot arrives during that held search
and refreshes the displayed clock anchor without restarting preparation. The first capture
still anchors `rec.computedAt`, the plan deadline and the release observation. The plan remains
immutable, the move retains its mandatory gesture, the release timestamp excludes verification, and
the latency does not update the learned pace. The fixture requires a sampled approach longer
than the generic 250 ms minimum, preventing a floor-only implementation from passing.

The complete-game replay charges `max(sampledTotal, searchMs + reservedApproachMs)` and
excludes preparation overruns from pace adaptation. This is a reservation estimate, not
measured browser release time; actual geometry and transport may require more time. No
native Chrome or existing user browser tab was used. Native execution remains unverified.

Queued premoves are entered during the opponent's turn. Their release belongs to that
earlier action; automatic board submission after the opponent move is not a fresh hand
gesture. A predicted reply alone does not prove that a premove was queued. Preserve the
session's actual queued-move path and prioritize it over optional hover activity.
