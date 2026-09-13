# Maia-3 integration batch — 2026-09-11

The owner's brief, after the feasibility study
([`docs/research/maia3-feasibility-2026-09-11.md`](../research/maia3-feasibility-2026-09-11.md)):
"begin implementation of Maia as the model for move selection (not timings) below 2600 elo. it
should decide which of the 3 maia model sizes to use based on the elo selected (and auto switch
to them) … from 2600-3200 we use stockfish 18 small net, then 3200-3800 stockfish 18 large net.
add another divider in the elo slider for that model switch as well (no need to label it
though). improve the fire animation in the slider … decrease the speed of the orangish slide …
increase the FREQUENCY as it gets closer to max." Plus, mid-batch: "moves that move the piece
FARTHER across the board (4+ squares) have higher chance to be a drag than they do a click."

This is the index of what changed, lane by lane; the selection design and its knobs are in
[`maia-selection-2026-09-11.md`](maia-selection-2026-09-11.md), the assets in `docs/models.md` §8.

## What plays now, by target Elo

| Target | Selects the move | Engine |
| --- | --- | --- |
| 400 – 1399 | Maia-3 **5M** | Stockfish 18 small net, full strength, as referee |
| 1400 – 1999 | Maia-3 **23M** | same |
| 2000 – 2599 | Maia-3 **79M** | same |
| 2600 – 3200 | Stockfish 18 policy (unchanged) | small net, `UCI_Elo`-limited |
| 3200 – 3800 | Stockfish 18 policy (unchanged) | full (big + small) net |

The 2600–3200 / 3200–3800 split already existed (`variantForSettings`, `LIMITS.nnueSmallEloMax`);
the brief restates it. The size follows the *target* (opponent-matched when that is on), so it
switches by itself: the session warms the size for the target at game start and whenever the
target crosses a band edge during a game (`warmPolicyFor`, deduped on size); the offscreen host
keeps one resident session and evicts the other on a switch. A switch mid-game costs at most one
move on the engine policy while the new size loads (`MAIA.inferenceBudgetMs` 1.5 s).
There is no user-facing switch (the owner's ruling: which model plays is decided by the Elo
slider alone); at or above 2600 the path is byte-for-byte what shipped before.

## Lanes

**Assets and build** — `assets/models/maia3/` ships all three sizes as fp16-weight ONNX
(10.9 + 45.9 + 156.2 MB; `MAIA_MODEL_FILES` pins bytes and SHA-256, and the Hugging Face
revisions and checkpoint hashes they were exported from). The 79M file is stored in the
repository as two `.part` slices under the Git host's 100 MB cap and joined by the build
(`scripts/maia-assets.ts`, called from `copyBundledAssets`; SHA-256 verified on join and again
by `verify-dist` rule 8). `tools/data/09_export_maia3.py` reproduces the export (pinned upstream
commit, fp16 pass, split, manifest, fixtures). `docs/third-party.md` is regenerated with the
Maia-3 AGPL-3.0 notice and the corresponding-source offer extended to it; the licence text ships
in `assets/models/maia3/LICENSE`. The release zip grows from 134 MiB to 320 MiB.

**Core policy** — `src/core/policy/`: the encoder (`encodeMaiaInputs`: 64 square tokens × 8
history frames × 12 piece planes, each frame mirrored on its own side to move, the earliest
repeated to fill; the 4352-move vocabulary), the decoder (`decodeMaiaOutputs`: legal-masked
softmax un-mirrored to the board frame, WDL), `temperedWeights`, and `maiaSizeFor` /
`usesMaia`. Written from the paper, not from the upstream AGPL package. Bit-exact on the 60
fixture positions; `test/integration/maia-onnx.test.ts` runs every size on the vendored
onnxruntime and agrees with the torch reference on argmax 60/60 and top-5 60/60 for all three
(max |Δp| ≤ 6e-4), at p50 13–16 / 46–52 / 162–196 ms single-threaded under Bun.

