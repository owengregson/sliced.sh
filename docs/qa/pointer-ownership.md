# Virtual pointer ownership

When the virtual pointer is visible, the content script hides the native cursor and captures
mouse, pointer, wheel and context-menu events. The capture listener is installed at
`document_start`, before waiting for the board's body to exist. Keyboard input remains enabled,
including Space and the stop shortcut.

The service worker announces each controlled CDP action and waits for a content acknowledgment
before dispatch. Admission matches the action, coordinates, button state and its current
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

This is page input isolation, not an operating-system mouse lock. Chrome's own controls and
native CSS hover hit testing can still respond to the physical pointer. The browser exposes no
separate hardware-origin flag: an exact simultaneous match of timestamp, position and button
state cannot be distinguished from the announced event. The cursor is never repositioned from
physical samples while owned. Real-browser QA should still exercise a live canvas board and a
DOM-rendered board while moving the physical mouse, then verify every stop path restores input.
