# Adapter tests — observer coverage note (for Task 31 manual QA)

happy-dom 16.8.1 has a `MutationObserver` defect: records are delivered only for
mutations made before the first macrotask hop after the page loads; every later
mutation is silently dropped (reproduced with a bare `new Window()`, no test
preload involved). Chrome is unaffected.

Consequences for what these suites prove:

- `loadFixture()` installs a **polling shim** (`installPollingObserver` in
  `helpers.ts`) on the tab window. The adapter takes `MutationObserver` from its
  `window`, so shipped code is untouched. The shim ignores `init`, snapshots the
  observed subtree every 4 ms and delivers one synthetic `childList` record (with
  the real added/removed elements) or one `attributes` record. Everything that
  drives `onPositionChange` / `onGameEnd` / `observeMove` through mutations runs on
  this shim, so those tests verify the *evaluation pipeline* (debounce, dedupe,
  unstable-state skips, hybrid FEN), not the browser's observer semantics.
- The **genuine happy-dom observer** is exercised once, for the one case it
  supports (`loadFixture(name, undefined, { observer: "native" })`): a single
  attribute flip on the board made synchronously after construction fires
  `onPositionChange` exactly once.
- The `observe(target, init)` **registrations themselves** are asserted with a
  recording stub that honours `init` but never delivers
  (`{ observer: "recording" }` + `installRecordingObserver`): target, `childList`,
  `subtree`, `attributes`, `attributeFilter`, `characterData` per concern, and that
  re-installing after a container replacement disconnects the previous set (the
  active-observer count stays bounded).

Not verified by any test here and to be confirmed on the live site in Task 31:
`attributeFilter` sufficiency against real chess.com mutation streams,
`characterData` deliveries from the chess.com move list, the body observer's
added/removed-node filter on real SPA re-renders, and `observeMove`'s body
observer under real drag/animation timing.