**Offscreen host and port** — `src/offscreen/maia-store.ts` (verified bundled bytes),
`src/offscreen/policy-inference.ts` (one resident session, warm-up on the start position,
single-thread retry, doubling cooldown after a failed load, never throws across the port),
`engine-host.ts` routes `policy` / `policy-warm` / `configure.warmPolicy`;
`src/service/handlers/engine/policy-infer.ts` is the service-worker side (per-query expiry,
abort, `warm`). Wire contract in `src/core/constants/messages.ts` (`policy`, `policy-result`,
`policy-status`) and `src/core/policy/types.ts` (`PolicyPort`).

**Selection** — `src/core/strength/maia-select.ts` and the Maia branch in `selectMove`; the
pipeline queries the policy in parallel with the search and runs the referee search at full
strength with the sampling breadth (`maiaSearchMode`, `refereeElo`); the predicted-position
pre-analysis asks for the same shape so the cache still hits. `ChosenMove.source` gains
`"maia"`; `Recommendation.maia = { size, wdl, ms }`. The draw is Maia's own distribution
(`MAIA.temperature` 1 — the owner's ruling: run the models as advertised and take the rating at
face value; a self-play calibration sweep was started and stopped on that ruling), with the
mistakes slider as the only heat control and the engine's never-play rails on top. Maia chooses
over its whole distribution (2026-09-12, the owner: "the maia model should be able to more freely
choose"): when its unscored legal moves carry `MAIA.extraMassMin` of the mass (or one of them
`MAIA.extraTopProb`), the pipeline runs one extra full-strength `go searchmoves` on the top
`MAIA.extraCandidates` of them (`MAIA.extraSearchMs`, 260 ms of its own, never over the class's
movetime, skipped when the clock fraction binds) and merges the lines into the pool the draw is
over, so a favourite
the MultiPV set did not rank is scored, railed and drawable; `searchmoves` results never touch
the analysis cache. Design, knobs and fallbacks:
[`maia-selection-2026-09-11.md`](maia-selection-2026-09-11.md).

**Panel** — the strength slider carries an unlabelled second divider at 2600 (`markers`, shorter
and dimmer than the 3200 network divider). The hot-range animation is rebuilt without the flame
particles: a slow drifting ember gradient in the fill (9.6 s), a breathing halo on the thumb
(2.4 s) and the warm sweep kept with a soft head and tapering tail whose **crossing speed is
constant** (two widths per 4.8 s — 3.75× slower than the old speed at max) and whose **cadence
rises with energy** (`STRENGTH_UI.flowGapMax` → `flowGapMin`: a sweep about every 6 s at 3200,
every 2.6 s at 3800). All three scale with `--sl-slider-energy` and respect reduced motion. The
Engine view names the active selection model ("Selection · Maia-3 · 23M", "… Stockfish 18 ·
small net", "… full net") and carries a **Human model** block beside the engine's (owner's
follow-up): the active size with an Off / No answer yet / Answering pill, the last answer's pick
probability and side-to-move W/D/L (or "Engine policy for this move" when the selector fell
back), the inference time as the numeral, and its own sparkline — one point per recommendation
the model answered (`LIMITS.policySparklineSamples`, 60), in the success colour so it reads apart
from the nps series. `Recommendation.maia.p` / `ChosenMove.maiaProb` carry the pick probability
from the selector for it. Settings gain the "Human model" toggle under the Elo slider.

**Input mode** — `auto` now draws the click share by travel distance
(`src/core/motor/input-style.ts`): `CLICK_MOVE.autoClickProb` 34 % for a hop under 4 squares,
`autoClickProbFar` 12 % for a carry of four or more (Chebyshev).

## The full build's crashes (2026-09-12)

The owner's console: the full build (`sf_18.js`) crashing in a pthread worker — "Uncaught
RuntimeError: table index is out of bounds" — then crashing again on every reboot until the host
gave up, and the game stuck on "the engine produced no line for this position" (the session's
12 × 250 ms retry gave up while the engine was still rebooting). The same family of fault
(`call_indirect` signature mismatch) is what made `test/integration/full-engine.test.ts` flaky
under load. A Bun probe of the multi-threaded full build driven the way a game drives it (four
threads, ponder → stop → full-strength MultiPV 20 referee → pre-analysis, six rounds) did not
reproduce it, so the fault is browser- or state-specific; three changes, none of which depends
on the root cause:

