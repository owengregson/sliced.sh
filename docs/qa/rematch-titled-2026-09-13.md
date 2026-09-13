# Rematching titled players — 2026-09-13

Owner's brief: "if the user is a titled player (candidate master, fm, gm, etc.) we automatically
send a rematch request after the game ends (only one time) — or, if they sent us a rematch request
we automatically accept it. … also if the rematch isnt accepted after 15 seconds we dismiss it and
keep queueing regular games. we only rematch them one time, not more than that."

This note records the rule as built, its gates and knobs, the click sequence, the markup the
adapter looks for, and the three things only a real chess.com board can answer.

## The rule

A rematch is a **step of the auto-queue**, not a separate feature: it runs where the queue's
"new game" click would, uses the same hand-driven click path (`NewGameInput` — the approach, the
held press, the revalidation by `targetId` + point before the press and during the hold, the
off-page release on abort), and is gated exactly like that click. Nothing here clicks from the
content script (§13.3): the adapter only ever reports where a control is.

When a game ends (`GameSession.finishGame`) the session hands the auto-queue the opponent it read
from the player card — name and, when the card carried one, the title. `AutoQueue.schedule`
decides (`rematchEligible`, `src/service/rematch.ts`):

1. `automation.autoQueue` on (the step is part of the queue) and `automation.rematchTitled` on.
2. The opponent is known by name and **titled**: the card's `cc-user-title-component` text,
   normalised to upper case, matches `TITLE_RE` (two to four letters). `TITLES` documents the
   known ones (GM, IM, FM, CM, NM, WGM, WIM, WFM, WCM); any text of that shape counts.
3. This playing session has not rematched this opponent yet (`PlayingSession.rematched`, by
   username; `REMATCH.offersPerOpponent` = 1).

