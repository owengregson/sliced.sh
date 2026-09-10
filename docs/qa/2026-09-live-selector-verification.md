# Live selector verification — 2026-09-09, real Chrome via devtools MCP

Method: navigated a live Chrome to each site and ran `document.querySelectorAll` for every
entry of every selector ladder in `src/content/adapters/selectors.ts`, then dumped the real
class strings / style attributes to check the regexes.

> **Historical record.** lichess support was removed after this pass (chess.com is the only
> supported site), so the lichess section below no longer describes any shipped selector. It is
> kept verbatim as the dated evidence of what was verified on the day.

## lichess.org — https://lichess.org/tv (live game, round app)
| selector | result |
|---|---|
| `.round__app .cg-wrap` | 1 ✅ (first ladder entry) |
| `cg-board` / `cg-container` | 3 each (page has mini-boards; round app resolved via the wrap ladder) |
| `svg.cg-shapes` | 1 ✅ |
| `.rclock` / `.rclock-top` / `.rclock-bottom` / `.time` | 2 / 1 / 1 / 2 ✅ |
| `.ruser-top` / `.ruser-bottom` | 1 / 1 ✅ |
| `square.last-move` | 6 ✅ |
| `coords.files` | 1 ✅ |
| moves ladder `aPp` | **1 ✅ first entry hits** |
| move ladder `Z7yx` | **28 ✅ first entry hits** |
| index ladder `qZM` | **14 ✅ first entry** |
| active ladder `.a1t` | **1 ✅ first entry** |
| `#promotion-choice` | 0 — only exists mid-promotion (state not reachable) |
| `.result-wrap`, `.rcontrols .follow-up`, `.ricons` | 0 — game live / TV has no controls |

Real values: wrap classes `cg-wrap orientation-black manipulable` (orientationBlack ✅
manipulable ✅); piece `black rook` + `transform: translate(476px, 476px)` matches
`translateRe` ✅; `main` class `round tv-single` contains `round` ✅.

**The obfuscated lila tag ladder is currently correct in its FIRST position** — the rotation
the ladder exists to survive has not happened since the research pass.

## chess.com
### https://www.chess.com/play/computer (fresh game, no moves)
`wc-chess-board` 1, id `board-play-computer` ✅ (second ladder entry, exact);
`.piece` 32 with classes `piece br square-88` — matches `pieceCodeRe` (`br`) and
`squareRe` (`square-88`) ✅; `.hover-square` 1 ✅;
`svg.coordinates text.coordinate-light` 8 ✅; `div.element-pool` **3 — the pooled-piece
hazard the ledger flagged is real and present** ✅.
Move list 0/6 and `.highlight` 0 — no moves played yet, so not rendered.

### https://www.chess.com/games/view/92716 (archived game with 43 plies)
| selector | result |
|---|---|
| `wc-simple-move-list` | **1 ✅ first ladder entry** |
| `.main-line-row` | 23 ✅ |
| `.node.main-line-ply` | **43 ✅ first entry** |
| `.node-highlight-content` | 43 ✅ |
| `.node-highlight-content.selected` | 1 ✅ |
| `.highlight` | 2 ✅ (last move) |
Real node classes: `node white-move main-line-ply`, text `e4`; row
`main-line-row move-list-row light-row` with two `.node` children ✅.

## Verdict
Every board, piece, coordinate, clock, player and move-list selector on both sites resolves,
with the first ladder entry hitting in every case. No selector needs deriving.

## Still unverified (needs a game state I could not reach read-only)
- lichess `#promotion-choice` + `square` order; `.result-wrap`/`.status`; `.rcontrols`
  follow-up / rematch / new-opponent; keyboard input.
- chess.com promotion picker order, game-over modal, new-game controls.
- Anything requiring the extension to be installed and armed.
