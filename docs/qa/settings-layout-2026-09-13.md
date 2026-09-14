# Settings layout — 2026-09-13

The owner's brief: recategorise and reorder the Settings view for everything added since the
2026-09-12 pruning (rematch titled, board effects, virtual pointer and its effects, input mode,
the H2 accuracy offset, the engine defaults), delete what no longer earns a row, expose what can
be strongly justified, make the slider sounds smarter and put a numeric readout under the thumb
of the label-only sliders. This note is the rationale; the code is `src/panel/views/settings/
sections.ts` (order), `rows.ts` (controls), `src/panel/copy.ts` (strings),
`src/core/storage/settings-storage.ts` (migrations), `src/panel/sounds.ts` (detent scheduler)
and `src/panel/components/slider.ts` (readout).

## The principles

1. **Most-used and most-consequential first.** The rating and the master switches are what a
   user touches before every session; theme and log level once.
2. **A control's dependants sit directly beneath it** and are disabled while it is off, so the
   eye reads "this, and then these details of it": auto-queue → its ranges → rematch; highlight
   → its style; effects → its chips; virtual pointer → its effects; match opponent → persona offset.
3. **Paired ranges stay adjacent** (session min/max, break min/max).
4. **One knob per concept.** Two knobs that can only sensibly agree are one knob.
5. **Dangerous and rare last** (engine resources, account, reset) — but never hidden behind a
   second level: the category chips and the search stay the only navigation.
6. **A section is a place, not a mechanism.** Strength · Automation · Timing · Hand describe
   what the assistant does; Board and Panel describe where things are drawn (the chess.com page
   vs this side panel); Keybinds, Engine, Account, Advanced are what they say.

## Sections, in order

| # | Section | Why it exists | Rows, in order, and why |
|---|---|---|---|
| 1 | **Strength** (kept first, owner) | The one number every session is about. | `targetElo` first (owner). `matchOpponentRating` next — it *replaces* the fixed rating (the slider dims when it is on). `personaEloOffset` beneath it — it only applies while matching (help says so; it is disabled otherwise, new). `blunderScale` shown as **Accuracy offset** (±`MAIA.slider.eloSpan` Elo, Part 4a) — the second modifier on the rating, fine-grained, after the coarse one. `useOpeningBook` last: on by default and rarely touched. |
| 2 | **Automation** | Whether the assistant acts by itself. The master switch has to be near the top (§4.4), and the auto-play opt-in is the most consequential toggle in the product, so this is the second section rather than fourth. | `enabled` (master) first. `autoMove` (the opt-in) beneath it. `resignLostGames` (new, Part 4c) directly beneath auto-play because it is a thing the *armed hand* does. `autoQueue`, then its four ranges (session min/max, break min/max — paired, adjacent, disabled while auto-queue is off), then `rematchTitled` (a queue step, disabled likewise). |
| 3 | **Timing** | When the hand plays, given that it plays. | `profile` (the preset picks a bundle) first; then the four knobs the preset scales: `speedScale`, `varianceScale`, `longThinkFrequency`, `premoveTendency` — the two that shape the think distribution together, the premove knob (an event, not a duration) last. |
| 4 | **Hand** | How the pointer commits a move. Was buried inside "Execution" beside the auto-queue ranges. | `inputMode` first (the most visible property of a move: drag or click), `motorSpeed`, `previewSelectScale` (one slider with an Off position, Part 1 merge), `verifyMoves` last — a safety check, on by default. |
| 5 | **Board** | What is drawn *on chess.com's board*. | `highlightMoves` → `highlightStyle` beneath (disabled while highlights are off, new). `boardEffects` → `moveQualityChips` beneath (new, Part 4b; disabled while effects are off). `virtualCursor` → `cursorEffects` beneath (disabled while the pointer mirror is off, new). |
| 6 | **Panel** | This side panel: what the Game view shows and how the panel looks and sounds. | `evalBar`, `multiPv` (**Lines**, the merged knob — the lines the engine searches are the lines the Game view shows), then appearance: `theme`, `reducedMotion`, then feedback: `uiSounds`, `ttsVoice`. |
| 7 | **Keybinds** | Unchanged: the four actions. | `playMove`, `toggleAutoMove`, `disable`, `speakMove`. The Scope row is gone (below). |
| 8 | **Engine** | Compute resources — consequential for the machine, not the game, and set once. Split out of "Advanced" so a user looking for threads/hash finds them by name. | `threads`, `hashMb`, `depthCap` (read-only, derived from the active rating). |
| 9 | **Account** | License, plan, device, sign out. Unchanged. | — |
| 10 | **Advanced** | Diagnostics and the two destructive actions. | `logLevel`, `timingLogEnabled`, export, reset. |

