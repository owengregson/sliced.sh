# QA checklist

Everything the automated suite structurally cannot answer, in the order you should do it. This
is a script: you should be able to run it end to end without asking anybody a question.

**Scope.** Sections A–L need a real Chrome and, for most of them, a real game on chess.com —
the only supported site. Nothing here is covered by `bun run check`; several items exist precisely
because a simulator, happy-dom or a hand-built fixture cannot establish them (each says which).

**Play against bots only.** §12.1 item 5: the real-site QA is performed against computer
opponents (chess.com "Play computer"), never against a human.
Export the timing log afterwards and run it through `tools/telemetry-conformance/`.

---

## 0. Setup (do this once)

1. `bun install && bun run check` — must exit 0. (Needs `python3` on `PATH`.)
2. `bun run build --dev`.
3. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
   - The card must read **sliced.gg (dev)**, version `2.0.0`, `version_name` `2.0.0-dev+…`.
   - **Expect zero errors and zero warnings on the card.** Any "Unrecognized manifest key",
     permission warning you did not expect, or CSP complaint is a finding — write it down.
4. Open the service-worker console (`chrome://extensions` → "service worker"). Every context's
   `log.*` output arrives here. Set Settings › Advanced › Log level to `debug` for the run.
5. Open `file:///…/test/fixtures/focus-probe.html` in its own tab — section C uses it.
6. Record, for the whole run: Chrome version, OS, machine (CPU cores, RAM), and whether the
   machine is on battery. Several timing items are hardware-sensitive.

Record results by filling in the **Observed** column / the blanks in each table. A row you did
not run is `not run`, never a tick.

---

## A. Release smoke

| # | Do | Expect | Observed |
|---|---|---|---|
| A1 | Load `dist/` unpacked | Card shows no errors/warnings; the toolbar icon appears | |
| A2 | Click the toolbar icon on a chess.com tab | Side panel opens; Login or Waiting view, never a blank panel | |
| A3 | Open the service-worker console | `service systems bootstrapped`, `license: validated`, no uncaught errors | |
| A4 | Open a supported site and wait for the engine | `chrome://extensions` → "Inspect views: offscreen.html" exists | |
| A5 | Navigate to a non-supported site (e.g. example.com) with the panel open | "Not on a supported site" view with a working chess.com link | |
| A6 | `bun run build` (release), load *that* `dist/` unpacked in a second profile | Card reads **sliced.gg** (no `(dev)`, no `version_name`); everything above still holds | |
| A7 | On a chess.com tab's page console, run `fetch("chrome-extension://" + "<the extension id from chrome://extensions>" + "/assets/sounds/make_move.wav")` | **Rejects.** v2 declares no `web_accessible_resources`, so a page cannot confirm the extension is installed (§13.3). A success here is a critical finding | |
| A8 | Same, with the engine: `.../assets/engine/sf_18_smallnet.wasm` | Rejects, same reason | |

---

## B. Real-site play

### B0. chess.com renderers — the WebGL live board and the DOM bot board

**Why this section exists.** chess.com ships two board renderers. `/play/computer` still lays out
`.piece` divs; the **live** board (`/play/online`, `/game/<digits>`) draws into a `<canvas>` with
`wc-chess-board#board-single.board.board-webgl-2d` and has **no piece elements at all**. The
bots-only rule above means the whole of section B otherwise exercises the DOM renderer only —
which is how "the extension does nothing on a live game" survived 34 task reviews and a green
suite. Everything here is read-only: do **not** arm auto-play, so nothing is played in a live
game against a human.

| # | Do | Expect | Observed |
|---|---|---|---|
| B0.1 | On a live game, page console: `const b=document.querySelector("wc-chess-board#board-single"); ({cls:b.className, canvas:b.querySelectorAll("canvas").length, pieces:b.querySelectorAll(".piece").length, fen:b.game.getFEN(), playingAs:b.game.getPlayingAs(), flipped:b.game.getOptions().flipped})` | `pieces: 0`, `canvas: 1`, a correct FEN. Record `playingAs` / `flipped` — the adapter's orientation rests on `flipped` meaning "black at the bottom" | |
| B0.2 | Panel on a live game, observing only | Live view within a move or two; SAN, eval and lines update on every move of both sides | |
| B0.3 | Service-worker console during that game | No `adapter.selectorMiss`; `gameStarted` exactly once per game (a second one right after chess.com rewrites `/play/online` → `/game/<id>` is known and harmless) | |
| B0.4 | Highlights on (default), observing a live game | The two highlighted squares are the recommended move's, on the correct squares — check a game **as black** as well, where the board is rotated 180° | |
| B0.5 | Flip the live board by hand (board context menu / keyboard) mid-game | Highlights stay on the right squares; the panel's lines do not change | |
| B0.6 | `/play/computer` against a bot | Same as above, with `pieces: 32` in B0.1's probe — the DOM path must not have regressed | |
| B0.7 | A promotion on the **live** board with auto-queen off in chess.com's settings (do this once, deliberately, *not* while armed on a game you care about) | **Known gap:** the picker is drawn on the canvas, so the hand cannot find it and leaves the pawn on the last rank. Record what the picker looks like in the DOM (if anything) — that capture is what a fix needs | |

