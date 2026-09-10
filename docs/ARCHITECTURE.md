# Architecture

A condensation of Part I of
`docs/superpowers/plans/2026-09-03-sliced-v2-implementation-guide-v2.md`, which stays the binding
spec — this file is the map, not the territory. Section numbers below are that plan's.

---

## 1. What it is

sliced.gg is a Manifest V3 Chrome extension that watches a live game on chess.com or lichess,
recommends a move at a chosen strength, and — when the user arms it — plays that move with a
humanised pointer at a humanly-plausible time. Chrome 128+, side panel UI, no Firefox/Safari
port, live games only (no puzzles or analysis boards), desktop layouts only (§1.4).

The single design pressure behind almost every structural decision is §13, the **telemetry
contract**: chess.com's `fps` plugin records per-move client signals (blur counts, focus toggles,
pointer continuity, event trust, timing distributions), so the extension must be indistinguishable
from a person at that layer. Anything that looks over-engineered in the executor, the timing model
or the focus rules is there for that reason.

---

## 2. Runtime contexts (§3.1)

```
┌──────────────────────────── Chrome ────────────────────────────────────────────┐
│  ┌───────────────┐   port "sl-panel"    ┌──────────────────────┐               │
│  │  SIDE PANEL   │◄────────────────────►│   SERVICE WORKER     │               │
│  │  (SPA, views) │  commands/snapshots  │   GameSession/tab    │               │
│  └───────────────┘                      │   MoveExecutor (CDP) │               │
│  ┌───────────────┐   port "sl-engine"   │   SidePanelPolicy    │               │
│  │  OFFSCREEN    │◄────────────────────►│   LicenseGate        │               │
│  │  EngineHost   │  UCI lines / status  │   Keepalive          │               │
│  │  (SF, SAB)    │                      └──────────┬───────────┘               │
│  └───────────────┘                                 │ port "sl-game"            │
│                                                    ▼                           │
│  chess.com / lichess tab           ┌──────────────────────────────┐            │
│  ┌──────────────────────────────┐  │ CONTENT (ISOLATED world)     │            │
│  │ PAGE BRIDGE (MAIN world)     │◄─┤ SiteAdapter (DOM observers)  │            │
│  │ generated from pagescript    │  │ Keybinds, CursorTracker      │            │
│  └──────────────────────────────┘  └──────────────────────────────┘            │
│        ▲ CDP Input.dispatchMouseEvent (from the SW via chrome.debugger)        │
└────────────────────────────────────────────────────────────────────────────────┘
```

| Context | Owns | Never does |
|---|---|---|
| **Service worker** `src/service/service-worker.ts` | `GameSession` per tab, recommendation pipeline, `MoveExecutor`, debugger lifecycle, side-panel policy, licence gate, offscreen lifecycle, alarms, `chrome.tts` | DOM, engine compute, heavy CPU |
| **Offscreen document** `src/offscreen/index.ts` | Stockfish worker (pthreads + SAB), `UciEngine`, NNUE loading, analysis cache, ONNX timing inference | Chrome tab APIs, `chrome.storage`, UI |
| **Side panel** `src/panel/index.ts` | Views, router, store hydrated from SW snapshots, settings editing | Direct engine or DOM access |
| **Content script (ISOLATED)** `src/content/index.ts` | Site detection, `SiteAdapter`, highlights, keybinds, cursor tracking, TTS relay | Engine, timing decisions, CDP |
| **Page bridge (MAIN)** generated `dist/js/page/*.js` | `wc-chess-board.game` / chessground internals; relays over `window.postMessage` with a per-build token | `chrome.*`, business logic |

The service worker is the only place that decides anything. The panel is a projection of SW
snapshots; the content script is a sensor and an actuator; the offscreen document is a compute
server.

---

## 3. The per-position pipeline (§3.2)

```
adapter.positionChanged(fen, ply, clocks, myColor, lastMove)
  → GameSession.onPosition()
     → not my turn: engine.ponder(fen)                       (go infinite, cached)
     → my turn:
        1. AnalysisRequest{fen, multiPv, limit} → offscreen engine   (cache hit → skip)
        2. MoveSelector.choose(analysis, persona, targetElo, ctx) → ChosenMove
        3. TimingModel.planMove(features(...)) → TimingPlan
        4. Recommendation → panel snapshot + board highlight
        5. if armed: MoveExecutor.schedule(plan) → humanised CDP drag → verify
```

