# Virtual cursor: layering and persistence — 2026-09-13

Two owner requests. "Increase the z-index all the time so its always at the maximum possible z
index (because right now some popups go over it when they appear)", and "ensure the virtual cursor
doesnt disappear between games etc. (still shows on our display and keeps its signal to the
page)". Nothing here dispatches input or moves focus: showing an arrow is not input, and the
focus discipline (`docs/qa/focus-discipline.md`) is untouched.

## What changed

- `src/core/constants/cursor.ts` — `CURSOR_LAYER`: the arrow's `z-index` (2147483647) and the
  one-step-under value its trail layer and shield fallback use (C1: the numbers live here, not in
  the page program).
- `src/page/virtual-cursor.ts`, `src/page/cursor-effects.ts` — the arrow, the shield and the
  trail layer are appended to `document.documentElement`, not `document.body`; the arrow uses
  `CURSOR_LAYER.zIndex`; `curEnsure` re-appends an arrow the site moved out from under `<html>`
  instead of drawing a second one.
- `src/service/game-session/session.ts` — `cursorHide` is no longer posted on game end, on a
  disarm, on a navigation or on the debugger detaching. It is posted on the switch going off
  (`Settings.enabled`, and `Shift+X` on the tab), on `Settings.display.virtualCursor` going off,
  on `tabRemoved` and on `dispose()`.
- `src/service/new-game-input.ts`, `src/service/resign-input.ts` — the trailing `cursorHide`
  after the click is gone; the mirror stays parked on the release point of the New Game / confirm
  control, which is where the next game's hand starts.
- `src/service/content-link.ts` — `pointerControlled(tabId)`: whether a `cursorTo` went out on
  this port after the last `cursorHide`.
- `src/service/move-executor/index.ts` — `arm()` starts the hand from `HandOwnership.position`
  (the point the arrow is parked on) while the mirror is on the page; a real pointer sample
  overrides the start only when nothing is drawn.

## Z-index and placement rules

1. The arrow's `z-index` is `CURSOR_LAYER.zIndex` = 2147483647, the largest value CSS accepts,
   written once in the element's style attribute at insert time. It is never lowered.
2. The arrow is a **direct child of `<html>`**. A `z-index` competes only inside its own stacking
   context; `transform`, `filter`, `contain`, `will-change`, `opacity < 1`, `isolation` or a
   positioned `z-index` on any ancestor would open one and confine the arrow to it, beneath every
   later sibling of that ancestor. Under `<html>` there is no ancestor left to do that (a site that
   styled `<html>` itself would also break `position: fixed` for everything, which is why the
   checklist row B5.3 records `<body>`'s and the board ancestors' computed `transform`).
3. Everything else the mirror owns sits **one step under** the arrow and under the same host:
   the trail layer (`cls + "e"`) and the shield's `z-index` fallback both use
   `CURSOR_LAYER.underlayZIndex` = 2147483646. Where the popover API exists the shield is a manual
   popover in the top layer and its `z-index` is irrelevant; it is transparent, so painting over
   the arrow changes nothing visible.