### B1. chess.com — blitz vs a bot, with a promotion and a premove

Set Settings › Strength to something clearly sub-engine (e.g. 1200, Balanced) so the play is
plausible. Play a 3+0 or 5+0 game against a bot.

| # | Do | Expect | Observed |
|---|---|---|---|
| B1.1 | Start the game with the panel open | Panel moves to Live within one move; opponent name and rating are read correctly; my colour is right (check with a black-side game too) | |
| B1.2 | Watch three of your turns without arming | Move card shows a SAN, from→to, eval and a plan line; the highlight lands on the right two squares on the board | |
| B1.3 | Watch the clocks through a move | Both clocks track the page's clocks; the running one is the side to move; tenths appear under 10 s | |
| B1.4 | Arm auto-play (hold the toggle ~600 ms) | Debugger infobar appears; toggle reads "Auto-play on"; countdown ring drains on your turn | |
| B1.5 | Let it play ~10 moves | Each move is a *drag*: press, a continuous path, release. No teleporting cursor, no instant click-click. Move times vary and look human | |
| B1.6 | Reach a promotion (push a pawn to the 8th) | **Turn chess.com's auto-promote-to-queen ON before arming on a live board.** With it on, the promotion completes and is verified as played. With it off the picker is drawn on the canvas, the hand cannot find it, and the pawn is left on the last rank until the two-failure disarm — see B0.7 | |
| B1.7 | Make a premove yourself while armed | The extension does not fight you: your premove is left alone or cleanly superseded; no double move, no illegal attempt | |
| B1.8 | Let the extension premove (obvious recapture, low clock) | The premove is placed during the opponent's turn and resolves; the panel's plan line says `premove` | |
| B1.9 | Switch tabs mid-move-window, come back | The move is **skipped** while hidden and played after the next fresh position. Nothing pulls the tab back | |
| B1.10 | Let the game end | Game-over is detected; panel returns to Waiting; auto-queue (if on) starts a new game after a plausible delay | |

### B2. chess.com — bullet vs a bot, including a flag

Bullet is its own regime: the timing floors, the premove path and the flag handling only get
exercised down here. Play 1+0 against a bot.

| # | Do | Expect | Observed |
|---|---|---|---|
| B2.1 | 1+0 vs a bot | Panel reaches Live; the bot's name and rating are read (`botName` / `botRating`) and the §13.6 target is a real number | |
| B2.2 | Play both colours | Board orientation and my colour are correct in both; highlights land on the right squares when the board is rotated | |
| B2.3 | Armed, play into severe time trouble (< 10 s) | Move times compress but stay above the floor; the hand still drags; nothing hangs waiting on a plan | |
| B2.4 | Let your own clock flag while armed | The extension stops cleanly at flag; no move is dispatched after the game ends; panel shows game over | |
| B2.5 | Resign / rematch from chess.com's own controls | Session ends and restarts cleanly; no stale highlights from the previous game | |

### B2a. The time control reaching the service worker (§4.3) — **answerable only in a browser**

The simulator cannot produce chess.com's own `board.game.timeControl.get()`, and everything the
clock drives hangs off it: the timing class, the compression factor, the hard caps, the §8.5
emergency regime, the §4.6 preset, the §7.4 premove gate and the hand's motor class. It is `null`
until the game actually starts, so the reading arrives *after* the session exists and
`GameSession.reprofile()` is what consumes it. These rows prove the whole chain on a real game.

