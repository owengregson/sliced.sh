# Architecture

A condensation of Part I of
`docs/superpowers/plans/2026-09-03-sliced-v2-implementation-guide-v2.md`, which stays the binding
spec — this file is the map, not the territory. Section numbers below are that plan's.

---

## 1. What it is

sliced.sh is a Manifest V3 Chrome extension that watches a live game on chess.com,
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
│  │  (SF, SAB)    │  "sl-review-engine"  │   ReviewEngine       │               │
│  │  + review SF  │◄────────────────────►└──────────┬───────────┘               │
│  └───────────────┘                                 │ port "sl-game"            │
│                                                    ▼                           │
│  chess.com tab                     ┌──────────────────────────────┐            │
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
| **Offscreen document** `src/offscreen/index.ts` | Stockfish worker (pthreads + SAB), `UciEngine`, NNUE loading, analysis cache, ONNX timing inference; a second, independent full-network Stockfish host on `sl-review-engine` for board ratings (2026-09-14) | Chrome tab APIs, `chrome.storage`, UI |
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

### 4.1 The site adapter (§3.4, §3.4a; `src/content/adapters/`)

chess.com is the only supported site. `SiteAdapter` is the interface the rest of the content
script sees — read the position, the clocks, the move list, my colour and the board geometry;
observe changes; draw highlights — `AdapterBase` is the markup-independent half (debounced
re-evaluation, observer bookkeeping, the bridge-state cache, `observeMove`, game identity), and
`chesscom.ts` is the half that knows the markup. chess.com exposes `wc-chess-board.game`, reached
from the ISOLATED world through the MAIN-world bridge, never by touching page globals directly.
Every selector lives once in `src/content/adapters/selectors.ts` (C1), and `self-check.ts`
re-validates them periodically so a site redesign degrades loudly instead of silently.

> The fixtures were hand-built from Appendix C's DOM descriptions rather than live captures, but
> the selectors themselves were checked against live chess.com on 2026-09-09
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

Stockfish 19 from `@lichess-org/stockfish-web`, vendored into `assets/engine/` and run in the
offscreen document because a service worker has neither `Worker` nor DOM. The document is
cross-origin isolated (COOP/COEP manifest keys) so pthreads and `SharedArrayBuffer` work; the
consequence is that it cannot fetch cross-origin assets itself. Both Stockfish NNUE nets — one
per vendored build, since Stockfish 19 retired the secondary net inside the full build — ship in
the extension and load from extension URLs. The large net is checked in as deterministic
gzip to fit the Git host's file limit; the build verifies its decoded SHA-256 prefix, emits the
raw `.nnue`, and excludes the compressed source. The SW relay provides a verified NNUE
cache/download fallback over `sl-engine` chunks. ChessMimic's download relay exists but is not
registered, and Maia remains bundled-only; neither is a working remote-delivery setup flow.
`src/core/engine/uci-client.ts` is a transport-agnostic UCI framework: request/response mailbox,
`info` coalescing, snapshot building, restart with backoff.

Board ratings use a separate full-network, unrestricted SF19 instance through `ReviewEngine`.
Complete before/after frames support ordinary expected-point ratings and legal sacrifice
evidence for Brilliant. Playing-engine scores are never review evidence. Foreground move
preparation pauses review search; planned waiting and mouse activity do not. Synchronous
classification has a separate critical-input guard and yields between jobs. Separate UCI
state does not remove CPU contention. See [review validation](qa/sf19-brilliant-review-2026-09-16.md)
and [continuous-play scheduling](qa/review-latency-2026-09-16.md).

### 4.4 Strength and selection (§7; `src/core/strength/`)

