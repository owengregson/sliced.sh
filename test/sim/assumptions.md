# Simulator assumptions — where `test/sim` deliberately differs from Chrome

The simulator models the Chrome extension platform closely enough for
behavioural tests of the service worker, panel, content script and offscreen
document to be meaningful. Everything below is a deliberate simplification.
When a test escapes to manual QA because Chrome behaved differently, add the
quirk here and fix the simulator — never bend the test to the simulator.

## Execution model

- **One global `chrome`.** Chrome gives every context its own realm; here
  every context shares one JS realm and `globalThis.chrome` is swapped by
  `bootXContext` / `ctx.activate()` / `ctx.run(fn)`. Callbacks the simulator
  itself invokes are re-homed to the context that registered them (fake
  timers, `chrome.*` event listeners, `onMessage` / `onConnect` listeners,
  the sender's `sendMessage` callback, port deliveries, async `sendCommand` /
  `executeScript` callbacks). Code that resumes after an `await` runs in
  whichever context is active at that moment; wrap such flows in
  `ctx.run(...)` when it matters. Teardown may happen in any order: every
  installed global keeps a stack of installers (`installGlobals`), so removing
  a lower context leaves the current top in place and removing the top
  re-applies the next one. Teardowns triggered by simulator events (tab
  removed, offscreen document closed) run on a microtask, after the event
  listeners' re-homed activation has unwound.
- **Side-panel pages get the full API** (`tabs`, `alarms`, `debugger`,
  `sidePanel`, `offscreen`, `commands`, `tts`, `scripting`, `windows`) like
  the SW; content and offscreen contexts get `runtime` + `storage` only.
- **Callbacks are synchronous.** `chrome.storage.*`, `tabs.*`, `alarms.*`,
  `sidePanel.*`, `offscreen.*`, `tts.*`, `runtime.getContexts` and the
  one-shot message transports invoke their callback (or settle their Promise)
  synchronously inside the call. Chrome always defers to a later task. Port
  `postMessage` / `disconnect` deliveries and `debugger.sendCommand` results
  are asynchronous (microtask) as in Chrome, because `connectPort` relies on
  attaching listeners after `connect()` returns.