| # | Do | Expect | Observed |
|---|---|---|---|
| B2a.1 | Open a live 3+0 game and watch the service-worker console from before the first move | One `game-session: time control learned from a position` line with `baseMs: 180000`, `incMs: 0`, `tc: "blitz"`. **No line at all is a finding**: the game is running untimed, with a classical hand and no premoves | |
| B2a.2 | Settings view, during that game | The detected preset chip matches the class (bullet → fast, blitz/rapid → natural, classical → slow). A game showing the stored preset instead means the time control never arrived | |
| B2a.3 | A game **with an increment** (3+2) | The log line shows `incMs: 2000`. If it shows `incMs: 2` — or a warning `adapter: implausible time-control field, reading it as seconds` — chess.com reports the increment in **seconds**, which is the one unit this lane could not confirm (the capture's increment was 0). Record which | |
| B2a.4 | 1+0 vs a bot, play down to under a second on your own clock | `emergency regime: no floors, minimal motor` appears in the plan's rationale (panel plan line / timing log). The move still lands; note how long it actually takes — the hand's motor floor is ~400–900 ms whatever the plan says, which is the real lower bound on a flag scramble | |
| B2a.5 | A game that is **not yet started** (waiting for an opponent), then let it start | The first positions carry no time control (expected), and the line in B2a.1 appears within a second or so of the clocks starting. A gap of many seconds means the 1 Hz re-ask is the only thing delivering it and the page's own event never fires | |
| B2a.6 | Under a minute on your own clock, read the panel's clock | It keeps counting (tenths shown). A clock that freezes or jumps to 0:00 means chess.com renders bare seconds in a shape `parseClockText` still rejects — record the exact string from the DOM | |

### B3. Executor and content-script edge cases (deferred from Tasks 18/20/21)

| # | Do | Expect | Observed |
|---|---|---|---|
| B3.1 | Load a game page by typing the URL (so the content script boots at `document_start` **before** `<body>` exists) | The content script still attaches and reports a position; SW log shows no "waiting for body" loop that never ends | |
| B3.2 | Navigate between games with SPA navigation (no reload) | A new game is detected exactly once — not on every re-render, and not missed | |
| B3.3 | Watch the pieces during a capture on chess.com | Confirm removed pieces are moved into `div.element-pool` **outside** `wc-chess-board`, and that the adapter's piece read never picks up a pooled piece (stale piece in the panel's position = finding) | |
| B3.4 | Armed: cancel a countdown with `Esc`, then let the next move run | Cancel is honoured; the following move executes normally | |
| B3.5 | Armed: interrupt a drag by moving the real mouse over the board | The hand keeps a continuous trace; no jump. (§13.5 hand ownership) | |

### B4. The board moving under the hand (§9.5)

The only thing the simulator cannot answer here is **whether the infobar's appearance fires the
board element's own `ResizeObserver`**, as opposed to only the viewport's. The content script
observes the board, `document.documentElement`, and the window's `resize` / `scroll`, precisely
because that could not be verified offline — B4.1 is what decides which of those carried it.

| # | Do | Expect | Observed |
|---|---|---|---|
| B4.1 | Arm **mid-game** with the side panel open (the infobar appears and the panel reflows the page at the same moment) | The service-worker console logs `executor: waited for the layout to settle after the attach` with a **non-zero** `waitedMs` before the first move. A zero or missing line means the board-rect reports never arrived and the whole guard is inert — that is a finding, not a pass | |
| B4.2 | Same, but watch the board through that first move | No half-finished drag: either the move plays normally on the new geometry, or the piece is put back on its origin square and the move is skipped (`hand: releasing on the origin square after a reflow` / `aborted: board-moved`). A piece dropped on a square that is not the recommended destination is a critical finding | |
| B4.3 | Armed on a live game, scroll the page during a move window | Board-rect reports are coalesced on animation frames, not one per scroll event; the move still lands on the right squares | |
| B4.4 | Armed, click **Cancel** on the infobar (layout shifts back) then Reattach | The settle wait runs again on the next execution; the move after the reattach lands on the right squares | |
| B4.5 | Page console on a live game: `new ResizeObserver(() => console.log("board resized")).observe(document.querySelector("wc-chess-board"))`, then arm | Record whether the board element itself reports, or only the viewport did. This is the answer B4.1 needs | |

### B5. The pointer mirror (Fix D) — **answerable only in a browser**

The mirror is one `position: fixed` `<div>` the MAIN-world bridge appends to `document.body` on the
first point the hand dispatches. Everything about the *stream* is covered offline
(`test/behavioral/game/virtual-cursor.test.ts` holds the posted sequence to the CDP sequence point
for point), and everything about the *element* is covered in happy-dom
(`test/page/virtual-cursor.test.ts`). What no simulator can answer is whether the page's own layout
and compositing leave it where it belongs, and whether the motion reads as continuous at real port
latency — happy-dom has no layout, no compositor and no frame clock.

