# Opponent-turn pointer movement

While the hand is armed, the assistant is enabled, and the position says the opponent is to move,
the executor runs successive activity bouts lasting 3.2–7.8 seconds. Each bout samples its pace,
side preference and number of visits, follows plausible source/destination squares, and finishes
with a stationary observation pause. The planner refreshes geometry and candidates between bouts.
It does not park indefinitely after the previous move or generate constant hover tremor.

Current ponder updates provide the preferred possibilities. Missing engine lines fall back to
legal opponent moves and legal responses after those actual replies. Candidate extraction never
pretends it is our turn by changing only the FEN turn field. No candidate inspection selects,
presses, drags, or releases a piece. The background stream uses separate randomness from move
selection and timing, and the same continuous pointer position and CDP delivery hooks as moves.

A move or queued premove aborts exploration and waits for its final in-flight point to finish
before acquiring the hand. Exploration resumes after a premove's release and stationary rest.
Position changes, disarming, stopping, disabling, navigation and disposal cancel the loop. Geometry
and focus guards apply to every dispatched point. A failed guard ends that exploration run; the
next valid turn/arm transition can start it again. Background activity emits pointer updates without
execution-state events, so a late opponent-turn point cannot mark a new own-turn move as started.

Small residual movements now have less sample noise as their travel distance decreases. Press
settling moves coherently toward one bounded endpoint and suppresses repeated integer coordinates;
it no longer walks randomly back and forth around the same piece. Existing macro paths, physical
speed limits and sampled stationary post-drop duration remain in use.

Validation covers legal candidate branches and live PVs, activity and pause variation over 200
seeds, both board sides, multi-bout continuity, live ponder evaluation, no background presses,
turn handoff, queued-premove preservation/resumption, direct cancellation during a path, reflow,
manual arm/disarm, disable, navigation, disposal and native focus restoration. Existing queued
premove, pointer-continuity, core exploration and hand-controller suites also pass. Live browser
gameplay should still be observed after reloading the development extension; simulator tests do
not establish how the movement feels on every board size or opponent think time.

The follow-up on 2026-09-11 adds an initial stationary wait of 1.0–2.2 seconds, or 0.6–1.0 seconds
under clock pressure, before the first exploration movement. A turn change cancels that wait.
The live session policy restricts tactical, queued-premove and lone-king contexts to our own
candidate moves. Low time also shortens bouts to 1.8–3.2 seconds with 1–2 visits and a lower active
fraction. Candidates and contextual policy are refreshed between bouts. A policy that tightens during
a bout cancels the old path before another point and replans from the current endpoint.

Clock-race, lone-king and premove gestures take a direct two-leg path inside a 20–300 ms motor
budget. They omit preview/fakeout, grab, wobble, hesitation and post-drop waits. These urgent paths
intentionally bypass ordinary Fitts and peak-speed timing floors while retaining continuous
sampled motion and the same focus, geometry, admission, delivery and retry checks. Promotions
still wait for picker geometry but omit voluntary look/hold delays and use a 24–60 ms picker leg.
Tests measure actual controller completion at 20, 70, 90, 120, 240 and 300 ms, not merely planned path
sums; a promotion fixture including its picker completes within 150 ms. Browser/IPC stalls and
picker readiness can still exceed the planned budget.

Execution fitting and instant retries preserve urgent budgets: 80 ms with 79 ms available stays
79 ms, and an overdue 80 ms plan uses a guarded 20 ms gesture. Existing positive plans shorter
than that are never lengthened by fitting. The ordinary 250 ms floor does not apply to urgent
moves or premoves.
