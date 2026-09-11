# Virtual pointer ownership

When the virtual pointer is visible, the content script hides the native cursor and captures
mouse, pointer, wheel and context-menu events. A transparent MAIN-world hit-test shield also
blocks native hover, which Chrome computes before event listeners can cancel input. The capture listener is installed at
`document_start`, before waiting for the board's body to exist. Keyboard input remains enabled,
including Space and the stop shortcut.

The service worker announces each controlled CDP action and waits for a content acknowledgment
before dispatch. The page bridge first acknowledges a two-pixel opening in the shield at the
announced coordinate. Each acknowledged pointer update closes that opening; a 250 ms timeout
also closes it when dispatch never completes. Admission matches the action, coordinates, button state and its current
wall-clock timestamp; each matching event type is consumed, and an unused admission expires
after 250 ms. This distinguishes real mouse movement from CDP input without treating every
trusted event as physical interference. Cancellation and focus/geometry guards are checked
again after the acknowledgment. Browser releases remain available for cleanup.

Hiding the mirror removes its native-cursor stylesheet. Disconnecting the content port also
hides it and drops input ownership; disposal, stop, debugger detach and game end use the same
cleanup. A resting hand now spends most pauses stationary; a long pause can contain one small
adjustment, never continuous idle twitching. Stationary post-drop rests retain their timed wait.

A dedicated headless Chrome run on 2026-09-10 verified the production capture code in an isolated
world: all nine announced pointer/mouse/click events were delivered, an unannounced move/press/
release sequence was blocked, Space reached the page, and mouse input returned on deactivation.
Unit and simulator tests additionally exercise event consumption, expiry, counter accuracy,
teardown, admission failure, cancellation during acknowledgment and late focus changes.

Chrome 152.0.7977.84 was checked again on 2026-09-11 using the production page AST and content
capture code in separate realms. Native CSS changed the fixture pieces from black to red on
hover before shielding and after cleanup. With the shield active, unannounced movement over a
different piece, the exact last virtual coordinate, and then away from that coordinate left both
pieces black. An announced point still reached the native hover target while its aperture was
open. A native pointer-captured drag delivered its press, intended movement and release; an
interleaved unannounced held movement did not reach the drag handler. Space still arrived.
A same-origin iframe's native hover was blocked and restored too; aperture expiry sealed itself
and cleanup left no shield or cursor nodes. The fixture used trusted CDP commands for the
unannounced input as well: this verifies Blink's actual native hit testing, not OS event injection.
The reproducible script and results for this run are in `/tmp/sliced-hover-qc/`.

This remains page-local isolation. The shield uses a manual top-layer popover to escape ordinary
stacking contexts, transforms and iframe surfaces, with a fixed-layer fallback in browsers that
lack that API. Separate cross-origin/OOPIF and newly opened modal/top-layer surfaces have not
been verified. The root document can still match `:hover` through the shield itself; stationary
piece CSS hover is deliberately suppressed between bot events. A physical pointer coinciding
with the two-pixel aperture during an announced dispatch can briefly affect native hover, even
though the timestamp/count filter still rejects its handlers. The page exposes no hardware-origin
flag that can close that narrow race. Browser chrome and the operating-system pointer remain
outside this page-local control. Live gameplay QA should also move the real desktop pointer over
a canvas board and a DOM board, then exercise every stop/disconnect path.

A cold-start follow-up exercised `prepare` before any `cursorTo`, using the production relay and
tracker as well as the emitted page code. With cursor display enabled, the first event needed no
aperture; its acknowledgment drew the mirror, and the next press/release used the shield handshake.
All three events confirmed delivery, the target received one click, and Space arrived. With the
display disabled, the same sequence confirmed every event and clicked once without creating DOM
nodes or making aperture requests. Matching admission events are consumed even while isolation is
inactive; unmatched user input is blocked only while isolation is active. The cold lifecycle
fixture and evidence are `/tmp/sliced-hover-qc/cold-check.ts` and `cold-results.json`.