4. `curEnsure` checks the arrow's parent on every point: an element the site's re-render moved
   into its own container is re-appended under `<html>` (the same node, so the fade and the
   effects' history survive); one the site removed outright is drawn again. The check is one
   property read per point — no re-append happens while the parent is right, so the per-point
   mutation surface (§13.3) is unchanged.
5. Ties: two elements at 2147483647 paint in DOM order. Ours is appended to `<html>` after
   `<body>`, so a site element at the same value inside `<body>` still paints under it; only a
   later `<html>` child at the same value would not, and nothing on the page appends there.

## The top-layer limitation

A `<dialog>` opened with `showModal()` and any element shown through the popover API render in
the **top layer**, which is above every stacking context regardless of `z-index`. No number the
arrow can carry beats it. The mirror does not enter the top layer itself: the owner's instruction
was a `z-index`, the shield already occupies the top layer for a different reason (native hover
isolation, `docs/qa/pointer-ownership.md`), and a `<dialog>` from us is out (it would be one more
page-realm signature, and a modal dialog steals focus, which §13.4 forbids).

Whether chess.com's popups use the top layer is **not established** by this change. Everything
the adapter addresses on those popups is an ordinary element (`src/content/adapters/selectors.ts`:
`.game-over-modal-container`, `wc-game-over-modal`, `[data-cy="game-over-modal-new-game-button"]`,
…) and none of the live DOM notes records a `<dialog>` or a popover, which is consistent with
positioned `div` modals — the kind a maximum `z-index` now beats — but no row has checked
`document.querySelector("dialog[open], [popover]:popover-open")` on a live game
(`docs/qa-checklist.md` B5.11 now does). If a popup still paints over the arrow after this change,
that is the check to run: a `<dialog open>` or an open popover in the result is the top layer, and
the arrow cannot go above it without joining the top layer itself.

## The hide contract

The arrow is where the pointer rests. It stays there, and the page keeps its signal — the shield,
the pointer-admission handshake (`ContentLink.pointerControlled`, `preparePointer` /
`confirmPointer`) and the content relay's `drawn` state all persist — through:

- a game ending (`onGameEnded`), including the auto-queue's New Game click and a resign;
- a navigation (`onTabEvent("navigated")`): on chess.com the route changes between every two games;
- a disarm (the panel toggle);
- the debugger detaching, by the auto-queue, the panel, an idle timer or the infobar's Cancel;
- the quiet stretch in between: nothing is posted, and nothing on the page expects a keep-alive —
  the element exists until a `cursorHide` removes it.

Exactly three things post `cursorHide`:

1. the assistant switched off — `Settings.enabled` going false, and `Shift+X` (`disable`) on the
   tab, which is the owner's explicit stop gesture (§13.4);
2. `Settings.display.virtualCursor` going off;
3. the tab going away — `tabRemoved` and `GameSession.dispose()` (which the registry calls when
   the tab is removed, the port drops or the worker shuts down).

One content-side hide stays: the ISOLATED relay erases the mirror when its port to the service
worker disconnects or the content script is disposed. A mirror nobody can move must not keep the
input shield up with no owner to lower it. The port reconnects on the worker's wake (`FeedPort`),
and the next dispatched point draws the arrow again; the worker's `HandOwnership` state does not
survive a suspension, so the hand's start after one is a plausible board point, as before.

The next game starts where the arrow is: `HandOwnership.position` is the last dispatched point and
survives the boundary; `attachExecutor` re-arms the next game's executor (an armed previous game, or
`automation.autoMove`), and `MoveExecutor.arm` now keeps that rest point whenever the mirror is on
the page rather than letting a fresh real pointer sample override it. The simulator holds this
end to end (`test/behavioral/game/virtual-cursor.test.ts`): after `gameEnded`, a user detach and a
new `gameStarted`, no `cursorHide` was ever posted and the first `cursorTo` of the new game is within
`TELEMETRY_BANDS.pointer.maxStepPx` of the last one; and after a disarm, a real sample far from the
arrow and a re-arm, the hand still continues from the arrow.

A consequence to be aware of: while the arrow is up the physical pointer is blocked
(`docs/qa/pointer-ownership.md`), and the arrow now outlives a disarm. To use the real mouse on the
page after disarming, turn the assistant off (`Shift+X` or the switch) or turn the pointer display
off — a disarm alone no longer returns the page to the real mouse.

## The page gate (later the same day)

The owner: "when on a page that isnt a game page (url doesnt contain /play/online or /play/... or
/game/live/...) we shouldnt lock cursor/disable input on the page."

The gate is the page kind, and the set is `GAME_PAGE_KINDS` in `src/content/adapters/page-kind.ts`:
**`live-game`, `live-lobby`, `vs-computer`** — `/game/<digits>`, `/game/live/<digits>`,
`/play/online` (and `/live`), `/play/computer` / `/play/bots`. `live-spectate`, `daily`, `analysis`,
`puzzles` and `other` are not game pages. On those the real mouse keeps the page:

