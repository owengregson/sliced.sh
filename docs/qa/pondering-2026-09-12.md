# Pondering — 2026-09-12

Owner: "make large humanization improvements to the pondering code including where/when/how often
it decides to ponder, the places it moves to, etc." Pondering is the opponent-turn free pointer
movement — `planOpponentExploration` — that starts after the post-drop decision
(`docs/qa/fix-batch-3-2026-09-11.md`, "After the drop: rest or ponder, decided at once"). The hold
and premove checkpoints of the opponent's turn (`scheduleOpponentDecision`) are untouched, and so
are the cancellation semantics: the bout still stops at once on our turn, disarm, disable,
navigation and dispose (`test/behavioral/game/opponent-exploration.test.ts` keeps every assertion
it had and adds three).

Before this batch every opponent turn pondered continuously, in 3–8 s bouts of hover/trace over
squares drawn from a candidate list, until the turn ended. What changed is in three parts: **when**
(an attention plan), **where** (places read from the position) and **how** (the movement itself).
Every knob lives in `OPPONENT_EXPLORATION` (`src/core/motor/constants.ts`) with a comment on what
it is set from; none of them has a behaviour dataset behind it — like the rest of the motor
constants (`MOTOR_DEFAULTS`) they are design values, and the tests pin the shape they produce.

## When: the attention plan

A human's attention over the opponent's think is uneven. The turn is now a sequence of *spells*,
one planned per call of `planOpponentExploration` and handed back through `previousSpell` so they
alternate:

- **First look** — short, right after the post-drop settle; reads the most likely line. Not
  phase-scaled (it must fit one reading), and without the orientation pause an ordinary active
  spell opens with, since the executor's own `initialRestMs` is that pause.
- **Still** — the hand keeps still where the spell left it, or first walks to a rest spot
  (`restMoveProb`, never straight after another still), and holds a few long dwells
  (`stillDwellMs`, 0.9–2.6 s each) with the idle tremor (`PATH.idle`, one small adjustment in a
  long pause at most).
- **Active** — a mix of the activities under *Where*, with a short orientation pause first
  (`orientationMs`, capped to `orientationMaxFrac` of the spell so a bullet spell keeps its room).
