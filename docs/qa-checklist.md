# QA checklist

Manual checks that the automated suite cannot make. Run them against `bun run build --dev`
loaded unpacked in Chrome (`chrome://extensions`), with the side panel open next to a lichess or
chess.com tab. Tick every box before a release; note the Chrome version and OS in the release
notes. Task 31 adds the real-site sections (adapter, executor, telemetry).

## Accessibility, keyboard and motion (Task 27)

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
      Live, ≥ 8 px between adjacent targets.