- **The relaxed-SIMD full build is now vendored and preferred** (`ENGINE_FILES.full.relaxedJs`,
  `chooseModule`), exactly as the small net already was. It is the build lichess itself runs
  in Chrome; the plain-SIMD `sf_18.js` — the one that faulted — is now only the fallback for
  browsers without relaxed SIMD.
- **A second consecutive crash of the full build reboots as the small-net build** instead of
  burning the remaining backoff on the same fault (`EngineHost.fallBackIfRepeated`). The status
  carries `fallbackFrom: "full"`; `RemoteEngine.configureAndWait` accepts it, so the service
  worker's configuration completes and the game goes on at the small net; a later `configure`
  asking for `full` is answered by the running fallback; the Engine view's version row says
  "full build crashed · small net until restart", and the panel's Restart button is the way
  back to the requested build.
- **`TIMINGS.sessionRetryMax` 12 → 40** (10 s of asking again): long enough for the backoff, a
  reboot and its nets.

## Pondering and the line preview (2026-09-12)

Two further owner requests landed in this batch, each with its own doc:

- **"Make large humanization improvements to the pondering code"** — the opponent-turn free
  movement is now an *attention plan* per turn (first look → still → activity/glance/still …,
  by time control, the opponent's think length, our clock, the phase, an armed premove/hold),
  with line reading in order, threat and king checks, rare off-board glances, centre-weighted
  rest spots, drift instead of stillness, and turns with no pondering at all:
  [`pondering-2026-09-12.md`](pondering-2026-09-12.md).
- **"A 'simulating' executor action … right click then drag and release … mapping out a
  line"** — `HandController.previewLine`: during a long think the hand draws chess.com's own
  arrows along the chosen line (2–4 plies, sometimes a second line) with right-button drags,
  classified as annotations in the telemetry (never a selection, never a move), the move's
  own left press clearing them: [`line-preview-2026-09-12.md`](line-preview-2026-09-12.md).
  The one thing only a real board can confirm is that chess.com draws on the right drag and
  clears on the left press exactly as assumed; the doc says how to check. Follow-up the same
  day: 3–7 plies per line (`LINE_PREVIEW.plies`), and lines that do something around the piece
  the opponent just moved are preferred (`nearRadius` / `nearWeight` / `nearSecondLineProb`).
- **"As elo gets higher, the amount that we speed up book moves should increase drastically
  until they are extremely fast starting at around 2100"** — `TIMING_CONSTANTS.bookSpeed`
  (`src/core/timing/timing-model.ts`, after the quick-reply regime): an in-book move's planned
  think is multiplied by a factor of the target Elo — 1 at 1200, 0.85 at 1500, 0.55 at 1800,
  0.3 at 2000, 0.15 at 2100, 0.12 from 2400 — jittered ±25 % from a per-position stream, never
  under the physical gesture or 0.35 s; a `long` plan becomes `normal`. `in_book` is the timing
  feature's (the session's book answer, or an early top-line move), so the same moves the head
  already treated as book get the speed-up. `test/core/timing/book-speed.test.ts`.

## Small fixes (2026-09-12)

- **A cleared mark fades out.** `ovClear` in `src/page/highlight-overlay.ts` used to cancel the
  mark's animations and remove the overlay on the spot, so in a fast endgame the marks snapped
  away one after another. It now renames the overlay out of the lookup class (a draw that
  follows gets a fresh one on top), leaves its running animations alone, and fades it to
  transparent over `HIGHLIGHT_MOTION.clearFadeMs` (220 ms) before removing it; without motion
  (reduced motion, no `animate`) it is removed as before. `test/page/highlight-overlay.test.ts`.
- **The persona-offset slider marks ±0** with the unlabelled hairline the strength slider uses
  for its model switches (`markers: [0]` on the `strength.personaEloOffset` row).

## Three timing terms, the confirm label, low-time clicks (2026-09-13)