- **Glance** — one hover (own king most often, else a threatened piece, else the top line's piece),
  then the still that follows. This is what a decayed attention does instead of an active spell.

Activity never follows activity: after a first look, an active spell or a glance the next spell is
a still; after a still the plan rolls what comes next.

**By time control** (`attention[tcClass]`): the spell lengths are set from the median human move
times per class in the ChessMimic bands (bullet ≈ 1.5 s, blitz ≈ 4 s, rapid ≈ 10 s, classical ≈
25 s) — a spell about a third of a median think, a still about a half:

| class | first look | active | still | no-ponder share | half-life |
|---|---|---|---|---|---|
| bullet | 0.6–1.3 s | 0.9–2.0 s | 0.4–1.2 s | 35 % | 3 s |
| blitz | 0.8–1.8 s | 1.4–3.4 s | 0.8–2.2 s | 18 % | 8 s |
| rapid | 1.1–2.6 s | 2.2–5.2 s | 1.5–4.5 s | 10 % | 20 s |
| classical | 1.4–3.2 s | 2.6–7 s | 2.5–8 s | 14 % | 50 s |

**Attention decays** with the opponent's elapsed think (`opponentThinkMs`, measured from the
position's `capturedAt`): `a = 2^(−think / decayHalfLifeMs)`. A still grows by up to
`decay.stillGrowthMax` (×3 at full decay); the chance that the spell after a still is active falls
from 1 toward `decay.activeFloor` (0.3), and a cycle that is not active is a glance with
`decay.glanceProb` (0.5), else more stillness. A fully decayed rapid turn shows one glance per
roughly 15 s — the "very long think" of the brief, long stills with an occasional glance.

**Some turns get no pondering at all** beyond a rest. `decideOpponentTurn` rolls it once per turn
from the class's `noPonderProb` — highest at bullet, where the reply is due before a look is
worth it, raised again at classical, where a long expected think makes the hand lean back — plus
`noPonderShortBoost` (0.25) when the opponent's clock is under `quickReplyClockMs` (15 s): they
are about to move. On such a turn the exploration task still runs (so the cancellation paths are
identical), but every spell is a still: the page sees nothing but the idle tremor, a few points
a few px apart over a 30 s think (`test/behavioral/game/opponent-exploration.test.ts`, seed
`attention-plan-4`). A low-time turn (`policy.lowTime`, the existing readiness policy) always
ponders in its own short own-only way; so does a caller without an attention context, exactly as
before (the legacy bout is kept, `boutMs`/`activeFrac`/`visits`, for that case).

**Game phase** (`phaseActiveScale`, from `@core/chess/phase`): opening spells are quick glances
(×0.7), a sharp middlegame — a capture or a check among the top replies, `isSharp` — holds longer
traces (×1.35, and the `line`/`threat` activities weigh `sharpActivityScale` more), the endgame is
between (×0.85).

**A premove or a hold armed** (`armed`, from the session's `premove`/`premoveEntry`/`holdEntry`):
mostly still — `armed.activeProb` (0.2) that a cycle is active at all, and active spells
`armed.activeScale` (×0.5) as long. A held piece never ponders (the executor does not start a bout
while a hold runs); this covers the armed-but-not-entered premove and the checkpoints between.

## Where: places read from the position

`opponentExplorationCandidates` now derives, besides the two candidate pools:

- **Line readings** (`readings`): the top `readingLines` (3) PVs as reply → our answer → their
  next (`readingPlies`), each an ordered from→to. A reading is performed in that order with short
  dwells (`readFromDwellMs` on the piece, `readToDwellMs` on the destination), and `rereadProb`
  (0.3) of the time a second, quicker pass (`rereadSpeedScale`). Which line is read is a weighted
  draw (`1/(rank+1)`) that avoids the line just read, so the sequence never scans the list in rank
  order; the first activity of any active spell is a reading most of the time
  (`firstLookLineScale`, ×2.5 — leaving a threat check about a sixth of the openings, which the
  unit test derives from the weights rather than pinning as a number).
  A leg refused for room ends the reading — a line is never read with a step left out.
- **Threat checks** (`threats`): our pieces the piece moved by each of the top `threatReplies`
  replies would attack (`Chess.attackers` after the reply), and their piece that just moved
  (`lastMove` — the session reads it from the history, since on the opponent's turn
  `snapshot.lastMove` is *our* move). `threatVisits` (1–3) per check with a worried
  `threatDwellMs` (0.3–1.1 s); the just-moved piece first `lastMoveFirstProb` of the time.
- **The king** (`kings`): a glance at either king — own `kingOwnProb` (0.65) of the time — as an
  activity, and as an *extra* at the start of any active spell with `kingGlanceProb` (0.12).
- **Off-board glances**: the clock / move-list area beside the board — the same
  `SAMPLING.clockBandPx` band to the right that `plausibleStart` already uses — or just past an
  edge (`SAMPLING.offBoardPx`), `offBoardClockProb` deciding which, never above the viewport origin
  (`viewportPadPx`). Rare: `offBoardGlanceProb` (0.06) as an extra, `activityWeights.offBoard`
  (0.5 of 11.5) as an activity, and never under `ownOnly` (a tactical or queued context keeps the
  eyes on the board). A dwell that reads a clock (`offBoardDwellMs`).
- **Rest spots** for stills (`restSpot`): a random piece drawn toward the centre with the same
  `EXECUTOR.postDropCentreBias` weight the post-drop rest uses (`restPieceProb`, 0.75), else a
  point just off the board edge. Never the square we intend to move to next (`intendedTo`: the
  armed premove's destination, else the ponder's answer to its top line), never the square just
  visited.
- **Candidates**: the previous browse, kept as an activity (`activityWeights.candidates`) and as
  the fallback for a position with no readable lines — the ponder held back, an engine still
  warming up.

`activityWeights` (line 5, threat 3, candidates 2, king 1, off-board 0.5) is what an active spell
draws from; an activity with nothing to do (no lines, no threats, no kings) weighs 0. The
`lowTime`/`ownOnly` policy semantics are unchanged: under `ownOnly` a reading keeps only our
answer, threats are ours by construction, the king glance is our king, and there are no off-board
glances.

## How: the movement

- Dwells carry the idle tremor: a dwell of 0.9 s or more draws `PATH.idle.adjustmentProb` for one
  small adjustment, planned as a `drift` action (a one-point path, then the rest of the dwell).
  The hand controller treats a drift as rest for the state pill.
- Stills hold fewer, longer dwells (`stillDwellMs`) than an active spell's (`readFromDwellMs`,
  `hoverDwellMs`, …).
- Trace speed varies with the persona's motor profile — every leg is `generatePath` under the
  hand's own profile — with a per-spell jitter (`traceSpeedScale`, ×0.85–1.2 on
  `travelSpeedScale`).
