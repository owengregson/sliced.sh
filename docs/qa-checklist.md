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
   - The card must read **sliced.sh (dev)**, version `2.0.0`, `version_name` `2.0.0-dev+…`.
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
| A6 | `bun run build` (release), load *that* `dist/` unpacked in a second profile | Card reads **sliced.sh** (no `(dev)`, no `version_name`); everything above still holds | |
| A7 | On a chess.com tab's page console, run `fetch("chrome-extension://" + "<the extension id from chrome://extensions>" + "/assets/sounds/make_move.wav")` | **Rejects.** v2 declares no `web_accessible_resources`, so a page cannot confirm the extension is installed (§13.3). A success here is a critical finding | |
| A8 | Same, with the engine: `.../assets/engine/sf_18_smallnet_relaxed-simd.wasm` | Rejects, same reason | |

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
| B0.8 | **Armed**, against a bot on `/play/computer` and then on a live game: watch the two marked squares for the whole of one move the hand plays — the approach, any touch of another piece, the press, the drag, the release | The mark is there the whole way and disappears only once the piece has landed (the owner's report of 2026-09-10 was that it went at the *start* of the action). Both renderers | |
| B0.9 | During B0.8, page console: `document.querySelectorAll("wc-chess-board > svg").length` while the hand is acting | `1` — the mark of the move being played is drawn through the bridge's own overlay `<svg>`, not through `game.markings`, precisely so the site's own press cannot remove it. **`0` on the live canvas board is the finding to record**: the overlay does not render there and the mark falls back to the pre-fix behaviour (it vanishes at the first press). Nothing else regresses | |
| B0.10 | During B0.8 **as black** | The two squares are the recommended move's, not their 180° mirror. The overlay draws from screen coordinates, so this is the row that proves the orientation reaches it | |
| B0.11 | Service-worker console during B0.8 on `/play/computer` | Zero or more `position ignored — our own hand is mid-move on this ply` lines, and **no** `move did not land` with `reason: "aborted"` while the hand was mid-drag. A lifted `.piece` used to republish the position, cancel the move and erase the mark; record whether the line appears at all (it says whether chess.com marks the drag with `.piece.dragging`) | |
| B0.12 | A move that needs a **retry**: watch the squares through both attempts (easiest to provoke with the promotion gap, B0.7, or by bumping the board as the hand presses) | The mark is there for the whole of the second attempt too, and disappears when the executor finally gives up — not between the attempts. The verifier no longer clears, so this is the path the owner's symptom used to survive on | |
| B0.13 | An attempt that fails for good (again, B0.7 is the reliable one) | The two squares clear as soon as the panel stops saying the hand is moving. A mark left behind here is now our own `<svg>`, which nothing on the page will ever wipe for us | |

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
| B5.6 | Watch the motion during a drag with the naked eye first, then record `performance.now()` gaps between `cursorTo` arrivals in the page (temporarily, in a dev build) and compare them against the hand's own dispatch gaps in the service-worker log | **Judge the glide, not a threshold.** Visible stepping or stalling during a drag — not merely uneven numbers — is what would justify the reference's rAF smoothing. The hand itself dispatches at p50 ~7 ms / p90 ~25-33 ms with a tail of hundreds of ms at its deliberate pauses (measured offline, ten runs), so gaps in the tens of ms are the *hand*, not the port: only arrival gaps materially **larger than** the dispatch gaps for the same move indicate a transport problem. Record both series | |
| B5.7 | `Shift+X`, turn the assistant off, turn **Settings › Display › Show the hand's pointer** off, close the tab | The arrow disappears and `document.querySelector` finds no leftover element in each case (2026-09-13: these are the only hide reasons; all covered offline in `test/behavioral/game/virtual-cursor.test.ts`). This row is the confirmation that the page really does drop the node | |
| B5.7b | Disarm, let a game end, let the auto-queue click New Game, navigate to the next game | The arrow **stays** parked where the hand stopped through all four, and the next game's first hand movement starts from it (no jump). While it is up the real mouse stays blocked (`docs/qa/pointer-ownership.md`); `Shift+X` or the switch gives it back | |
| B5.8 | Click **Cancel** on the debugger infobar while the arrow is parked between moves | The arrow **stays** (2026-09-13). §13.4 forbids the mid-game re-attach, so the hand owns no pointer for the rest of this game; the next game re-arms from the parked point | |
| B5.9 | With the mirror on screen, inspect `document.documentElement.children`, record the element's `z-index` and the rate of `style` mutation records (`new MutationObserver(r => console.log(r.length)).observe(el, {attributes: true})`), and watch the site's own network payloads | Record whether anything the site sends changes. The element is a direct child of `<html>` (after `<body>`) with a per-build class, no `id`, no `data-*` and no listeners — but it *is* an extra DOM node with `z-index: 2147483647` that changes its `style` attribute ~45×/s while the hand plays (§13.3 residual; the report's Fix-round §m3/m6 defence is what this row tests) | |
| B5.11 | Let each of the site's popups appear while the arrow is up: the game-over modal, the play menu, a toast, the resign confirmation | The arrow paints **over** each of them. If one still covers it, run `document.querySelector("dialog[open], [popover]:popover-open")` — a hit means that popup is in the top layer, which no `z-index` reaches (`docs/qa/virtual-cursor-2026-09-13.md`); record which | |
| B5.10 | Arm, play a move so the arrow is up, then force the service worker to restart (`chrome://serviceworker-internals` → Stop, or leave the tab idle past the worker's eviction) and press `Shift+X` | The arrow disappears. The worker that wakes has never drawn anything, and the hide is posted unconditionally for exactly this case — covered offline, but this is the real eviction | |

---

### B6. Board effects and the move-quality chip (`docs/qa/board-effects-2026-09-13.md`) — **answerable only in a browser**

The effect layer is a second `<svg>` on the board host, one `z-index` above the recommendation
mark. Everything about the *batch* is covered offline (`test/behavioral/game/board-effects.test.ts`)
and everything about the *element* in happy-dom (`test/page/effects-overlay.test.ts`). What no
simulator can answer is whether it renders on the live WebGL canvas board at all, whether the
geometry lands on the right squares, whether the chip is legible, and how often the verdict search
reaches a usable depth in a real game.

| # | Do | Expect | Observed |
|---|---|---|---|
| B6.1 | Settings › Display: confirm **Board effects** sits directly beneath **Highlight moves** and ships on. Turn it off, play a move, turn it on | Nothing is drawn while it is off; whatever was drawn disappears on the flip. Turning it on draws from the *next* move, not retroactively | |
| B6.2 | Live game (`/play/online`, WebGL board). Let the opponent capture, check or fork | The rays appear on the board over the canvas, red-toned. If nothing appears, check `document.querySelector("wc-chess-board > svg")` — a hit with nothing visible means the canvas paints over it (a finding) | |
| B6.3 | Same on `/play/computer` (DOM renderer) | Identical rays. A difference between the two renderers is a finding | |
| B6.4 | Make a move yourself; compare its rays with the opponent's | Ours are blue (`effect.mine`, #3B82F6 family), theirs red (`effect.theirs`, #EF4444 family). Both are drawn; the chip's disc keeps its own category colour | |
| B6.5 | Play through a castle, a promotion, an en-passant capture and a discovered check | Each draws its own shape: two slide traces, a ray onto the captured pawn's real square, a dashed ray from the *checker* rather than from the piece that moved. The promotion itself draws nothing (its pulses were the rings the owner removed); any other effect the promoting move produced still draws | |
| B6.6 | Watch a fork (a knight hitting two pieces) | The rays fan out one after another, not all at once | |
| B6.7 | Record the ray endpoints against the squares they name (screenshot, or read the `<path d>` and compare with the board rect) | Each ray starts and ends inside the squares it names. A constant offset means the overlay's 8×8 viewBox and the host element disagree — the same assumption the recommendation mark makes | |
| B6.8 | Watch the bottom-left of the destination square after each move, on a large board and then with the side panel widened so the board is small | The chip (0.345 board units, 0.8 opacity) scales in, holds ~1.2 s and fades. Record whether the glyph is still readable on the small board and whether it collides with chess.com's rank/file labels on `a`-file and rank-1 squares | |
| B6.9 | Play a full blitz game with Engine view › Log at `debug` and count: moves played vs chips shown, **per side** | Both sides should chip on nearly every move: ours from the referee lines during the think time, theirs from the ponder lines plus our own-move search, neither needing a search of its own. Every move without a chip has a `board effects: no chip for the landed move` line with a `reason`; record the reasons per side. A run of `superseded` or `shallow` is a finding; `unscored` on the opponent's moves after a fast reply or a hold is the known gap | |
| B6.15 | Play a fast exchange (bullet or premoves): three or four moves inside ~2 s | Every move's rays and chip run their full life; a new move never cuts the previous one short. Several chips may be on the board at once (at most `maxLiveChips` = 4; a recapture on the same square replaces that square's chip). Record whether the stacking reads as a burst or as clutter | |
| B6.16 | Watch a capture, a check and a threat side by side | The capture is a diagonal pill sweeping across the *taken* piece's square (no line from the origin), entering from the mover's side. The check and threat are thicker pill-shaped rays whose base fades in and whose arrowhead fades to its point; no hard end on either. **No rings or pulses anywhere** — a circle expanding from a square is a finding (they were removed on 2026-09-13) | |
| B6.17 | Let a move produce rays (a capture, a check, a fork) and wait for its chip | The chip appears beside the rays on the destination square — for our own moves in the same instant as the rays, for the opponent's a moment later — and neither disturbs the other. A move with rays and no chip, where a quiet move chips, is a finding | |
| B6.18 | Play a move whose recommendation you then override by hand (arm nothing, move a different piece than the arrow shows) | The chip is for the move you played and sits on its destination; nothing is drawn for the planned move. A chip on the arrow's square is a finding | |
| B6.19 | Bullet or blitz with autoplay armed and chess.com premoves on: wait for the log's `entering a premove on the site`, then let the opponent play the predicted reply | Two batches in the same instant — their move's rays (red), then our premove's (blue) — and a chip for each. For a recapture both chips land on the same square and ours replaces theirs. A fired premove with rays and no chip is a finding; look for `no chip for the landed move` and its reason | |
| B6.20 | Autoplay **off** (panel-only mode), play a few moves by hand | Our chips still appear — at landing, from the panel ponder's lines, since the referee search at a limited Elo cannot be classified before landing and the panel ponder supersedes the fallback. A move by hand with no chip and no logged reason is a finding | |
| B6.10 | Watch the categories over a whole game | Record which fire. Blunder / Mistake / Inaccuracy / Good / Excellent / Best should all appear; Book early; Great and Brilliant rarely. A category that never fires, or Brilliant firing on ordinary moves, is a calibration finding | |
| B6.11 | Arm and let the hand play with effects on. Compare move timing against a game with effects off (the Engine view's log has the think times) | No visible delay to our own moves. In the common case the lane adds no search at all; the dedicated fallback runs only from `prepare()` during the think time, and the landing-time cache probe is free on a hit. The claim it cannot delay a move rests on the engine queue's supersede rule | |
| B6.12 | Turn the OS reduced-motion setting on and play a few moves | The rays are drawn statically and stay until the next move replaces them; the chip appears without the scale-in. Judge whether a static ray set through a whole opponent turn is wanted | |
| B6.13 | With the assistant armed and a recommendation marked, let the opponent move | The mark and the effect layer coexist; the effects sit above the mark and neither clear erases the other | |
| B6.14 | End a game, start a new one, `Shift+X`, navigate away | The effect layer disappears in each case and `document.querySelector("wc-chess-board > svg")` finds no leftover beyond the recommendation mark's | |

### B7. Session-side Maia: pre-inference, the per-game size, the repertoire and the fast moves (`docs/qa/session-maia-2026-09-13.md`) — **answerable only in a browser**

Everything about the *decision* is covered on the simulator (`test/service/game-session/session-maia.test.ts`,
`maia-session.test.ts`, `repertoire.test.ts`). What no simulator can answer is how often the
pre-inference actually lands before the reply on real hardware, whether the offscreen document
keeps up with one extra query per opponent turn, and whether the repertoire survives the worker's
restarts. Engine view › Log at `debug`; the Human-model block is the display.

| # | Do | Expect | Observed |
|---|---|---|---|
| B7.1 | Blitz game, target 1200, autoplay on. Watch the log on each opponent turn | One `game-session: pre-inferred the predicted position` per opponent turn with `reply`, `size 5m`, `selfElo` and `historyPlies`. Record how many opponent turns produce one (the ponder must settle first — at rapid there is no harvest and no pre-inference; that is by design) | |
| B7.2 | Same game: count opponent replies that matched the prediction vs those that did not (the `reply` in B7.1 against the move that came) | Record the hit rate. On a hit the own-move query is answered from the pre-inference (no second Maia query in the log for that ply); on a miss the Human-model block still shows an answer, from the fresh query | |
| B7.3 | Human-model block during play | History reads `8/8 plies` from ply 8 on; the "History unavailable" line never appears on a live WebGL board once the move list exists. If it appears mid-game, note the ply — the move list was unreadable there (CLAUDE.md's "no move list until the first move" case) | |
| B7.4 | Entropy / railed / unscored / KL / rank rows | Present on every move Maia drew (`source: maia`), hidden on a book move, a premove or an engine-policy fallback. KL is `0.000` on a move where no rail fired; railed mass is non-zero exactly when the rationale says `maia never-play: … excluded` | |
| B7.5 | Settings › Strength: match opponent rating on, target 1200. Play against an opponent rated 2100+ | The block's size stays the one the game started with (`Maia-3 · 5M` if the rating arrived after the first move; `79M` if it arrived before). The log shows no re-warm mid-game. Change the target by hand mid-game: one re-warm, the new size from the next move | |
| B7.6 | Play white twice from the same start (two games, same profile) | The book's first move is the same both games; the rationale in the log reads `polyglot … · repertoire`. Play black twice against 1.e4: same reply. Reload the extension between the games — the repertoire persists (`chrome.storage.local["sl::repertoire"]`) | |
| B7.7 | Remove `sl::repertoire` in DevTools › Application › Storage, play again | A new pair is created (`repertoire: created the opening repertoire keys`) and the first move may differ | |
| B7.8 | Bullet or a blitz scramble with autoplay on: let the hand hold a piece (the log says `holding the piece over its square`) | When a pre-inference had landed for the predicted position, the released move's rationale reads `ready move: a Maia draw over the pre-analysed lines`; otherwise the old `chosen for a hold` line. Record the share | |
| B7.9 | Bullet, a recapture premove situation (the log says `premove armed`) | Occasionally `premove dropped — the human model would not play it here` follows the pre-inference, and no premove is entered for that turn; the fast reply still plays after the real reply. A premove already `entering … on the site` is never retracted | |
| B7.10 | Offscreen document memory (Task Manager) over a 20-move blitz game | One extra inference per opponent turn: no growth beyond the size's resident set, no `maia query failed` in the log. If the 79M size is committed (target ≥ 2000) note the p95 of the pre-inference `ms` against the opponent's think time | |

### B8. The lobby hold (`docs/qa/lobby-hold-2026-09-13.md`) — **answerable only in a browser**

`/play/online` shows a board with still clocks before any game is queued, and the page calls it
`playing`. The session now withholds the hand there until a clock ticks, a move lands, an opponent
rating is read or the URL moves on to a game id. The simulator covers the wiring; what it cannot
see is what the real lobby page reports. Engine view › Log at `info`; auto-move **on** in Settings.

| # | Do | Expect | Observed |
|---|---|---|---|
| B8.1 | Open `https://www.chess.com/play/online` in a tab with auto-move on, side panel open, and do nothing for 5 s | Your real mouse works on the page (no shield, no arrow); the Live view's eyebrow reads `Lobby · no game queued`; the log shows `lobby suspected — the hand stays off the mouse` then `lobby confirmed — the clocks have not moved`. **A finding:** an `opponent` message with a numeric `ratingEstimate` on the lobby (the hold never engages), or a `lobby over` line with no game — record the top player card's text and whether the bottom clock carries `clock-player-turn` | |
| B8.2 | Click **Play** with your own mouse and let a game be found | Record the URL at the moment the game starts (`/game/<id>` at once, or `/play/online` for a while). The log shows `lobby over — a game is on the board` with its `reason` (`hello` / `gameStarted` / `an opponent was read` / `a clock reading`), then `executor: armed`; the arrow appears and the shield goes up only now | |
| B8.3 | Same as B8.2, playing **white** | The first move plays. If the log shows the hold still on after the game started (no `lobby over`), record whether the URL was rewritten and whether the opponent's rating rendered — those are the two releases that do not need a clock tick before white's first move | |
| B8.4 | While on the lobby in B8.1, look at the infobar | The "… is debugging this browser" bar is already up (the attach happened on the lobby, outside any move window); after the game starts no second layout shift lands in the first move window. Stay on the lobby > 3 min and note the idle detach, then start a game: the re-attach's shift is at ply 0, before your first move | |
| B8.5 | On the lobby, press Shift+A (auto-move **off** in Settings) | Nothing locks the mouse; the log reads `arm deferred — this is the lobby`; once a game starts the hand arms on its own. The toggle showing "off" until then is the known follow-up | |
| B8.6 | On the lobby, change the time control in the selector (3 min → 5 min) | The clocks jump to 5:00 / 5:00 and the hold stays on (no `lobby over`, no arm); a game on 5 min then releases it as in B8.2 | |
| B8.7 | Open a game link directly (`/game/<id>`) as **black** and wait, before white moves | No hold: the hand arms at once as before (this URL is "no other url"). The eyebrow reads `Live` | |

### B9. Rematching titled players (`docs/qa/rematch-titled-2026-09-13.md`) — **answerable only in a browser**

After a game against a titled opponent the auto-queue offers one rematch (or accepts theirs)
before it queues a regular game; an offer not taken within 15 s is withdrawn and the ordinary
new-game click follows. The simulator covers the flow against the owner's captured markup; what
it cannot see is what the real game-over panel does after our Rematch click, when the incoming
panel appears, and where an accepted rematch takes the tab. Auto-queue **on**, "Rematch titled
players" **on** (Settings › Execution), Engine view › Log at `info`.

| # | Do | Expect | Observed |
|---|---|---|---|
| B9.1 | Play (or lose quickly) against a titled player — one whose card shows `FM` / `NM` / `CM` / `GM` — and let the game end | The waiting view names the opponent; the log shows `auto-queue: scheduled` with `rematch: "<username>"`. After 0.9–2.6 s the arrow walks to **Rematch** and presses it (`rematch: offer sent { action: "rematch" }`); the status reads `Rematch offered · queueing in 14s` counting down. **A finding:** a titled card whose title was not read (`opponent` in the log without `title`) — record the card's exact markup | |
| B9.2 | In B9.1, have the opponent accept within 15 s | The rematch game starts on the same tab (`gameStarted` with a new `/game/<id>`); no new-game click; the log shows `auto-queue: rematch step finished { outcome: "started" }`. **Record the URL** at the moment the rematch starts — whether the game id changed on this tab (the wait ends on a new id; a rematch that keeps the id or opens elsewhere would expire at 15 s and is the open item) | |
| B9.3 | In B9.1, let the offer sit untaken | At 15 s the log shows `rematch: not taken in time { withdrawn: true / false }`. **Record what the game-over buttons show after the Rematch press** (a "Cancel" button? its `aria-label`, class, container) — the cancel markup was not captured; with `withdrawn: false` and `content: no rematch control found for this action { action: "cancel" }` the new-game click simply navigates away. Either way the new-game click follows *immediately* (no second delay) and matchmaking starts | |
| B9.4 | Have a titled opponent send **their** rematch first (before or during the queue delay) | `Good game! Rematch?` replaces the two buttons; the arrow presses **Accept** (never Rematch, never Decline); the log shows `offer sent { action: "accept" }`. **Record whether the panel can appear before the game-over modal / before the result is shown** (the step reads it every second from the game's end) | |
| B9.5 | Play the same titled opponent a second time in the same playing session (after B9.2) | No second offer and no `rematch` read: the ordinary new-game click at the ordinary delay. Reload the extension between the two games: still no second offer (the mark is persisted with the queue session) | |
| B9.6 | Have an **untitled** opponent send a rematch | Nothing is pressed on the panel; the status shows `Retrying…` while the panel hides the new-game button, then the ordinary new-game click once the panel goes | |
| B9.7 | With a 1-minute session and a 1-minute break configured, end a game against a titled opponent after the session expired | The rematch step runs first (status `Next game in …` then `Rematch offered …`, the mouse **not** released); if the rematch starts, the break follows *that* game (`Session break · …` on its end, a freshly sampled length); if the offer lapses, the break starts at 15 s and the mouse is released then (`session break — the mouse is released`) | |
| B9.8 | Turn "Rematch titled players" off and repeat B9.1 | No offer, no `rematch` read; the ordinary queue as before | |

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
| 10r | **Move one after a refocus** (the owner's 2026-09-10 ruling). Use a **rapid or classical** game so the first move's think window is seconds, not milliseconds. Arm from the waiting view, then click into the **side panel** and stay there while the game starts, so the first position arrives with the page unfocused. **Before clicking back in, check the panel's telemetry pill: it must *not* say "blur seen"** — if it does, the window saw a blur and a pass here means nothing. Then click once into the board. | The first move is played shortly after the click. Then Settings → Advanced → **Export timing log** and read `telemetry.ac` on move one's entry: expect `DidFocusOnOwnTurn` set, **`DidToggle` clear, `BlurCount` 0**, and a `LastFocusToMoveTime` that is **not** the same value every game. Move one's recorded think (`plannedMs`) will be as long as you were away — that is the re-plan making the record truthful, capped at the clock the move started with; it is not the interval you waited after clicking | | | |
| 10r′ | Same time control, but click the side panel **during** the first move's think window, then click back into the board. As white at ply 0 nothing else is coming, so after the check play the move by hand to continue (or abort the game) | The move is **not** played; it waits for the next position (§13.4 unchanged). If it plays, the blur guard has failed — that is a regression, not a ruling | | | |

**Row 6r matters twice.** The event side is asserted by the simulator; what is unknown is
whether the infobar's appearance disturbs page focus at all, and how much it shifts the layout.
If the board itself moves, confirm the executor's geometry is re-read after attach — a stale
board rect would put clicks on the wrong squares.

**Then**: update the Results table in `docs/qa/focus-discipline.md` with what you saw. If rows 1
and 2 show that a panel button click does *not* blur the page, §4's decision note explains the
relaxation of hands-off that becomes available — propose it with the probe log as evidence
rather than making it silently.

**Rows 10r / 10r′ are the owner's ruling of 2026-09-10 being checked on a real board** (§4 of
`docs/qa/focus-discipline.md` records the decision and its scope). 10r is "did the first move
finally happen"; 10r′ is the guard that keeps the relaxation to the case he allowed.

**Where to read the numbers.** Not chess.com's own `fps` submission — you cannot see that. Ours:
Settings → Advanced → **Export timing log** writes a JSON file whose entries carry `telemetry.ac`,
the §13.2 shadow of that payload (`advanced.timingLogEnabled` is on by default). Move one's entry is
the one to read, and the fields are `DidFocusOnOwnTurn`, `DidToggle`, `BlurCount` and
`LastFocusToMoveTime`. The panel's telemetry pill is the live read of the blur flag while the game is
running.

**What it looks like if it goes wrong:** a per-move focus count where move one carries `DidToggle` (a
blur *and* a focus inside one window) or `BlurCount ≥ 1`, where a human's first move is typically 0 —
or a `LastFocusToMoveTime` that is identical game after game (a machine interval — nothing in the code
guarantees it varies; the simulator measures 590–1010 ms across seeds, from the hand's motor path, and
the re-plan does **not** change that distribution) — or, on 10r′, a move that plays after the refocus when it should have
waited. Any of those is a withdrawal case, not a tuning case.

**`report.py` will print `[FAIL] zero blur/toggle` for a game that exercised the ruling, and that is
expected.** The band requires `focusFieldsSet == 0` and the released move sets `DidFocusOnOwnTurn`;
the band is deliberately not relaxed, because a carve-out would also hide a focus field on move *two*
— the every-move relaxation the owner declined. The reasoning is recorded beside the check in
`tools/telemetry-conformance/report.py`. One failing game whose only focus field is on move one is
the ruling working. Do not "fix" the band.

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
| D7 | Select Network = `big`, or set target Elo above 3200; repeat after returning to Small | The full engine loads both installed raw networks, reaches ready, and searches without remote NNUE requests or a download-progress bar | |
| D8 | Disable cache storage and network access, then select the full engine | Packaged networks still load. On an older installation missing those assets, separately verify the OPFS/IndexedDB and checksum-verified relay fallback | |
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
- [ ] `Alt+1/2/3` switch Game / Settings / Engine during live play as well as between games;
      they do nothing on the login view.
- [ ] Space requests play-now from each panel view, including a focused non-text control. It
      does not change that control. Text entry and keybind recording retain their normal input.
- [ ] Arming with the keyboard: Tab to the auto-play toggle and hold Enter; release before the
      hold completes cancels, while a completed hold arms the bot.
- [ ] Cancelling a countdown: with the play button armed and counting, `Esc` cancels this move
      (toast "Skipped …"); auto-play stays on. `Esc` in a popover closes the popover; `Esc` in a
      keybind capture cancels the capture — in that priority when two are active at once.
- [ ] During live play, Tab reaches controls normally; click and Enter activate them, Settings
      and Engine remain reachable, and no hands-off banner or blanket disabled state appears.
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

**L2 — resolved: Network selection and full networks.** `EngineController` switches variants
before searching: Big requests full at any Elo; Auto or Small upgrades above the product's
3200 cutoff. Both variants now use packaged networks. Missing assets on older installations
retain the verified cache/download fallback. See D7–D8 and
[`bundled-nnue-2026-09-11.md`](qa/bundled-nnue-2026-09-11.md).

**L3 — `bun run dev` does not watch.** `--watch` is parsed but there is no watch loop; it is one
build. Re-run `bun run build --dev` and reload the extension.

**L4 — the release zip is ~270 MiB.** The Maia-3 79M model, the full Stockfish net, three 18 MB
ChessMimic bands and onnxruntime, all bundled so the product works offline out of the box
(per-asset table in [`qa/package-size-2026-09-13.md`](qa/package-size-2026-09-13.md)). Fine for
zip + unpacked distribution; it would not fit the Chrome Web Store, which §12.2 does not use.

**L5 — a data: URL export.** The Engine view's timing-log export opens a
`data:application/json` URL in a new tab. Confirm Chrome actually renders it rather than blocking
the navigation — if it is blocked, the export needs a different delivery.

---

## Results log

| Date | Chrome | OS | Machine | Build (`version_name`) | Sections run | Findings |
|---|---|---|---|---|---|---|
| | | | | | | |
