# The lobby hold — 2026-09-13

The owner: "dont lock the mouse on .../play/online/ (no other url) if both timers are locked at
3:00 or some other time and arent moving - this is because this is the QUEUE screen BEFORE you've
queued a game".

## What the lobby looks like from the extension

`https://www.chess.com/play/online` — exactly that path — shows a board with the default time
control's clocks (3:00 / 3:00 for a 3-minute pool) before any game has been queued. To the adapter
it is a live game in every respect but the ones below:

| Signal | On the lobby | On a real game |
|---|---|---|
| URL | exactly `/play/online` (a trailing slash allowed) | `/game/<digits>` or `/game/live/<digits>`; chess.com rewrites the lobby URL to it once a game is found (`docs/qa-checklist.md` B0.3) |
| `pageKindFromPath` | `live-lobby` | `live-game` |
| `ChessComAdapter.detectPageKind()` | **`live-game`** — the board's game object answers `mode: "playing"` with a `playingAs`, and the bridge refinement wins | `live-game` |
| session started by the content script | yes (`LIVE_KINDS` has `live-game`) | yes |
| `PositionSnapshot.ply` | 0, no move list in the DOM | 0 at first, then moves |
| `PositionSnapshot.clocks.{w,b}.ms` | both the pool's base time, **never changing** | one side's clock goes down while the other stays |
| `opponent.ratingEstimate` | `null` — the top player card is a placeholder | a number, once the card renders (`TIMINGS.opponentReadRetryMs` re-reads) |
| `timeControl` | absent (`timeControl.get()` answers `null` until a game starts, §4.3) | arrives on a republish once the game starts |
| `gameId` (`gameIdentity`) | `-play-online-#<serial>` (no digits in the URL) | the URL's digits |

So the page kind cannot tell the two apart, and neither can the state machine: the session reaches
`live:*`, and with `Settings.automation.autoMove` on the pre-game executor armed the hand at
`hello` — ownership published, the input shield up, the mirror drawn — on a board nobody is playing
on. The owner could not click Play with their own mouse.

## The design

One URL fact plus the clocks.

- **The content script states the URL.** `isLobbyPath(pathname)` (`src/content/adapters/page-kind.ts`)
  is true for exactly `/play/online` / `/play/online/` (query and hash ignored) and for nothing
  else — not `/play/online/new`, not `/live`, not a game id. `hello` and `gameStarted` carry
  `lobby: true` when it holds (omitted otherwise: `GameMeta.lobby`, the `hello` message), and
  `redetect` re-sends `hello` when only that flag changes — `/play/online` → `/game/<id>` keeps the
  refined kind (`live-game` both sides) and still has to be announced.
- **The service worker decides from the clocks.** `src/service/game-session/lobby.ts` is a pure
  detector: `lobby && ply === 0 && opponentRating === null` is the precondition; the first credible
  clock reading on the lobby path (both sides `> 0`) is the baseline; the verdict is
  - `suspected` — precondition holds, the clocks have not proven anything yet (no credible reading,
    or still inside `LOBBY.clockStillMs`);
  - `held` — both readings unchanged for `LOBBY.clockStillMs` (1 500 ms, `src/core/constants/lobby.ts`);
  - `released` — one clock went **down while the other stayed**: a running game on the lobby URL;
  - `none` — off the lobby path, a move played, or a rating known.

  A reading where both clocks changed, or one went up, is the lobby's own time-control selector
  (3 min → 5 min), not a tick: it moves the baseline and releases nothing.