- `src/content/index.ts` — `inputOwnership { owned: true }` is answered as **not owned**; a
  `cursorTo` is claimed and dropped (`createVirtualCursor`'s `allowed` option), so the first draw —
  the thing that raises the shield and keyboard exclusivity — never happens; and when the page kind
  changes *to* a non-game kind while something is up (SPA navigation: chess.com routes to the
  analysis board after a game), `releaseInput()` drops ownership and erases the mirror, through the
  unlock glide below. This is the gate that holds regardless of what the worker sends.
- `src/service/hand-ownership.ts` — the worker's half, for tidiness: the tab's last `hello` page
  kind is remembered and `inputOwnership` is published as `owned && isGamePage(kind)`, so a hello
  from the analysis board is answered with a release and a hello back on a game page re-announces a
  standing arm. A tab that has not said hello is not gated (the content side is).

Nothing else changed: sessions still start on `live-game` / `vs-computer` only (`LIVE_KINDS`), and
the hide contract above is untouched on game pages.

## The unlock glide

The owner: "when the mouse goes from virtual mouse locked -> unlocked [in any situation], we want
to smoothly move the cursor from its current position to the actual user's cursor position THEN
unlock the mouse cursor (so its like a smooth transition)."

Every unlock of a drawn mirror — the worker's `cursorHide` (the three hide reasons), the page gate
above, the port dropping — is now a glide first, then the hide:

1. **Where the real mouse is.** `CursorTracker.latest()` (`src/content/cursor-tracker.ts`) is the
   owner's most recent trusted `pointermove` / `pointerdown` / `pointerup` sample *regardless of
   ownership*. Real moves keep reaching the tracker while the shield is up: the tracker's listener
   is a window capture-phase listener installed at `document_start`, it runs before it stops the
   event, and the MAIN-world shield is an element under the pointer that only blocks the site's
   hover and handlers, not the event's arrival. Verified in
   `test/content/cursor-tracker.test.ts` ("latest() follows real moves while the pointer is owned")
   and end to end in `test/content/index.test.ts` (a stopped `pointermove` at (700,140) is the
   glide's end point). `report()` — the next hand's plausible start — still freezes during
   ownership, as before; only `latest()` follows. CDP-dispatched points are admitted by the
   pre-dispatch handshake and consumed before sampling, so they never become a "real" position.
2. **The glide.** `createVirtualCursor` (`src/content/virtual-cursor.ts`) remembers the last point
   it drew. On a hide with a drawn mirror and a known real position it feeds
   `glidePoints(arrow, real)` — `ceil(CURSOR_UNLOCK.glideMs / stepMs)` = 20 points, ease-in-out
   cubic, the last one exactly the real position — down the mirror's existing `cursorTo` draw path,
   one per `stepMs` (16 ms) over `glideMs` (320 ms; `src/core/constants/cursor.ts`, C1). The points
   are `down: false` and go over the bridge as fire-and-forget notifies, exactly like the hand's
   own; **nothing is dispatched** (C7): the CDP command count is unchanged across a glide
   (`test/behavioral/game/virtual-cursor.test.ts`). Then, and only then, `cursorHide` goes out.
3. **Still locked until it lands.** The mirror counts as `shown()` for the whole glide
   (`gliding()` says which), so the shield and keyboard exclusivity stay up until the arrow has
   reached the mouse and the visibility callback drops them — the two cursors swap in place instead
   of the real one appearing somewhere else. The admission handshake still runs against the drawn
   mirror during the glide. `ContentLink.pointerControlled` on the worker side is unaffected: the
   worker posted its hide and moves on; the glide is the page's own business.
4. **A new lock cancels it.** A `cursorTo` arriving mid-glide (the hand took the pointer back — a
   new game armed while the arrow was on its way) cancels the glide; the arrow continues from
   where it is and nothing hides. A second hide mid-glide neither restarts nor doubles it.
5. **When it is skipped.** No real position known (no real pointer event since the content script
   loaded), the arrow already on the real position, or the page side gone (`bridge.isAvailable()`
   false — the "does not forget a hide it could not send" contract is kept): the hide is immediate,
   as before. `dispose()` (the content script going away) erases at once, with no glide. A page
   side that vanishes *during* a glide ends it and leaves the hide pending, as before.

`releaseInput()` in `index.ts` is the one path for the port-drop and page-gate unlocks: ownership
off, hide (glide) requested, and the shield lowered at once only when no glide is running — a
mirror nobody can move must not keep the page locked with no owner to lower it.

What only a browser can answer: that the 20 points at 16 ms read as one smooth motion over the
site's canvas board, and that the real OS cursor is exactly under the arrow at the moment the
element goes (the tracker samples `clientX` / `clientY`, the same space the arrow is drawn in).
`docs/qa-checklist.md` §B5 is the place for both.

## Verification

`bun run gen:pagescript`, `bun scripts/check-constants.ts`, `bun run typecheck`, `bun run lint`,
`bun test test/page/`, `bun test test/content/`, `bun test test/behavioral/game/`,
`bun test test/behavioral/telemetry/`, and the touched service suites
(`content-link`, `new-game-input`, `resign-input`, `game-session/*`, `move-executor/*`,
`hand-ownership`) all pass. The z-index and the host are asserted on the emitted program and on a
happy-dom window; what only a browser can answer — that the arrow now paints over the site's
positioned popups, and whether any of them is top-layer — is `docs/qa-checklist.md` §B5.