- **`lastError`** is set only for the duration of a failing callback, on a
  single bus-wide host shared by every context's `runtime` (Chrome keeps one
  per context). Callbacks that never read it are recorded in
  `sim.bus.lastError.unchecked` (Chrome would log "Unchecked
  runtime.lastError"). Promise-form calls reject with an `Error` carrying the
  same message. `runtime.lastError` is also assignable so hand-rolled stubs
  can drive it.
- **Serialisation.** Messages, responses, port payloads and storage values are
  JSON-cloned (`JSON.parse(JSON.stringify(v))`): functions and `undefined`
  properties are dropped, `Date`/`Map` degrade like they would over Chrome's
  structured-clone-to-JSON boundary.
- **No realm for the SW.** `ServiceWorkerGlobalScope` is not defined, so
  `@core/logger` treats a booted SW as a page and forwards logs through
  `runtime.sendMessage` (harmless: nobody listens and the rejection is
  swallowed). The `self` global is left untouched.

## Contexts and the bus

- `runtime.sendMessage` reaches every other non-content context (SW, panel,
  offscreen); `tabs.sendMessage(tabId)` reaches the content context(s) booted
  for that tab; content scripts never receive `runtime.sendMessage` or
  `runtime.onConnect` — as in Chrome. `tabs.connect` is not modelled.
- With **no listener at all** the caller gets "Could not establish
  connection. Receiving end does not exist."; with listeners that neither call
  `sendResponse` synchronously nor return `true`, "The message port closed
  before a response was received.". A listener that returns `true` and never
  responds leaves the caller pending forever (Chrome would eventually close
  the port when the context dies).
- `runtime.connect(name)` fans out to **every** other non-content context
  that has an `onConnect` listener (each gets its own port end); Chrome does
  the same. `disconnect()` fires `onDisconnect` on the other end(s) only, never
  on the caller — Chrome's documented behaviour. The `(extensionId, info)`
  overload connects to this extension regardless of the id.
- `sender` carries `id`, `url`, `origin`; content senders also carry the real
  `chrome.tabs.Tab` and `frameId: 0`. `documentId` / `documentLifecycle` are
  not set.
- The SW is the simulator's default context: `sim.chrome` is its `chrome` and
  `bootSwContext` reuses it (a second boot without `teardown` throws).
  `teardown()` is SW termination — listeners it registered on any fake and
  ports it held are dropped, `chrome.storage.session` survives. Booting again
  is a restart. Panel / content / offscreen contexts are fresh instances per
  boot and are removed on `teardown`.
- `runtime.getContexts` lists the SW (`BACKGROUND`), booted panels
  (`SIDE_PANEL`) and the offscreen document (`OFFSCREEN_DOCUMENT`, whether
  created via `offscreen.createDocument` or adopted by
  `bootOffscreenContext`). Only `contextTypes`, `contextIds` and `tabIds`
  filters are honoured.
- Listener ownership is by the **active** context at `addListener` time, so a
  test that registers listeners on `sim.chrome.*` while a panel is booted
  attributes them to the panel.

## Storage

- Only `local` and `session` exist (the manifest never uses `sync`).
- `onChanged` fires synchronously inside `set` / `remove` / `clear`, before
  the callback, with `oldValue` only when the key existed; removing a missing
  key fires nothing. Per-area `local.onChanged` / `session.onChanged` also
  fire. Quotas are not enforced; `getBytesInUse` is an estimate.
- `failNextWith(message)` fails exactly the next area call (either area).

## Tabs and windows

- One window (`id 1`, focused) unless `windows.setFocus` says otherwise.
  Tabs are created `loading` and fire `onUpdated({status:"loading"})`;
  `sim.openTab` / `tabs.setStatus` deliver `"complete"`. `tabs.update({url})`
  fires `url` + `status:"loading"` but never `"complete"` on its own
  (`sim.tabs.navigate` does both). `onActivated` fires when the active tab
  actually changes.
- `tabs.query` honours `url` (match patterns, `<all_urls>`, or a plain URL
  prefix), `active`, `status`, `windowId`; `currentWindow` /
  `lastFocusedWindow` are ignored (single window).
- Closing a tab (`sim.closeTab` / `tabs.remove`) tears down its content
  context and detaches the debugger with `target_closed` (`onDetach` fires).

## Alarms and time

- `alarms.create` with an existing name replaces it; Chrome's 30 s minimum
  period (Chrome 120+) is **not** enforced so tests may use short periods.
- Periodic alarms re-arm from the previous `scheduledTime`, so a large
  `time.advance` fires every missed period, in order.
- `time.install()` fakes `setTimeout` / `clearTimeout` / `setInterval` /
  `clearInterval` / `Date.now` / `performance.now` (relative to the clock's
  origin) globally until `uninstall()`; `new Date()`, `setImmediate` and
  `queueMicrotask` stay real. `advance(ms)` fires timers and alarms in due
  order (ties: creation order, timers before alarms) and drains microtasks
  after each with a real macrotask hop; nothing runs unless the test
  advances or flushes. Zero-delay loops abort after 100 000 steps.
- Fake timers remember the context that armed them: they fire under that
  context's globals and are **cancelled when it is torn down** (a terminated
  SW's timers never fire, as in Chrome). Timers armed with no context booted
  belong to the default SW context.
- happy-dom's `window.requestAnimationFrame` runs on real time, not the
  virtual clock (it is happy-dom's own timer), and `TimeController` captures
  the real `setTimeout`/`Date.now`/`performance.now` at construction — if two
  controllers are installed and uninstalled out of LIFO order the earlier
  one's `uninstall()` restores the originals it captured, which is fine, but
  the later one's restores the first controller's fakes.
- `CdpCommandRecord.at`, `TtsCallRecord.at`, `AttachmentRecord.at` and
  `DispatchedPointerEvent.at` are `sim.now()` at call time (ms epoch).

## Debugger and CDP input

- `attach` requires an existing tab and fails when already attached
  (Chrome's messages); `detach` / `sendCommand` fail when not attached.
  `onDetach` fires only through `detachByUser` / `detachTargetClosed` (and
  `sim.closeTab`), never for the extension's own `detach()`, as in Chrome.
- Every `sendCommand` is recorded before it is answered. Answers come from a
  test responder (`sim.debugger.respond(method, handler)`), else the input
  bridge, else `{}`. `Runtime.evaluate` answers `{ result: { type:
  "undefined" } }` by default — page programs are not executed.
- `Input.dispatchMouseEvent` dispatches `pointer*` / `mouse*` DOM events at
  the element `TabDom.elementAt(x, y)` reports; happy-dom has **no layout**,
  so hit-testing and `getBoundingClientRect` come from rectangles the test
  records with `dom.layout(selector, rect)` (later rectangles are on top;
  unmatched points hit `document.body`). Events are `bubbles`, `cancelable`,
  `composed`, carry `clientX/Y`, `screenX/Y` (= client), `button`, `buttons`,
  modifier keys, `pointerId 1` / `pointerType` / `isPrimary`, and
  `isTrusted: true` is defined on the object (happy-dom's `Event` lacks the
  property). `click` fires when a left press and release hit the same
  element; `dblclick`, `contextmenu`, `pointerenter/leave`, hover CSS and
  drag-and-drop (`Input.dispatchDragEvent`) are not modelled.
  `Input.dispatchKeyEvent` resolves `{}` without touching the DOM.
- `getTargets` lists every tab as a `page` target with its `attached` flag.

## Side panel, offscreen, tts, commands, scripting

- `sidePanel.open` does not require a user gesture; calls are recorded in
  `sim.sidePanel.state.opens`. Options merge per tab over the global
  options. `onOpened` / `onClosed` are not modelled.
- `offscreen.createDocument` enforces the single-document rule with Chrome's
  message; `closeDocument` without a document fails with "No current
  offscreen document." and, when an offscreen context is booted, tears it
  down (its ports disconnect). Tearing a booted offscreen context down
  directly does **not** clear the document record — use
  `offscreen.closeDocument()` or `sim.offscreen.reset()`.
- `tts.speak` records the call and delivers `start` then `end` to
  `options.onEvent` on a microtask; nothing is queued or interrupted, and
  `isSpeaking` is only true between `speak` and that microtask.
- `commands.onCommand` fires only through `sim.commands.trigger`; `getAll`
  returns `[]` (the manifest's commands are not parsed).
- `scripting.executeScript` records the injection and returns
  `[{ frameId: 0, documentId: "sim-doc", result: undefined }]` unless
  `sim.scripting.respond` scripts it; nothing is injected.

## The simulated chess site (`test/sim/telemetry/sim-site.ts`)

- **A left press on the board clears the site's own user markings.** Modelled
  by `boardMarks()` in `test/behavioral/game/mark-survives-the-hand.test.ts`,
  the only place that assumes it: a `mousedown` removes a *native* mark and
  leaves an overlay mark alone. chess.com is the only authority on whether it
  is true — `docs/qa-checklist.md` B0.8–B0.9 answers it.

  Two separate things rest on this, and only one of them is safe:

  - The **production fix** does not rest on it. The mark of a move the hand is
    playing is drawn through the bridge's own `<svg>` either way, and if the
    site turns out never to clear anything the overlay mark simply sits there
    as the native one would have.
  - One **test** does rest on it entirely: the last case in that file ("with a
    site that wipes its own markings on a press, …"). Its `atPress` /
    `duringDrag` / `atRelease` assertions are satisfied by the pre-fix code the
    moment the assumption is switched off, so read that case as a statement of
    the owner's symptom, not as proof the symptom is gone. The assumption-free
    proofs are the other cases in that file (the ordering of the board commands
    against the hand's real CDP press stream, the clear on a failed attempt,
    and the lifted-piece republish) together with
    `test/content/mark-to-page.test.ts`, which runs the real content script and
    the **emitted** bridge program against a real DOM and asserts what the page
    actually holds.
- **The simulated site has no `.piece` elements**, so it cannot produce the
  DOM renderer's mid-drag reading at all. The test that covers it posts the
  reading the real adapter was measured to publish (same game, same ply, an
  approximate FEN with the mover missing) straight down the game port.
- **The simulated site does not run `src/content/index.ts`.** It reimplements
  the responders the executor needs (`geometry`, `boardCheck`, `observeMove`)
  and knows nothing about `createHighlights`, so no behavioural test in
  `test/behavioral/` can observe what the content script does with a mark.
  That is why the verifier's "removes nothing" contract is pinned in
  `test/content/mark-to-page.test.ts` instead.

## DOM (happy-dom)

- happy-dom skips capture-phase listeners when an event is dispatched on the
  same target, its `KeyboardEvent.preventDefault()` is a no-op unless
  `cancelable: true`, and `Element.getBoundingClientRect()` returns zeros for
  elements without a recorded rectangle.
- `installWindowGlobals` exposes `window`, `document`, `location`, the DOM
  constructors, observers, rAF and web storage of the context's window as
  globals; `navigator` is Bun's.