If all three hold, the entry is scheduled at the **ordinary** queue delay
(`TIMINGS.autoQueueDelayRangeMs`, 0.9–2.6 s) with a pending rematch plan — even when the
session's break was due: the break waits for the rematch game. An untitled opponent never gets an
offer and never has their offer accepted; their incoming panel simply hides the new-game button,
so the ordinary queue retries its read until the panel goes away (the site's own timeout).

## The sequence

```
gameEnded (opponent titled, rematchTitled on, not yet rematched this session)
  → AutoQueue.schedule: status "waiting", dueAt = now + delay(0.9–2.6 s), plan { opponent }
      · every REMATCH.incomingPollMs (1 s) until dueAt: port `rematch { action: "accept" }` read;
        `incoming: true` runs the step at once (they offered during the delay)
  → at dueAt (gates: canQueue = "allow", rematchTitled still on, offer still left)
      status "rematch", dueAt = now + REMATCH.acceptTimeoutMs (15 s); panel: "Rematch offered · queueing in Ns"
      RematchStep.run:
        1. read `incoming`
        2. click Accept (incoming) or Rematch (not) through NewGameInput{kind:"rematch"}:
           port `rematch { action }` → SiteAdapter.rematchTarget(action) → the hand's walk + held press,
           revalidated by targetId + point before the press and during the hold
           → the once-only mark (session.rematched += opponent), persisted at the press
        3. wait up to 15 s for `observedGame` (the next `gameStarted` on the tab), polling `incoming`
           every 1 s while our offer is pending: theirs appearing meanwhile → click Accept
        4. no game by the deadline → click Cancel when the adapter finds one (ignored otherwise)
  → outcome
      started   → the rematch game; the entry is cleared; the playing session continues
                  (a break that was due is deferred: `breakUntil` cleared, the expired session
                  samples a fresh break when the rematch game ends)
      expired / not-ready → no second delay: the ordinary new-game click follows at once —
                  unless the session's break was due, in which case the break starts now
                  (status "break", the mouse released as a directly scheduled break releases it)
      in-game   → a game is already on the board: the entry is cleared, like the queue's own `in-game`
```

## The knobs (`src/core/constants/rematch.ts`, C1)

| Knob | Value | Meaning |
|---|---|---|
| `REMATCH.acceptTimeoutMs` | 15 000 | How long an offer (ours, or theirs once accepted) may take to start the next game. |
| `REMATCH.offersPerOpponent` | 1 | Rematches per opponent per playing session. |
| `REMATCH.incomingPollMs` | 1 000 | Cadence of the passive "is their offer showing" read while waiting. |
| `REMATCH.targetTimeoutMs` | 2 000 | Port budget for one `rematch` read / revalidation. |
| `TITLES` / `TITLE_RE` | — | The known titles, and the shape any title text must have. |

Setting: `automation.rematchTitled` (default **on**; the row sits under the auto-queue rows and is
disabled while `autoQueue` is off). Copy: "Rematch titled players — After a game against a titled
opponent, offer one rematch (or accept theirs); if it is not taken within 15 s, queue normally."

## Gates

The same as the queue click, because it *is* a queue click: `Settings.enabled` (`mayAct`),
`automation.autoQueue`, the session in `game-over` / `waiting-for-game` on the same game id
(`canQueue`), the game port connected, the debugger attached, page focus held (a reservation of
the action's own when the hand holds none), `FocusGate.canExecute`, one attempt per tab. The
lobby hold and the session-break release are untouched: the click borrows the hand transiently
exactly as the new-game click does, and a break that starts after an untaken offer releases the
mouse through `GameSession.takeQueueBreak` — the same release a directly scheduled break gets.

Never: twice per opponent per playing session (the mark is set at the press and persisted with
the queue session, so a worker reload cannot re-offer); for an untitled opponent; accepting an
untitled opponent's offer.

## Persistence

`PendingAutoQueue.rematch` (the pending plan's opponent, only while the plan is pending and with a
deadline) and `PlayingSession.rematched` (the once-only marks) travel with the queue's session
record (`SESSION_KEYS.autoQueuePending`); `auto-queue-persistence.ts` validates both and drops a
malformed list without dropping the session. A reload mid-delay restores the plan and runs the
step at the persisted deadline; a reload mid-wait restores the entry's deadline only, so the
ordinary click follows at the persisted `dueAt` — "not taken within 15 s" by construction.

## The markup (`src/content/adapters/selectors.ts`)

From the owner's captures:

- Title: `.cc-user-title-component` inside the **opponent's** card (`playerTop`); our own card
  carries one too when the owner is titled, so the read never leaves the top card. Re-read with
  the same bounded poll the rating uses (the card renders late).
- Outgoing offer (`rematchOffer`, positive label `/^rematch$/i`, never inside the incoming panel):
  `[data-cy="game-over-modal-rematch-button"]`, `[data-cy="sidebar-game-over-rematch-button"]`,
  `button[aria-label="Rematch"]`, `.new-game-buttons-rematch`.
- Incoming panel: `.game-over-buttons-incoming-rematch` — "Good game! Rematch?" with
  `button[aria-label="Decline Rematch"]` / `button[aria-label="Accept Rematch"]` (positive labels
  `/^decline\b/i`, `/^accept\b/i`). `incomingRematch()` is "a usable Accept inside the panel".
- Cancel of a pending outgoing offer (**not captured** — see below): any `button` /
  `[role="button"]` inside `.game-over-buttons-component`, `.game-over-buttons-buttons`,
  `.game-over-modal-shell-buttons`, `.new-game-buttons-component`, `.new-game-buttons-buttons`
  whose label contains "cancel" and not "search" (a matchmaking "Cancel Search" is never it).

Port contract: `rematch { id, action, targetId?, point? }` →
`rematchResult { id, status: ready | not-ready | in-game, target?, incoming }`. `incoming` rides on
every reply so the pre-click poll and the wait's poll are one passive read.

## Open browser items

1. **The cancel control's real markup.** The owner did not capture what the game-over buttons
   show after our Rematch click. If the page shows a "Cancel" (or "Cancel rematch") button in one
   of the containers above, the deadline withdraws the offer before the new-game click; if it
   shows nothing findable, the new-game click simply navigates away (the Engine view's log shows
   `content: no rematch control found for this action { action: "cancel" }`). Record the
   markup and add its selector at the top of `rematchCancelScope` (or a dedicated ladder).
2. **When the incoming panel appears relative to `gameEnded`.** The step reads `incoming` at the
   deadline and every second before it, so either order works — but if the panel can appear
   *before* the game-over modal (and before `gameEnded`), the first read happens up to 2.6 s
   later than it could. Record whether "Good game! Rematch?" ever precedes the modal.
3. **Whether accepting a rematch navigates to a new game id on the same tab.** The wait ends on
   `gameStarted` for a *different* game id on the same tab (`AutoQueue.observedGame`). chess.com's
   rematch is believed to reuse the board element with a new `/game/<id>` URL; if it instead keeps
   the same id (or opens the game elsewhere), the step will expire at 15 s and the ordinary click
   will fire on a board that is mid-game — the adapter answers `in-game` to that read, which
   clears the queue, but record it: the fix would be to also end the wait on a ply reset.

## Tests

- `test/behavioral/game/rematch-titled.test.ts` — the whole stack on the simulator with the
  site's post-game controls: titled → one Rematch press via the hand after the delay, the next
  game within 15 s → no new-game click, no second offer; not taken → Cancel + the new-game click
  at 15 s with no second delay; no Cancel control → the new-game click still follows; incoming
  from a titled opponent → Accept; incoming during the delay → Accept early; incoming while ours
  is pending → Accept; incoming from an untitled opponent → ignored, ordinary retries; untitled →
  no `rematch` read at all; second game vs the same opponent → no read; setting off → no read; a
  due break waits for the rematch game and starts after it; a due break starts after an untaken
  offer with the mouse released.
- `test/service/auto-queue.test.ts` — the step inside the queue's state machine against a
  scripted step, including the once-only mark and the pending plan surviving a reload.
- `test/service/rematch.test.ts` — the decision and the step's state machine on a fake scheduler.
- `test/content/adapters/rematch.test.ts` — the title read (opponent's card only, normalised,
  every known title), and the control discovery / revalidation on the owner's markup.
- `test/panel/views/waiting.test.ts` — the "Rematch offered · queueing in Ns" countdown.
