# In-game progress review — 11 September 2026

The live view now reads in one order: operational phase, paired clocks, persistent evaluation,
move and actual execution countdown, keyboard controls, principal variations, then session
configuration and diagnostics. The implementation keeps the existing templates, shared tokens,
logo, read-only live policy, and 3650 rating/network controls.

## Audit and corrections

- `src/panel/views/templates/live.html:10` — both clocks now share a fixed scoreboard above the
  move card. Evaluation stays in that scoreboard during either turn, analysis, execution, and
  errors; disabling the evaluation setting still hides it.
- `src/panel/views/live.ts:352` — one phase heading reports Waiting…, Analysing…, Executing…,
  Ready, Paused, or Engine error. Scheduled delay and opponent wait share the concise Waiting…
  heading; the progress row identifies the next action. Identical snapshots do not repeatedly
  replace the live-region heading.
- `src/panel/components/move-card.ts:150` — one determinate bar measures the actual scheduled
  deadline. No fabricated search or input percentage appears. Withdrawing a schedule clears
  the countdown; execution remains visible through repeated snapshots and clears next turn.
- `src/panel/components/move-card.ts:214` — recommendation text updates immediately. An earlier
  SAN animation can no longer finish later and repaint an obsolete move. Repeated snapshots do
  not announce the same recommendation again.
- `src/panel/components/button.ts:106` — repeated `loading: null` updates preserve the current
  button label instead of resetting it to an empty fallback.
- `css/views/live-progress.css:1` — phase changes preserve clock, evaluation, move-card and
  shortcut geometry. Controls that are unavailable during live play no longer look like
  clickable buttons; shortcut hints remain visible. Session configuration uses compact text,
  with strength and telemetry below the main progress area. Low clocks retain danger styling.
- `css/views/live-progress.css:128` — semantic foreground color improves move-text contrast in
  light mode; the miniature evaluation rail has a visible boundary on either theme. Countdown
  motion uses a transform and stops for system or explicitly selected reduced motion.

The audit used the current [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md),
fetched on 11 September 2026. Review emphasis: semantic controls, state announcements, stable
layout, long labels, low-time readability, reduced motion, and theme contrast.

## Verification

- All 207 panel tests across 29 files pass in isolated Bun processes. New tests cover phase
  transitions, paired-clock/evaluation placement, real countdown progression and withdrawal,
  and repeated executing snapshots. Existing shortcut, live-lock, settings, route and quiet
  move-feedback tests continue to pass.
- TypeScript, CSS token validation, scoped Biome checks, and `git diff --check` pass.
- Browser fixture: `bun tools/panel-preview.ts`, then
  `http://127.0.0.1:4179/?state=thinking` for the scheduled execution phase.
- Main states: `opponent`, `analysing`, `thinking`, `executing`, `lowtime`, `error`, `live`,
  `cached-opponent`, `cached-thinking`, `no-rec`, and `unarmed`.
- Additional options: `&theme=light`, `&motion=reduced`, `&eval=off`, `&elo=3650`, and
  `&opponent=LongOpponentName`. Settings controls remain in `?state=settings`.
- Screenshots and measured DOM audit: `build-logs/ui-progress-review/`. Review includes
  320/360/480 px widths, light and reduced-motion variants, long names, and the rating ceiling.
  The primary scoreboard and move card retain identical rectangles across all move phases at
  each viewport. No horizontal overflow or unnamed visible buttons were found.

The preview renders the actual panel code with a deterministic Chrome boundary. It validates
panel layout and state projection; native game input, service timing, and engine behavior are
covered in their separate workstreams. No build, commit, or push was performed in this lane.