The previous "Execution" section mixed the master switch, the auto-queue ranges and the hand's
motor knobs; "Display" mixed board marks, the panel theme and the pointer mirror; "Advanced"
carried the engine resources. Each of those is now one place.

A stale `ui.settingsCategory` from the old ids (`execution`, `display`) falls back to *All*.

## Deletions (each with a migration in `normalizeSettings`)

| Leaf | Decision | Why | Migration |
|---|---|---|---|
| `display.pvCount` | **Deleted; merged into `engine.multiPv` ("Lines").** | Two "lines" knobs that could disagree: the engine searched ≥ `max(adaptive, multiPv, breadth)` lines and the panel showed `pvCount` of them. The panel can show what the engine searches, so the count of lines searched *is* the count shown. Default 4 (the engine's; was 3 shown). The Game view's count chip writes `engine.multiPv` (1–8, subject to the collapse budget). | The key is dropped (the normaliser rebuilds the object); a stored `engine.multiPv` is kept as it was. Pinned: an old profile with `display.pvCount: 2` loads, no `pvCount` key remains. |
| `execution.previewSelects` | **Deleted; folded into `execution.previewSelectScale`, whose range becomes 0…2 with 0 = Off.** | A scale with an "off" position is one control. `executorSettingsFor` reads `previewSelectScale` alone (0 → previews off). | Stored `previewSelects: "off"` → `previewSelectScale: 0`; `"auto"` keeps the stored scale. Pinned in `settings-storage.test.ts`. |
| `timing.respectBudget` | **Forced `true`** (`FORCED_SETTING_VALUES`). | Off swaps `budgetController` for `scheduleAlloc`, which ignores the clock entirely — in bullet it plans thinks the clock cannot afford. No legitimate use; the code path stays for the timing tests. | Forced on every read like the 2026-09-12 leaves. |
| `automation.highlightStyle` | **Kept.** | `AdapterBase.highlight` renders all three: `squares` (no arrow), `arrows` (no squares), `both`. Now sits beneath Highlight moves and is disabled while it is off. | — |
| `keybinds.global` | **Forced `false`.** | Chrome's own shortcuts (`manifest.json` `commands`, editable at chrome://extensions/shortcuts) fire regardless of this flag — the SW forwards `commands.onCommand` unconditionally. All "Global" did was make the captured page keybinds inert (except bare Space) and mark them invalid without Ctrl/Alt. A scope switch that only ever *removes* the user's shortcuts is not a setting. The content listener's `global` branch and the keybind component's `global` option stay in code. | Forced on every read. |

## New settings (Part 4)

| Leaf | Verdict | Why |
|---|---|---|
| `strength.blunderScale` → **Accuracy offset** | **Exposed** (un-forced). Slider −250…+250 Elo, step 25, default 0; the leaf stays 0–2 in storage and the row maps display ↔ storage (`display = eloSpan · (1 − scale)`, so +150 means "plays as a 150-higher rating would", the intuitive sign). | H2 made it an honest Elo offset on the rating Maia is asked about and the rails judge at (`sliderEloOffset`), distinct from the persona offset (which moves the *target*, engine strength and timing included). The blunder channel keeps reading the 0–2 unit, so a storage migration would have to convert in five readers — the display mapping is the clean side. The copy for the row already existed (`SETTINGS_COPY.rows["strength.blunderScale"]`). |
| `automation.moveQualityChips` | **Exposed**, default on, beneath Board effects. | The chip is the one board element that shows an *evaluation* (best / mistake / blunder, chess.com-review style) where the rays show chess facts; and it is the only part of board effects that costs engine time (a dedicated search for every landed move without lines). Off: `BoardEffectsReporter.prepare` is a no-op and `report` posts the rays without opening a verdict job — no chip, no search. The content script needs no new field: it draws only what arrives. |
| `automation.resignLostGames` | **Exposed**, default on, beneath Auto-play. | `shouldResign` had no setting: an armed hand always resigned a forced mate ≤ `RESIGN.maxMateIn`. Some owners will want the game played out (rating-farming a flag, or simply never resigning). One boolean read at the top of `shouldResign`. |
| Lobby hold | Not exposed. | Automatic detection of the queue screen; nothing to configure. |
| Release the mouse on breaks | Not exposed. | Automatic; a break with a held pointer would be a bug, not a preference. |
| Rematch timeout | Not exposed. | `REMATCH.acceptTimeoutMs` is fine as a constant; the help text names it. |

## Disabled-when rules (`settings.ts` `disabledFor`)

| Row | Disabled while |
|---|---|
| `strength.targetElo` | `matchOpponentRating` on (as before) |
| `strength.personaEloOffset` | `matchOpponentRating` **off** (new — it is only added when matching) |
| auto-queue ranges, `rematchTitled` | `autoQueue` off (as before) |
| `automation.highlightStyle` | `highlightMoves` off (new) |
| `automation.moveQualityChips` | `boardEffects` off (new) |
| `display.cursorEffects` | `virtualCursor` off (new) |

## Slider sounds: the detent scheduler (Part 2)

`createDetentScheduler(range, now)` in `src/panel/sounds.ts`, pure and per slider; the slider
component owns one and hands its ticks to the shared player. Constants in `SLIDER_SOUND`:

| Rule | Constant |
|---|---|
| The slider's steps are grouped into at most `maxDetents` audible detents (group size `ceil(steps / maxDetents)`); a sound is possible only when the thumb's detent index changes. | `maxDetents` 24 |
| A per-slider rate limiter keeps ticks ≤ `maxTicksPerSecond`: the crossing speed (detents per second over the last move) gives `k = ceil(speed / maxTicksPerSecond)` and only every k-th detent ticks; a hard minimum interval of `1000 / maxTicksPerSecond` ms guarantees the cap whatever the speed. Slow drags tick every detent. | `maxTicksPerSecond` 14 |
| Pitch follows position (as before). | `pitchMin` 0.8, `pitchRange` 0.65 |
| Volume drops with crossing speed: full at ≤ `volumeAtSpeed.slowDetentsPerSec`, `volumeAtSpeed.minFraction` of it at ≥ `fastDetentsPerSec`, linear between. | 4 / 30 detents·s⁻¹, 0.35 |
| Release plays one soft settle tick (`settleFraction` of the volume) only when the value changed since the press. | `settleFraction` 0.7 |
| Keyboard steps always tick (they are deliberate; the cap still holds on key repeat). | — |

Same `smallSlide` sample (C5: no new files).

## The readout (Part 3)

`SliderOptions.readout?: (value) => string`. When set, a muted `.sl-slider__readout` under the
thumb shows the numeric value while the slider is changing and fades out
`UI_TIMINGS.sliderReadoutFadeMs` (1500 ms) after the last change (timer reset per change; under
reduced motion it hides without a transition). It is `aria-hidden` — the bubble already carries
`aria-valuetext`. Rows whose resting text is a label supply it: Variance (`1.15×`) and Motor
speed (`1.00×`).

## Tests

- `test/panel/views/settings.test.ts`: the new section ids and order, `targetElo` first,
  `enabled` first in Automation, the invariant (every leaf has a row except the forced ones and
  `display.tts`), the disabled-when rules, the accuracy-offset display mapping, the merged
  lines row, the Off position of the preview slider.
- `test/core/storage/settings-storage.test.ts`: old shapes with `display.pvCount`,
  `execution.previewSelects`, `timing.respectBudget: false`, `keybinds.global: true` load; the
  forced table; `blunderScale` clamped, no longer forced.
- `test/panel/sounds.test.ts`: the scheduler with a fake clock — slow drag ticks every detent,
  fast drag never exceeds the cap, no tick without a crossing, release-without-change silent,
  keyboard steps tick, volume falls with speed.
- `test/panel/components/slider.test.ts`: the readout appears on change, fades after 1500 ms,
  resets its timer, and is absent without `readout`.
- `test/service/game-session/executor-settings.test.ts`, `test/behavioral/game/live-settings.test.ts`:
  previews off is scale 0.
- `test/behavioral/game/resign.test.ts`: `resignLostGames: false` plays the mate out.
- `test/service/game-session/board-effects-chips.test.ts`: chips off → rays only, no search.
- `test/panel/views/live.test.ts`, `live-collapse.test.ts`: the Game view reads `engine.multiPv`
  (four rows by default; the §8.2 collapse walk is pinned at three).

## Not this change

`test/behavioral/game/timing-observation.test.ts` ("includes search time in full-move feedback")
fails in the current working tree (5200 ms against 4000) with or without this change's settings:
it passes at `HEAD` with every working-tree change stashed, and the uncommitted work in
`src/service/game-session/session.ts` and `src/core/timing/timing-model.ts` is what it exercises.