| # | Do | Expect | Observed |
|---|---|---|---|
| B5.1 | Armed on a live game, watch a move play with the real mouse held still well away from the board | The arrow appears, moves along the hand's path and stays where the hand stopped. It must be the *only* thing moving: if it tracks your real mouse, the feed is wrong (a finding, not a setting) | |
| B5.2 | Same, with the page **scrolled** so the board is not at the top of the document | The arrow sits on the squares the hand is touching, not offset by the scroll amount. An offset equal to `scrollY` means the coordinate spaces diverged | |
| B5.3 | Page console on a live game: `getComputedStyle(document.body).transform` and the same for every ancestor of the board | Record the values. Anything but `none` on `<body>` makes it a containing block for `position: fixed` and would shift the mirror — the one assumption the offline tests cannot check | |
| B5.4 | Watch the arrow during the press and the release | It dips slightly (about the tip, not the box corner) exactly while the piece is held, and returns on the release | |
| B5.5 | Watch the first appearance | It fades in over ~0.4 s rather than popping. No fade at all means the post-insert style flush did not take effect in this Chrome | |
| B5.6 | Watch the motion closely during a drag, then record `performance.now()` gaps between `cursorTo` arrivals in the page (temporarily, in a dev build) | Continuous glide. Gaps consistently above ~30 ms would be the first evidence that the port cannot keep up and that the rAF smoothing from the reference is needed after all — the offline measurement says it is not (~45 points/s, 4-6 ms apart) | |
| B5.7 | Disarm, `Shift+X`, turn the assistant off, turn **Settings › Display › Show the hand's pointer** off, let a game end, navigate away | The arrow disappears and `document.querySelector` finds no leftover element in each case | |
| B5.8 | Click **Cancel** on the debugger infobar while the arrow is parked between moves | Record what happens. The hand stops dispatching, so the arrow stays parked; decide whether that reads as stale to the owner (it is literally where the pointer is) | |
| B5.9 | With the mirror on screen, inspect `document.body.children` and the site's own network payloads | Record whether anything the site sends changes. The element is a body child with a per-build class, no `id`, no `data-*` and no listeners — but it *is* an extra DOM node while the hand plays (§13.3 residual) | |

---

## C. Focus discipline (`docs/qa/focus-discipline.md`)

This is the highest-value section: §13.4 rests on a premise the simulator cannot establish, and
six rows are still unrecorded. happy-dom has no window-focus model, so only a real browser can
answer these.

**Procedure** (full version in `docs/qa/focus-discipline.md` §1): open the focus probe in the
game tab's window, open the side panel on it, **clear the probe log before every action**, then
perform the action and copy the probe's log into the row. Record `document.hasFocus()` after the
action and whether the counters moved.

| # | Action | Expected | Blur? | Focus? | Observed (paste the probe log) |
|---|---|---|---|---|---|
| 1 | Click a side-panel button | blur on the page, `hasFocus()` false | | | |
| 2 | Type in a side-panel input | blur once, on first focus of the field | | | |
| 5r | CDP click via the executor on a live chess.com tab, page already focused | pointer events only, no focus/blur | | | |
| 6r | Debugger **attach** (arm auto-play) | no blur; infobar appears; note the **layout shift in px** and whether the board moves | | | |
| 6r′ | Debugger **detach** (disarm) | no blur; infobar disappears; layout shifts back | | | |
| 8/9 | Switch tab / focus another window and return | blur then focus — the user's own toggle. Confirm the extension never causes one | | | |

**Row 6r matters twice.** The event side is asserted by the simulator; what is unknown is
whether the infobar's appearance disturbs page focus at all, and how much it shifts the layout.
If the board itself moves, confirm the executor's geometry is re-read after attach — a stale
board rect would put clicks on the wrong squares.

**Then**: update the Results table in `docs/qa/focus-discipline.md` with what you saw. If rows 1
and 2 show that a panel button click does *not* blur the page, §4's decision note explains the
relaxation of hands-off that becomes available — propose it with the probe log as evidence
rather than making it silently.

| # | Do | Expect | Observed |
|---|---|---|---|
| C1 | Armed, click **Cancel** on the debugger infobar | Auto-play pauses; panel shows the detached state with a Reattach action; no move is attempted | |
| C2 | Click Reattach | Debugger reattaches; infobar returns; auto-play resumes without a page reload | |
| C3 | Open DevTools on the game tab while armed | Chrome steals the debugger: same detach path as C1, handled the same way | |
| C4 | Close the game tab while armed | Detach is handled (`target_closed`); SW logs no unhandled rejection; the session is torn down | |

---

## D. Engine, offscreen and cross-origin isolation (deferred from Task 12)

Everything in this section is unverifiable outside a real browser: the simulator has no
`crossOriginIsolated`, no `SharedArrayBuffer` and no OPFS.

Open the offscreen document's console (`chrome://extensions` → Inspect views: offscreen.html).