All in `src/core/timing/timing-model.ts` after the book term, constants in
`TIMING_CONSTANTS`, pinned by `test/core/timing/clock-terms.test.ts`:

- **The "basically forced" reply** (`threatReply`): `src/core/chess/threat.ts` reads the position
  for our pieces attacked by a *cheaper* enemy piece (a pawn on a knight, a knight on a rook;
  kings and pawns excluded); when the chosen move moves that piece or takes the attacker the
  planned think is ×0.55, never under 0.45 s or the physical gesture. Not on a forced move (the
  quick reply already has it), a premove or in the emergency regime.
- **The evening term** (`evening`): `factor = 1 + 0.12 · clamp((ours − theirs) / 60 s, −1, 1)`
  — longer when they have less time, shorter when they have more. Lengthening only while our
  clock is above 30 s, never past the hard cap, and never more than 15 % of the lead itself;
  shortening never lifts a capped plan back to a floor.
- **The low-clock ramp** (`lowClock`): under 20 s left the think is multiplied by a factor
  falling from 1 at 20 s to 0.45 at 5 s and below, on top of the head's own compression; it
  stops where the §8.5 emergency regime and the clock race take over, so their windows are
  untouched. The Step 2f characterisation ("the hand is a small part of a move") now excludes
  moves under 20 s, which are the motor by design.
- **Resign confirmation**: the confirmation's label is exactly "Resign" (`resignConfirmTextRe`
  `/^resign$/i`); the popup-aware discovery (a control not visible before the resign click,
  never the resign control itself) stays.
- **Low-time clicks** (`CLICK_MOVE.lowTime*`, `src/core/motor/input-style.ts`): the auto mode's
  click share ramps from its ordinary value at 30 s left to 75 % at 10 s and below, whatever the
  distance; premoves and holds are drags by construction.

## The Live view catching up (2026-09-13)

The owner: "sometimes, when in a game, the live state of the UI doesnt know its in a game until I
click out of the sidebar tab and re-open it (in the meantime the bot is playing the game just
fine)". Reopening the panel makes a fresh `PANEL_GET_SNAPSHOT` request, and that is what put the
view right, so `PanelStore` now repeats that request as a backstop: every
`TIMINGS.panelSnapshotPollMs` (2.5 s) while its document is visible, and at once on every
visibility or focus return. A push that arrives supersedes an in-flight request (the store's
`generation`), so the two never fight; the poll keeps the worker awake while the panel is open,
which is by design. The root cause of the missed push was not reproduced in the simulator
(`test/panel/store.test.ts` pins the backstop); if the Engine view's log shows
`panel-broadcaster: tabs.query failed` or a `hello` for a different window while it happens, that
is the lead.

## Verification

`bun run check` (the full gate) and `bun run build` exit 0 on the tree that produced the zip;
`js/panel.js` 235.9 KiB of its 400 KiB budget (an unminified `--dev` build reads 414 KiB
against the same budget — pre-existing, the dev build is not what ships). New suites:
`test/core/policy/*`, `test/integration/maia-onnx.test.ts`, `test/offscreen/{maia-store,policy-inference}.test.ts`,
`test/service/handlers/policy-infer.test.ts`, `test/behavioral/game/maia-warm.test.ts`,
`test/core/strength/maia-select.test.ts`, `test/scripts/maia-assets.test.ts`,
`test/core/motor/input-style.test.ts`, plus the extended slider, engine-view, recommendation,
engine-host and verify-dist suites.

## Known gaps

- Everything only a browser can answer: in-browser latency and memory per size next to
  Stockfish (the 79M session is ≈ 0.9 GB resident in the Bun measurement), the cold-load cost of
  reading a 156 MB packaged asset, a mid-game size switch on a real opponent-matched target.
- No calibration against `AGREEMENT_BANDS` by the owner's ruling; the session strip's bands are a
  diagnostic below 2600, not an acceptance test.
- `assets/engine/LICENSE` is the GPL-3 text although the vendor script labels it AGPL — a
  pre-existing mislabel noticed while adding the Maia notice; not changed here.
