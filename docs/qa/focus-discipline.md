# Focus discipline — verification procedure and results

Current UI policy (owner instruction, 2026-09-11): the panel remains interactive during play.
The historical hands-off restrictions below no longer disable controls or navigation. Space
requests play-now across panel views outside text/keybind editing; click and Enter still activate
controls. Automatic update/reload prompts are deferred during games. This change does not alter
the executor's input/focus checks or turn the historical simulator rows into native Chrome evidence.

Part I §13.4 rests on one empirical claim: **nothing the extension does may produce a `blur` or
`focus` event on the game tab's `window` during a game.** Every `blur` is counted per move by
chess.com's `fps` plugin (`BlurCount`, `DidBlurOn*Turn`, `DidFocusOn*Turn`, `TotalBlurTime`) and a
blur followed by a focus inside one move window sets `DidToggle` — the single strongest client
signal the corpus documents. This document is where that claim is checked, action by action.

Two kinds of row live in the table below:

- **simulator** — recorded automatically by `test/behavioral/telemetry/focus-discipline.test.ts`
  against the extension simulator plus the `ac` shadow, with the real `FocusGate`, `MoveExecutor`,
  `installFocusEdges` and `installKeybinds` in the loop. These rows re-run on every `bun run check`
  and cannot silently rot.
- **real Chrome (Task 31 QA)** — *not yet recorded*. happy-dom has no window-focus model
  (`document.hasFocus()` is always `true`, nothing blurs a tab), so the simulator cannot answer
  them honestly; they need a human with an unpacked build. They are listed with the exact
  expectation so the Task 31 QA pass only has to fill in the observed column.

The simulator's own focus model is a deliberate stand-in: `SimulatedSite.panelClick()` *declares*
that an interaction outside the page blurs the window. That is the §13.4 design assumption, not a
measurement — which is exactly why the panel rows below are still open.

The Task 31 QA rows below are also listed, with the rest of the real-Chrome work, as section C
of `docs/qa-checklist.md`. Run them from there; record the results here.

---

## 1. Setup

1. `bun run build --dev`, then load `dist/` at `chrome://extensions` (Developer mode → Load
   unpacked).
2. Open `test/fixtures/focus-probe.html` in a tab (`file:///…/test/fixtures/focus-probe.html`).
   It logs every `window` `blur`/`focus`, every `visibilitychange` and every pointer event on its
   target box with `performance.now()`, `document.hasFocus()`, `document.visibilityState` and
   `event.isTrusted`, and keeps running counters. **Clear the log before every action.**
3. Open the side panel on that tab.
4. For the CDP rows, open a real bot game as well (`https://www.chess.com/play/computer`) and arm
   auto-play from the waiting view, so the debugger attaches outside any move window.

Record, for each action: the events the probe logged, `document.hasFocus()` after the action, and
whether the counters moved. Copy the probe log into the row's notes.

## 2. Actions

