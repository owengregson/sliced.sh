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
  port deliveries, async `sendCommand` / `executeScript` callbacks). Code that
  resumes after an `await` runs in whichever context is active at that moment;
  wrap such flows in `ctx.run(...)` when it matters.
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
  context and detaches the debugger with `target_closed`.

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

## DOM (happy-dom)

- happy-dom skips capture-phase listeners when an event is dispatched on the
  same target, its `KeyboardEvent.preventDefault()` is a no-op unless
  `cancelable: true`, and `Element.getBoundingClientRect()` returns zeros for
  elements without a recorded rectangle.
- `installWindowGlobals` exposes `window`, `document`, `location`, the DOM
  constructors, observers, rAF and web storage of the context's window as
  globals; `navigator` is Bun's.
