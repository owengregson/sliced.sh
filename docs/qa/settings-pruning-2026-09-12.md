# Settings pruning — 2026-09-12

The owner asked for seven controls to leave the Settings view (and the Live view's strength
popover where they appeared there) while the code behind them stays. The extension now decides
each value: `normalizeSettings` overwrites whatever is stored with `FORCED_SETTING_VALUES` on
every read, so a stale profile, an import or a test patch cannot resurrect a removed option.
`setSettings` still accepts patches for the keys — the normaliser simply wins.

## The one registry

`FORCED_SETTING_VALUES` in `src/core/constants/defaults.ts`. Every value equals its
`DEFAULT_SETTINGS` counterpart (`test/core/storage/settings-storage.test.ts` and
`test/panel/views/settings.test.ts` both check). The panel's reason table `FORCED_SETTINGS` in
`src/panel/views/settings/sections.ts` is typed as `Record<leaf of FORCED_SETTING_VALUES, string>`,
so the two cannot drift.

| Setting | Was | Forced to | Where the code still lives |
|---|---|---|---|
| `strength.persona` | four chips (cautious / balanced / aggressive / blitz-demon) in Settings and the Live popover | `balanced` | `src/core/timing/*`, `src/core/strength/*` (persona latents, premove propensity, exploration); `COPY.personaName` stays for the Engine view's timing log |
| `strength.selectionMode` | chips in Settings, segment in the Live popover (engine / persona / hybrid) | `hybrid` | `src/core/strength/move-selector.ts` (all three branches) |
| `strength.blunderScale` | slider 0–2× | `1` | `src/core/strength/*` blunder model; `LIMITS.blunderScaleMin/Max` remain |
| `execution.calibrateFromMyMouse` | toggle | `false` | the calibration code in the motor / executor |
| `execution.backend` | segment (Chrome debugger / Native) | `cdp` | `src/service/move-executor/*` keeps the `native` path; the row went with its only remaining option |
| `execution.keepDebuggerAttached` | toggle | `true` | `src/service/debugger-manager.ts` (attach once before the game; the infobar layout-shift rule) |
| `engine.nnue` | chips (Small / Large / Auto) | `auto` | `src/core/engine/options.ts` `variantForSettings` (small below `LIMITS.nnueSmallEloMax`, large above) |

## What changed

- `src/panel/views/settings/rows.ts`, `sections.ts`: the seven rows are gone; `rowCopy` now only
  accepts a leaf that has copy (`CopiedPath`), so a row cannot be added back without its strings.
- `src/panel/views/live/strength-card.ts`, `templates/live/strength-popover.html`,
  `css/views/live.css`: the popover is the Elo slider alone; the card label is the band alone
  (`COPY.strength.card(elo, band)`).
- `src/panel/copy.ts`: the dead strings went with the rows — `COPY.persona` (chip descriptions),
  `COPY.execution.debugger`, the seven `SETTINGS_COPY.rows` entries, `SETTINGS_COPY.options`
  `selectionMode` / `backend` / `nnue`, `COPY_LIVE.strength.modes` / `modeLabel`.
- `src/core/storage/settings-storage.ts`: forced keys read from `FORCED_SETTING_VALUES`; the
  enum sets for persona, selection mode, backend and network are gone with the validation they fed.
- `src/types/settings.ts`: each forced key is marked in the `Settings` doc comments.

Still shown, as diagnostics only: the Engine view's timing-log rationale names the persona of each
logged plan (`COPY.personaName`), and the collapsed Live strength chip reads `"<elo> · Balanced"`.

## Tests

- `test/panel/views/settings.test.ts`: the "every setting has a row" invariant now excludes
  exactly `Object.keys(FORCED_SETTINGS)`, checks they equal the leaves of `FORCED_SETTING_VALUES`,
  that each forced value equals the default, and that none renders a row.
- `test/panel/views/live.test.ts`: the popover holds one slider, no chips, no segment.
- `test/core/storage/settings-storage.test.ts`: stored non-default values for all seven keys
  normalise to the forced ones; a `setSettings` patch for them stores the forced value.

Two tests outside this change assert the old behaviour (a stored `persona: "blitz"` flowing
through) and now fail by design — they belong to the game-session lane and were left for its
owner: `test/service/lifecycle.test.ts` ("does not clobber v2 settings already present",
`expect(s.strength.persona).toBe("blitz")`) and `test/behavioral/game/live-settings.test.ts`
(`exploration: { persona: "blitz", previewScale: 2 }` after `h.patch({ strength: { persona:
"blitz" } })`).