Through target Elo 3000, Maia supplies rating-conditioned move probabilities, with phase,
pressure, opening and safety constraints in `MoveSelector`. Below effective Elo 2800, the
verifier compares two independent proposals sampled with replacement using finite shallow
evidence; equal or missing evidence preserves the policy distribution. The upper policy retains
its stronger verification. Above 3000, selection uses the strongest guarded engine continuation.
The heuristic policy remains a fallback when Maia is unavailable. Three local Polyglot books
cover club games, master games and named theory; review's Book label uses only the latter two.
Registries live in `src/core/constants/` and `src/core/strength/constants.ts`.

### 4.5 Timing (§8; `src/core/timing/`)

Move times come from a generative model of the whole move window, not a multiplier chain. The
head is ChessMimic's clock model, exported per rating band to ONNX and run in the offscreen
document (`timing-inference.ts`), with a deterministic v1 head as the fallback whenever inference
is unavailable or too slow. Features are computed from the analysis, the chosen move, the clocks
and the persona; the plan that comes out carries an orientation latency, a decision pause, the
exploration budget and the drop time.

The learned elapsed time includes execution. The first accepted position arrival establishes
one deadline for preparation, optional activity and the final mouse release; clock refreshes
do not restart it. The executor omits optional actions that cannot fit, preserves the mandatory
gesture when preparation overruns, and excludes that overrun from natural-pace learning.
Lobby waiting is excluded from the first active move. See the
[timing/execution contract](research/timing-execution-contract-2026-09-16.md).

The clocks are two separate readings and both are the page's. Remaining time comes from the DOM
clock elements (`clocks.ts`, including the sub-minute form with tenths); the *time control* comes
from the MAIN-world bridge's `board.game.timeControl.get()` → `{baseTime, increment}` in ms
(`time-control.ts`), because `game.times` / `game.timestamps` are empty on a live game. That object
is **null until the game actually starts**, after the session has already been created, so the
adapter republishes the unmoved position when it arrives and `GameSession.reprofile()` re-derives
the timing model (including its per-class move-time gain) and the hand's motor class from it.
Without it every game conditions
as `untimed`, which bypasses the compression factor, the hard caps, the §8.5 emergency regime and
the §7.4 premove gate, and leaves a bullet game with a classical hand.

### 4.6 Execution (§9; `src/service/move-executor/`, `src/core/motor/`)

The "virtual hand". A move is a continuous pointer trajectory (WindMouse paths, motor profile,
exploration and preview selections) dispatched as trusted `Input.dispatchMouseEvent` events over
`chrome.debugger` from the service worker, then verified against the board. The pointer is
*owned* by the hand for the duration (§13.5) so the trace never teleports, and the debugger
attaches once before the game so its infobar's layout shift never lands inside a move window.

A per-game repertoire retains an attention purpose briefly and regenerates its targets from
current candidates. Elo, phase and clock context modulate preparation, inspection, comparison,
verification, relation tracing and stillness. These mouse-rate weights are design priors.
Safe preview selections reserve their complete gesture before optional routes. Queueable
premoves take priority over holds and exploration; readiness suppresses optional movement.

### 4.7 Panel (§10, Appendix F; `src/panel/`, `css/`)

One stylesheet framework (`sl-ui`), one token source ("Lattice", `src/design/tokens.ts` →
`css/tokens.css`), one icon registry, one copy file. The shell owns the top bar, banner slot,
content region, toast and overlay layers and the live regions; views are mounted one at a time
and each `mount()` returns its own teardown. Game, Settings, and Engine stay interactive during a
live game, following the owner's 2026-09-11 override of the original hands-off UI lock. Shared
shortcuts work across views; Space requests play-now outside text and keybind editing. Automatic
update/reload prompts wait until play ends. Executor input and focus checks remain independent.

### 4.8 Licence gate (§3.6; `src/service/license-gate.ts`)

`ensure()` on SW startup, `revalidate()` on a 6 h alarm, and a `LicenseClient` interface with the
phantom.ac endpoint as the default implementation. The stored state keeps both the effective
`status` and the endpoint's `rawStatus`. Network errors never downgrade a previously valid
state. **The gate is currently forced open** (`LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__`,
and `build.config.json` sets `licenseEnforce: false`).