- **What the session does with it** (`GameSession`, `reviewLobby` and friends):
  - `suspected` or `held`: `attachExecutor`'s automatic arm is withheld (`withholdArmForLobby`).
    A carried arm (the hand was armed on the previous game) is remembered in `rearmAfterBreak`, the
    same flag a session break uses; the stored `autoMove` default is re-read when the hold ends.
    The debugger is attached anyway (`DebuggerManager.ensureAttached`) so its infobar and the layout
    shift it brings land on the queue screen, outside every move window (§13.4) — the arm at game
    start then shifts nothing. A manual Shift+A on the lobby is deferred the same way (log line
    `arm deferred — this is the lobby`), not taken.
  - `held` (the clocks proved still): a hand that was already armed — the session was armed and the
    URL became the lobby without a new game id — is released the way `releaseForBreak` releases it
    (`disarm()`, `rearmAfterBreak = true`), and the mirror is hidden whether or not the hand was
    armed, because a parked arrow keeps the shield up on its own (`docs/qa/virtual-cursor-2026-09-13.md`).
    Inside the grace the carried arm is kept, so an auto-queue hop through the lobby that leaves
    within the window does not release and re-arm the hand for nothing.
  - out of a hold (`released` / `none`): `endLobbyHold` arms exactly as a fresh game start does —
    `autoArm`, the one implementation `attachExecutor` also uses now (awaited for its result, one
    arm per executor at a time, `reconsiderGuarded` afterwards). This is ply 0, before our first
    move, so it is outside any move window; as white with the clock running the hand arms and the
    first move follows through the ordinary reconsider path.
  - The clocks *not* moving produces no message, so `suspected → held` is a timer's to notice
    (`scheduleLobbyStill`, cleared on dispose).
- **The queue click is untouched.** `NewGameInput.attempt` neither reads the session's hold nor
  `HandOwnership.isArmed`; it borrows the debugger, mirrors its own path and presses. The hold
  only gates `MoveExecutor.arm()`.
- **Panel.** `GameSessionView.lobbyHold` (present only when true) and the Live view's eyebrow reads
  `COPY.workspace.lobby` ("Lobby · no game queued") instead of "Live". A deferred manual arm has no
  panel state of its own yet — the toggle reads off — which is a follow-up.

## Not a hold: a real game URL with still clocks

As black at ply 0 both clocks read 3:00 until white moves — the same picture as the lobby, on
`/game/<id>`. The owner's rule is the URL ("no other url"), so this is not held: the hand arms at
once, as before. `test/behavioral/game/lobby-hold.test.ts` pins it.

## Tests

- `test/service/game-session/lobby.test.ts` — the detector: every verdict, the tick rule, the
  selector rule, the credibility rule, the baseline (moved by a selector, dropped off the lobby
  path, reset per board).
- `test/behavioral/game/lobby-hold.test.ts` — the wiring on the simulator: arriving on the lobby
  with auto-move on (no arm, no `inputOwnership: true`, no `cursorTo`, debugger attached); the
  hold ending on a tick, on an opponent rating, on the URL moving on (one arm, not one per path);
  an armed hand kept inside the grace and released at `clockStillMs`, then re-armed; a manual arm
  deferred; the selector change; the real-game URL not held; the auto-queue click from the lobby.
- `test/content/index.test.ts` — `hello` says `lobby: true` on exactly `/play/online`, re-sends
  when only the flag changes while the refined kind stays `live-game`, and drops it on
  `/play/online/new` and on a game id.
- `test/content/adapters/page-kind.test.ts` — `isLobbyPath`.

## What only a browser can answer

1. **Does the lobby's top player card carry a rating?** `getOpponent()` reads `.player-top`'s
   rating; the hold's precondition is `ratingEstimate === null`. If the lobby renders a number there
   (the previous opponent's, say), the hold never engages — the service-worker log would show an
   `opponent` message with a rating on the lobby. B8.1.
2. **When does chess.com rewrite `/play/online` to `/game/<id>`?** At match time (B0.3 says the
   second `gameStarted` "right after" the rewrite is known). If so the hold ends on the `hello` /
   `gameStarted` that follow, before any tick; if the URL stays put, the hold ends on the rating or
   the first tick. Either is handled; which one it is decides how quickly the hand arms. B8.2.
3. **Does a clock tick before white's first move?** If chess.com starts the clocks only on white's
   first move, then on a lobby URL that is *not* rewritten and with no rating read, the hold would
   last until white moves — as white, a stall. The rating (1) and the rewrite (2) are the two
   releases that do not depend on it. B8.3.
4. **The clocks' `running` flag on the lobby** is deliberately ignored (the reading's `ms` alone
   decides). Whether `clock-player-turn` is on the bottom clock there is worth recording. B8.1.
5. **The infobar lands on the lobby.** `ensureAttached` runs when the arm is withheld; the
   debugger's idle detach (`TIMINGS.debuggerIdleDetachMs`, 3 min) will drop it on a long stay, and
   the arm at game start re-attaches (an infobar shift at ply 0, before our first move — the same
   as a manual waiting-view arm today). B8.4.
6. **The panel eyebrow** on the lobby. B8.5.