| # | Action | Expected (design assumption) |
|---|--------|------------------------------|
| 1 | Click a side-panel button | `blur` on the page, `hasFocus()` false |
| 2 | Type in a side-panel input | `blur` on the page (once, on first focus of the field) |
| 3 | Press a `chrome.commands` shortcut while the page is focused | no `blur`, no `focus` |
| 4 | Press an in-page keybind captured by the content script | no `blur`, no `focus` |
| 5 | Trigger a CDP click via the executor with the page already focused | pointer events only; no `focus`, no `blur` |
| 6 | Attach the debugger (arm auto-play) | no `blur`; infobar appears, layout shifts |
| 7 | Detach the debugger | no `blur`; infobar disappears, layout shifts back |
| 8 | Switch to another tab and back | `blur` then `focus` (the user's own toggle — the extension must never cause it) |
| 9 | Focus another application window and come back | `blur` then `focus` |
| 10 | Be in the side panel when the **first** position of a game arrives (page unfocused, no blur inside the window), then click into the board | `focus` on the page; the first move is then played |

## 3. Results

| # | Action | Source | Blur? | Focus? | Observed |
|---|--------|--------|-------|--------|----------|
| 3 | `chrome.commands` shortcut while the page is focused | **simulator** | no | no | `pageFocusEvents() = {blur: 0, focus: 0}`; the shortcut reaches `MoveExecutor.playNow()` through `chrome.commands.onCommand` inside the service worker and every `ac` keeps `BlurCount 0`, `EventTrusted true`. No `tabs.update`, `windows.update` or `Page.bringToFront`. The row fires on the first `normal` move with a planned think of ≥ 5 s so the effect is measurable: with the shortcut the hand skips exploration entirely, starts its touch at 0 ms and drops after **1790 ms of a 5892 ms plan**; the same seeded game *without* it explores (two `scan` phases), starts the touch at 4516 ms and drops at 5763 ms. |
| 4 | In-page keybind captured by the content script | **simulator** | no | no | The real `installKeybinds` listener runs on the simulated page; a trusted `keydown` (`Space`, `Shift+X`) fires `playMove` / `disable` and the window records no `blur` or `focus` at all. A keypress never moves focus, which is the whole reason §13.4 routes every in-game control through a shortcut. |
| 5 | CDP click on an already-focused page | **simulator** | no | no | The tab's DOM sees `pointerdown`/`pointerup` (and `mousedown`/`mouseup`) only; no `focus` or `blur` event is dispatched, and every `ac` keeps `BlurCount 0`. Chrome's real `Input.dispatchMouseEvent` behaviour still has to be confirmed on a live tab — see row 5r. |
| 6 | Debugger attach at arm time | **simulator** | no | no | Exactly one `attach` for the whole game, at arm time, at or before the first move window's `positionArrived`; no attach ever falls inside a window (`positionAt < at ≤ submittedAt`). The infobar's *layout* effect is not modelled — see row 6r. |
| 7 | Debugger detach on disarm | **simulator** | no | no | `disarm()` + `DebuggerManager.detach` produce exactly one `detach`, `isAttached` turns false, and the page still records `{blur: 0, focus: 0}`. Same fidelity as row 6: the *event* side is asserted, the infobar's layout effect is not — see row 6r. |
| 8 | Tab switch during a move window | **simulator** | (user's) | (user's) | The executor **waits**: the move is `skipped` with reason `hidden`, nothing but the already-scheduled `mouseMoved` is dispatched, and the move is played only after a fresh position on the game tab. `tabs.update` stays at 0 — the extension never pulls the tab back. |
| 9 | Browser window loses focus (`windows.onFocusChanged` → `WINDOW_ID_NONE`) | **simulator** | (user's) | (user's) | The move is `skipped` with reason `unfocused`, nothing is dispatched, and the replay after refocus executes. No focus-moving API is called. |
| 10 | First position arrives unfocused, owner clicks into the board | **simulator** | (user's) | (user's) | The owner's 2026-09-10 ruling, scoped to move one. `GameSession.onFocusRegained` re-delivers the held position on the focus edge and the move is then played — re-planned for the wait, so it does not land on the `minExecutionMs` floor; the hand still asks `FocusGate.canExecute` for itself, so this grants a second chance, not permission. Six assertions in `test/behavioral/game/first-move.test.ts`: the release itself; a blur *inside* the window still cancels and clicking back in does **not** play it; a *later* move is not released (§13.4 unchanged from move two on); a **mid-game FEN published with `ply: 0`** is not move one; a **republish of the unmoved ply-0 position** does not clear the blur hold; and the released plan covers the wait. No `tabs.update`, `windows.update` or `Page.bringToFront` — the extension reacts to the owner's focus change and never causes one. |
| 1 | Side-panel button click | real Chrome (Task 31 QA) | expected **yes** | expected yes on return | *to be recorded on real Chrome in Task 31 QA* |
| 2 | Typing in a side-panel input | real Chrome (Task 31 QA) | expected **yes** | expected yes on return | *to be recorded on real Chrome in Task 31 QA* |
| 5r | CDP click on a live chess.com tab | real Chrome (Task 31 QA) | expected no | expected no | *to be recorded on real Chrome in Task 31 QA* |
| 6r | Debugger attach infobar (layout shift, focus side effects) | real Chrome (Task 31 QA) | expected no blur; layout shift only | expected no | *to be recorded on real Chrome in Task 31 QA* |
| 10r | First move after a real refocus, on a live board | real Chrome (Task 31 QA) | (user's) | expected yes, once | *to be recorded on real Chrome in Task 31 QA — this is the row that tells the owner whether his ruling worked* |

Every simulator row above is an assertion, not a note: if one stops holding,
`test/behavioral/telemetry/focus-discipline.test.ts` fails — except row 10, whose assertions live in
`test/behavioral/game/first-move.test.ts` because the session, not the telemetry shadow, is what
decides it. Note that the rows in this file are **not** independent evidence for row 10's two guards:
every one of them targets a later move *and* blurs inside the window, so both guards refuse them for
two reasons at once. Row 10's own tests are the evidence.

## 4. Decisions

- **The original hands-off UI decision was superseded by the owner's 2026-09-11 instruction.**
  Controls and navigation remain available during live games. The focus rows still describe the
  measurements they originally tested; allowing panel interaction is an explicit product choice.
- **The extension never restores focus itself.** When a move is due and the gate says the page is
  not focused, the executor waits and the panel's telemetry pill turns to "blur seen"; the move is
  played only after a fresh position arrives. Rows 8 and 9 are the simulator's proof of that.
- **Move one may be played after a refocus. Decided by the owner on 2026-09-10; every other move
  is unchanged, and that deferral stands.** The rule above has one case where "wait for a fresh
  position" means "wait for ever": at the game's first move no later position can arrive, because as
  white the board cannot change until we play. The owner reported the symptom ("it sometimes doesnt
  make the first move (if youre on white)"), and after Fix G found this as the third of four holds on
  that path he ruled:

  - **The three options on the table.** (1) Leave §13.4 exactly as written — the first move stays
    unplayable in this case, and the deferral below continues to cover it. (2) Release **move one
    only**. (3) Release **every** move whose window lost focus. He took (2) and declined (1) and (3).
  - **What he decided.** The hand may play the **first** move of the game even if focus moved during
    its window — guarded so that it still skips when a blur actually lands *inside* the window.
    Implemented as `GameSession.onFocusRegained`, scoped by the named `isGameFirstMove` so the
    boundary is visible at the call site and cannot quietly widen. The scope is read from the **FEN's
    own move counters** (fullmove 1, i.e. ply 0 playing white and ply 1 playing black), not from
    `PositionSnapshot.ply`: that field is a read of chess.com's move-list DOM and is 0 whenever the
    list cannot be found, which on `/play/online` also makes the session start a spurious "new game"
    — so scoping on it would have turned this into option (3) by accident. The companion guard is the
    session's own record of the ply a blur landed on, **not** `FocusGate`'s per-window `blurSeen`:
    that flag is cleared by `positionArrived`, and at move one the colour and the time control arrive
    on a *republish of the unmoved ply-0 position*, so the normal case would have cleared the guard.
    A blur inside the window still cancels the move, at move one as everywhere else.
  - **Why only move one.** A real player's first move usually *does* carry a focus change, because
    they have just clicked to start the game. Spending the focus-discipline margin there is
    defensible in a way that spending it on every move is not.
  - **What he did not choose.** Options (1) and (3) above. (3) in particular was offered and
    declined, so §13.4's rule stands unchanged from move two onward, and the simulator asserts that
    (row 10's third assertion). Do not widen the scope without a new ruling.
  - **The released move is re-planned, and what that fixes is the *record*.** A withheld plan's
    deadline is in the past, so `MoveExecutor.schedule` fits its `thinkMs` down to
    `EXECUTOR.minExecutionMs` and the §8.6 row would report a move that waited twenty seconds as a
    250 ms think. `reconsider` re-plans through `TimingModel.replan(…, "withheld-then-released")`, so
    `plannedMs`, the panel's plan line and `preMoveHoverMs` match the wall-clock hold chess.com saw —
    bounded by the clock the move started with, because a recorded think the clock could not have
    afforded is a malformed row. It is **not** what makes the post-click interval vary: measured over
    14 seeds that interval is 590–1010 ms with the re-plan and 590–1010 ms without it, 12 of 14
    byte-identical, because the interval is the hand's motor path and was already drawn per move. An
    earlier round of Fix G claimed the re-plan removed a constant-250 ms signature; nobody had
    measured it, and there was no constant.
  - **`report.py` will print `[FAIL] zero blur/toggle` on a game that exercised this, and that is
    expected.** The band requires `focusFieldsSet == 0`; the released move sets `DidFocusOnOwnTurn`
    and a non-null `LastFocusToMoveTime`. The band is deliberately **not** relaxed — a carve-out would
    also hide a focus field on move two, which is option (3) happening by accident. The reasoning is
    recorded beside the check in `tools/telemetry-conformance/report.py`. One failing game whose only
    focus field is on move one is the ruling working; anything else is a bug.
  - **What evidence would change this.** Row 10r on real Chrome. If the export shows the first move
    carrying a `DidToggle` (a blur *and* a focus inside one move window) rather than a bare
    `DidFocusOnOwnTurn`, or if `BlurCount` on move one is ≥ 1 where a human's first move is typically
    0, the guard is not doing its job and the relaxation should be withdrawn. A `LastFocusToMoveTime`
    that is the same number every game is the other withdrawal case — note that nothing in the code
    guarantees it varies; the simulator measures 590–1010 ms, and the variation comes from the hand's
    motor path, not from the re-plan. The reverse evidence — a corpus
    showing human first moves carry a focus edge at a comparable rate — is what would justify
    widening it, and nobody has recorded that either.
- **The debugger attaches once, in the waiting view.** Rows 6/6r exist because an attach inside a
  move window would put the infobar's layout shift into the same window as the move; row 7 is the
  same assertion for the detach on disarm.
- **Only the panel rows are genuinely out of reach.** Rows 3, 4, 6 and 7 are all "the extension did
  something and the page's window saw no focus edge", which the simulator answers exactly. Rows 5r
  and 6r are the same actions checked against *Chrome's own* behaviour rather than the simulator's
  model of it, and rows 1–2 are the premise nothing here can establish.

## 5. What the simulator cannot tell us

happy-dom has no window-focus model, so anything that depends on Chrome actually moving focus
between two documents in the same browser window (the side panel and the tab) is out of its reach.
That is the whole of rows 1, 2, 5r and 6r. The simulator's `panelClick()` asserts the
*consequence* we designed for ("a blur reaches the gate, the move is skipped"), which is worth
testing on its own, but it cannot establish the *premise* ("a panel click blurs the page"). Only
row 1 on real Chrome can.

**A fidelity gap that hid a production hold, recorded because it is the shape to watch for.** Until
2026-09-10 `test/sim/telemetry/sim-site.ts` posted `{ kind: "focus", hasFocus: true }` at content
boot — a message the real content script never sent. `FocusGate.canExecute` answers `unfocused`
while it has no reading at all, and the reading only ever came from that message, so a tab that was
already focused when the content script loaded and was armed with the `Shift+A` shortcut (no focus
edge, by design — row 3) had **every** move skipped with nothing to release it. The fabrication made
every simulated game start with focus known, so no test could see it. Both halves are fixed:
`installFocusEdges` now reports the state once at install (so the worker is told, without any focus
edge being spent), and the fake no longer invents the message. The size of what it was hiding is
visible in the mutation: remove the install report and nine of `first-move.test.ts`'s tests and five
rows of `focus-discipline.test.ts` fail, because the simulated hand can no longer play at all. A fake
that supplies what production cannot is worth more suspicion than a fake that omits something.
