# Page focus and input recovery

This follow-up supersedes the earlier requirement to pause an armed hand whenever the owner
switches tabs or applications. The user requested the behavior of the local
`Documents/tranquill-dev` extension's visibility shield.

## Focus implementation

The reference's `src/content/visibility-shield/patches/document-visibility.ts` overrides
`visibilityState`, `hidden` and `hasFocus`; its capture blockers suppress tab-transition events.
This project uses Chrome's native
[`Emulation.setFocusEmulationEnabled`](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setFocusEmulationEnabled)
to provide that page-visible state while also keeping rendering callbacks active. No tab or
window activation is requested, and no page prototype or timer is replaced.

Arming waits for the emulation command to succeed. The focus gate accepts physical tab/window
changes only while the debugger manager confirms that native hold. Stop/disarm restores native
state after the input release completes; disposal and debugger detach clear ownership too.
Commands are serialized and each arm reserves a tab-wide token before waiting for attach or
acknowledgment. Cleanup from an older executor cannot disable a newer arm; a failed current arm
waits for input cleanup before restoring native focus. Unmaintained pages retain the existing
focus checks.

A dedicated headless Chrome run used a separate temporary profile and two tabs. With the game
target inactive, it reported `hasFocus: true`, `visibilityState: visible`, `hidden: false` and
continued animation frames. Switching tabs again produced no focus/visibility edges. Disabling
the hold restored hidden visibility. After CDP clicks, headless Chrome retained its frame-focus
flag; an independent target with no emulation showed the same native behavior. This is not a
claim about every possible page visibility signal or minimized/sleeping browser behavior.

## Lost press recovery

The former admission filter compared `performance.timeOrigin + event.timeStamp` to the sent
epoch timestamp within 0.5 ms, and required exact coordinates. It now maps each admission onto
the current monotonic event clock, tolerating browser timer quantization and device-pixel
rounding (8 ms and 1 CSS pixel). This avoids a persistent clock-offset rejection after a
wall-clock adjustment. Admissions remain single-use with matched button/type and bounded life.

For each controlled press/release, the executor asks whether the content filter actually
accepted the event. A renderer acknowledgment alone no longer counts as delivery. A rejected
press keeps the browser's real button state long enough to release it, then retries once after
checking the board. A move that already landed is never repeated, and an unreadable board stops
the retry. Even the final rejected acknowledgment gets a bounded board recheck, since a release
may have landed the move despite a missing acknowledgment. Each attempt reads fresh geometry.

The same Chrome run delivered all nine expected pointer/mouse/click events to the inactive
target and blocked an unannounced press/release. Unit and simulator regressions cover rounded
events, positive/negative clock shifts, rejected presses, release cleanup, bounded retries,
no duplicate submission, native-focus failure and stopping after a tab/window change.

Generated evidence is in `build-logs/input-review/`. Real chess.com canvas/DOM games and actual
application switching still need a manual smoke test; the fixture validates the browser input
and focus mechanisms, not the site's live server interaction.
