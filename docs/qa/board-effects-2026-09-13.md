# Board effects — 2026-09-13

The owner's brief of 2026-09-13: after every move on the board, either side's, show what the move
did as directional animations from the square the piece landed on, and put a chess.com-style
move-quality chip in the bottom-left of that square. One new setting gates the whole thing.

## What was built

### The setting

`Settings.automation.boardEffects`, a boolean directly beneath **Highlight moves** in Settings ›
Display. It ships **on**, following `highlightMoves` (the brief: "default off is fine unless the
code base defaults highlight on, in which case default on"). It is an ordinary visible row — not a
`FORCED_SETTINGS` entry — so `test/panel/views/settings.test.ts`'s "every setting has a row" walk
covers it, and `normalizeSettings` picks it up like every other boolean.

**Superseded 2026-09-15:** `boardEffects` now gates the rays and the capture mark only. The rating
chip has its own gate on the same command (`moveRatings` = `enabled && automation.moveQualityChips`),
and the rating sounds follow that alone, so every combination of the two switches works — see
`docs/qa-checklist.md` B6.26. The rest of this document describes the layer as first built.

The service worker reports it to the content script on the existing `settings` command as
`enabled && automation.boardEffects`, beside `highlightMoves`. §13.3 rule 4 is unchanged: the page
draws nothing until that command arrives, and turning the setting off mid-game erases whatever is
drawn on the next push.

### The three layers

| Layer | Where | What it owns |
|---|---|---|
| Detection | `src/core/chess/board-effects.ts` | Pure chess.js. Given the position before a move and the move, answers the ray list. No engine, no settings, no I/O. |
| Verdict | `src/core/engine/move-quality.ts` | Pure. Given full-strength MultiPV lines for the position before the move (and, when the played move is not among them, its own score), answers one of ten categories. |
| Drawing | `src/page/effects-overlay.ts` | A pagescript AST program (C2), embedded in `chesscom-bridge` and also emitted standalone for the happy-dom test. |

The service worker's `BoardEffectsReporter` (`src/service/game-session/board-effects.ts`) joins
them: `GameSession.onPosition` calls `reportBoardEffects` right after `trackMove`, the effect list
goes out at once, and the verdict goes out with it when it is already known (our own move, see
"Our move is classified before it is played" below) or follows asynchronously otherwise.

## The 2026-09-13 revision (owner's bug report)

Six changes, each with its own section below; the short form:

| # | Report | What changed |
|---|---|---|
| 1 | "multiple ratings/animations should be allowed at once — they clear each other" | Batches no longer replace one another. Every ray group and every chip has its own lifecycle and removes itself; only `clearEffects` wipes the layer; `maxLiveGroups` / `maxLiveChips` cap growth (§ *Lifecycles*). |
| 2 | "sometimes the rating doesn't appear … compute it as soon as we know the move" | `BoardEffectsReporter.prepare()` classifies our planned move the moment the recommendation is final, keyed by (position, move); `report()` finds the verdict ready and ships it inside the first batch. Staleness is "is this still the last move", not a serial (§ *Our move is classified before it is played*). |
| 3 | "a move with another animation never shows its rating" | Rays and chip are drawn from independent bookkeeping (`efLive` / `efChips`, `efMark` / `efChipMark`); a batch with both draws both, and a chip arriving later joins without touching the rays (§ *Lifecycles*). |
| 4 | "chip 25 % smaller, opacity 0.8" | `chipSize` 0.46 → 0.345, new `chipOpacity` 0.8 (§ *The chip*). |
| 5 | "fade the ends of the attacking lines, thicker, pill-shaped" | Widths ×1.6, round caps, a per-ray `userSpaceOnUse` gradient transparent at both ends (§ *Rays are pills*). |
| 6 | "captures: a sweep/slash over the taken piece" | `capture` is a diagonal pill swept across the captured square, no ray from the origin (§ *The capture slash*). |

Four more, later the same day:

| # | Report | What changed |
|---|---|---|
| 7 | "attack highlights should be blue for your attacks and reddish for their attacks" | New `effect.mine` / `effect.mine-strong` / `effect.theirs` / `effect.theirs-strong` tokens on `azure.500` (#3B82F6) and `crimson.500` (#EF4444), soft step at a64, strong step opaque; `EFFECT_COLORS` reads them. The chip keeps its per-category colours (§ *The effect vocabulary*). |
| 8 | "remove the three rings that go out from the center of a piece" | The pulse rings are gone from every kind: the `rings` / `ringWidth` / `ringFrom` / `ringTo` knobs, `ringMs` / `ringStaggerMs` / `ringOpacity` and the page program's `efRing` are deleted. A promotion now draws nothing (§ *Rings removed*). |
| 9 | "move ratings don't show up for premoves (when they finish)" | A queued premove fires in the same instant as the reply, so two plies land in one position and the reporter saw neither: `landedPlies` recovers the reply and both moves are reported, theirs first, each classified against its own position; our premove's lines come from the premove candidate's own search through a cache probe at the session's strength (§ *Two plies in one position*). |
| 10 | "move ratings occasionally don't ever show up for unknown reason" | The verdict is assembled from searches that already ran — the referee lines for our move, the ponder lines plus our own-move search for the opponent's — and the dedicated search is only the fallback, issued from `prepare()` while the engine is idle. A verdict stays deliverable for the last two landed moves, and every landed move that ends without a chip is logged at debug with the reason and counted (§ *Where the evaluation comes from*). |

And two more, still the same day:

| # | Report | What changed |
|---|---|---|
| 11 | "instead of remaking the arrows for the board effects, just reuse the arrows from highlight move (but downscale them)" | The pill rays are gone. `arrowShapeStatements` (`src/page/arrow-shape.ts`) is parameterised — identifier prefix, cell/animate routine names, a build-time `scale`, an optional runtime size argument — and the effect layer emits the recommendation arrow's own silhouette a second time as `efArrow` at `BOARD_EFFECT_GEOMETRY.arrowScale` 0.6, sized per kind by `BOARD_EFFECT_STYLES[kind].scale`. The capture slash is untouched (§ *The arrows are the highlight arrow*). |
| 12 | "make sure the enemy castle/discover lines are also red like the take lines — (and ours are blue)" | The soft a64 step is no longer bound: `EFFECT_COLORS` is `{ mine: effect.mine-strong, theirs: effect.theirs-strong, edge }`, the `strong` knob is gone, and every kind takes its side's one opaque colour (§ *The effect vocabulary*). |

And, later still:

| # | Report | What changed |
|---|---|---|
| 13 | "more pastel, less opacity" and "also, include making them dotted like they were before (a modified version of the highlight move arrow)" | `azure.500` → #8DB4EC and `crimson.500` → #F0A3A3 (pastel), and `EFFECT_COLORS` binds the a48 steps `effect.mine` / `effect.theirs` (`rgb(… / 0.48)`) rather than the opaque `*-strong` ones. The line kinds are dotted again: `arrowShapeStatements` gains a `dotGapRatio` option that gives `efArrow` a `dash` argument, and `BOARD_EFFECT_STYLES[kind].dash` restores the earlier cut's lengths — discovery 0.14, pin 0.09, castle 0.12; threat, fork, check, en passant 0 (§ *The line kinds are dotted*). |
| 14 | "change the take-piece animation (improve it, no longer do a slash — come up with another creative, simple, minimalist animation for when taking pieces)" | The slash, its `efPaint` gradient and the `slashHalfSpan` / `slashWidth` / `slashSegment` / `slashFade` / `slashMs` knobs are gone. The capture is the **seize mark**: a rounded-square outline in the mover's colour that starts at 1.12× the captured square and contracts to 0.86× over 260 ms, fading to transparent as it lands (`BOARD_EFFECT_SEIZE`, § *The seize mark*). Captures stay ray-free. |

### The effect vocabulary

Nine kinds, each with its own visual identity, all directional from the moved piece's destination
to the square it affects. The registry is `src/core/constants/board-effects.ts`; the wire carries
the one-letter code, never the name.

| Kind | Code | Drawing (revision 11: the highlight arrow, at `scale` × `arrowScale`; revision 13: `dash` > 0 = dotted shaft) | Detection |
|---|---|---|---|
| threat | `t` | arrow, `scale` 0.85, solid | the moved piece attacks a non-pawn, non-king enemy piece that is undefended **or** attacked by something cheaper (`cheapThreats`' rule, widened per the brief) |
| fork | `k` | arrow, `scale` 0.95, solid, staggered fan | two or more threats from the destination at once — a check counts as one prong |
| check | `c` | arrow, `scale` 1 (the largest), solid | the moved piece attacks the enemy king |
| discovery | `d` | arrow, `scale` 0.9, dotted (`dash` 0.14) | a slider the move uncovered now hits something (the check case is drawn from the *checker*, not the mover) |
| capture | `x` | the seize mark closing in on the captured square (no arrow from the origin) | the move took a piece |
| pin | `p` | arrow, `scale` 0.8, dotted (`dash` 0.09), two of them | a slider on the destination lines up a front piece and a more valuable piece behind it (pins and skewers alike) |
| castle | `s` | arrow, `scale` 0.8, dotted (`dash` 0.12), ×2 | the king's move and the rook's |
| promotion | `u` | nothing, since revision 8 (its pulses were the rings the owner removed); detected and sent so the vocabulary and the wire stay stable | the move promoted |
| passant | `e` | arrow, `scale` 0.85, solid, onto the pawn's real square | en passant |

Same-kind effects are emitted consecutively, and the overlay staggers a *run* of them by
`BOARD_EFFECT_STYLES[kind].delayMs × runIndex` — which is what turns two or more threats into a fan
rather than a starburst. One ray per pair of squares (a bishop that both threatens and pins the
same knight draws one line, not two), and the batch is capped at `BOARD_EFFECT_LIMITS.maxEffects`
(10), with sub-caps of 4 threats, 2 discoveries and 2 pin chains.

Colours come from `TOKENS` through `EFFECT_COLORS` in `src/page/index.ts` — never a literal in the
pagescript. Revision 7: the owner's moves are **blue** (`azure.500`) and the opponent's **red**
(`crimson.500`); both palette entries are new in `src/design/tokens.ts` (`bun run gen:tokens`
regenerates `TOKENS`), and the first cut's brand-accent / cool-line pairing is gone. Revision 12:
revision 7 had bound each side in a soft (a64) and a strong (opaque) step, with the threat, castle,
pin, en passant and promotion kinds on the soft one — which read as a washed-out grey beside the
opaque capture ("make sure the enemy castle/discover lines are also red like the take lines"). Now
`EFFECT_COLORS` is `{ mine: effect.mine-strong, theirs: effect.theirs-strong, edge }` — one opaque
colour per side, every kind alike, `edge` (`canvas`) tinting the arrow's shadow as
`OVERLAY_COLORS.edge` does for the recommendation mark — and the `strong` knob is gone from the style
table. Revision 13 ("more pastel, less opacity") then moved both palette entries to pastel —
`azure.500` #8DB4EC, `crimson.500` #F0A3A3 — and bound the **a48** steps instead: `EFFECT_COLORS` is
now `{ mine: effect.mine, theirs: effect.theirs, edge }`, rendered as `rgb(141 180 236 / 0.48)` and
`rgb(240 163 163 / 0.48)`; the opaque `*-strong` tokens still exist but nothing binds them. The
quality chip is unaffected: its disc colours are the per-category `MOVE_QUALITY_ICONS`.

### The arrows are the highlight arrow (revision 11)

The pill rays of revision 5 — a stroked shaft with a separate triangular head, a gradient at each
end, dashed variants for the line-like kinds — are gone. The owner: "instead of remaking the arrows
for the board effects, just reuse the arrows from highlight move (but downscale them)".

`arrowShapeStatements` in `src/page/arrow-shape.ts` now takes options: `prefix` (identifiers become
`${prefix}ArrowPath` / `${prefix}ArrowGradient` / `${prefix}Arrow` / `${prefix}ArrowSerial`), the
names of the `cell` and `animate` routines in scope, a build-time `scale` that multiplies every
length of the silhouette (shaft and head half-widths, head length, corner radius, start inset, tail
and tip radii, shadow offset and blur, fade length — `arrowGeometry(scale)`, rounded to six
decimals), and `sizeArg`, which gives `${prefix}Arrow` a fifth argument. `${prefix}Arrow` now
returns the drawn `<g>`. With the defaults the recommendation mark's emitted program is unchanged
but for that `return group` (diffed at the time), and `test/page/highlight-overlay.test.ts` is
green.

The effect layer emits a second copy — `efArrow`, `cell: "efCell"`, `animate: "efAnimate"`,
`scale: BOARD_EFFECT_GEOMETRY.arrowScale` (0.6, "the highlight arrow, downscaled — owner
2026-09-13"), `sizeArg: true` — and `efArrowEffect` calls it with `motion` false and the wire object
`{ f, t, c }` the arrow reads, so the silhouette, its base-fade gradient and its soft shadow are
drawn statically into the effect group; the group id scheme is `<effectsClass>a<n>` on its own
`efArrowSerial`, beside the slash's `<effectsClass>r<n>`. The layer's own lifecycle then applies:
the shape grows from the stub (`efArrowPath(arrowStubLength(0.6))` — head, tail cap and one
corner) to its full `d` over `drawMs` after the fan's `delay`, opacity 0 → 1 with `fill:
backwards` so a staggered prong is invisible until its turn; the hold and fade run on the group
exactly as before (`LIFE`, `forgetOnFinish`).

**Per-kind size.** `BOARD_EFFECT_STYLES[kind].scale` (threat 0.85, fork 0.95, check 1, discovery
0.9, pin and castle 0.8, en passant 0.85; capture and promotion 0 = no arrow) is the fifth argument:
the path is built at `length / k` and the shape drawn under `transform="scale(k)"`, so the body
scales about the arrow's start while the tip still lands on the target — a check is a little bigger
than a threat, and the pin's two lines a little thinner. The `ray`, `head`, `dash`, `width` and
`strong` knobs are gone, as are `sourceInset`, `targetInset`, `headLength`, `headHalfWidth`,
`minLength`, `rayFadeLength` and `rayFadeFraction` from the geometry; `slashWidth` (0.16) and
`slashFade` (0.35) take over the two numbers the slash still needs, so the capture is byte-for-byte
what revision 6 drew.

Two visible consequences besides the look: the line-like kinds (discovery, pin, castle) became
solid arrows for a while — until revision 13 dotted them again, as a mode of the same silhouette
(below); and an effect between **adjacent squares** is drawn (a short arrow, as the
recommendation mark draws one for a pawn push) where the pill's insets used to leave nothing and
the ray was dropped. The arrow's own guard (`startInset + headLength` at scale, 0.41 board units)
is the only threshold.

### The line kinds are dotted (revision 13)

The owner: "also, include making them dotted like they were before (a modified version of the
highlight move arrow)". The dotted arrow is the highlight arrow's own geometry, not a third
drawing: `arrowShapeStatements` takes a `dotGapRatio` option that gives `${prefix}Arrow` a `dash`
argument after `size` and emits one more routine, `${prefix}ArrowHeadPath(length)` — the head
portion of `${prefix}ArrowPath` (from `h = length − headLength` round the tip and back, the same
rounded corners and tip, built from the same shared run of path text so the two cannot drift),
closed straight across its base at `h − cornerRadius`. With `dash` 0 the draw is the single filled
silhouette exactly as before; above 0 the same rotated group, gradient and shadow hold two parts:

- the **head**, a filled path of `${prefix}ArrowHeadPath`, painted through the gradient as before;
- the **shaft**, a `<line>` on the arrow's axis from `x = tailRadius` to `x = h − cornerRadius`,
  `stroke` the same gradient url, `stroke-width` = 2 × `shaftHalfWidth`, round caps, and
  `stroke-dasharray = "<dash × scale> <dash × scale × dotGapRatio>"` — path units, so under the
  kind's `scale(k)` transform the dots scale with the arrow. `pathLength` is unset.

The draw animation in dotted mode grows the head from the stub's head over `drawMs` as the solid
arrow grows from the stub, and runs the shaft's `stroke-dashoffset` from the shaft's length to 0
over the same `drawMs` — the dots travel from the tail to the head — with the dash array unchanged.
In the effect layer `efArrowEffect` does the same on its own timeline (`fill: backwards`, the fan
`delay`, opacity 0 → 1 on both parts).

The per-kind knob is `BOARD_EFFECT_STYLES[kind].dash`, in board units at scale 1, with the earlier
cut's values: discovery **0.14**, pin/skewer **0.09**, castle **0.12**; threat, fork, check, en
passant and promotion **0** (solid — the strikes), capture 0 (the seize mark). The gap ratio is
`BOARD_EFFECT_GEOMETRY.dotGapRatio` = 1.1, just over one dot, so the round-capped dots read as a
beaded line. The recommendation mark's program does not pass the option and its emitted JS is
byte-identical to before (diffed at the time; `test/page/highlight-overlay.test.ts` green).

### Rings removed (revision 8)

Every kind used to end with pulse rings on the target square — one for a threat, two for a check
and a capture, three for a promotion. The owner asked for "the three rings that go out from the
center of a piece" to go, and they are gone wholesale rather than switched off: the `rings`,
`ringWidth`, `ringFrom` and `ringTo` knobs left the style table, `ringMs`, `ringStaggerMs` and
`ringOpacity` left `BOARD_EFFECT_MOTION`, and the page program's `efRing` routine and its loop are
deleted. Rays, the capture slash and the chip are as they were. The one visible casualty is the
promotion effect, which was rings only: it is still detected and sent (`u`), and the page draws
nothing for it; a replacement flourish is the owner's call.

### Rays were pills (revision 5 — superseded by revision 11)

Between revisions 5 and 11 every ray was a `stroke-linecap: round` path at 1.6× the first cut's
width, painted through its own `<linearGradient gradientUnits="userSpaceOnUse">` from the shaft's
base to the tip with `0 → 0`, `fadeIn → 1`, `1 − fadeOut → 1`, `1 → 0` stops, and a triangular head
in board coordinates sharing that paint. Only the slash keeps this paint now (`efPaint`, ids
`<effectsClass>r<serial>`); the directional kinds are the highlight arrow (above).

### The seize mark (revision 14)

The owner: "change the take-piece animation (improve it, no longer do a slash — come up with
another creative, simple, minimalist animation for when taking pieces)". `capture` is now
`seize: 1, scale: 0, dash: 0`, and `efSeize` draws the square being closed in on: a `<rect>` of the
unit square (`x`/`y` −0.5, `width`/`height` 1, `rx`/`ry` `BOARD_EFFECT_SEIZE.radius` 0.12) inside
its own `<g transform="translate(cx cy)">` at the captured square's centre, `fill: none`, `stroke`
the mover's colour, `stroke-width` 0.05, `transform-origin: 0px 0px` (the group's origin is the
centre, so the scale is about it). With motion it animates `transform: scale(1.12)` → `scale(0.86)`
(`from` / `to`) and opacity 1 → 0 over `ms` 260 with the layer's `easing`, `fill: both`, after the
fan `delay`; the group's own hold and fade run as for every kind and the entry lives in the same
`efLive` list, so it accumulates and removes itself like the arrows and is capped by
`maxLiveGroups`. Without motion the outline is drawn once at 1× and left for the next batch to
replace, as the static path does for everything. Captures stay ray-free: nothing is drawn from the
mover's origin, and the batch carries no second element.

### The capture slash (revision 6 — superseded by revision 14)

Between revisions 6 and 14 `capture` was a pill of width 0.16 swept corner to corner across the
captured square, entering from the corner nearest the square the mover came from, one dash of the
diagonal with `stroke-dashoffset` animated from before the first corner to past the second over
520 ms, faded at both ends by its own `userSpaceOnUse` gradient (`efPaint`, ids
`<effectsClass>r<serial>`). The routine, the paint and the `slashHalfSpan` / `slashWidth` /
`slashSegment` / `slashFade` / `slashMs` knobs are deleted.

### The chip

Ten categories, worst → best: **Blunder, Miss, Mistake, Inaccuracy, Good, Excellent, Best, Book,
Great, Brilliant**. The owner's SVG path data and disc colours are transcribed once into
`MOVE_QUALITY_ICONS` / `MOVE_QUALITY_ART` in `src/core/constants/move-quality.ts` and bound into
the overlay at build time; only `MOVE_QUALITY` (the thresholds) reaches a runtime bundle, because a
bundler inlines an object literal whole. `miss` was supplied without a colour and takes the blunder
red, per the brief.

The chip is an `<svg>` group at `chipSize` **0.345** board units (revision 4: three quarters of the
first cut's 0.46), anchored at (0.26, 0.74) inside the destination square — low and left. It scales
and fades in over 200 ms (with a small overshoot to 1.08) to `chipOpacity` **0.8**, holds 1.2 s at
that opacity and fades out over 220 ms, then removes itself. Without motion the group is drawn at
`opacity="0.8"`.

### Lifecycles (revisions 1 and 3)

The first cut treated every batch as a replacement: `efDraw` cancelled every running animation,
removed every node and dropped the chip whenever the batch key changed — so a fast reply erased the
previous move's rays mid-flight and its chip with them (bug 1), and any chip whose verdict arrived
after the next batch had nowhere to go (bug 3 as observed).

Now a batch only *adds*. Each ray group and each chip is an entry `{ node, anims }` in `efLive` /
`efChips`; it animates in, holds, fades and removes itself (forgetting its entry when it does). The
lists exist for two things:

- **Caps.** `BOARD_EFFECT_LIMITS.maxLiveGroups` (24) and `maxLiveChips` (4): beyond them the oldest
  entry is dropped (animations cancelled, node removed). A new chip on a square that already
  carries one replaces that one — two discs blended on one square are unreadable, and a recapture is
  exactly that case.
- **The static path.** Without motion nothing removes itself, so a new distinct batch still
  replaces the layer, as it always did under `prefers-reduced-motion`.

Dedupe is kept but separated: `efMark` = `[orientation, list, mine]` says whether the rays of this
batch are already drawn (the verdict command repeats the list; a republished position repeats the
batch), and `efChipMark` = `[orientation, mine, chip]` says whether this chip is — `mine` is in the
chip's key so a recapture with the same verdict on the same square still shows. A batch carrying
rays **and** a chip draws both from one call; a chip arriving on its own later joins the rays it
was sent beside without cancelling anything. Only `efClear` — the assistant off, `Shift+X`, a new
game, the game ending, the tab navigating or closing, the setting turned off — wipes the layer.

### Our move is classified before it is played (revision 2)

The first cut started the verdict search when the move landed. For our own move that is the worst
moment there is: `GameSession.onOpponentTurn` starts the opponent-turn ponder on the very same
position arrival, and in the engine queue a request supersedes a running search of equal or lower
rank — so the `panel` classification issued beside a `ponder` was either stopped at once (answering
whatever depth it had, usually 0) or queued behind a search bounded by `ponderMaxMs`, and when the
opponent replied the `move` search queued ahead again. `classifyMoveQuality` refuses a frame below
`minDepth`, so no chip. That is the whole of "sometimes the rating doesn't appear" for our moves;
for the opponent's the search runs after our own move search and usually lands.

`BoardEffectsReporter.prepare()` fixes it where the owner said to: `GameSession.runPipeline` calls it
the moment `this.rec` is assigned (gated on the same `mayAct() && automation.boardEffects` as
`reportBoardEffects`), with the position, its history root, the chosen move and
`outcome.fromBook` as `inBook`. The engine is idle then — the move search has answered, the ponder
belongs to the opponent's turn — and the hand is still waiting out the human think time. The job
is keyed by `${beforeFen}|${uci}`; a repeat for the same key is a no-op, a different plan replaces
the previous job (its search stopped). When `report()` sees the landed move's key match, it adopts
the job: a settled verdict goes out **inside the first `effects` command**, an in-flight one is
awaited rather than restarted. A prepared verdict for a move we did not play is abandoned and the
played move is classified as before. Search shape and knobs (`multiPv` 3, `movetimeMs` 350,
`depthCap` 18, `minDepth` 8, `panel` priority, no `elo`) are unchanged.

**Staleness is identity, not a serial — and a window of two.** A verdict posts while its move is one
of the last `MOVE_QUALITY.landedWindow` = 2 moves `report()` saw: a clock tick or an exact-FEN
republish of the same board does not touch it (the session never calls `report()` for one:
`landedPlies` finds no move), the move after it does not either (revision 10: a queued premove or
an instant reply must not orphan the opponent's verdict), the move after *that* does, and `cancel()`
(game over, setting off, new game) clears everything. A late chip is skipped when a later move
landed on the same square — a recapture — because two verdicts on one square replace each other on
the page. There is no wall-clock abandon deadline; the search's own `movetimeMs` is the only bound.

### Two plies in one position (revision 9)

A queued premove (Fix F) is entered on the site during the opponent's turn and fires the instant
they move, so the next position this session sees is two plies on: their reply, which it never saw
as a position, and our premove, which the site marks as the last move. The first cut derived the
landed move with `uciOf(previous.fen, last.from, last.to)` — our piece cannot move in a position
where it is the opponent's turn, so that answered `null` and nothing was reported for either ply.
And even a reported premove had no verdict: `prepare()` runs from `runPipeline`, and a premove is
armed from `armPremove` / `enterPremove`, never planned there.

`landedPlies(beforeFen, last, afterFen)` (`src/service/game-session/board-effects.ts`, reached
through `BoardEffectsReporter.landedPlies`) tries the direct reading first and, failing that, every
legal reply followed by the marked move, keeping the pair whose result is the board. The session
reports both moves in one `report()` — theirs first, `mine` inferred from the last ply — each with
its own before-position, history and ply, and the page draws two batches (independent lifecycles,
revision 1). Each is classified against its own position: theirs from the ponder lines of the
position before it (the ponder that ran during their turn), ours from the lines of the middle
position — which the premove candidate's own `analyseAfter` searched at the session's strength
while choosing the premove. The reporter asks for that position at that strength
(`Arrival.strengthElo`, no depth cap, so the cache's depth gate is its default) and the
`AnalysisCache` answers without a search. The premove is usually the first line of that search,
so no "played" score is needed either; when it is not, the opponent-turn ponder of the new
position supplies it on the next landing (window of two, above). A recapture's two chips land on
the same square, and the page's same-square replacement shows the later one — ours.

## The thresholds

Everything is measured from the point of view of the side that played the move, in lichess win
probability (`winProb(cpEffective(score))`, `@core/strength/elo-map`) rather than raw centipawns: a
centipawn is worth far more at 0.00 than at +8.00, and a chip that calls a +9 → +6 move a blunder
is wrong.

```
loss = winProb(best move's score) − winProb(the played move's score), clamped at 0
```

`cpEffective` maps a mate to ±(1000 + (100 − |N|)), so mate-for ≈ +1099 cp (win probability ≈ 0.98)
and mate-against ≈ −1099. A move that walks from "mate in 3" into a drawn position therefore lands
in the blunder band on its own arithmetic.

**Bands, applied worst first, one pass:**

| Test | Verdict |
|---|---|
| `loss ≥ 0.30` (`blunderLoss`) | **Blunder** |
| `winProb(best) ≥ 0.90` **and** `winProb(played) < 0.80` **and** `loss ≥ 0.08` | **Miss** — a win or a mate was on the board and the move did not take it |
| `loss ≥ 0.18` (`mistakeLoss`) | **Mistake** |
| `loss ≥ 0.09` (`inaccuracyLoss`) | **Inaccuracy** |

`Miss` outranks `Mistake` and `Inaccuracy` but never `Blunder`: throwing the game away is worse
than failing to finish it.

**Upgrades, applied to anything below the inaccuracy band; each can only move it up the ladder:**

| Test | Verdict |
|---|---|
| (start) | **Good** |
| `loss < 0.02` (`excellentMaxLoss`) | **Excellent** |
| the played move is the engine's first choice, or within `bestTieCp` = 10 cp of it | **Best** |
| still in the opening book | **Book** |
| Best **and** the runner-up is `greatGapWp` = 0.18 worse in win probability | **Great** — the only move that held |
| Great or Best **and** a sound sacrifice | **Brilliant** |

- **Best** accepts a 10 cp tie because MultiPV ordering at a tie is a search artefact, not a
  judgement.
- **Book**: the caller states it when it knows (our own move carries `RecommendationOutcome`'s
  `fromBook` concept); for an opponent move it falls back to the timing model's own approximation
  in `@core/timing/features` — `ply < bookMaxPly` (16) — widened from "the engine's top move" to
  "a move that lost at most `bookMaxLoss` = 0.02", because book lines transpose and the engine's
  first choice is not the only theoretical one. A losing move is never called Book: the bands run
  first.
- **Great** needs at least two scored lines. With one line there is no runner-up and no claim.
- **Brilliant** is `hangsOutright(beforeFen, uci)` (`@core/chess/safety`: after the move the
  opponent can take the moved piece with something cheaper, or take it for nothing, net of whatever
  the move itself captured) **plus** a piece worth at least `brilliantMinPieceValue` = 3 (a pawn
  offer is a gambit, not a brilliancy) **plus** `winProb(played) ≥ 0.5` (the sacrifice has to be
  sound).

**The classifier refuses to answer** — and no chip is drawn — when there is no usable line, when the
deepest complete frame is shallower than `minDepth` = 8, or when nothing scored the played move.

## Where the evaluation comes from

Revision 10 ("move ratings occasionally don't ever show up for unknown reason"). The first cut ran
its own search for every landed move at `panel` priority — the lowest rank the engine queue has —
and the queue supersedes a running search of equal or lower rank the moment a request arrives, and
*any* running ponder for any request. That left three ways for a verdict to answer an empty frame,
which `minDepth` refuses:

1. the opponent's move: the verdict search was issued in the same turn as our own-move search
   (`move` rank), which superseded it at once;
2. our move at landing (a hand-played move without a prepared verdict): the opponent-turn ponder
   (`ponder` rank) superseded it;
3. **panel-only mode** (autoplay off, the owner moving by hand): `runPipeline` calls `prepare()` and
   then, one call later, `actOnRecommendation` starts the *panel* ponder on the same position at
   the same `panel` rank — which superseded the verdict search that revision 2 had just moved to
   the idle engine. This is the case revision 2 did not cover, and it is the common way of using
   the extension.

The reporter now keeps a small memory of lines — `supply(fen, lines, fullStrength)`, the last
`MOVE_QUALITY.knownPositions` = 8 positions any search touched — and assembles a verdict from it
whenever it can, in this order:

| Move | "best" (the position before it) | "played" (when the move is not among those lines) |
|---|---|---|
| ours, planned | the recommendation's own referee lines (`prepare` with `analysis`), **when the own-move search carried no `elo`** — Maia mode, or a target above `LIMITS.engineEloMax`. Shaped lines are not accepted before landing: there is time for the full-strength search. | the dedicated after-search |
| ours, landed | whatever the session holds for the position: the prepared verdict; else the ponder's lines (`ponderer.latestLines(previous.fen)`, the panel ponder in panel-only mode), any strength; else a cache probe at the session's strength | the opponent-turn ponder of the new position, supplied on the next landing |
| theirs | the ponder's lines of the position before it, any strength | our own-move search of the position after it — the very next `prepare()` carries `rec.lines` for exactly that position |

The dedicated full-strength search (`multiPv` 3, `movetimeMs` 350, `depth` 18, no `elo`, `panel`
priority — unchanged) is the fallback for what those lines cannot answer: a chosen move nothing
scored, a book move, a frame shallower than `minDepth`. It is issued from `prepare()`, the one
moment the engine is idle (the human think time), for our planned move and for any landed move
still waiting — never at landing, when the next `move` or `ponder` request is already on its way.
At landing the only request is the cache probe for a "before" position nobody analysed at full
strength (`Arrival.strengthElo`, no depth cap): a hit costs nothing, a miss is a best-effort search
the next request may supersede. Each half of a classification is searched at most once.

**Every landed move that ends without a chip says why.** The reporter logs
`board effects: no chip for the landed move` at debug with `{ uci, ply, mine, reason }` when the
move leaves the two-move window or the game ends, and counts it in `stats()` —
`{ delivered, dropped: Record<reason, number> }` — for the tests. The reasons:

| Reason | Meaning |
|---|---|
| `no-line` | no lines for the position before the move, from any source |
| `shallow` | the deepest frame it had was below `minDepth` |
| `unscored` | the move is not among the lines and nothing analysed the position after it |
| `superseded` | the dedicated search was cut short by a higher-ranked request and answered below `minDepth` |
| `stale` | the verdict arrived after the move left the window, or a later move landed on the same square |
| `failed` / `no-searcher` | the search failed or refused; no engine attached |

A prepared verdict for a move we did not play is discarded and logged, but not counted: it never
landed.

When the verdict is not yet known at landing, the second command repeats the **same** effect list
beside it, so the page's dedupe skips the rays it has already drawn and only adds the chip. Sending
an empty list there would look like a new batch. When it is known — the prepared move, an opponent
move among the ponder's lines — the first command carries it.

## Message shapes

**Service worker → content (`sl-game` port, `GamePortCommand`):**

```ts
{ kind: "settings"; highlightMoves: boolean; boardEffects?: boolean }
{ kind: "effects"; effects: BoardEffect[]; mine: boolean; quality?: { square: Square; quality: MoveQuality } }
{ kind: "clearEffects" }
```

`boardEffects` is optional on the settings command so every existing fixture still means "off",
which is exactly what "default off until sent" says.

`BoardEffect` is `{ kind: BoardEffectName; from: Square; to: Square }`; a promotion flourish has
`from === to`.

**Content → page (MAIN-world bridge, `BRIDGE_KINDS.effects` / `effectsClear`):** single-letter
fields from `BRIDGE_WIRE`, so nothing page-visible spells a chess idea or a category name.

```
{
  r: "w" | "b",                        // orientation (black at the bottom)
  u: boolean,                          // the owner played it
  z: [ { n: <kind letter>, f: <square>, t: <square> } ],
  b?: { q: <square>, j: <index into MOVE_QUALITY_ORDER> }
}
```

The page answers each with its id and an empty payload. The style table, the palette and the chip
artwork are bound into the program at build time, so the wire carries only letters, squares and one
number.

**Clear points.** `clearEffects` is deliberately *not* part of `clearBoardMarks()` — that runs on
every new position, and a batch drawn for the move that produced it would be wiped in the same
turn. The effect layer is erased only when the game it belongs to is over: the assistant turned off,
`Shift+X`, a new game, the game ending, the tab navigating or closing.

## Presence and telemetry (§13.3)

- Its own `<svg viewBox="0 0 8 8">` appended to the board host on the first batch, with a per-build
  class derived from `deriveToken(seed, SPOOF_PURPOSES.effectsClass)`, no `id`, no `data-*`, no
  text, `pointer-events: none`.
- Separate element from the recommendation mark, one step above it
  (`BOARD_EFFECT_GEOMETRY.zIndex` = 4 vs the mark's 3) and far below the pointer mirror, which is a
  child of `<html>` at `CURSOR_LAYER.zIndex`. Neither clear touches the other.
- The only `id`s are the per-arrow gradient and shadow filter (`<effectsClass>a<n>`,
  `<effectsClass>a<n>s`), inside the layer, the same scoping the recommendation arrow's gradient
  already uses; the seize mark carries none (revision 14 removed the slash's `<effectsClass>r<n>`).
- A clear renames the element out of its own lookup's reach, fades it over
  `HIGHLIGHT_MOTION.clearFadeMs` and removes it — the `ovClear` pattern, so a batch that arrives
  during the fade gets a fresh layer rather than joining the dying one.
- `prefers-reduced-motion: reduce` draws the same geometry statically, exactly as the recommendation
  mark does; the layer is then replaced by the next batch rather than fading.
- The emitted program contains none of the seven §13.3 rule 5 words (asserted in
  `test/page/effects-overlay.test.ts`, and enforced for every build by `check-constants`).

## Tests

| File | Covers |
|---|---|
| `test/core/chess/board-effects.test.ts` | 17 cases: the ray vocabulary per kind, the threat rule, restraint chains, discovered attacks and checks, the pair dedupe, the caps, and that an opponent move reads identically |
| `test/core/engine/move-quality.test.ts` | 16 cases: every band and every upgrade, the win-probability framing, `Miss` vs `Blunder` precedence, the book approximation and the explicit override, the sacrifice rules, and the three refusals |
| `test/page/effects-overlay.test.ts` | 19 cases in happy-dom: presence, forbidden words, the threat as the highlight arrow's silhouette at `arrowScale` with the tip on the target under the kind's runtime size (revision 11), one pastel a48 colour per side — `TOKENS.color.dark.effectMine` / `effectTheirs` as `rgb(… / 0.48)`, not the opaque hex — across castle / discovery / capture / pin / en passant (revisions 12–13), the dotted pin: head path without shaft edges, the `<line>` from the tail cap to the head's base at the shaft width with the scaled dash array and the head's gradient, the head's draw from the stub's head and the dash-offset run (revision 13), the draw from the stub after the fan delay and the group hold/fade, every directional kind through the one silhouette — three dotted, four solid — and nothing for a promotion, the adjacent-square arrow, the seize mark: a `rect` with `rx` in the translated group, the scale keyframes `from` → `to` with opacity to 0, colour by side, and the static outline under reduced motion (revision 14), orientation (read off the seize mark), the chip's position, artwork, hold opacity and one-shot animation beside its arrow, a late verdict joining the arrow, batches accumulating and removing themselves one by one, same-square chip replacement, the live-group cap, reduced motion (static, replaced by the next batch), SPA repair, junk input, and the clear's fade |
| `test/page/highlight-overlay.test.ts` | unchanged and green: the parameterised `arrowShapeStatements` emits the recommendation mark's arrow as before (byte-identical across revision 13) |
| `test/behavioral/game/board-effects.test.ts` | 12 cases on the real service-worker stack: the opponent's move and ours, the verdict arriving second, our planned move classified before it lands (the chip inside the first batch, no new search at landing), a prepared verdict discarded when a different move is played, nothing at all with the setting off, the mid-game flip, the game-end clear, the batch cap; revision 10: our move classified from the referee lines with **no** dedicated search at full strength, the opponent's from the ponder lines plus our own-move search with none, the dedicated search still running when every frame is shallow with the drop counted **and** logged with its reason; revision 9: a queued premove firing on the reply produces two batches and a chip for each ply with no new search. Plus 3 pure cases for `landedPlies` |
| `test/panel/views/settings.test.ts` | the row exists, is checked to the shipped default, carries its help text, and sits directly beneath **Highlight moves** |

`test/behavioral/game/harness.ts` now seeds `automation.boardEffects: false`, the same discipline it
already applies to `execution.inputMode`: every other behavioural test is about the *move* pipeline
and counts `go` lines, so the fixture states the lane off and `board-effects.test.ts` turns it back
on.

## What only a real browser can answer

Nothing below is a defect until a browser says so; happy-dom has no layout, no compositor and no
frame clock, and the simulator has no real engine.

1. **Does the layer render on the live WebGL board at all?** `wc-chess-board.board-webgl-2d` has a
   single `<canvas>` child and no `.piece` elements. The recommendation mark's overlay is appended
   to the same host and does render there (QA B0), so the expectation is that this does too — but it
   is a second absolutely-positioned `<svg>` sibling at a higher `z-index`, and nothing offline can
   confirm the canvas does not paint over it.
2. **Does the ray geometry land on the right squares?** The viewBox is 8×8 board units and the host
   is the 8×8 playing area, the same assumption the recommendation mark makes. A board whose host
   element includes coordinates or a border would offset every ray.
3. **Do the arrows read at real frame rates?** The path-`d` growth from the stub, the fan stagger,
   the dotted shafts' run and the seize mark's contraction are all judged by eye. Revision-specific
   questions: at 0.6 of the recommendation arrow (a check at 0.6, a threat at 0.51, a pin at 0.48
   of it) is the silhouette still legible on a 400 px board; does the per-kind size difference
   read as intended or as inconsistency; does the shadow (also scaled) still separate the arrow
   from the pieces; at 0.48 alpha do the pastel colours still show over a dark square and over a
   piece; do the dots (a pin's at 0.09 × 0.6 × 0.8 ≈ 0.043 board units, about 3 px on a 400 px
   board) survive as dots rather than a fuzzy line, and does the dash-offset run over 260 ms read
   as motion or as flicker; and does the seize outline (0.05 stroke, 1.12× → 0.86×) read as
   closing in on the taken piece rather than as a stray box? The `transform-origin: 0px 0px` on the
   outline assumes the origin resolves in the rect's own (translated) user space, as the chip's
   inner group already relies on.
4. **Is the chip legible at a real board size?** 0.345 board units is roughly 28 px on a 660 px
   board and roughly 17 px on a 400 px one, at 0.8 opacity. Whether the glyph survives the smaller
   case, and whether the bottom-left anchor clashes with chess.com's own coordinate labels on rank
   1 / file a, is a visual question.
5. **Do chips actually appear in a live game?** Offline the scripted engine answers instantly. Both
   sides should now chip on nearly every move without a search of their own (revision 10); what a
   live game can measure is how often the fallbacks are needed and how they fare — the debug log
   says `no chip for the landed move` with a reason for every miss. A run of `superseded` means the
   dedicated fallback is still being cut short; a run of `shallow` on the opponent's moves means the
   ponder's frames are too shallow at that time control (`SEARCH_BUDGET.ponderMultiPv`,
   `TIMINGS.ponderMaxMs`); `unscored` on the opponent's moves means their move was outside the
   ponder's three lines *and* no own-move search followed (a fast reply, a hold). Record the
   reasons per side.
10. **Overlap.** Batches now stack: a bullet exchange can have three or four moves' worth of rays and
    up to four chips alive at once. Whether that reads as a burst or as clutter — and whether the
    `maxLiveGroups` = 24 / `maxLiveChips` = 4 caps are ever hit — is a live-game judgement.
6. **Does it cost anything the owner can feel?** In the common case the lane now adds no search:
   the verdicts come from the referee, the ponder and the cache. The dedicated fallback (~350 ms at
   `panel` priority, from `prepare()` during the think time) and the landing-time cache probe are
   the only requests; the claim that neither delays a move rests on the engine queue's supersede
   rule, which is exercised offline. Whether a probe *miss* — a shaped search issued at landing and
   superseded a moment later — costs a visible stop round-trip in a bullet game is not.
7. **Category calibration.** The thresholds are designed, not fitted. Whether "Brilliant" fires on
   moves a human would call brilliant — and whether "Great" and "Miss" fire often enough to mean
   something — needs a real game against a real opponent with the chips watched move by move.
8. **Layering against the site's own markings.** The recommendation mark, the effect layer, the
   site's last-move highlight and the pointer mirror all coexist. Only a browser shows whether the
   stack reads clearly.
9. **Reduced motion.** With the OS setting on, the layer is static and persists until the next move
   replaces it. Whether a board carrying a static ray set for a whole opponent turn is an
   improvement or a nuisance is a judgement call for the owner.