- The first movement after a still is slower (`reorientSpeedScale`, ×1.3 on `travelSpeedScale`):
  the hand re-orients. `test/core/motor/opponent-exploration.test.ts` measures it against a first
  look from the same rest point.
- No square is visited twice in a row — within a spell and across spells (`previousTarget`).
- An active spell too short for the leg it chose (bullet, a far piece) still looks at something:
  the nearest of a line's pieces, a threat, a king or a candidate (`nearestLookTries`), so an
  active spell is never motionless by accident.

Nothing here presses a button: `HandController.explore` is the same path as before, travel and
pause only, gated before every point. Every dispatched point stays within
`TELEMETRY_BANDS.pointer.maxStepPx` of the previous one (the paths are `generatePath`'s, the
drift `PATH.idle.maxOffsetPx`), which the unit test checks per plan and the blitz behavioural
test checks on the wire; `bun test test/behavioral/telemetry/` and `tools/telemetry-conformance/`
stay green.

## What the owner will see

After the drop the hand either rests on a piece or goes straight to a first look: the likely
reply's piece, where it goes, our answer's piece, where it goes — a couple of seconds — then it
stops. On a blitz clock it comes back every second or two for another look (a different line, a
threatened piece, the king, once in a while the clock); on rapid and classical the pauses are
longer, and the longer the opponent thinks the longer they get, until the hand only glances now
and then. Some turns it does nothing at all — a still hand with the odd twitch — and with a
premove armed it is mostly still. It never goes back to the square it just left, and it never
parks on the square it is about to move to.

## Tests

- `test/core/motor/opponent-exploration.test.ts` (seeded `createRng`): the candidates' readings,
  threats, kings, pieces and last move; the no-ponder share per class and with a quick reply; the
  first-look → still → … alternation with the spell lengths per class and stills ordered bullet <
  blitz < rapid < classical; attention decay (stills ×2+, activity near the floor, glances
  appearing); the armed share; a quiet turn's stills-only plans; reading order (a contiguous slice
  of one reading's reply→answer→next, a re-read now and then, the first look not always on the top
  line); threat, king and off-board rates against the registry; no square twice in a row;
  off-board points outside the board and inside the viewport; rest spots never on `intendedTo`;
  every point within `maxStepPx` and its own square; the slower re-orientation.
- `test/behavioral/game/opponent-exploration.test.ts`: the five existing cancellation and
  continuity tests, unchanged, plus a blitz turn that alternates busy and quiet seconds with no
  press, no teleport and no point above the origin, and a no-ponder turn (seed `attention-plan-4`)
  that keeps still for 30 s and still cancels at once on our turn.

Both seeds in the behavioural file are coupled to the constants above the way the file's existing
seed is: changing a knob re-rolls them, and a failure there is a re-seed, not a finding, unless the
unit tests move with it.