Every step but the engine call is a pure function of its inputs and is unit-tested on its own.

**GameSession** (§3.3) is a per-tab state machine: `idle` → `waiting` → `live:opponent-turn` /
`live:my-turn:analysing` / `live:my-turn:ready` / `live:my-turn:executing` → `game-over`. The
panel router picks its view from that state plus the licence state and the update flag.

---

## 4. Subsystems

### 4.1 Site adapters (§3.4, §3.4a; `src/content/adapters/`)

One `SiteAdapter` per site behind a common interface: read the position, the clocks, the move
list, my colour and the board geometry; observe changes; draw highlights. chess.com exposes
`wc-chess-board.game`; lichess exposes chessground. Both are reached from the ISOLATED world
through the MAIN-world bridge, never by touching page globals directly. Every selector lives once
in `src/content/adapters/selectors.ts` (C1), and `self-check.ts` re-validates them periodically so
a site redesign degrades loudly instead of silently.

> The fixtures were hand-built from Appendix C's DOM descriptions rather than live captures, but
> the selectors themselves were checked against live chess.com and lichess on 2026-09-09
> (`docs/qa/2026-09-live-selector-verification.md`) and the
> first ladder entry hit in every case. What is still unconfirmed is the markup behind game
> states a read-only pass cannot reach — promotion pickers, game-over modals, follow-up controls
> — which `docs/qa-checklist.md` §F tracks.

### 4.2 pagescript (§5; `src/pagescript/`, `src/page/`)

Page-realm code is never written as a JavaScript string. It is authored as an AST with typed
builders, emitted to `dist/js/page/*.js` by `bun run gen:pagescript`, and bound with per-build
parameters (a spoof seed, selectors, colours). This gives three things §13.3 needs: identifiers
are salted per build so a page-side detector cannot match on names; the emitted program is
scanned for product words at build time; and there is no eval-shaped string anywhere.

### 4.3 Engine (§6; `src/offscreen/`, `src/core/engine/`)

Stockfish 18 from `@lichess-org/stockfish-web`, vendored into `assets/engine/` and run in the
offscreen document because a service worker has neither `Worker` nor DOM. The document is
cross-origin isolated (COOP/COEP manifest keys) so pthreads and `SharedArrayBuffer` work; the
consequence is that it cannot fetch cross-origin assets itself, so the SW fetches the big NNUE
nets and ChessMimic bands and streams them back over the `sl-engine` port as base64 chunks.
`src/core/engine/uci-client.ts` is a transport-agnostic UCI framework: request/response mailbox,
`info` coalescing, snapshot building, restart with backoff.

### 4.4 Strength and selection (§7; `src/core/strength/`)

`UCI_Elo` alone produces recognisable engine play, so the shipped default is a hybrid: the engine
supplies MultiPV lines, and `MoveSelector` picks among them with a persona-shaped policy —
centipawn-loss priors, a blunder model, phase and time-pressure terms, an opening book
(`book/`, with the lichess explorer as a source) and premove candidates. Every constant is in
`src/core/strength/constants.ts`.

### 4.5 Timing (§8; `src/core/timing/`)

Move times come from a generative model of the whole move window, not a multiplier chain. The
head is ChessMimic's clock model, exported per rating band to ONNX and run in the offscreen
document (`timing-inference.ts`), with a deterministic v1 head as the fallback whenever inference
is unavailable or too slow. Features are computed from the analysis, the chosen move, the clocks
and the persona; the plan that comes out carries an orientation latency, a decision pause, the
exploration budget and the drop time.

### 4.6 Execution (§9; `src/service/move-executor/`, `src/core/motor/`)

The "virtual hand". A move is a continuous pointer trajectory (WindMouse paths, motor profile,
exploration and preview selections) dispatched as trusted `Input.dispatchMouseEvent` events over
`chrome.debugger` from the service worker, then verified against the board. The pointer is
*owned* by the hand for the duration (§13.5) so the trace never teleports, and the debugger
attaches once before the game so its infobar's layout shift never lands inside a move window.

### 4.7 Panel (§10, Appendix F; `src/panel/`, `css/`)

One stylesheet framework (`sl-ui`), one token source ("Lattice", `src/design/tokens.ts` →
`css/tokens.css`), one icon registry, one copy file. The shell owns the top bar, banner slot,
content region, toast and overlay layers and the live regions; views are mounted one at a time
and each `mount()` returns its own teardown. While a game is live the panel enters **hands-off**
mode: pointer-events off, a capture-phase keyboard guard, every focusable `aria-disabled`, and a
banner explaining why — because a panel interaction blurs the game tab (§13.4).