### 4.9 Module structure

Every subsystem follows one layout rule: **`foo.ts` is the public entry and `foo/` holds its
parts.** The entry either owns a thin orchestrator (a class that decides *when*) or only
re-exports; the parts own state, mechanics and pure rules, each with a small interface and its
own dispose. Callers import the entry — the part paths are an implementation detail — so a
subsystem can be re-cut without touching its importers.

| Entry | Parts | Shape |
|---|---|---|
| `service/game-session/session.ts` | `session/` | `GameSession` orchestrates; `SessionCore` holds the shared per-game state and the common queries (may act, colour hold, target Elo, clocks, state machine). Collaborators own one concern each — position feed, move delivery, premove decision, queued premove, scramble hold, prediction, hand arming, resign flow, lobby hold, time control and re-plan, Maia warm-up, board marks, effects feed, executor binding, move recorder — and read `SessionCore` fields live, never a copy, because each game replaces them. `position-rules.ts` is the pure half. |
| `service/game-session/recommendation.ts` | `recommendation/` | `RecommendationPipeline.run()` is nine named stages: context → timing → policy → book → analysis → candidates → selection → plan → assembly. Budget, Maia-search and own-move rating rules are pure modules (`budget.ts`, `maia-search.ts`, `own-move.ts`). |
| `service/game-session/board-effects.ts` | `board-effects/` | `BoardEffectsReporter` keeps the job lifecycle; `ReviewSearchLoop` owns the review engine's search/pre-emption/back-off, `VerdictClassifier` the classification, `ClassificationQueue` the one-verdict-per-turn pacing, `reviewWants` the urgency rule. |
| `service/move-executor/index.ts` | `executor/` | `MoveExecutor` facade over an explicit execution state machine (`execution-slots.ts`: pending, running, parked, fast-forward), `MoveDispatcher`, the opponent-turn explorer, move planning and timing fit. |
| `service/move-executor/hand-controller.ts` | `hand/`, `hand/gestures/` | `HandController` sequences a move; `HandMotor` owns every gated travel/press/release primitive; gestures (commit, escape, exploration, line preview, promotion, post-drop rest) are separate planners; the move window is a pure function. |
| `service/engine-controller.ts`, `review-engine.ts` | `engine-controller/`, `review-engine/`, `analysis/handles.ts` | Both engines share one set of queued-analysis handles; cache policy and the routed-queue `supersedes` rule are pure. |
| `service/panel-broadcaster.ts`, `auto-queue.ts`, `content-link.ts`, … | same-named dirs | Snapshot assembly is pure (`assembleSnapshot`), transport and throttling separate; the auto-queue state machine is separate from its entry/record codec; request bookkeeping (`PendingRequests`) separate from the port. |
| `core/strength/move-selector.ts` | `selector/`, `selector/strategies/` | `selectMove` is a pipeline over one `SelectionFrame`: prepare lines → resolve the Maia rating → mate guard → the first strategy that decides (full strength, Maia draw, native, sampled). Stage order is RNG draw order. The heuristic prior is a rule table (`prior/rules.ts`). |
| `core/engine/uci-client.ts` | `uci-client/` | `UciEngine` coordinator; a pending search is composed of `LiveLines`, `FrameCapture`, `UpdateBuilder`, `UpdateCoalescer`; `SearchQueue`, `ReadyWaiters`, `AppliedOptions` own their protocols. |
| `core/timing/timing-model.ts` | `timing-model/` | `planMove` = `normaliseSample` → `guardPremove` → `composeThink` → `assemblePlan`; one `replan` function per reason. The v1/ChessMimic heads implement one `DistributionHead` strategy. |
| `core/motor/opponent-exploration.ts`, `exploration.ts` | same-named dirs | `SpellTimeline` owns pointer position and spell budget; activities are functions over a shared scene; `ActionSequence` replaces duplicated closures. |
| `content/index.ts` | `content/boot/` | Composition root wiring the game feed, command router, responders, control reads and input shield. |
| `content/adapters/adapter.ts`, `chesscom.ts` | `adapters/base/`, `adapters/chesscom/` | `contract.ts` is the `SiteAdapter` interface; `AdapterBase` composes `SnapshotPublisher` (the single snapshot path), `ColourAuthority`, `TimeControlProbe`, `GameIdentity`, observers; chess.com readers are pure functions over a `PositionSources` record. |
| `offscreen/engine-host.ts`, `asset-store.ts` | same-named dirs, `inference/`, `shared/` | Host lifecycle, reboot back-off, info coalescing and the port router are separate; both ONNX hosts share `SessionPool`/`FailureBackoff`/`RunGuard`; the OPFS + IndexedDB store is one abstraction. |
| `page/*.ts` | `page/parts/`, same-named dirs | Program definitions built from shared AST fragments (`ast`, `svg`, `motion`, `layer`); the emitted programs are byte-identical to the pre-split ones. |
| `panel/copy.ts`, `panel/views/*.ts`, `panel/shell.ts` | `copy/`, `views/<view>/`, `shell/` | `COPY` is assembled from per-domain string modules (still one source, C5); each view section is a `create…Section(el)` with `render`/`dispose`. |
| `types/game.ts`, `types/settings.ts` | `types/game/`, `types/settings/` | Type registries split by domain behind the same entries. |

