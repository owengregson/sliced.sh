# Focus discipline — verification procedure and results

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
| 1 | Side-panel button click | real Chrome (Task 31 QA) | expected **yes** | expected yes on return | *to be recorded on real Chrome in Task 31 QA* |
| 2 | Typing in a side-panel input | real Chrome (Task 31 QA) | expected **yes** | expected yes on return | *to be recorded on real Chrome in Task 31 QA* |
| 5r | CDP click on a live chess.com tab | real Chrome (Task 31 QA) | expected no | expected no | *to be recorded on real Chrome in Task 31 QA* |
| 6r | Debugger attach infobar (layout shift, focus side effects) | real Chrome (Task 31 QA) | expected no blur; layout shift only | expected no | *to be recorded on real Chrome in Task 31 QA* |

Every simulator row above is an assertion, not a note: if one stops holding,
`test/behavioral/telemetry/focus-discipline.test.ts` fails.

## 4. Decisions

- **Hands-off mode stays as specified (§13.4) until rows 1 and 2 are recorded.** During a live
  game the panel is display-only, all controls are disabled and the banner explains why; every
  in-game control is a `chrome.commands` shortcut or an in-page keybind. The brief allows relaxing
  hands-off to "no typing" *if* a panel button click turns out not to blur the page — that
  relaxation is **not** taken here, because the measurement that would justify it does not exist
  yet. Task 31 QA records rows 1 and 2 and then either confirms the current rule or proposes the
  relaxation with the probe log as evidence.
- **The extension never restores focus itself.** When a move is due and the gate says the page is
  not focused, the executor waits and the panel's telemetry pill turns to "blur seen"; the move is
  played only after a fresh position arrives. Rows 8 and 9 are the simulator's proof of that.
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