### 4.8 Licence gate (§3.6; `src/service/license-gate.ts`)

`ensure()` on SW startup, `revalidate()` on a 6 h alarm, and a `LicenseClient` interface with the
phantom.ac endpoint as the default implementation. The stored state keeps both the effective
`status` and the endpoint's `rawStatus`. Network errors never downgrade a previously valid
state. **The gate is currently forced open** (`LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__`,
and `build.config.json` sets `licenseEnforce: false`).

---

## 5. Cross-cutting rules

- **Constants registry (C1).** `src/core/constants/*`, `src/design/tokens.ts`,
  `src/design/icons.ts`, `src/content/adapters/selectors.ts`. `scripts/check-constants.ts` fails
  the build on a duplicate.
- **Chrome wrappers (C6).** Everything goes through `src/core/chrome/*`, so `test/sim/` can
  substitute a whole fake browser — a controllable clock, storage, ports, alarms, tabs, debugger,
  a happy-dom tab and an `ac` telemetry shadow.
- **Messaging (§4.3).** Three named ports plus typed one-shot messages, all names in
  `src/core/constants/{ports,messages}.ts`, routed by `src/core/messaging/router.ts`.
- **Storage (§4.4).** Every key in `LOCAL_KEYS` / `SESSION_KEYS`, every value typed by
  `LocalStorageSchema` / `SessionStorageSchema`.

---

## 6. Build and distribution (§11, §12)

`scripts/build.ts` runs eleven steps in order: clean → gen-tokens → gen-icons → gen-pagescript →
check-constants → check-css → typecheck → bundle → copy → stamp manifest → verify-dist →
package. Four bundles come out (`service-worker.js`, `offscreen.js`, `panel.js` as ESM,
`content.js` as an IIFE) plus the generated MAIN-world programs, with `__SL_VERSION__`,
`__SL_BUILD__`, `__SL_SPOOF_SEED__`, `__SL_LICENSE_URL__`, `__SL_LICENSE_ENFORCE__` and
`__SL_DEBUG__` substituted at bundle time.

Distribution is a zip plus the unpacked folder. The v1 `update_url` is gone — Chrome no longer
installs self-hosted CRXs outside enterprise policy — but the manifest `key` is preserved, so the
extension ID is unchanged from v1 and a 1.x install upgrades in place. Because that id is fixed
and knowable, the manifest declares **no** `web_accessible_resources`: a web-accessible path
would let any script on a matched site probe for the extension's presence (§13.3). `src/service/update-check.ts`
polls `URLS.websiteManifest` on the licence alarm and raises `LOCAL_KEYS.updateAvailable`;
`src/service/lifecycle.ts` migrates the eleven flat 1.x storage keys on first run after an update.

---

## 7. Known gaps

Two settings are written, stored and rendered, but nothing acts on them. Both controls persist
their value, so they look functional and are not. Recorded here (and in `docs/qa-checklist.md`)
so a QA pass reports them as known rather than new. The first is a bug against the product's own
copy and is being fixed separately; the second is unbuilt wiring.

| Setting | What actually happens | Where the wiring belongs |
|---|---|---|
| `Settings.enabled` — the master toggle (**a known bug, not a design gap**: the row's copy promises "Off stops analysis and recommendations until you turn it back on") | `set-enabled.ts` writes it and the snapshot carries it, but the only consumer is `moveCardState()` in `src/panel/views/live/move-section.ts`, which greys the move card. Nothing in `src/service/**` reads it: analysis, recommendation, highlighting and auto-play all continue while it is off. Being fixed separately. | The SW session (`src/service/game-session/**`): refuse to analyse, recommend, highlight or execute while it is false, and let the panel route to a disabled state rather than a greyed card. |
| `Settings.engine.nnue` — `small` \| `big` \| `auto` (default `auto`) | Read only by the Settings view's row (`views/settings/rows.ts`) to render the control. `EngineController` never passes it on, so the running variant is always the bundled smallnet and the on-demand full-build nets are never requested. | `src/service/engine-controller.ts`'s configure path: choose the `ENGINE_FILES` target from the setting, and trigger the `nnue-request` download of `LIMITS.nnueBigNames` when the choice is not `small`. |