**Tooling** follows the same rule. `scripts/lib/` holds the build's shared pieces (paths,
hashing, fs, JSON, defines, CLI parsing, reporting, downloads); `build.ts` is an ordered list of
named steps (`build/steps.ts`), `verify-dist` a registry of independent checks
(`verify-dist/checks.ts`), `check-constants` a registry of rules, `vendor-engine` fetch / verify
/ notice stages with pure notice-section renderers. The Python book builders share
`pgn_games.py` and `polyglot_book.py`. `tools/lib/` holds the research tooling's shared pieces —
the Stockfish referee and UCI plumbing (`engine/`), the Maia runner, PGN export/split/think-time
readers (`pgn/`), CLI parsing and statistics — and each tool under `tools/*/` is a thin CLI over
its own folder of parts; `tools/data/datalib/` is the Python equivalent for the numbered data
scripts.

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

`scripts/build.ts` runs its named steps (`scripts/build/steps.ts`) in order: clean → gen-tokens → gen-icons → gen-pagescript →
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

## 7. Operating boundaries and remaining validation

NNUE selection is now wired: `EngineController` selects the full engine above the product's
one strength division, the Maia cutoff `MAIA.eloMax` (3000; owner, 2026-09-15 — it was a separate
3200 small-network cutoff with a Maia-prior band between the two), loads the packaged full-build
net locally, and holds searches until the new engine has replayed its options. Above the cutoff
selection is the strongest guarded engine continuation, the opening book is off and the automatic
depth ceiling is the maximum. Explicit Big selects
the full engine at any target. At or below the cutoff, Auto and Small use the bundled smallnet.
The 3800 endpoint selects maximum available search strength; it is not a calibrated human rating.

`Settings.enabled` now gates session analysis, recommendations, highlights and execution;
`test/behavioral/game/assistant-enabled.test.ts` covers stop and resume behavior. The Game
auto-play switch owns both the current hand and the saved next-game preference. Settings links
to that control instead of exposing a second switch.

Offline simulations and real-engine/model runs validate invariants and selected distributions.
They do not establish population-wide human equivalence, proprietary Chess.com rating parity,
or native extension behavior. The September 16 work does not use the owner's Chrome for further
live testing. Models remain bundled at roughly 300 MiB compressed; measured size alternatives
and cache limits are in [the packaging audit](research/bundled-assets-and-cache-2026-09-16.md).
