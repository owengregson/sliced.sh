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