| # | Do | Expect | Observed |
|---|---|---|---|
| D1 | In the offscreen console: `crossOriginIsolated` | `true`. If `false`, the COOP/COEP manifest keys are not taking effect and pthreads will not work | |
| D2 | `typeof SharedArrayBuffer` | `"function"` | |
| D3 | Watch the boot log for the shared memory allocation | The first attempt is `LIMITS.engineMemoryInitialPages[0]` = 2560 pages = **160 MiB**. Record which of `[2560, 1536, 1024]` actually succeeded, and on how much RAM | |
| D4 | Force the fallback (open several heavy tabs first, or run on a low-RAM machine) | A failed 2560-page allocation degrades to 1536 then 1024 and the engine still boots, rather than throwing | |
| D5 | Confirm the extension-URL `import()` of the Emscripten factory works under the extension CSP | Engine reaches `uciok`; no CSP violation in the offscreen console | |
| D6 | Confirm pthreads actually spawn (`mainScriptUrlOrBlob`) | Worker threads appear; `Threads` option takes effect (nps rises with more threads in the Engine view) | |
| D7 | Trigger a full-build NNUE download (Settings › Engine › Network = `big`, **see Known gaps L2 — this control is currently inert, so drive it from the SW console instead**) | The SW fetches, the offscreen store receives ~4 MiB base64 chunks; record the wall-clock latency per chunk and total. `nnue-progress` drives the panel's progress bar | |
| D8 | With OPFS unavailable (or quota exhausted) | The IndexedDB fallback (`NNUE_DB`) is used; the engine still boots | |
| D9 | Open two windows on supported sites | Exactly **one** offscreen document exists (`chrome.runtime.getContexts`), shared by both | |
| D10 | Engine view → Restart | Engine restarts, reaches `ready`, and analysis resumes without a reload | |

---

## E. Timing head (ChessMimic; deferred from Task 34)

| # | Do | Expect | Observed |
|---|---|---|---|
| E1 | Boot with the SW console open, first connect | The default band `1500_1600` pre-warms: record the wasm instantiation time and the first-band load time (~206 ms and ~18 MB were the export-time figures) | |
| E2 | Same on the slowest machine you have | Record it. If the pre-warm collides with the Stockfish boot badly enough to delay the first recommendation, that is a finding | |
| E3 | Play with `targetElo` in each of the three bands (1200–1300, 1500–1600, 1800–1900) | Each band's session loads on demand; with `LIMITS.timingSessionsMax = 2`, the third evicts by LRU — confirm the eviction does not stall a move | |
| E4 | Measure per-move inference latency (Engine view timing log, or the offscreen console) | Under the **100 ms** head budget. Above it the v1 head substitutes — confirm the substitution is what actually happens, and how often | |
| E5 | Exercise the **streaming** band download against a real `Response` | Point a band at a non-bundled URL (or flip `bundled: false` for one band in a scratch build). Confirm the relay streams: chunks arrive *during* the transfer, not after. The production preset has only ever been exercised through the buffering fallback in tests | |
| E6 | Interrupt a band download half-way (offline, then back) | The stall budget (`TIMINGS.assetDownloadStallMs`) fires, the band is retried after ~30 s, and nothing wedges | |
| E7 | Export the timing log after a full bot game | Run `tools/telemetry-conformance/report.py` over it; record the verdict | |

---

## F. Adapter selectors vs the live DOM (deferred from Task 20)

The adapters were built against fixtures hand-written from Appendix C's DOM descriptions rather
than live captures. **Most of that gap is now closed** (evidence:
`docs/qa/2026-09-live-selector-verification.md`). On 2026-09-09 every board, piece,
coordinate, clock, player and move-list selector was checked against live chess.com in a real
browser, and the first ladder entry hit in every case — including the move list
(`wc-simple-move-list` 1, `.node.main-line-ply` 43, `.node-highlight-content.selected` 1). Those
rows are struck below. (That pass also covered lichess, which is no longer supported.)

What remains needs a game *state* a read-only pass cannot reach: promotion pickers, game-over
modals, follow-up controls, and anything that needs the extension installed and armed. For each
row, open DevTools on the live page and check the selector in `src/content/adapters/selectors.ts`
against what is actually there.

| # | Selector / concern | Where | Expect | Observed |
|---|---|---|---|---|
| F1 | `chesscom.rating` — `.cc-user-rating-white` / `.cc-user-rating-black` / `.user-tagline-rating` | live chess.com game | One candidate matches and yields the opponent's rating | |
| F2 | `chesscom.botCard` / `botName` / `botRating` — `.bot-component*` | chess.com "Play computer" bot picker | The bot's name and rating are read; the §13.6 opponent-matched target gets a real number | |
| F3 | `chesscom.username`, `playerTop`/`playerBottom` | live game | Correct top/bottom assignment in both orientations | |
| F5 | `div.element-pool` pooled pieces | chess.com, after several captures | The pool itself is **already confirmed** (3 on `/play/computer`). What remains: after several captures, confirm it holds recycled `.piece` elements and that the adapter's piece read never picks one up (a stale piece in the panel's position is the symptom) | |
| ~~F6~~ | ~~chess.com move-list ladders~~ | — | **Struck — verified live 2026-09-09**: `wc-simple-move-list` 1, `.main-line-row` 23, `.node.main-line-ply` 43, `.node-highlight-content` 43, `.node-highlight-content.selected` 1, all first ladder entry | done |
| F8 | `chesscom.gameOver` ladder + `gameOverHeaderClassRe` | after a win, a loss and a draw | Result is classified correctly in all three | |
| F9 | Run the content self-check (`self-check.ts` probe output in the SW log) | every selector concern reports a matched index; nothing reports "no candidate" | |

Anything that only matches at a later ladder index, or not at all, should be captured as a real
DOM snapshot into `test/fixtures/` so the regression is caught next time. Note also that the
live pass found chess.com resolving `wc-chess-board#board-play-computer` — the *second* board
ladder entry — on `/play/computer`, which is expected and exact, not a fall-through.

---

## G. Licence paths

`build.config.json` ships `licenseEnforce: false`, so the gate is forced open and every key
validates. **That is intended — there are no locks right now.** Do not flip the flag, and do not
treat "a bad key was accepted" as a finding. What is worth checking is that the login flow works
and that the endpoint's real verdict is still visible for diagnostics.

| # | Do | Expect | Observed |
|---|---|---|---|
| G1 | Fresh profile, first open | Login view; the version line reads the build version | |
| G2 | Enter a well-formed key | Accepted; the panel proceeds to Waiting/Live | |
| G3 | Engine view → licence block | Shows `status: valid` **and** the endpoint's real `rawStatus` — confirm `rawStatus` is not being masked by the force-valid path | |
| G4 | Go offline and reopen the panel | The last stored verdict is kept; a network error never changes the state (H.12) | |

---

## H. Update flow (§12.2)

| # | Do | Expect | Observed |
|---|---|---|---|
| H1 | In the SW console: `chrome.storage.local.set({ "sl::update-version": "2.1.0", "sl::update-available": true })` | With no game live, the panel raises the Update view reading "sliced 2.1.0 is ready" | |
| H2 | Click **Later** | Returns to the previous view, leaves the info banner, and never re-interrupts | |
| H3 | Set the flag while a game is live | The interrupt is deferred; only the banner shows; it appears after the game ends | |
| H4 | Click **Restart and update** | The extension reloads (`chrome.runtime.reload()`); the panel reconnects. Confirm a live game is not disrupted beyond the reload | |
| H5 | Set `sl::update-available` to `false` | Interrupt and banner both disappear | |
| H6 | Let the licence alarm fire with the site reachable (or call `checkForUpdate()` from the SW console) | Version compared against the site's `manifest.json`; the flag matches reality; the value is written **only** when it changes | |
| H7 | Watch the SW console across H6 | **No `update-check: could not read the published manifest` warning.** If one appears, read its `reason`: `network` (usually CORS — check `host_permissions` covers `https://sliced.sh/*`), `http-status` (the path 404s), `not-json`, or `no-version` (the site is serving a PWA web-app manifest at `/manifest.json`, not the extension's). Each of these makes the check silently mean "no update" forever, which is why it warns | |

---

## I. Panel layout — visual QA against Appendix F (Task 29)

Drag the side panel's edge to each width and resize the window to each height, and compare every
view against the wireframes in Appendix F §4 and the breakpoint rules in §8.1/§8.2. **No CSS was
adjusted for this pass** — the layout has never been seen in a browser, so treat this as
discovery. Screenshot each cell into `docs/qa/2026-09-panel/<view>-<width>x<height>.png`.

### I1. Width breakpoints (Appendix F §8.1)

At each width, check every view: Login, Not-supported, Waiting, Live (idle / armed+counting),
Settings, Engine, Update, Expired.

| Width | Rules to verify | Observed |
|---|---|---|
| **320** (compact) | Wordmark hidden, mark only. View switch icons only. Eval numeral inline in the opponent row at `numeral-md`; WDL in a tooltip. Ratings hidden. Move card `move-sm`, padding `space.3`, ring in the plan line. Play button `control.md`, label "Play". PV max 2, depth column hidden. Toggles icon-only. Session strip hidden. Settings rows wrap the label above the control past 16ch. | |
| **360** (standard) | Wordmark shown. View switch icons only. Eval numeral `numeral-lg` on its own row with WDL. Move card `move-lg`. PV up to the setting (max 5), depth column hidden. Toggles icon + label. Session strip shown. | |
| **420** (comfortable) | View switch shows labels. Ratings shown. PV depth column shown. Move card SAN and from→to on one baseline with `space.6` gap. Settings rows keep label and control on one line. Popovers ≤ 400px. | |
| **480** (capped) | Content column capped at 480px and centred; extra space goes to margins; nothing scales further. | |

At **every** width: no horizontal scrolling anywhere; hit targets ≥ 44 px in Live; ≥ 8 px between
adjacent targets; nothing clipped or overlapping; the focus ring is never cut by an overflow
container (check the PV list and the engine log).

### I2. Height rules (Appendix F §8.2)

Live view, armed and counting, at 360 wide:

| Height | Expect | Observed |
|---|---|---|
| **720** | The whole Live view fits with **no scrolling** (the §8.2 budget totals 656 px) | |
| **600** | Collapses in order until it fits: (1) session strip hidden, (2) PV rows 3 → 2 → 1, (3) WDL folds into the eval tooltip and the numeral drops to `numeral-md` inline. Record which collapses fired | |
| **480** | Further collapses: (4) strength card becomes a one-line chip in the toggles row, (5) move card `move-sm` with the plan merged into the button label. Below 480 available height the view scrolls with the move card scroll-pinned at the top | |

Each collapse must be a discrete state — drag the edge slowly and confirm the layout does not
scale fluidly or flicker between two states at one size.

### I3. Web Interface Guidelines review

Run the `web-design-guidelines` review over `pages/panel.html` + `css/` and record the findings
here. Fix only what is genuinely wrong; do not restyle against Appendix F.

### I4. Deviations found

List every place the rendering differs from the wireframe, with the screenshot name. Fixes are
**CSS only** — a layout deviation is not licence to change behaviour.

---

## J. Multi-window and multi-tab

| # | Do | Expect | Observed |
|---|---|---|---|
| J1 | Two Chrome windows, a game in each, panel open in both | Each panel shows *its own* window's game. A background window's panel may briefly show the last-focused window's game until its hello round trip lands (a few ms) — anything longer or sticky is a finding | |
| J2 | Two tabs in one window, a game in each; switch between them | The panel follows the active tab; sessions do not cross-talk; auto-play stays armed only on the tab it was armed on | |
| J3 | Arm on tab A, switch to tab B, come back | Still armed on A, not on B; the debugger is attached only to A | |
| J4 | Close the window holding the panel while a game runs | The session tears down; the SW logs no unhandled rejection | |

---

## K. Accessibility, keyboard and motion (Task 27)

Automated coverage (`test/panel/a11y.test.ts`): SAN → speech, accessible names on every
interactive element, tab order per Appendix F §8.3, `Esc` priority, live-region debounce, theme
and reduced-motion attributes, fonts within budget, §8.4 CSS blocks. The checks below need a
person, a screen reader and the OS settings.

### Screen reader run-through (VoiceOver on macOS, NVDA on Windows)

- [ ] Login: the license field announces "License key", its hint, and the error copy after a
      bad key; the Continue button announces its label and busy state ("Checking key…").
- [ ] Waiting: the status pill reads as a status ("Idle" / "Thinking · d18"); the Watching line
      is not announced repeatedly while the position polls.
- [ ] Live: the move card's live region announces "Recommended: knight f3, g1 to f3" exactly
      once per new recommendation — never on every eval tick.
- [ ] Live: arming auto-play announces "Auto-play on"; the play button's name becomes
      "Auto-playing knight f3 in 4 seconds. Activate to cancel." and updates per whole second,
      not per tenth.
- [ ] Live: the eval bar reads "White +1.34, 71% win, 22% draw, 7% loss" (or "Mate in 5 for
      Black"); the clocks are announced as time, not as digits.
- [ ] Settings: every toggle is a switch with a checked state; the auto-play toggle is described
      by the hold hint; sliders read their `aria-valuetext` ("Club 1200"), not the raw number.
- [ ] Settings › Keybinds: pressing a capture button says "Press a key…"; a conflict reads the
      conflict copy; Esc cancels and the row announces the previous value.
- [ ] Engine: the log is a list; "Clear log" confirms; the restart button announces its result.
- [ ] Banners are announced as status; warn/danger toasts as alerts; success toasts do not
      interrupt.
- [ ] Nothing in the panel moves focus by itself: opening the panel, a view change, a banner, a
      toast or an engine restart never steals focus from the board tab. (Popovers only trap Tab
      while open and return nothing on close.)

### Keyboard-only

- [ ] Tab order in every view: top bar (view switch, then the status pill if focusable) →
      banner action → content top-to-bottom → toast action. No element is skipped or visited
      twice; no positive `tabindex` anywhere (`tabSequence` in `a11y.ts` is the reference).
- [ ] `Alt+1/2/3` switch Game / Settings / Engine from anywhere in the panel; they do nothing
      while a game is live (hands-off) and on the login view.
- [ ] Arming with the keyboard: Tab to the auto-play toggle, hold Space for ~600 ms — the fill
      grows, release before the hold completes cancels (tooltip once per session); a full hold
      arms and the label reads "Auto-play on".
- [ ] Cancelling a countdown: with the play button armed and counting, `Esc` cancels this move
      (toast "Skipped …"); auto-play stays on. `Esc` in a popover closes the popover; `Esc` in a
      keybind capture cancels the capture — in that priority when two are active at once.
- [ ] Hands-off (game live): Tab skips every control in the content; Enter/Space on a remembered
      element does nothing; the view switch is disabled but still reachable and named.
- [ ] Focus ring: 2px ring at 2px offset visible on every control in both themes; never
      clipped by an overflow container (check the PV list rows and the log).

### Reduced motion (OS setting, and Settings › Display › Reduced motion = On)

Take screenshots of Live (armed, counting), Settings and Engine in both states.

- [ ] No transforms: the SAN hero swaps by crossfade only, the segment indicator jumps, buttons
      do not press-scale, sliders do not lift their thumb.
- [ ] Crossfades run at 200 ms (`duration.2-5`) — never longer.
- [ ] The countdown ring is replaced by the "in 3.1s" text; the spinner is static; the armed
      pulse is a static 32% ring.
- [ ] The setting overrides the OS both ways (`Off` restores motion under an OS "reduce";
      `On` removes it without one); `System` follows the OS live when it changes.

### Forced colours (Windows High Contrast / Chrome `--force-color-profile` + emulation)

DevTools › Rendering › Emulate CSS media feature `forced-colors: active`. Screenshot Live
(armed) and Settings.

- [ ] Eval bar draws in `CanvasText` on `Canvas` with a 1px `CanvasText` divider; it stays
      readable at ±0 and at mate.
- [ ] Armed state is visible without colour: label reads "Auto-play on" and the track and the
      play button carry a 2px `Highlight` outline.
- [ ] Brand fills (primary buttons, checked toggles, slider fill, chips) become `ButtonFace`
      with `ButtonText`; every button, chip, pill, input, toast, popover and banner has a
      `CanvasText` border.
- [ ] Focus ring is a 2px `Highlight` outline.

### More contrast (`prefers-contrast: more`; DevTools emulation)

- [ ] Secondary text lifts to `charcoal.300`; subtle and default borders draw as
      `border-strong`; ghost buttons, keybind chips and inputs gain the strong border.

### Theme

- [ ] Dark, Light and System each apply immediately from Settings › Display; System follows the
      OS live. `color-scheme` matches (native scrollbars and form controls flip with it).
- [ ] Fonts: Geist for UI text, Bricolage Grotesque for the SAN hero / eval numerals / clocks,
      Geist Mono for PV lines and the log — no fallback flash after first paint (`font-display:
      swap` on a packaged font is instant); tabular numerals in clocks and evals do not jitter.
- [ ] Panel widths 320 / 360 / 420 / 480 px: no horizontal scroll, hit targets stay ≥ 44 px in
      Live, ≥ 8 px between adjacent targets. (Section I covers this in detail.)

---

## L. Known gaps — record, do not report as new bugs

These are real, known, and deliberately not fixed in this pass. Confirm the symptom matches the
description; if it differs, *that* is the finding.

**L1 — the master toggle does not stop anything. This is a known *bug*, not a gap.** The
Settings row's own copy promises "Off stops analysis and recommendations until you turn it back
on", and that is currently false. `Settings.enabled` is written by
`src/service/handlers/settings/set-enabled.ts` and carried in the panel snapshot, but the only
consumer is `moveCardState()` in `src/panel/views/live/move-section.ts`, which greys the move
card. Nothing in `src/service/**` reads it, so with the toggle **off** the extension still
analyses, still recommends, still highlights and — if armed — still plays. Being fixed
separately; the gate belongs in the SW session (`src/service/game-session/**`).

**L2 — the Network control is inert.** `Settings.engine.nnue` (`small` | `big` | `auto`, default
`auto`) is read only by the Settings view to render its control. `EngineController` never passes
it on, so the running variant is always the bundled smallnet and the full build's on-demand nets
are never requested. The wiring belongs in `src/service/engine-controller.ts`'s configure path.

**L3 — `bun run dev` does not watch.** `--watch` is parsed but there is no watch loop; it is one
build. Re-run `bun run build --dev` and reload the extension.

**L4 — the release zip is ~63 MB.** Three 18 MB ChessMimic bands plus a 16 MB engine. Fine for
zip + unpacked distribution; it would not fit the Chrome Web Store, which §12.2 does not use.

**L5 — a data: URL export.** The Engine view's timing-log export opens a
`data:application/json` URL in a new tab. Confirm Chrome actually renders it rather than blocking
the navigation — if it is blocked, the export needs a different delivery.

---

## Results log

| Date | Chrome | OS | Machine | Build (`version_name`) | Sections run | Findings |
|---|---|---|---|---|---|---|
| | | | | | | |
