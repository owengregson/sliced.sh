# sliced.gg v2 — Manifest V3 Rewrite Implementation Guide (V2, supersedes the 2026-09-03 plan)

> **Supersession notice.** This guide replaces `2026-09-03-sliced-v2-implementation.md`. Changes in V2: (1) the license gate is force-valid for now (§3.6); (2) a new Part I §13 "Telemetry-shaped operation" derived from the empirical corpus in `~/Documents/ChessTelemetry/` (reproduced in Appendix I) is the binding contract for every mechanism that touches the page; (3) bot-vs-bot play is the intended use; (4) the executor, panel, adapters, content script and session were amended to satisfy §13 (rate-controlled preview selections, focus discipline, hand ownership, no page storage / DOM signatures, highlights off by default); (5) Task 33 adds the telemetry conformance harness. Where V1 text and §13 disagree, §13 wins. **V2.1 revision (same day):** multi-piece selection is modelled as a realism signal at a human rate (§9.3a, §13.2) rather than forbidden; the timing model gains an untimed regime, orientation latency and a joint move-window process (§8.4b); **V2.2:** games are fully independent (no session drift or warm-up) and timings are trained offline ahead of time on public online datasets (the Lichess open database with per-move clocks; Task 34) — nothing is recorded by us, and hover/preview behaviour is hand-designed; **V2.5 (owner decision 2026-09-04):** sliced.gg is a non-commercial project and ships **ChessMimic** as its timing head (Appendix J; licence notice in `docs/third-party.md`, no flags in code), run through onnxruntime-web in the offscreen document; real mouse input is ignored while the hand is active (§13.5); the extension-side "bots only" gate is removed — scope is enforced by the user (§13.1).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part I of this document is the design spec; Part II is the task list. Executors read both. Every task's requirements implicitly include **§1.3 Global Constraints**.

**Goal:** Rebuild the sliced.gg chess-assistant Chrome extension from scratch as a Manifest V3, TypeScript, side-panel extension with a modern Stockfish (NNUE) engine driven by `UCI_Elo`, a dynamic human-timing model, a humanized move executor, and one unified constants / styling / page-injection architecture.

**Architecture:** Five isolated runtime contexts — service worker (orchestrator), offscreen document (engine host), side panel (UI), isolated-world content script (site adapters), MAIN-world page bridge (generated from our page-script AST) — connected by typed ports and messages. All chess logic, timing, strength and motor models live in pure `src/core/*` modules with no Chrome dependencies so they are unit-testable under `bun test`.

**Tech Stack:** Bun ≥ 1.3 (runtime, bundler via `Bun.build`, test runner), TypeScript 5.9 strict, Biome (lint/format), chess.js (move generation / SAN), Stockfish WASM (NNUE, multi-thread via SharedArrayBuffer), `astring` (build-time only, page-script code generation), happy-dom + fake-indexeddb (tests), Font Awesome Free (vendored), Chrome 128+ (`minimum_chrome_version`).

**Spec:** This file, Part I (§1–§13). Research digests that back the spec are reproduced in Appendix A–I so the plan is self-contained. §13 (telemetry contract) and Appendix I (ChessTelemetry corpus) are the empirical source for everything that interacts with the page.

---

# PART I — DESIGN SPEC

## 1. Scope, goals, constraints

### 1.1 Product goals (from the owner's brief)

| # | Goal | Where addressed |
|---|------|-----------------|
| G1 | Migrate to Manifest V3, compatible with current Chrome | §3, §11, Tasks 1–9, 30 |
| G2 | Replace popup with side panel; modern UI redesign | §10, Tasks 22–29 |
| G3 | Latest Stockfish, strength via `UCI_Elo` | §6–§7, Tasks 10–15 |
| G4 | Better engine communication framework; better model (NNUE) storage | §6, Tasks 10–13 |
| G5 | Ground-up recode with optimal conventions for an ML chess-move + timing program | §2–§5, §11, all tasks |
| G6 | Dynamic (non-algorithmic) move-timing system | §8, Task 16 |
| G7 | Superior move execution: one button → best move played as human input | §9, Tasks 17–19, 32 |
| G8 | Overall architecture/design improvements | §3–§5, §10–§12 |
| G9 | **Function without triggering site telemetry anomalies** (V2): every move's client telemetry looks like an attentive human's; bot-vs-bot play only | §13, Appendix I, Task 33, amendments in Tasks 9, 17, 18, 20–24, 30 |

### 1.2 Owner-mandated engineering constraints (added 2026-09-03)

| # | Constraint | How this plan satisfies it |
|---|-----------|---------------------------|
| C1 | **Unified structure; no constant repeated anywhere** | One registry package `src/core/constants/` (§4). Every string/number that appears in two places is defined once there and imported. Storage keys, message types, port names, alarm names, timings, defaults, selectors, icon names, and design tokens all live in registries. Biome rule + a custom `scripts/check-constants.ts` lint (Task 2) fails the build if a registry literal is re-declared. |
| C2 | **All page-executed code is written in our language-level AST, compiled to JS** | `src/pagescript/` (§5): a typed ESTree-compatible node set with builder combinators. Every program that runs in the page realm (MAIN-world bridges, CDP `Runtime.evaluate` expressions, `chrome.scripting.executeScript` snippets, board overlays) is authored as a builder tree in `src/page/*.ts` and compiled at build time to JS strings by `scripts/gen-pagescript.ts`. No raw JS string templates anywhere. |
| C3 | **One styling framework; spacing/colour/etc. from a single base** | `src/design/tokens.ts` (§10) is the single source: base unit → spacing scale, palette → colour tokens with derived alphas, ratio → type scale. `scripts/gen-tokens.ts` emits `css/tokens.css` (custom properties) and `src/design/tokens.generated.ts`. The `sl-ui` framework (base → primitives → components → views) consumes only tokens. Page overlays (highlights/arrows) receive colours from the same generated module through pagescript parameters. |
| C4 | **Icons from Font Awesome** | Font Awesome Free 7 vendored under `assets/vendor/fontawesome/` (MV3 forbids remote scripts; local also works offline). `src/design/icons.ts` maps semantic names → FA classes; templates use `data-icon="play"` and a build-time/mount-time resolver, so `fa-*` strings exist in exactly one file. |
| C5 | **Keep the logo the same** | `assets/images/sliced_128.png` and `sliced_256.png` are copied byte-for-byte; manifest `icons` and panel brand lockup reference them. No new mark. |
| C6 | **Truly human, forward-proof input; no shortcuts** (2026-09-03, second message) | CDP trusted input only, full virtual hand (§9), motor profile fitted from the user's traces, `InputBackend` for a native successor. |
| C7 | **Telemetry-shaped operation** (V2/V2.1) | §13 contract: zero blur/toggle, `EventTrusted`, human-rate preview selections, pointer continuity with hand ownership, human `MoveHoldTime` distribution, no presence signals; scope enforced by the user; force-valid license for now (§3.6). |

### 1.3 Global Constraints (apply to every task)

- `manifest_version: 3`, `minimum_chrome_version: "128"`.
- TypeScript `strict: true`; `noEmit`; path aliases `@core/*`, `@service/*`, `@content/*`, `@panel/*`, `@offscreen/*`, `@pagescript/*`, `@page/*`, `@design/*`, `@typedefs/*`.
- Runtime/bundler/test runner: Bun. No webpack, no Vite, no npm scripts that require Node-only tooling.
- Lint/format: Biome (tabs, double quotes, semicolons, line width 100). `bun run lint` must pass before every commit.
- No `any` except in `*.d.ts` shims for third-party globals. No non-null assertions outside tests.
- No `console.*` in shipped code — use `log` from `@core/logger`.
- No inline HTML in `.ts` files: templates live in `src/panel/views/templates/*.html` and are imported as text (`?raw`).
- No CSS outside `css/` and no numeric CSS values that are not tokens (`var(--sl-*)`), except `0`, `1px` borders, `100%`, and `auto`.
- No page-realm JS string literals: page code is authored in pagescript builders (C2).
- No duplicated constants (C1). Registry files: `src/core/constants/*.ts`, `src/design/tokens.ts`, `src/design/icons.ts`, `src/content/adapters/selectors.ts`.
- Every `chrome.*` call goes through the typed wrappers in `src/core/chrome/*` (Promise-based, `lastError`-checked) so core modules can be tested against the simulator.
- Every module that owns listeners/timers exposes a cleanup/dispose function.
- Tests: `bun test` per-file isolation via `scripts/test-runner.sh`; pure-logic tests < 5 ms each; behavioural tests use the simulator in `test/sim/`.
- Commit after every task with the conventional-commit message given in the task.
- Brand: product name `sliced.gg`, short name `sliced`, existing orange accent retained (`#ffa71f`), dark-first.
- **Telemetry contract (§13) applies to every task**: no untrusted input, no focus changes, no page storage, no DOM/global signatures, modelled (rate-controlled) preview selections, continuous pointer owned by the hand, human timing. Task 33's lints and `ac`-shadow tests are part of `bun run check` once they land.

### 1.4 Non-goals (explicitly out of scope for v2.0)

- Firefox / Safari ports (MV3 differences in `sidePanel`/`offscreen`).
- Server-side account system redesign (the license client is isolated behind an interface; the current `phantom.ac` endpoint is kept as the default implementation).
- Puzzle / analysis-board modes on chess.com or lichess (only live games; the adapter interface leaves room).
- Mobile-layout chess sites.

## 2. Legacy audit (what exists today, and what is wrong with it)

Source of truth: the current `slicedggMV2/` tree (MV2, ~13 files + Stockfish build + assets). Everything below was read in full before writing this plan.

### 2.1 Inventory

| Path | Role | Verdict |
|------|------|---------|
| `manifest.json` | MV2; `background.page`; `browser_action` popup `login.html`; `content_scripts` on `*.chess.com/*`, `*.lichess.org/*` at `document_start`; permissions `storage`, `debugger`; CSP `'unsafe-eval'`; `update_url` sliced.sh; fixed `key` | Replace entirely. Keep the `key` field only if the same extension ID must be preserved (decision: keep it; see §12.2). |
| `pages/background.html` + `scripts/background.js` | Loads `SlicedEngine/engine.js` (Stockfish) in the background page; on every content message re-sends `setoption Skill Level`; debugger attach/detach; dispatches `Input.dispatchMouseEvent` press/release at coordinates supplied by the content script; initialises storage defaults | Replace. Engine cannot live in an MV3 service worker (no `Worker`, no DOM). Mouse dispatch is click-click with zero timing. `alert()` in `onAttach` breaks in SW. Global mutable state (`globalVariable.currentTabId`, `xC/yC`). |
| `SlicedEngine/build.js` (105 KB) | The content script: webpack bundle containing (a) minified chess.js 0.x, (b) `Stoke` square class, (c) coordinate maths for square → viewport point (both orientations) and promotion popup offsets, (d) `MetricsData` chess.com adapter, `Router` lichess adapter (2023 selectors), (e) `Nucleus` engine proxy that polls a shared string every 100 ms, (f) `createClient` — the per-move pipeline: scrape SAN list → replay in chess.js → FEN → engine → highlight → compute move time with ad-hoc multipliers → `setTimeout` → click-click move → promotion click; (g) keybind polling on `document.onkeydown`; (h) 1 s `setInterval` for auto-new-game | Replace. Selectors are stale (chess.com now uses `wc-chess-board`, lichess uses `kwdb`/`rm6`), 50 ms polling loops, no MutationObserver, no cancellation, `throw` on unsupported site, timing model is the multiplier chain (§6.1). |
| `SlicedEngine/engine.js` / `engine.wasm` / `engine.worker.js` | Old Emscripten Stockfish (pre-NNUE-era glue, 347 KB wasm, pthread worker) | Replace with the distribution chosen in §6. |
| `scripts/popup.js` + `pages/gui.html` | Popup UI (Bootstrap 5 from CDN + Google Fonts): Enabled toggle, ELO 1–20, Depth 1–14, AutoMove speed 0–10 s, Highlight/Auto-move/Auto-queue toggles, three keybind capture buttons, UI sounds | Replace. Bootstrap from CDN violates MV3 remote-code policy for scripts (CSS is allowed but we drop it anyway). Keybind capture adds a new `keydown` listener on every click (leak). `elo` label formula `1650*n/7` is fiction. |
| `scripts/login.js` + `pages/login.html`, `invalid.html`, `invalid-ip.html`, `cat-facts.html` | License gate: `GET https://phantom.ac/slicedgg/index.php?key=…&type=gold`, then `if (asReply.includes('"valid"') || true)` — **always passes** | Replace with `LicenseClient` behind an interface (§3.6); keep the endpoint as default; **keep the force-valid behaviour for now** as a single explicit constant (`LICENSE_FORCE_VALID = true`); fold error pages into panel views. |
| `scripts/id-generator.js` | Dev utility to brute-force a CRX ID containing a string | Move to `tools/` (not shipped). |
| `css/style.css` (74 KB) | Bootstrap overrides + `kbc-button` keyboard-key CSS library | Delete; replaced by `sl-ui`. |
| `assets/images/sliced_128.png`, `sliced_256.png` | Logo | **Keep unchanged (C5).** |
| `assets/sounds/*` | 14 UI sounds | Keep; expose behind a single `UI sounds` toggle and a `sounds.ts` registry. |
| `.history/` | Editor history | Delete. |

### 2.2 Behavioural findings that shape v2

1. **Engine strength was Skill Level, not Elo.** `UCI_LimitStrength false` + `Skill Level 1..20`. The UI showed a fabricated Elo. v2 uses `UCI_LimitStrength true` + `UCI_Elo` (engine-native, 1320–3190) *and* a persona-driven selection layer for the range below 1320 and for human-like variance (§7).
2. **Every move restarted the engine cold** (`ucinewgame` on every `go`), discarding the transposition table. v2 keeps one engine session per game, ponders on the opponent's clock, and caches analyses by FEN.
3. **Messaging was string-polling.** The content script polled `this.backgroundMessage` every 100 ms; results were correlated by a `round` counter. v2 uses request-ids, typed ports and async iterators (§6.4).
4. **Timing was a multiplier chain** on a user slider (§8.1 and Appendix D reproduce it). v2 replaces it with a feature-conditioned distributional model with a per-game budget controller and persona latent variables (§6).
5. **Move execution was four instant CDP clicks at exact square centres.** v2 executes a humanized drag with cursor travel, jitter and timing, verifies the move landed, and retries once with click-click (§9).
6. **Site adapters were DOM-polling with 2023 selectors.** v2 uses MutationObservers plus MAIN-world bridges generated from pagescript, with a selector registry and runtime self-checks (§3.4, Appendix C).
7. **Keybinds** were polled from storage on every keydown. v2 loads keybinds once into memory and subscribes to `storage.onChanged`.
8. **Text-to-speech** used `SpeechSynthesis` in the page. v2 uses `chrome.tts` from the service worker (no page-side audio, no permission prompts).
9. **Auto-queue** clicked "New N min" via a 1 s interval. v2 triggers on the adapter's `gameEnded` event, with a humanized delay.

### 2.3 What we keep from the legacy code (semantics, not code)

- Feature set: Enabled, Highlight moves, Auto-move, Auto-queue, keybinds (play move / disable / speak move), license login, UI sounds.
- Square-centre coordinate maths for both orientations (re-derived in Task 20 with tests).
- Promotion-popup handling concept (re-researched in Appendix C/E).
- The orange brand and the logo.


## 3. Architecture

### 3.1 Runtime contexts and responsibilities

```
┌──────────────────────────── Chrome ────────────────────────────────────────────┐
│                                                                                 │
│  ┌───────────────┐   port "sl-panel"    ┌──────────────────────┐                │
│  │  SIDE PANEL   │◄────────────────────►│   SERVICE WORKER     │                │
│  │  (SPA, views) │  commands/snapshots   │   GameSession/tab    │                │
│  └───────────────┘                       │   MoveExecutor (CDP) │                │
│                                          │   SidePanelPolicy    │                │
│  ┌───────────────┐   port "sl-engine"    │   LicenseGate        │                │
│  │  OFFSCREEN    │◄────────────────────►│   Keepalive          │                │
│  │  EngineHost   │  UCI lines / status   └──────────┬───────────┘                │
│  │  (SF worker,  │                                  │ port "sl-game"            │
│  │   SAB, NNUE)  │                                  │ positions / highlights    │
│  └───────────────┘                                  ▼                           │
│                                    ┌──────────────────────────────┐             │
│  chess.com / lichess tab           │ CONTENT (ISOLATED world)     │             │
│  ┌──────────────────────────────┐  │ SiteAdapter (DOM observers)  │             │
│  │ PAGE BRIDGE (MAIN world)     │◄─┤ KeybindCapture, CursorTrack  │             │
│  │ generated from pagescript    │  │ PageBridgeClient (postMsg)   │             │
│  │ board.game hooks, arrows     │  └──────────────────────────────┘             │
│  └──────────────────────────────┘                                               │
│        ▲ CDP Input.dispatchMouseEvent (from SW via chrome.debugger)             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| Context | Entry | Owns | Never does |
|---------|-------|------|-----------|
| Service worker | `src/service/service-worker.ts` | `GameSession` state machine per tab, recommendation pipeline (engine → selector → timing), `MoveExecutor`, debugger lifecycle, side-panel per-tab policy, license gate, offscreen lifecycle, alarms, `chrome.tts` | DOM, engine compute, heavy CPU |
| Offscreen document | `src/offscreen/index.ts` (`pages/offscreen.html`) | Stockfish worker (pthreads + SAB), `UciEngine`, NNUE loading, analysis cache, optional ONNX timing inference | Chrome tab APIs, UI |
| Side panel | `src/panel/index.ts` (`pages/panel.html`) | Views, router, state store hydrated from SW snapshots, settings editing | Direct engine/DOM access; it is a pure client of the SW |
| Content script (ISOLATED) | `src/content/index.ts` | Site detection, `SiteAdapter` (DOM observers + bridge), highlights (via bridge or overlay), keybinds, cursor tracking, TTS trigger relay | Engine, timing decisions, CDP |
| Page bridge (MAIN) | generated `dist/js/page/*.js` | Access to `wc-chess-board.game` / chessground internals; event relay via `window.postMessage` with a per-build token | chrome.* APIs (unavailable), business logic |

### 3.2 The recommendation pipeline (per position)

```
adapter.positionChanged(fen, ply, clocks, myColor, lastMove)
   → SW GameSession.onPosition()
      → if not my turn: engine.ponder(fen)          (go infinite, cached)
      → if my turn:
          1. AnalysisRequest{fen, multiPv:K, limit} → offscreen engine (cache hit → skip)
          2. MoveSelector.choose(analysis, persona, targetElo, gameCtx) → ChosenMove
          3. TimingModel.planMove(features(analysis, chosen, clocks, persona)) → TimingPlan
          4. Recommendation{chosen, lines, eval, wdl, plan} → panel snapshot + content highlight
          5. if autoMove armed: MoveExecutor.schedule(plan) → at t: humanized CDP drag → verify
```

All four steps are pure functions of their inputs except the engine call; each is independently unit-tested.

### 3.3 GameSession state machine (SW, one per tab)

States: `idle` → `waiting-for-game` → `live` (sub-states: `opponent-turn`, `my-turn:analysing`, `my-turn:recommended`, `my-turn:executing`) → `game-over` → `waiting-for-game`. Transitions are driven by adapter events (`gameStarted`, `positionChanged`, `gameEnded`), user commands (`playNow`, `armAutoMove`, `disarm`, `disable`), executor results (`executed`, `failed`), and tab lifecycle (`tabRemoved`, `navigated`). The machine is implemented as a table (`src/service/game-session/transitions.ts`) so tests enumerate every edge.

### 3.4 Site adapters

`SiteAdapter` (interface in `src/content/adapters/adapter.ts`) is implemented by `ChessComAdapter` and `LichessAdapter`. Each combines: (1) a MAIN-world bridge (pagescript program) that exposes the site's own board object when available — preferred for FEN, turn, legal moves, arrows; (2) DOM observation as fallback and cross-check (piece placement → FEN, move list → SAN replay through chess.js); (3) a selector registry `src/content/adapters/selectors.ts` with primary + fallback selectors and a self-check that logs `adapter.selectorMiss` telemetry. Full adapter research is in Appendix C.

### 3.5 Engine host

The engine runs only in the offscreen document (MV3 service workers cannot create Workers). `EngineHost` loads the vendored Stockfish build, feeds NNUE buffers, and exposes a line-oriented transport over a `chrome.runtime` port. The SW-side `RemoteEngine` implements the same `UciEngine` interface over that port. Details and the chosen distribution: §6 and Appendix A.

### 3.6 License gate

`LicenseClient` interface: `validate(key): Promise<LicenseResult>` where `LicenseResult = { status: 'valid'|'invalid'|'ip_limit'|'network_error', expiresAt?: number }`. Default implementation `PhantomLicenseClient` calls the existing endpoint (`https://phantom.ac/slicedgg/index.php?key=…&type=gold`) and parses the JSON object. **V2 decision (owner, 2026-09-03): the gate is force-valid for now.** `src/core/constants/limits.ts` exports `LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__` (the only runtime reference; the build-time define comes from `build.config.json` `"licenseEnforce": false`, so the shipped default is force-valid); `LicenseGate.ensure()` still calls the client and records the real result in `LOCAL_KEYS.licenseState.rawStatus` for diagnostics, but the effective `status` is `"valid"` whenever the flag is set, so any key (including an empty one) unlocks the extension — the same semantics as the legacy `|| true`. The login view stays (it collects the key), and the Engine view shows the raw verdict. Setting `"licenseEnforce": true` in `build.config.json` restores real gating with no other code change. Validation runs at SW startup (alarm every 6 h) and on login. Network errors never lock the user out.

### 3.7 Repository layout

```
slicedggMV2/                        # repo root (git init in Task 0)
├── manifest.json                   # MV3 source manifest (build copies + stamps version)
├── package.json  bunfig.toml  biome.json  tsconfig.json  build.config.json
├── scripts/
│   ├── build.ts                    # Bun.build pipeline (entries, gen steps, copy, zip)
│   ├── gen-tokens.ts               # tokens.ts → css/tokens.css + src/design/tokens.generated.ts
│   ├── gen-pagescript.ts           # src/page/*.ts builders → dist/js/page/*.js + src/page/generated/*.ts
│   ├── gen-icons.ts                # icons.ts → verifies FA classes exist in vendored CSS
│   ├── check-constants.ts          # C1 lint: no duplicated registry literals
│   ├── test-runner.sh              # per-file bun test isolation
│   └── verify-dist.ts              # manifest ↔ dist consistency, size report
├── src/
│   ├── core/
│   │   ├── constants/  index.ts storage-keys.ts messages.ts ports.ts alarms.ts timings.ts
│   │   │               defaults.ts urls.ts limits.ts sounds.ts
│   │   ├── chrome/     storage.ts tabs.ts debugger.ts runtime.ts offscreen.ts side-panel.ts tts.ts alarms.ts
│   │   ├── chess/      fen.ts san.ts squares.ts phase.ts material.ts move-classify.ts
│   │   ├── engine/     uci-parser.ts uci-client.ts transport.ts remote-engine.ts analysis-cache.ts options.ts types.ts
│   │   ├── strength/   elo-map.ts move-selector.ts blunder-model.ts persona.ts book/{polyglot.ts,explorer.ts}
│   │   ├── timing/     features.ts timing-model.ts budget.ts distributions.ts persona-latents.ts v2-inference.ts types.ts
│   │   ├── motor/      path-generator.ts windmouse.ts bezier.ts motor-profile.ts sampling.ts types.ts
│   │   ├── messaging/  typed-messages.ts router.ts ports.ts
│   │   ├── storage/    settings-storage.ts license-storage.ts session-storage.ts
│   │   ├── auth/       license-client.ts phantom-license-client.ts
│   │   ├── logger.ts serialization.ts rng.ts util/{dedupe-async.ts,clamp.ts,lru.ts,ids.ts}
│   ├── pagescript/     nodes.ts builders.ts emit.ts spoof.ts bind.ts std.ts index.ts
│   ├── page/           chesscom-bridge.ts lichess-bridge.ts highlight-overlay.ts cursor-probe.ts focus-probe.ts
│   │                   generated/ (build output, gitignored)
│   ├── service/        service-worker.ts bootstrap.ts lifecycle.ts keepalive.ts offscreen-manager.ts
│   │                   debugger-manager.ts move-executor.ts side-panel-policy.ts license-gate.ts tts.ts
│   │                   game-session/{session.ts,transitions.ts,registry.ts,recommendation.ts}
│   │                   handlers/{panel,content,engine,license,settings}/*.ts
│   ├── offscreen/      index.ts engine-host.ts stockfish-loader.ts nnue-store.ts timing-inference.ts
│   ├── content/        index.ts site-detect.ts adapters/{adapter.ts,selectors.ts,chesscom.ts,lichess.ts,dom-fen.ts,move-list.ts,clocks.ts}
│   │                   page-bridge-client.ts keybinds.ts cursor-tracker.ts highlights.ts feed-port.ts
│   ├── panel/          index.ts router.ts view.ts store.ts actions.ts animation-manager.ts sounds.ts icons-mount.ts
│   │                   components/{eval-bar.ts,move-card.ts,pv-list.ts,clock.ts,countdown-ring.ts,toggle.ts,slider.ts,keybind.ts,toast.ts,status-pill.ts}
│   │                   views/{login,unsupported,waiting,live,settings,engine,update,expired}.ts + templates/*.html
│   ├── design/         tokens.ts icons.ts tokens.generated.ts (build output)
│   └── types/          chrome-ext.d.ts settings.ts storage.ts game.ts engine.ts messages.d.ts
├── css/                tokens.css (generated) base.css primitives.css components.css views/*.css sl-ui.css (imports)
├── pages/              panel.html offscreen.html
├── assets/             images/ (logo unchanged) sounds/ vendor/fontawesome/ engine/ (wasm, worker, nnue)
├── tools/              id-generator.js (legacy dev tool, not shipped) data/ (timing-model training pipeline, Python)
├── test/               setup.ts sim/ core/ service/ content/ panel/ pagescript/ behavioral/
├── docs/superpowers/{specs,plans}/
└── legacy/             frozen copy of the MV2 tree (reference only; deleted in Task 31)
```

## 4. The constants registry (C1)

### 4.1 Rules

1. A literal that is read in more than one module is defined once in `src/core/constants/` (or the design/icon/selector registries) and imported everywhere else.
2. Registries are `as const` objects; types are derived (`type LocalKey = (typeof LOCAL_KEYS)[keyof typeof LOCAL_KEYS]`).
3. Build-time constants (`__SL_BUILD__`, `__SL_SPOOF_SEED__`, `__SL_VERSION__`, `__SL_LICENSE_URL__`) are declared once in `src/types/chrome-ext.d.ts` and injected once by `scripts/build.ts` `define`.
4. `scripts/check-constants.ts` scans `src/**` for string literals matching `^sl[:-]`, `^__sl`, `^sl-` (storage keys, ports, CSS classes for JS hooks) and for numeric literals with a `// const:` marker; any occurrence outside a registry file fails the build.
5. The message-type registry (`messages.ts`) is the only place message `type` strings exist; handlers register by constant.

### 4.2 Registry contents (authoritative; later tasks import these names)

```ts
// src/core/constants/storage-keys.ts
export const LOCAL_KEYS = {
	settings: "sl::settings",                 // Settings (types/settings.ts)
	licenseState: "sl::license-state",        // LicenseState
	licenseKey: "sl::license-key",            // string
	updateAvailable: "sl::update-available",  // boolean
	engineNnueMeta: "sl::engine-nnue-meta",   // { name, sha256, bytes, storedAt }
	sessionStats: "sl::session-stats",        // SessionStats (games, moves, avgThinkMs)
	timingLog: "sl::timing-log",              // ring buffer of TimingLogEntry (max 200)
	installedAt: "sl::installed-at",          // number
	motorTraces: "sl::motor-traces",          // MotorTrace chunks (Task 19), ≤ 20 MB total
	motorProfile: "sl::motor-profile",        // fitted MotorProfile (Task 19)
	explorerCache: "sl::explorer-cache",      // opening-explorer LRU (Task 15)
} as const;
export const SESSION_KEYS = {
	autoMoveArmed: "sl::auto-move-armed",     // Record<tabId, boolean>
	debuggerAttached: "sl::debugger-attached",// Record<tabId, boolean>
	personaByGame: "sl::persona-by-game",     // Record<gameId, PersonaLatents>
} as const;

// src/core/constants/ports.ts
export const PORT_NAMES = {
	panel: "sl-panel",     // panel ↔ SW
	game: "sl-game",       // content ↔ SW (one per tab)
	engine: "sl-engine",   // offscreen ↔ SW
	logStream: "sl-log",   // panel devtools log subscriber
} as const;

// src/core/constants/alarms.ts
export const ALARM_NAMES = { licenseRevalidate: "sl-license", keepalive: "sl-keepalive", timingLogFlush: "sl-timing-flush" } as const;
export const ALARM_CADENCE_MINUTES = { licenseRevalidate: 360, keepalive: 0.5, timingLogFlush: 5 } as const;

// src/core/constants/timings.ts   (cross-module timing constants, ms unless noted)
export const TIMINGS = {
	engineReadyTimeoutMs: 20_000, engineStopTimeoutMs: 2_000, engineRestartBackoffMs: [500, 2_000, 8_000],
	analysisDefaultMovetimeMs: 1_500, ponderMaxMs: 60_000,
	panelSnapshotMinIntervalMs: 100, engineInfoCoalesceMs: 100,
	adapterDebounceMs: 40, adapterSelfCheckIntervalMs: 15_000,
	executorVerifyTimeoutMs: 1_200, executorRetryDelayMs: [250, 600],
	debuggerIdleDetachMs: 180_000, licenseValidateTimeoutMs: 8_000,
	autoQueueDelayRangeMs: [900, 2_600], keybindDebounceMs: 150,
} as const;

// src/core/constants/limits.ts
export const LIMITS = {
	eloMin: 400, eloMax: 3200, engineEloMin: 1320, engineEloMax: 3190,
	multiPvMin: 1, multiPvMax: 8, depthMin: 6, depthMax: 30,
	threadsMax: 8, hashMbMin: 16, hashMbMax: 128,
	timingLogMax: 200, analysisCacheEntries: 256, cpClamp: 1000,
} as const;

// src/core/constants/urls.ts
export const URLS = {
	website: "https://sliced.sh", licenseEndpoint: __SL_LICENSE_URL__, // build-time; default https://phantom.ac/slicedgg/index.php
	lichessExplorer: "https://explorer.lichess.ovh/lichess",
	chesscomMatch: "*://*.chess.com/*", lichessMatch: "*://*.lichess.org/*",
} as const;

// src/core/constants/sounds.ts
export const SOUNDS = { clickLight: "click_light.wav", clickHeavy: "click_heavy.wav", clickLightOff: "click_light_disable.wav",
	clickHeavyOff: "click_heavy_disable.wav", guiOpen: "gui_open.mp3", guiOff: "gui_disable.wav", slide: "slider_slide.mp3",
	smallSlide: "small_slide.mp3", tick: "tick_light.mp3", makeMove: "make_move.wav", slamLight: "slam_light.wav",
	slamHeavy: "slam_heavy.wav", slamLow: "slam_low.wav" } as const;

// src/core/constants/defaults.ts  → re-exports DEFAULT_SETTINGS from types/settings.ts (single definition there)
```

`messages.ts` (message type registry) is specified in §4.3 below; `selectors.ts` in §3.4/Appendix C; `tokens.ts`/`icons.ts` in §10.

### 4.3 Message and port contracts (`src/core/constants/messages.ts` + `src/core/messaging/`)

All cross-context traffic is either a **port message** (streaming, per-connection) or a **runtime message** (request/response). Every message has `type` from `MSG` and the response shape is mapped in `MessageResponseMap` so `sendTyped()` infers return types (pattern reproduced from tranquill's `types/messages.ts`, see Appendix H).

```ts
export const MSG = {
	// panel → SW (request/response)
	PANEL_GET_SNAPSHOT: "sl:panel:getSnapshot", PANEL_PLAY_NOW: "sl:panel:playNow",
	PANEL_SET_AUTO_MOVE: "sl:panel:setAutoMove", PANEL_CANCEL_PENDING: "sl:panel:cancelPending",
	PANEL_SET_ENABLED: "sl:panel:setEnabled", PANEL_PREVIEW_LINE: "sl:panel:previewLine",
	PANEL_LOGIN: "sl:panel:login", PANEL_LOGOUT: "sl:panel:logout", PANEL_RECHECK_LICENSE: "sl:panel:recheckLicense",
	PANEL_ENGINE_RESTART: "sl:panel:engineRestart", PANEL_EXPORT_TIMING_LOG: "sl:panel:exportTimingLog",
	// content → SW (request/response)
	CONTENT_HELLO: "sl:content:hello", CONTENT_KEYBIND: "sl:content:keybind", CONTENT_CURSOR: "sl:content:cursor",
	// SW → content (fire-and-forget)
	CONTENT_HIGHLIGHT: "sl:content:highlight", CONTENT_CLEAR_HIGHLIGHT: "sl:content:clearHighlight",
	CONTENT_SET_KEYBINDS: "sl:content:setKeybinds", CONTENT_START_NEW_GAME: "sl:content:startNewGame",
	// offscreen ↔ SW (also via port)
	OFFSCREEN_PING: "sl:offscreen:ping", OFFSCREEN_ENGINE_STATUS: "sl:offscreen:engineStatus",
	// shared
	LOG: "sl:log",
} as const;

// Port payloads
export type PanelPortMessage =            // SW → panel
	| { kind: "snapshot"; snapshot: PanelSnapshot }          // full state (on connect + on change, ≤10 Hz)
	| { kind: "toast"; level: "info"|"warn"|"error"; text: string }
	| { kind: "timingLog"; entry: TimingLogEntry };
export type GamePortMessage =             // content → SW
	| { kind: "hello"; site: Site; pageKind: PageKind; adapterVersion: string }
	| { kind: "position"; snapshot: PositionSnapshot }
	| { kind: "gameStarted"; game: GameMeta } | { kind: "gameEnded"; result: GameResult }
	| { kind: "cursor"; x: number; y: number; t: number; real: true } | { kind: "selectorMiss"; selector: string }
	| { kind: "focus"; hasFocus: boolean; visibility: "visible"|"hidden"; at: number }          // V2 §13.4: every window focus/blur/visibilitychange edge
	| { kind: "opponent"; isBot: boolean; name: string; ratingEstimate: number|null }        // V2 §13.6: opponent identity for matchOpponentRating
	| { kind: "moveObserved"; san: string; ply: number; byMe: boolean; atMs: number };
export type GamePortCommand =             // SW → content
	| { kind: "highlight"; from: Square; to: Square; style: HighlightStyle } | { kind: "clearHighlight" }
	| { kind: "arrow"; lines: Array<{from: Square; to: Square; weight: number}> }
	| { kind: "keybinds"; keybinds: Keybinds } | { kind: "startNewGame" } | { kind: "speak"; text: string };
export type EnginePortMessage =           // offscreen → SW
	| { kind: "line"; line: string } | { kind: "status"; status: EngineStatus } | { kind: "nnue"; progress: number };
export type EnginePortCommand =           // SW → offscreen
	| { kind: "uci"; line: string } | { kind: "restart" } | { kind: "loadNnue"; names: string[] };
```

`PositionSnapshot = { site, gameId, fen, ply, sideToMove, myColor, lastMove?: {from,to,san}, clocks: {w:{ms,running}, b:{ms,running}}, timeControl?: {baseMs, incMs}, capturedAt }`.

`PanelSnapshot = { license: LicenseState, site: Site|null, pageKind, session: GameSessionView, engine: EngineStatus, executor: {debuggerAttached: boolean, lastError?: string}, settings: Settings, recommendation?: Recommendation, autoMove: {armed: boolean, scheduledAt?: number, plan?: TimingPlan}, stats: SessionStats, focus: { pageHasFocus: boolean; blurSeenThisMove: boolean; handsOff: boolean; realPointerEventsDuringHand: number } /* V2 §13.4, V2.1 §13.5 */, opponent?: { isBot: boolean; name: string; ratingEstimate: number|null; derivedTargetElo: number } /* V2 §13.6 */ }`.

`Recommendation = { chosen: ChosenMove, lines: EvalLine[], eval: Eval, wdl?: [number,number,number], depth: number, nps: number, plan: TimingPlan, computedAt: number, fen: string }` where `EvalLine = { multipv, score: {cp?:number, mate?:number}, depth, pvUci: string[], pvSan: string[] }` and `ChosenMove = { uci, san, from, to, promotion?, source: 'engine-elo'|'sampled'|'blunder'|'mate'|'book'|'premove', rankInLines: number, cpLoss: number, rationale: string[] }`; `GameSessionView = { state: GameSessionState; gameId: string|null; site: Site|null; pageKind: PageKind; myColor: 'w'|'b'|null; sideToMove: 'w'|'b'|null; ply: number; clocks: PositionSnapshot['clocks']|null; timeControl?: {baseMs, incMs}; hand: 'resting'|'exploring'|'moving'|'paused'|'detached'; lastExecution?: ExecutionResult }`.

### 4.4 Storage schema (`src/types/storage.ts`, `src/types/settings.ts`)

```ts
export interface Settings {
	enabled: boolean;
	strength: { targetElo: number; matchOpponentRating: boolean; personaEloOffset: number; persona: PersonaId; selectionMode: "engine-elo"|"persona-sampling"|"hybrid"; useOpeningBook: boolean; blunderScale: number /*0..2*/ };   // V2.1: matchOpponentRating (default true) derives targetElo from the opponent (§13.6)
	timing: { profile: "manual"|"fast"|"natural"|"slow"|"custom"; speedScale: number; varianceScale: number; premoveTendency: number; longThinkFrequency: number; respectBudget: boolean };
	execution: { style: "drag"|"click"|"auto"; motorSpeed: number; keepDebuggerAttached: boolean; verifyMoves: boolean; calibrateFromMyMouse: boolean; backend: "cdp"|"native"; previewSelects: "auto"|"off"; previewSelectScale: number /* 0.5..2, multiplies the model rate (V2.1) */ };
	automation: { autoMove: boolean; autoQueue: boolean; highlightMoves: boolean /* V2 default false, §13.3 */; highlightStyle: "squares"|"arrows"|"both" };
	keybinds: { playMove: Keybind; toggleAutoMove: Keybind; disable: Keybind; speakMove: Keybind; global: boolean };
	display: { evalBar: boolean; pvCount: number; uiSounds: boolean; tts: boolean; ttsVoice: string|null; theme: "dark"|"light"|"system"; reducedMotion: "system"|"on"|"off" };
	engine: { threads: number|"auto"; hashMb: number; depthCap: number; multiPv: number; nnue: "small"|"big"|"auto" };
	advanced: { logLevel: LogLevel; timingLogEnabled: boolean };
}
export interface Keybind { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ /* values in Task 4; the ONLY definition */ });
export interface LicenseState { status: "unknown"|"valid"|"invalid"|"ip_limit"|"expired"|"network_error"; rawStatus?: LicenseState["status"] /* V2: the endpoint's real verdict when LICENSE_FORCE_VALID */; checkedAt: number; expiresAt?: number; message?: string }
```


### 3.4a Site adapters — decisions (research basis: Appendix C, live-verified in Chrome on 2026-09-03)

| Concern | chess.com | lichess |
|---------|-----------|---------|
| Board element | `wc-chess-board#board-single` / `#board-play-computer`; rect = exact 8×8 area; no shadow DOM | `cg-board` inside `.cg-wrap.orientation-{white,black}[.manipulable]`; rect = 8×8 area (coords never affect it) |
| Authoritative state | MAIN-world `board.game`: `getFEN()`, `getTurn()`, `getPlayingAs()`, `getMode().name === "playing"`, `getLegalMoves()`, `getLastMove()`, `getHistorySANs()`, `getPositionInfo()/getResult()`, `timeControl.get()`, `timestamps.get()`, `on("Move"|"Load"|"CreateGame")` | `window.lichess.events.on("ply")` (public API) + DOM; the round controller and chessground instance are **not** exposed on game pages |
| DOM → placement (self-check + fallback) | `.piece` with `[wb][prnbqk]` + `square-XY` classes (regex, any order); skip while `.piece.dragging` | `cg-board > piece.{color}.{role}[style=transform: translate(x,y)]`, orientation-aware; skip while `piece.anim`/`.dragging`; `square.last-move` pair |
| Full FEN | `game.getFEN()`; else SAN replay through chess.js cross-checked against DOM placement (`approximate: true` on mismatch) | SAN replay (structural move-list detector) cross-checked against DOM placement |
| Move list | `wc-simple-move-list .node.main-line-ply > .node-highlight-content(.selected)` (+ `data-figurine`) | **Tag names are obfuscated and rotate** (2026-07-03: `kwdb/i5z/l4x/rm6/rb1 → Z7yx/qZM/aPp/i5d/bo3`); use the structural detector (`findLichessRoundMoves`) + `events.on("ply")`, persist discovered tags |
| Clocks | `.clock-component.clock-{top,bottom}.clock-{white,black}[.clock-player-turn] span.clock-time-monospace[role=timer]` (`m:ss.t` under 20 s) | `.rclock.rclock-{top,bottom}.rclock-{white,black}[.running][.emerg] > .time` (`<sep>`, `<tenths>`) |
| Colour / turn | `getPlayingAs()`; DOM `#board-layout-player-bottom .cc-user-block-{white,black}`; `.flipped` / `getOptions().flipped` (never `isWhiteOnBottom`) | `body.playing` + `.cg-wrap.manipulable` ⇒ `orientation-black ? b : w`; `.rclock.running` colour |
| Game over / new game | `.game-over-modal-shell-content … .game-over-modal-header-{userWon,…}`, `.result-row .game-result`; buttons ladder (`[data-cy=…]`, `[aria-label="New Game"]`, `.new-game-buttons-component button`) | `.result-wrap > p.result`; `.rcontrols .follow-up button.fbt.rematch` / `button.fbt.new-opponent` |
| Highlights / arrows | native `game.markings.addOne({type:"arrow"|"highlight", …})` with returned keys; overlay SVG fallback | own overlay `<svg viewBox="0 0 8 8">` appended to `cg-container` (never inside `svg.cg-shapes`); analysis pages `chessground().setAutoShapes` |
| Promotion picker | `.promotion-window .promotion-piece.{wq,wn,wr,wb|bq…}` (rects from DOM) | `#promotion-choice.{top,bottom} > square` in order Q,N,R,B; `left = file·12.5 %` (mirrored when black), `top = i·12.5 %` when colour == orientation else `(7−i)·12.5 %` |
| Page kinds | `/game/live/<id>`, `/play/online*`, `/play/computer|bots`, `/game/daily`, `/analysis*`, `/puzzles*` + `getMode()` refinement; SPA (watch `popstate` + body observer) | `main.round` + `body.playing` (player, 12-char URL) vs spectator; `main.analyse`; `/training|storm|racer|streak`; MPA + rematch redirect |
| Input | trusted CDP only (§9); synthetic pointer events are accepted by chess.com but rejected as a design choice | trusted CDP only; chessground ignores untrusted events (`drag.start` checks `isTrusted`) |

V2 additions (§13): `getOpponent()` returns `{ isBot, name, ratingEstimate }` (chess.com bot card `.bot-component`/player row username + rating; lichess AI level from the opponent row "lichess AI level N" → Elo table {1:800,2:1100,3:1400,4:1700,5:2000,6:2300,7:2700,8:3000}); `detectPageKind()` must classify `vs-computer` (chess.com `/play/computer*`, `/play/bots*`; lichess round page whose opponent is the AI) so the panel can label the game; every live game page (`live-game` and `vs-computer`) is played. The adapter installs `window` `focus`/`blur` and `document` `visibilitychange` listeners (passive, capture) and reports every edge on the game port (`kind: "focus"`). No adapter method reads or writes page storage; highlights default off.

Move detection uses MutationObservers (board `class/style` + move list `childList/subtree` + clock `class`), debounced `TIMINGS.adapterDebounceMs`, plus the MAIN-world events where available; the 50 ms polling loops are gone. The selector registry (`src/content/adapters/selectors.ts`, Appendix C §5) holds ordered candidate ladders per concern; `probe()` runs at startup and on every game start and reports which candidate matched (`selectorMiss` telemetry to the panel Engine view). Self-checks (Appendix C §5): board sanity (2..32 pieces, one king each), replay-vs-DOM placement, turn consistency (API → clocks → parity), orientation consistency, geometry round-trip (`pointToSquare(squareToPoint(sq)) === sq`, `elementFromPoint` inside the board), lichess tag-rotation detector, chess.com API presence.


## 5. pagescript — the page-realm AST (C2)

### 5.1 Why an AST instead of JS strings

Code that runs inside chess.com or lichess (MAIN world bridges, CDP `Runtime.evaluate` expressions, overlay injections) is the most fragile and the most exposed code in the extension: it must not collide with site globals, must be parameterised safely (selectors, tokens, colours), and must not be authored as string templates that escape badly or drift from the TypeScript types. pagescript makes every page program a **typed tree** built with combinators; the build step prints it to JS (`astring`), applies identifier spoofing from the build seed, and emits a string constant plus a typed `bind()` function whose parameters are checked at compile time.

Boundary definition: **page-realm code** = anything evaluated in the site's JavaScript realm (MAIN world) or through the DevTools protocol. The ISOLATED-world content script is extension code and is ordinary TypeScript.

### 5.2 Node set (`src/pagescript/nodes.ts`)

A strict subset of ESTree, enough for our programs and nothing more (no classes, no generators, no `with`, no labels):

```ts
export type Node =
	| Program | FunctionExpression | ArrowFunctionExpression | BlockStatement | ExpressionStatement
	| VariableDeclaration | ReturnStatement | IfStatement | ForOfStatement | WhileStatement | TryStatement | ThrowStatement
	| Identifier | Literal | TemplateLiteral | ArrayExpression | ObjectExpression | Property
	| MemberExpression | CallExpression | NewExpression | UnaryExpression | BinaryExpression | LogicalExpression
	| ConditionalExpression | AssignmentExpression | AwaitExpression | SpreadElement | ChainExpression | Param;
// Each node carries `type` (ESTree name) so `astring.generate()` prints it unchanged.
```

Placeholders: `{ type: "Identifier", name: "$$param:selector" }` marks a **bind parameter**; `{ type: "Identifier", name: "$$spoof:token" }` marks a **spoofed identifier** (replaced with a deterministic per-build token from `__SL_SPOOF_SEED__`, same derivation as tranquill's `deriveToken`).

### 5.3 Builders (`src/pagescript/builders.ts`) — "our language"

```ts
export const js = {
	// literals & identifiers
	id: (name: string): Identifier, str: (s: string): Literal, num: (n: number): Literal, bool, nil, undef,
	param: <T>(name: string): Identifier,          // bind-time parameter (typed)
	spoof: (purpose: string): Identifier,          // build-time spoofed global/property name
	tpl: (strings: string[], ...exprs: Expression[]): TemplateLiteral,
	arr: (...items: Expression[]): ArrayExpression, obj: (props: Record<string, Expression>): ObjectExpression,
	// access & calls
	member: (obj: Expression, ...path: (string | Expression)[]): MemberExpression,  // js.member(js.id("document"), "body", "children", js.num(0))
	call: (callee: Expression, ...args: Expression[]): CallExpression,
	opt: (obj: Expression, ...path: string[]): ChainExpression,                     // a?.b?.c
	new_: (callee: Expression, ...args: Expression[]): NewExpression,
	// statements
	const_: (name: string, init: Expression): VariableDeclaration, let_: (name: string, init?: Expression),
	assign: (target: Expression, value: Expression): ExpressionStatement,
	if_: (test: Expression, then: Statement[], else_?: Statement[]): IfStatement,
	forOf: (name: string, iterable: Expression, body: Statement[]), while_: (test, body),
	ret: (value?: Expression): ReturnStatement, throw_: (value: Expression), try_: (body, catchParam, handler, finalizer?),
	expr: (e: Expression): ExpressionStatement,
	// functions
	fn: (params: string[], body: Statement[], opts?: { async?: boolean; name?: string }): FunctionExpression,
	arrow: (params: string[], bodyOrExpr: Statement[] | Expression, opts?: { async?: boolean }): ArrowFunctionExpression,
	iife: (body: Statement[], opts?: { async?: boolean }): CallExpression,
	// operators
	op: (left: Expression, operator: BinaryOperator, right: Expression), not: (e), and: (a, b), or: (a, b), nullish: (a, b),
	cond: (test, consequent, alternate), await_: (e), typeof_: (e), spread: (e),
	// program
	program: (body: Statement[]): Program,
};
```

`src/pagescript/std.ts` adds domain combinators built from the primitives so page programs stay short and uniform: `std.query(selector)`, `std.queryAll(selector)`, `std.postToExtension(token, payload)` (→ `window.postMessage({__sl: token, ...payload}, location.origin)`), `std.onExtensionMessage(token, handlerFn)`, `std.defineOnce(globalName, valueExpr)` (idempotent install guard on `window[spoofed]`), `std.tryCatchLog(body)`, `std.rect(elExpr)` (→ `getBoundingClientRect()` to a plain object), `std.jsonClone(e)`.

### 5.4 Emit, spoof, bind (`emit.ts`, `spoof.ts`, `bind.ts`)

- `emit(program, { seed }) → { code: string; params: ParamSpec[] }` — build-time. Walks the tree, replaces `$$spoof:*` identifiers with `deriveToken(seed, purpose)`, validates that every `$$param:*` identifier appears in the declared parameter list of the program's outer function, and prints with `astring` (`indent: "", lineEnd: ""` for compact output, source maps off).
- Every page program is exported as `defineProgram({ name, params: { selector: "string", token: "string", colours: "json" }, build: (p) => js.program([...]) })`. `scripts/gen-pagescript.ts` compiles all programs under `src/page/*.ts` and writes `src/page/generated/<name>.ts` exporting `{ code, bind }` where `bind(args: Params) → string` substitutes JSON-encoded arguments for the `$$param` slots (via a `Literal` substitution before printing when compiled per-call, or a safe `JSON.stringify` replacement into pre-printed placeholders `/*$$param:x*/`) — the generated `bind` is typed from `params`, so a wrong argument type is a compile error in the caller.
- Runtime-side, only the generated strings + `bind` functions ship; `astring` and the builders are build/test-time dependencies (kept out of the extension bundles by the `scripts/gen-pagescript.ts` split).
- Tests (`test/pagescript/*.test.ts`) evaluate emitted code with `new Function` inside happy-dom to assert behaviour, and snapshot-test the emitted source so refactors are visible.

### 5.5 Page programs (`src/page/*.ts`) — the complete list

| Program | Purpose | Delivery |
|---------|---------|----------|
| `chesscom-bridge` | Locate `wc-chess-board` (retry until defined), expose `game` accessors; relay `Move`/`Load`/`GameOver` events to the ISOLATED world via `std.postToExtension`; accept commands `getState`, `draw`, `clear`, `legalMoves` | MAIN-world content script (`world: "MAIN"`, `document_start`, generated file registered in manifest) |
| `lichess-bridge` | Observe `cg-board`/`cg-container` and the round data (`main.round` JSON in `#main-wrap` `data-*`, `lichess`/`site` globals); relay position/clock/turn; draw shapes via a `cg-custom-svgs` overlay if the chessground instance is not reachable | MAIN-world content script |
| `highlight-overlay` | Generic DOM overlay for from/to squares + SVG arrow when native drawing is unavailable; parameterised by board rect, orientation, colours from tokens | injected by content script via `std` (not CDP) |
| `cursor-probe` | Returns last known pointer position captured by a capture-phase `pointermove` listener installed once (`std.defineOnce`) | MAIN world via bridge (used by the executor for path start) |
| `focus-probe` | Returns `document.hasFocus()`, `visibilityState`, board rect, `devicePixelRatio`, scroll offsets — the executor's pre-flight | CDP `Runtime.evaluate` (returnByValue) |
| `verify-move-probe` | Reads the last move from site state (bridge) for executor verification when the port is slow | CDP `Runtime.evaluate` |

Program parameters (`token`, selectors from `selectors.ts`, colours from `tokens.generated.ts`) are passed at bind time, so the page programs never embed a literal that another module also owns (C1).

### 5.6 Example (authoring style — this is what engineers write)

```ts
// src/page/focus-probe.ts
import { js, std, defineProgram } from "@pagescript";
export const focusProbe = defineProgram({
	name: "focusProbe",
	params: { boardSelector: "string" },
	build: (p) => js.program([
		js.ret(js.call(js.arrow([], [
			js.const_("el", std.query(p.boardSelector)),
			js.ret(js.obj({
				hasFocus: js.call(js.member(js.id("document"), "hasFocus")),
				visibility: js.member(js.id("document"), "visibilityState"),
				dpr: js.member(js.id("window"), "devicePixelRatio"),
				rect: js.cond(js.id("el"), std.rect(js.id("el")), js.nil()),
			})),
		]))),
	]),
});
```
emits (spoof/param resolved at build):
```js
(() => { const el = document.querySelector(/*$$param:boardSelector*/"wc-chess-board"); return { hasFocus: document.hasFocus(), visibility: document.visibilityState, dpr: window.devicePixelRatio, rect: el ? (r => ({x:r.x,y:r.y,width:r.width,height:r.height}))(el.getBoundingClientRect()) : null }; })()
```


## 6. Engine: distribution, hosting, NNUE storage, UCI framework

Research basis: Appendix A (verified 2026-09-03 against Stockfish sources, npm, lichess `stockfish-web`, Chrome docs).

### 6.1 Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Engine distribution | `@lichess-org/stockfish-web` 0.4.4, target **`sf_18_smallnet`** (+ `_relaxed-simd` variant chosen at runtime) | Only maintained SF18 WASM with a separate-NNUE API (`setNnueBuffer`), SIMD + pthreads, ~600 KB wasm, TypeScript typings, production-proven at lichess. `nmrugg/stockfish` bakes nets into 7–113 MB wasm files; `stockfish.wasm` is SF11-era. |
| Stockfish version | **Stockfish 18** (tag `sf_18`, 2026-01-31) | Latest stable release. |
| NNUE ("model") storage | Bundle `nn-4ca89e4b3abf.nnue` (10.4 MB, smallnet) in the package; **optional** full-strength pack (`sf_18.wasm` + `nn-c288c895ea92.nnue` 72.8 MB + `nn-37f18f62d772.nnue` 2.9 MB) downloaded on demand into **OPFS** with SHA-256-prefix verification (`nn-<12 hex>` is the hash) and IndexedDB fallback | Package stays small; engine works offline immediately; upgrade is opt-in. `EvalFile` path options are non-functional in the wasm build; `setNnueBuffer(buf, index)` is the supported path. No compression (int8/16 weights compress <15%; Chrome lacks native brotli/zstd streams). |
| Host context | **Offscreen document** (`reasons: ["WORKERS"]`), created via a `runtime.getContexts` guard (`hasDocument` is Chrome 150+) | Service workers cannot create Workers; pthread builds need Workers + SharedArrayBuffer. |
| Cross-origin isolation | Manifest `cross_origin_embedder_policy: require-corp`, `cross_origin_opener_policy: same-origin`; assert `self.crossOriginIsolated` in the offscreen page | Required for SAB. Side effect: cross-origin fetches from extension pages need CORP; the big-net download is performed by the **service worker** (not COEP-restricted) and handed to the offscreen doc as an ArrayBuffer over the port in 4 MB chunks. |
| CSP | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` | MV3 minimum; module workers loaded from extension URLs. |
| Strength control | `UCI_LimitStrength true` + `UCI_Elo` (1320–3190) **and** `MultiPV ≥ 4` so `info multipv` lines expose candidates; our selection layer (§7) covers 400–1319 and human-like variance | Engine's own limiter never plays human blunders; needs a layer on top. |
| Threads / Hash | `Threads = clamp(hardwareConcurrency − 2, 1, 4)` (setting `engine.threads`), `Hash 32` (16–128) | Each thread is a pthread Worker; shallow limited-strength searches need little hash. |
| License | AGPL-3.0-or-later package (Stockfish GPL-3) | Ship the engine's source offer (`assets/engine/LICENSE` + link to the build repo) in the settings "About" section. |

### 6.2 Files vendored (`assets/engine/`)

```
sf_18_smallnet.js / .wasm                    28.6 KB / 596 KB     (ES module factory; also the pthread worker script)
sf_18_smallnet_relaxed-simd.js / .wasm       28.7 KB / 596 KB     (optional; picked when WebAssembly.validate(relaxed-simd probe) passes)
nn-4ca89e4b3abf.nnue                         10.4 MB              (smallnet weights)
sf_18.js / .wasm                             28.6 KB / 602 KB     (full build; nets fetched on demand)
LICENSE                                       AGPL text
```
`stockfishWeb.d.ts` is copied to `src/types/stockfish-web.d.ts` (types only).

### 6.3 Offscreen engine host (`src/offscreen/`)

- `stockfish-loader.ts` — `bootEngine(variant: "smallnet"|"full") → Promise<StockfishWeb>`: check isolation, choose relaxed-simd, `const factory = (await import(chrome.runtime.getURL(`assets/engine/${js}`))).default`, `factory({ wasmMemory: sharedMemory(initialPages), locateFile, mainScriptUrlOrBlob })` with a shrink-on-failure loop for `initial` pages (2560 → 1536 → 1024), then `getRecommendedNnue(i)` loop → `setNnueBuffer(await nnueStore.get(name), i)`.
- `nnue-store.ts` — `get(name) → Uint8Array`: bundled (`fetch(chrome.runtime.getURL("assets/engine/"+name))`) → OPFS → request download from SW (`EnginePortMessage {kind:"nnue-request", name}` → SW fetches `https://tests.stockfishchess.org/api/nn/<name>` and streams chunks back) → verify `sha256(buf).slice(0,12) === name.slice(3,15)` → persist to OPFS (`navigator.storage.getDirectory()`), IndexedDB fallback. Progress events go to the panel (`nnue` progress).
- `engine-host.ts` — owns exactly one engine instance; wires `sf.listen → port.post({kind:"line", line})`, `sf.onError → status`, `port.onMessage {kind:"uci"} → sf.uci(line)`; on `restart` destroys and re-boots with backoff `TIMINGS.engineRestartBackoffMs`; reports `EngineStatus = { state: "booting"|"loading-nnue"|"ready"|"searching"|"crashed", variant, threads, nnue: string[], nps?: number, version: string }`.
- `index.ts` — connects `PORT_NAMES.engine` to the SW on load and re-connects on disconnect (the SW may restart; the offscreen doc does not die with it). Note: **`chrome.storage` is not available in offscreen documents** — every setting the host needs arrives over the port.
- `timing-inference.ts` — hosts the optional v2 timing head (§8.4) so the SW stays thin.

### 6.4 UCI client framework (`src/core/engine/`)

```ts
export interface EngineTransport { send(line: string): void; onLine(cb: (line: string) => void): () => void; onStatus(cb: (s: EngineStatus) => void): () => void; restart(): Promise<void> }
export interface AnalysisLimit { depth?: number; movetimeMs?: number; nodes?: number; infinite?: true }
export interface AnalysisRequest { id: string; fen: string; moves?: string[]; multiPv: number; limit: AnalysisLimit; searchmoves?: string[]; elo?: number /* UCI_Elo; undefined = full strength */ }
export interface AnalysisUpdate { id: string; depth: number; seldepth?: number; lines: EvalLine[]; nodes: number; nps: number; timeMs: number; complete: boolean /* all multipv lines for this depth arrived */ }
export interface AnalysisResult { id: string; bestmove: string | null; ponder?: string; final: AnalysisUpdate; engineElo?: number }
export interface AnalysisHandle { updates: AsyncIterable<AnalysisUpdate>; result: Promise<AnalysisResult>; stop(): Promise<void> }
export class UciEngine {
	constructor(transport: EngineTransport, opts: { readyTimeoutMs: number; stopTimeoutMs: number });
	init(): Promise<EngineInfo>;                       // uci → uciok (parse `option` lines into EngineInfo.options)
	setOptions(opts: Partial<EngineOptions>): Promise<void>;   // diffed; only sends changes; waits readyok; refused while searching
	newGame(): Promise<void>;                           // ucinewgame + isready
	analyse(req: AnalysisRequest): AnalysisHandle;     // queued: one search at a time; `stop` then wait bestmove before next position/go
	ponder(fen: string, moves: string[], multiPv: number): AnalysisHandle;   // go infinite (cancelled by the next analyse)
	state(): "idle" | "initialising" | "searching" | "stopping" | "crashed";
}
```
- `uci-parser.ts` — `parseInfo(line) → Info | undefined` exactly per Appendix A §6 (tokens: depth, seldepth, multipv, score cp/mate ± bound, wdl, nodes, nps, hashfull, tbhits, time, pv, currmove, currmovenumber, string), `parseBestmove(line)`, `parseOption(line)`, `parseId(line)`. `lowerbound`/`upperbound` lines are ignored for multipv 1 and accepted for k > 1 (lichess behaviour).
- `uci-client.ts` — the state machine `idle → searching → stopping → idle` with `initialising` and `crashed`; a FIFO of `AnalysisRequest`s; per-request accumulation of the latest line per `multipv` index and an `updates` async iterator that yields only when a depth iteration completes (or every `TIMINGS.engineInfoCoalesceMs` for partial); mate scores mapped to cp via `±(2000 − 10·plies)` for consumers that need a scalar (`cpEquivalent`); on transport `crashed` all pending handles reject and the client re-`init`s with replayed options.
- `remote-engine.ts` — the SW-side `EngineTransport` over `PORT_NAMES.engine` (`connectPort` from Task 4) so `UciEngine` runs in the SW while the engine runs offscreen. Backpressure: the host coalesces `info` lines per multipv index and forwards at most every 50 ms; the SW forwards panel snapshots at most every `TIMINGS.panelSnapshotMinIntervalMs`.
- `analysis-cache.ts` — `LruCache<string, AnalysisResult>` keyed by `${fen}|${multiPv}|${elo}|${limitKey}` (`LIMITS.analysisCacheEntries`); ponder results are inserted so the opponent's expected reply is often a cache hit.
- `options.ts` — `EngineOptions` (`Threads`, `Hash`, `MultiPV`, `UCI_ShowWDL`, `UCI_LimitStrength`, `UCI_Elo`, `Skill Level`, `Ponder`, `Move Overhead`) with defaults and clamps from `LIMITS`; `optionsForSettings(settings) → EngineOptions`.

Per-move protocol (SW `GameSession`): opponent moves → `engine.analyse({fen, multiPv: settings.engine.multiPv ≥ 4, limit: {movetimeMs: budget}, elo: engineElo})` where `budget = min(settings-derived, plan-independent 400–1500 ms)`; when the timing plan needs the engine to be "done" before acting, the executor waits on `result`. While it is the opponent's turn: `engine.ponder(fen)` at full strength MultiPV 4 for `≤ TIMINGS.ponderMaxMs`, producing `expectedOppReply = lines[0].pvUci[0]` for the timing model's `ponder_hit` feature.

### 6.5 Feature depth for the timing model

The timing model consumes MultiPV output at a fixed feature depth `D_f = 10` (Appendix D §2). The client therefore records the last complete depth-10 iteration separately (`AnalysisResult.atFeatureDepth`) even when the search continues deeper.


## 7. Strength and move selection

Research basis: Appendix E (full formulas, prior table, book formats, calibration loop). Appendix A §2 verified the engine's `Skill`/`UCI_Elo` internals from `search.cpp`.

### 7.1 How `UCI_Elo` and our layer fit together (the "hybrid" default)

Verified engine behaviour (SF18): with `UCI_LimitStrength true`, the search runs at full strength with `MultiPV = max(MultiPV, 4)`; at iterative-deepening depth `1 + int(level)` the engine freezes a weighted-random pick among the top-`MultiPV` root moves (`weakness = 120 − 2·level`, spread capped at one pawn) and later swaps it into `bestmove`. The `info multipv k` lines remain the honest full-strength lines. Consequences:

- One search yields **both** the engine's Elo-limited pick (`bestmove`) and the candidate set with true evals (`info` lines). We therefore always run with `UCI_LimitStrength true` + `UCI_Elo = clamp(targetElo, 1320, 3190)` (the owner's requirement: the Elo parameter is passed to the engine) and `MultiPV = settings.engine.multiPv` (≥ 4, default 6).
- The engine's limiter alone never produces human-style errors (it cannot pick outside the top-`MultiPV`, never hangs a piece to a 2-move tactic once `level` ≥ 3, plays forced tactics perfectly) and its floor is 1320. So the **selection layer** (`src/core/strength/move-selector.ts`) makes the final choice from the candidates using a rating-parameterised stochastic policy, with the engine's pick entering as a prior boost.

`Settings.strength.selectionMode`:
| Mode | Behaviour |
|------|-----------|
| `engine-elo` | play `bestmove` as returned by the engine at `UCI_Elo` (debug / purist mode) |
| `persona-sampling` | ignore `bestmove`; sample from MultiPV with the policy below (engine still runs with `UCI_Elo` so evals are unchanged) |
| `hybrid` (default) | policy below, with `prior(bestmove) ×= 2.0` so the engine's Elo pick is favoured but not forced |

### 7.2 Selection policy (normative; constants live once in `src/core/strength/constants.ts`)

Inputs: `lines: EvalLine[]` (side-to-move POV), `targetElo`, per-game `form` latent (AR(1) `form_t = 0.85·form_{t−1} + N(0, 0.25)`, clamped ±1), game context (ply, phase, clocks, last move), optional `prior: Map<uci, number>`.

1. `E = clamp(targetElo + 150·form, LIMITS.eloMin, LIMITS.eloMax)`.
2. Effective score `cpEff` = cp clamped ±`LIMITS.cpClamp`; mate → `±(1000 + (100 − |mate|))` with sign.
3. Score jitter `cpEff += N(0, σ(E))`, `σ(E) = 8 + 42·clamp((2400 − E)/1600, 0, 1)`.
4. Win-probability loss: `win(cp) = 1/(1 + e^(−0.00368208·cp))`, `loss_i = win(best) − win(i)`.
5. Never-play filters (Appendix E §1.5): no move into forced mate when an alternative exists (except `E < 1000` with p = 0.25 for mates ≥ 2 plies deep); play mate-in-≤3 with p = 1 for `E ≥ 1400`, else `0.5 + 0.5·(E−800)/600`; never hang a piece for nothing outside the blunder channel.
6. Blunder channel: with `b(E, ctx) = b0(E)·f_clock·f_complexity` (`b0`: 0.075 @<1000 … 0.005 @2500; `f_clock = 1 + 1.5·clamp((20 s − clock)/20 s, 0, 1)`; `f_complexity = 1 + 0.6·[std(cpEff) ≥ 150]`; scaled by `Settings.strength.blunderScale`), draw a target loss (65 %: U(0.10, 0.30) "mistake", 35 %: U(0.30, 0.70) "blunder") and pick the candidate whose loss is nearest the target weighted by prior. Streak damper: `b ×= 0.3` for 3 moves after an injected blunder.
7. Base policy over candidates within gap `G(E) = 60 + 440·clamp((2200 − E)/1400, 0, 1)` cp of the best: `p_i ∝ exp(−loss_i / τ(E)) · prior_i^β(E)` with `τ(E) = clamp(0.02 + 0.28·((2500 − E)/1700)², 0.02, 0.30)` and `β(E)` = 0.6 (<1600) / 0.4 (<2200) / 0.2. After 12 consecutive top-1 picks, `τ ×= 1.3` until a non-top-1 is played.
8. `prior_i` = heuristic prior table (Appendix E §3.4: recapture ×2.5, check ×1.4/×1.15, capture of undefended piece ×1.8, castling ×1.6, development ×1.4, quiet middlegame king move ×0.35, underpromotion ×0.05, …) × situational modifiers (simplify when ahead / complicate when behind, endgame technique by Elo) × `2.0` for the engine's `bestmove` in hybrid mode × optional Maia prior (v2.1+, `onnxruntime-web` in the offscreen doc, Maia-1 ONNX nets; not shipped in v2.0).
9. Output `ChosenMove { uci, san, source: 'book'|'sampled'|'engine-elo'|'blunder'|'mate'|'premove', rankInLines, cpLoss, rationale[] }`.

Target whole-game statistics (Appendix E §1.6) are the acceptance bands for the calibration loop (`tools/data/calibrate_selection.py`): e.g. Elo 1200 → top-1 agreement 42–48 %, ACPL 75–95, 2.0–2.5 blunders/40 moves; Elo 2000 → 52–58 %, ACPL 28–40, 0.5–0.8.

### 7.3 Opening play (`src/core/strength/book/`)

Order while `ply ≤ 30` and `Settings.strength.useOpeningBook`:
1. **Lichess opening explorer** (`URLS.lichessExplorer`, `ratings` = the three buckets around `E`, `speeds` matched to the game's time control; 1 200 ms timeout; one request in flight; 429 → 60 s back-off; results cached in `chrome.storage.local` under a 30-day TTL, 2 000-entry LRU). Sample `p_i ∝ n_i^γ(E)`, `γ(E) = 0.75 + 0.25·clamp((E − 1200)/1200, 0, 1)`, only moves with `n_i ≥ max(5, 0.02·N)`; leave book when `N < 200` or (`E ≥ 1800` and sampled loss ≥ 0.15). Requires `host_permissions` for `https://explorer.lichess.ovh/*`; documented as a privacy toggle (position is sent to lichess).
2. **Polyglot book** offline fallback: `assets/books/gm2600.bin` (347 KB) for `E ≥ 1800`, `assets/books/club.bin` (generated, ≤ 3 MB) below; reader per Appendix E §2.2 (781-entry Random64 table, binary search, castling remap, promotion bits). Loaded in the SW from `chrome.runtime.getURL`.
3. Engine selection (§7.2). The engine searches in parallel regardless (panel eval; trap check for `E ≥ 2000`).

### 7.4 Premove candidates

Bullet/blitz only, `E ≥ 1200`, probability `0.35 + 0.5·clamp((E − 1200)/1200, 0, 1)` (further gated by the timing model's `π_p`): after choosing `m`, take the opponent reply `r` from the engine's `ponder` (or a 150 ms MultiPV-3 search); require `p(r) ≥ 0.6` under softmax(τ = 0.06) over the opponent's lines; analyse after `m r` (`movetime 120`, MultiPV 2); premove `q` only if it is a recapture on the just-captured square, the only legal move, or `loss_2nd ≥ 0.25`, and not a king move. The content script executes the premove only if the opponent actually plays `r`.

### 7.4a Opponent-matched target (V2.1, §13.6)

When `Settings.strength.matchOpponentRating` is true (default), `targetElo = clamp(opponent.ratingEstimate + Settings.strength.personaEloOffset, LIMITS.eloMin, LIMITS.eloMax)`, where `personaEloOffset` defaults to `+50` (slightly stronger than the opponent so games are won at a plausible rate, not crushed). If the adapter cannot identify the opponent's rating, the slider value is used and the panel says "opponent rating unknown". The session strip reports running top-1 % and ACPL against the §7.2 band for the derived target and warns after three consecutive out-of-band games.

### 7.5 Search budget policy

`tEngine = clamp(0.6·plannedThinkMs, 150, 4000)` ms with `depthCap` by speed (bullet 14 / blitz 18 / rapid 22 / classical 24, capped by `Settings.engine.depthCap`), `K = 3 (< 300 ms) / 6 (< 1500 ms) / 8`. Panel-only mode (auto-move off and no keybind pending): `go infinite` coalesced. Pondering: after our move, `go infinite` MultiPV 3 on the opponent's position; on the opponent's move `stop → bestmove → position → go`. `ucinewgame` once per game. Quality guard: depth < 8 → one retry with +300 ms; depth < 6 → top-2 only with `τ/2`.


## 8. Move-timing model

Research basis: Appendix D (full design with formulas, constants, literature). This section fixes the architecture and the API; the constants table in Appendix D §7 is normative and is transcribed into `src/core/timing/constants.ts` **once** (C1).

### 8.1 What is being replaced

The legacy multiplier chain (base slider × random × distance × phase × clock × four coin-flips × clamps) had no dependence on position complexity, eval, time control, opponent pace or game history, and could not produce the spike-body-tail shape of real human think times.

### 8.2 Architecture

```
per game   PersonaSampler  →  { s_game, ι, π_p, τ, ρ_mirror, motor_k }        (sampled fresh per game; no cross-game state, V2.2)
per move   Features(ctx)  →  BudgetController(alloc)  →  DistributionHead.sample()  →  PressureCaps  →  MotorSplit  →  TimingPlan
                                                        v1: parametric (ships)   |   v2: 28→96→96→32 MLP (JSON weights, offscreen)
state      AR(1) residual ε_t, tilt counter, my/opp pace histories, budget_used_ratio — reset at game start, fed by observe()
```

Think time is modelled on the log scale: `log t = log alloc + Σ β_i f_i + s_game + ε_t`, with a discrete **premove / instant** spike, a log-normal **body**, and a Pareto **long-think** tail; then time-pressure compression and hard caps; then a split into invisible wait + motor time (hover + drag + promotion).

### 8.3 Interfaces (`src/core/timing/types.ts`, normative)

```ts
export type TcClass = "bullet" | "blitz" | "rapid" | "classical";
export type TimingMode = "premove" | "instant" | "normal" | "long";
export interface TimingContext {
	fen: string; ply: number; moves: string[]; myColor: "w" | "b";
	chosenMove: string; lines: EvalLine[] /* at feature depth */; evalBeforeOppMove: number | null; expectedOppReply: string | null;
	myClockMs: number; oppClockMs: number; baseSec: number; incSec: number;
	oppThinkMsHistory: number[]; myThinkMsHistory: number[];
	site: Site; targetElo: number; profile: PersonaProfile; engineReady: boolean;
	inputMethod: "drag" | "click"; autoQueen: boolean; nowMs: number;
}
export interface TimingPlan {
	thinkMs: number; mode: TimingMode; preMoveHoverMs: number; dragDurationMs: number;
	fakeout?: { piece: Square; holdMs: number; gapMs: number }; promotionDelayMs?: number;
	deadlineMs: number; rationale: string[]; features: Record<string, number>;
}
export type ReplanReason = "engine-not-ready" | "engine-changed" | "clock-jump" | "opponent-moved" | "blur" | "manual-now" | "emergency";
export interface DistributionHead { readonly id: "v1-parametric" | "chessmimic"; sample(f: Features, persona: Persona, state: GameTimingState, rng: Rng, allocSec: number): { tSec: number; mode: TimingMode; why: string[] } }
// Implementations: chessmimic-head.ts (the timing head — ONNX via onnxruntime-web in the offscreen document, assets/models/chessmimic/*.onnx; §8.4b item 6) and v1-head.ts (constants, always-available fallback).
export class TimingModel {
	constructor(head: DistributionHead, settings: Settings["timing"], rng: Rng);
	startGame(meta: { targetElo: number; profile: PersonaProfile; baseSec: number; incSec: number; site: Site; gameId: string }): void;
	planMove(ctx: TimingContext): TimingPlan;
	replan(plan: TimingPlan, ctx: TimingContext, reason: ReplanReason): TimingPlan;
	observe(actualThinkMs: number, plan: TimingPlan): void;
}
```

Features (25, Appendix D §2) are computed by `features.ts` from `PositionSnapshot` + `AnalysisResult.atFeatureDepth` + chosen move + clocks + histories. The budget controller (`budget.ts`) implements Appendix D §3a.2 (`N_rem`, `reserve`, `alloc`). `distributions.ts` provides `logNormal`, `pareto`, `sigmoid`, `truncNormal` on top of `@core/rng`. `persona-latents.ts` implements Appendix D §4. `v1-head.ts` implements Appendix D §3a.3–§3a.5 and Appendix D Appendix A verbatim; `chessmimic-head.ts` (default) prepares ChessMimic's inputs in TypeScript (searchless_chess FEN tokeniser, 1 968-entry UCI vocabulary, last-12-move window, per-band scaler constants embedded as JSON, virtual clock for clockless games) and calls `timing-inference.ts` in the offscreen document, which runs the exported ONNX clock model through onnxruntime-web and returns the 30 bucket probabilities; decoding (mask, bucket sample, within-bucket sample) happens in the SW. v1 is the fallback if the asset fails to load or inference exceeds its budget.

### 8.4 Where it runs

`TimingModel` orchestration runs in the **service worker**. The ChessMimic head's inference runs in the offscreen document via `timing-inference.ts` (onnxruntime-web WASM, SIMD + threads under the existing COOP/COEP isolation; `ort.wasm.min.js` + `ort-wasm-simd-threaded.wasm` vendored under `assets/vendor/onnxruntime/`) and is called over the engine port with a 100 ms budget (p95 target; int8 quantisation if fp16 misses it); on timeout or failure the v1 head answers. Because the engine ponders on the opponent's clock, the timing query is issued as soon as the opponent's move arrives and normally completes before the orientation latency elapses, so it adds no visible delay.

### 8.4a Telemetry mapping (V2, §13.2)

`TimingPlan.thinkMs` is, by construction, the value chess.com records as `MoveHoldTime` (position arrival → move completion) and lichess records as the move time. The model therefore *is* the telemetry shaper: the spike/body/tail shape, complexity and phase dependence, budget behaviour and compression under pressure are what make the per-move distribution human. Two additional guards apply in bot play: no non-premove/instant move completes in under 250 ms (`TIMING_CONSTANTS.minNormalMs`), and the per-game coefficient of variation of `thinkMs` must stay ≥ 0.5 (the model re-samples the residual if a game's running CV falls below it after 12 moves). A blur observed inside a move window (§13.4) cancels the move for that position and `observe()` records the extra elapsed time so ε_t stays coherent.

### 8.4b V2.1 improvements — the move window as one generative process

The V1/V2 model samples a think time and then executes; the owner asked for a stronger model. V2.1 makes the following changes (all implemented in Task 16, normative):

1. **Untimed regime (kept simple, V2.4).** chess.com bot games are untimed by default. `tc_class` gains `"untimed"`: the clock-budget controller and time-pressure terms are bypassed and the model is run as if the game were a long time control (the `classical` conditioning), so think times are the realistic classical-tempo distribution with no clock pressure. No special proxy calibration is done; realism of the per-move distribution is what matters.
2. **Perceptual/orientation latency.** Every move window starts with `orientationMs ~ LN(median 380 ms, σ 0.35)` (time to register the opponent's move and re-scan the board), longer after a surprising move (`+0.4·swing_bad` in log space) and shorter for expected replies (`ponder_hit` −0.25). Bots reply within ~0.3–1.5 s, so without this term our replies would cluster unnaturally tightly after the bot's move. `orientationMs` is part of `thinkMs` (so of `MoveHoldTime`), not extra.
3. **Attention process instead of "wait then move".** The window is generated as a sequence: `orientation → scan (hovers over candidate pieces, dwell ∝ candidate probability) → [preview-select with p_preview (§9.3a)] → decision pause → approach/grab/drag/release`. The sampled total `thinkMs` is the budget; the planner (`ExplorationPlanner`) allocates it across phases with the committed approach always last and the decision pause (no pointer motion, 15–40 % of the window) placed before the approach. Long thinks contain more scan and at least one preview with high probability; instant moves contain none. Hover targets are the candidate *from*-squares weighted by the selection layer's probabilities (the persona "considers" the moves it might play), so exploration content, think time and the final move are mutually consistent.
4. **Game independence (V2.2).** Every game is played independently: `startGame()` discards all state (AR residual, tilt, pace histories, hand rest point) and samples the persona latents fresh from the per-game seed. There is no warm-up, boredom, fatigue, session mean (`session_mu` of Appendix D §4 is **not** used), or any other quantity carried from one game to the next; the auto-queue delay is a stateless draw from `TIMINGS.autoQueueDelayRangeMs`. Two games with the same inputs and different seeds share nothing but the model parameters.
5. **Opponent-pace term for bots.** `opp_pace` is computed on the opponent's observed reply latency; for bots (near-constant sub-second) the mirroring coefficient is floored so a fast opponent does not drag our think times below 0.6× the model's own median for the position (humans do not race an instant bot).
6. **Timing head = ChessMimic (V2.5 owner decision, 2026-09-04; Appendix J).** Existing human move-timing models were verified before choosing: Maia-2/3 have no time head; ALLIE (MIT) is a 355 M-parameter, clock-blind point estimator; **ChessMimic** (arXiv 2606.04473, code + weights at `thomasj02/1e4_ai`) is the right shape — ~9 M parameters per rating band, inputs FEN + last 12 UCI moves + rating of the side to move + both clocks + increment, a **30-bucket think-time distribution**, stock ops (ONNX-exportable), ~30–80 ms per move in onnxruntime-web. Its code and weights are **PolyForm Noncommercial 1.0.0**; sliced.gg is a non-commercial project, so it simply uses ChessMimic (the licence notice lives in `docs/third-party.md`; there is no commercial/non-commercial flag anywhere in code or config). The product ships `ChessMimicHead` as the timing head:
   - **Runtime:** the exported clock model runs in the offscreen document through onnxruntime-web (WASM, SIMD + threads under the existing COOP/COEP isolation) via `timing-inference.ts`; the service worker calls it over the engine port with a 100 ms budget and falls back to the v1 parametric head on timeout or load failure.
   - **Inputs from our pipeline:** FEN and the last 12 UCI moves from `PositionSnapshot`; rating = the derived target Elo (§7.4a); clocks = the adapter's `clocks`; increment = the detected time control. For **clockless games** (chess.com bot play) a fixed virtual clock is supplied — `player_clock = opp_clock = 300 s`, `increment = 0` (a blitz context within the model's training range) — so the predicted distribution is the realistic blitz think-time distribution; no untimed calibration is attempted (owner decision).
   - **Rating bands:** the package ships the three bands nearest the default target range (`1200_1300`, `1500_1600`, `1800_1900` at fp16, ≈18 MB each); the other bands are downloaded on demand into OPFS with hash verification (same `NnueStore` mechanism as the engine nets, §6.3). The band is chosen from the derived target Elo and can change only between games.
   - **Decoding:** apply the `player_clock + increment` validity mask client-side (the shipped inference code does not), draw a bucket from the (temperature-scaled, default 1.0) softmax, then a continuous value inside the bucket from the shipped per-bucket empirical distribution; bucket 0 (< 1 s) maps to the §8 `instant`/`premove` modes subject to `premove_eligible`; the sampled time is the `MoveHoldTime` budget that the move-window process (§8.4b item 3) allocates across orientation, scan, preview and approach.
   - **Persona and consistency on top:** the per-game persona `s_game` shifts the sampled time in log space (σ 0.20) and the AR(1) residual (σ 0.20, φ 0.35) adds within-game consistency, because ChessMimic's per-position distributions are diffuse (normalised entropy ≈ 0.3–0.4) and independent across moves.
   **Behaviour (hover scan, preview selections, orientation latency, decision pause) is designed, not learned**: no public dataset contains pointer behaviour, and we do not record our own; the constants in §8.4b/§9.3a are the shipped values (one registry, C1) and are tuned only through the conformance harness's plausibility checks.
7. **Coupling guarantees.** The conformance harness checks the joint distribution: think time vs `n_reasonable` correlation ≥ 0.2, preview-select rate rising with think time, no accuracy improvement at shorter think times beyond the band, orientation latency present after every opponent move.

### 8.5 Manual and override paths

- `PANEL_PLAY_NOW` / keybind / `chrome.commands` "play-best-move" → `replan(plan, ctx, "manual-now")`: hover wait = 0, drag duration kept, `observe()` records actual elapsed.
- Hold key (keybind `hold`, optional): freezes the plan; on release elapsed time counts as spent.
- Emergency: `myClockMs < 1500` → every wait 0, minimal motor.
- Auto-move disarmed → `planMove` is still computed and shown in the panel ("would think 4.2 s · normal") so the user sees the model's intent.

### 8.6 Logging and evaluation

Every planned move writes a `TimingLogEntry` (`{ gameId, ply, mode, plannedMs, actualMs, alloc, clockMs, comp, eps, topTerms: [name, value][] , persona }`) to a 200-entry ring buffer in `LOCAL_KEYS.timingLog` (flushed every 5 min by alarm, exported from the Engine view as JSON). The offline pipeline (`tools/data/*.py`, Appendix D §3b.2 and §6) computes NLL/CRPS/AUC against Lichess `%clk` data; the acceptance metric is a real-vs-simulated classifier AUC ≤ 0.70 (v1) / ≤ 0.60 (v2).


## 9. Move execution: the virtual hand

Research basis: Appendix G (CDP semantics verified in Chromium source; chessground drag internals verified in source; WindMouse and ghost-cursor sources; Fitts / minimum-jerk literature; mouse-dynamics bot-detection literature).

### 9.1 Owner requirements (2026-09-03) and what they rule out

> "truly indistinguishable mouse movements … the mouse smoothly moves to the spot … clicks for the right timings, the mouse explores potential moves … absolutely to the tee as realistic as possible and most importantly FORWARD-PROOF."

Consequences:
1. **No synthetic page events, no site APIs.** Untrusted `PointerEvent` dispatch (Appendix G "Tier 3") is rejected by chessground outright (`drag.start` requires `isTrusted`) and is flagged by chess.com (`didUseCheatMouse`); the chess.com `board.game.move()` API (Tier 4) produces a move with no input events at all. Both are removed from the shipped design; the plan keeps only **trusted input**: CDP `Input.dispatchMouseEvent` through `chrome.debugger` in v2.0, and an OS-level native input backend behind the same interface as the forward-proof successor (§9.8).
2. **A complete hand model, not a move dispatcher.** The executor owns a persistent *virtual cursor* per tab across the whole game: it rests, drifts, explores candidate pieces while "thinking", grabs, travels, hesitates, drops, corrects, and returns to rest. Every phase has human timing.
3. **Data-driven, re-fittable motor parameters** (§9.6): the profile that generates paths is fitted from the user's own recorded pointer traces so the hand matches *this* player, and the same evaluation harness that scores timing (§8.6) scores motion against real traces. Constants are versioned; the generator is pluggable.
4. **Robust to site and Chrome changes**: adapters supply geometry through a self-checking registry (§3.4), verification is state-based rather than selector-based where possible, and the backend interface isolates the input transport.

### 9.2 Verified input semantics (from Appendix G)

- `Input.dispatchMouseEvent` enters the browser input pipeline (`RenderWidgetHost`), so the page receives **trusted** `pointerdown/mousedown/pointermove/mousemove/pointerup/mouseup/click` with correct `clientX/Y`, `screenX/Y`, hover side effects and `buttons`. `x`/`y` are CSS px relative to the main-frame viewport (same space as `getBoundingClientRect()`); no DPR maths. The command resolves after the renderer acknowledges the event, which gives natural back-pressure. Omit `timestamp`.
- Drag = `mousePressed{button:left,buttons:1,clickCount:1}` → N × `mouseMoved{button:left,buttons:1}` → `mouseReleased{button:left,buttons:0,clickCount:1}`. `Input.dispatchDragEvent`/`setInterceptDrags` are HTML5-DnD only and must not be used.
- chessground: listens `mousedown` on `cg-board`, `mousemove`/`mouseup` on `document`; drag threshold 3 px (0 after the first drag); drop square resolved from the release point (must be inside the target square); click-click executes on the **second mousedown**; premoves use the same input. chess.com `wc-chess-board`: pointer events; press-inside-from, release-inside-to; click-click supported; premove highlights.
- Debugger: attach lazily on the first execution of a game, keep attached through the game (each attach shows the infobar), detach on game end or after `TIMINGS.debuggerIdleDetachMs`; handle `onDetach(canceled_by_user)` with a panel notice and lazy re-attach; on Chrome 118+ an attached debugger keeps the SW alive.

### 9.3 Executor architecture (`src/service/move-executor/`, `src/core/motor/`)

```
                       ┌───────────────────────────────────────────────────────────┐
 TimingPlan ──────────►│  HandController (per tab)                                 │
 Recommendation        │   state: rest | exploring | approaching | grabbing | dragging | dropping | correcting | promoting
 CursorState ─────────►│   owns VirtualCursor {pos, buttons, lastRealSeenAt}       │
                       │   uses ExplorationPlanner, PathGenerator, MotorProfile     │
                       └──────────────┬────────────────────────────────────────────┘
                                      │ PathPoint[] + press/release commands (absolute schedule)
                                      ▼
                       ┌───────────────────────────────┐    ┌────────────────────────────┐
                       │ InputBackend (interface)      │───►│ CdpInputBackend (v2.0)     │  chrome.debugger Input.*
                       │ move(p,t) press(p,t) release  │    │ NativeInputBackend (v2.1)  │  native messaging host → OS cursor
                       └───────────────────────────────┘    └────────────────────────────┘
                                      │
                                      ▼
                       MoveVerifier (content adapter observeMove ⟶ board state) ── retry policy
```

- `src/core/motor/types.ts` — `Pt`, `Rect`, `PathPoint {x,y,dtMs}`, `MotorProfile`, `HandState`, `ExecutionPlan`, `ExecutionResult`, `InputBackend`.
- `src/core/motor/path-generator.ts` — `generatePath(from, to, targetRect, profile, rng) → PathPoint[]`: cubic Bezier with anchors on the chord normals (spread ∝ distance, one-sided bow), **minimum-jerk** time profile `s(τ)=10τ³−15τ⁴+6τ⁵` sampled by arc length every `sampleIntervalMs` (8 ms), **Fitts** duration `MT = (a + b·log2(D/W+1))·speedScale·U(0.85,1.2)` floored by the peak-speed cap, **overshoot** with corrective sub-movement (probability scales with distance), **micro-correction** inside the target, **AR(1) tremor** (σ `jitterPx`, ρ 0.6, zero at the ends), integer quantisation, final-point clamp inside the target rect. `windmouse.ts` provides the alternate style (SRL parameters, gravity/wind/velocity clip/damping) scaled to the same duration; `styleMix` chooses per game.
- `src/core/motor/exploration.ts` — `ExplorationPlanner.plan(waitMs, candidates, boardGeometry, profile, rng) → HandAction[]` produces the "thinking" behaviour inside the timing plan's pre-touch wait: with probability rising in `n_reasonable` and `waitMs`, hover 1–3 candidate *from*-squares (drawn from the MultiPV lines weighted by their selection probability, so the hand lingers on moves the persona is considering), dwell 200–900 ms with micro-drift, sometimes trace toward the candidate's *to*-square without pressing, rest positions (on the last moved piece, near the clock, off-board), and idle tremor while resting; every action is clipped to end ≥ `reactionMs` before the committed approach so the total wait is preserved. **V2.1 (§13.2): exploration includes preview selections at a human rate** — see §9.3a. Hovers are the common case; preview selections are the deliberate, rate-controlled case; both are driven by the same candidate probabilities.
- **§9.3a Preview selections (`src/core/motor/preview-select.ts`, V2.1).** A preview selection is a human "let me look at this piece's moves" action: press+release on a candidate piece (click style: the site shows its legal moves; drag style: pick the piece up, move it 8–40 px, and put it back on its own square), dwell 300–1 200 ms while the hand drifts over one of that piece's destination squares, then either select the real piece directly (switching selection, the common case) or click an empty square to deselect first. Generation: `p_preview = clamp(base(persona) · f(n_reasonable) · g(thinkMs), 0, 0.35)` with `base` 0.04 (cautious) / 0.07 (balanced) / 0.10 (aggressive) / 0.05 (blitz), `f = 1 + 0.35·(n_reasonable − 1)`, `g = 0` for `thinkMs < 1 200`, rising to 1 at 4 s and 1.6 at 10 s; ×`Settings.execution.previewSelectScale`; 0 in premove/instant modes and when `myClockMs < 15 000`; at most one preview per move at default rates (a second with `p_preview·0.25`). The previewed piece is a *different* candidate than the committed move with probability 0.8 (drawn from the selection layer's runner-up distribution), else the committed piece itself (select, deselect, then move it — the "hesitation" form). Site mechanics: chess.com click-select switches selection on the next own-piece click; chessground executes a move on the *second mousedown* if the second square is a legal destination of the selected piece — so the planner never clicks a legal destination of the previewed piece unless that is the committed move, and drag previews always release on the origin square. Every preview is a complete, resolvable selection (no stuck selection when the move is played). The rate and its context dependence are design constants in `src/core/motor/constants.ts` (V2.3: there is no behaviour dataset and nothing is recorded); they are checked only by the conformance harness's plausibility bands.

- `src/core/motor/motor-profile.ts` — `MotorProfile` (Appendix G §8 defaults: `reactionMs`, `fittsA/B`, `travelSpeedScale`, `peakSpeedCapPxPerS`, `jitterPx`, `overshootProb`, `hesitationProb`, `microCorrectionProb`, `pressHoldMs`, `grabDelayMs`, `releaseSettleMs`, `sampleIntervalMs`, `styleMix`, `exploration: {hoverProb, feintProb, restStyle}`), `profileFor(persona, timeControl, moveType)` (blitz faster/sloppier, promotions add a look-delay, premoves ×0.7), per-game ±10 % offsets plus per-move lognormal noise, `exploration: { hoverProb, previewBase, restStyle }` (V2.1), and `MotorProfile.version` for the fitted profiles (§9.6).
- `src/core/motor/sampling.ts` — `samplePointInRect(rect, σFrac, innerFrac)` (truncated 2-D Gaussian; press σ 0.18 / inner 70 %, release σ 0.22 / inner 80 %), `plausibleStart(boardRect)`.
- `src/service/move-executor/hand-controller.ts` — the state machine above; consumes `TimingPlan` (`preMoveHoverMs` → exploration window, `dragDurationMs` → travel budget, `promotionDelayMs`) and executes: `rest → orientation → [scan: hovers …] → [preview-select …] → decision pause → approach(from) → press → grabWobble → travel(to) → [hesitate] → settle → release → [promotion: look-delay → approach(piece) → click] → post-drop rest`. Click-click style: approach → press/hold/release on from, inter-click gap 90–220 ms, approach → press/hold/release on to. Presses outside the committed move occur only as the modelled preview selections of §9.3a (V2.1). **V2 gates (§13.4–§13.5):** before the approach begins the controller consults the `FocusGate` (page `hasFocus` continuously true since the position arrived, tab visible, no blur edge in this move window) if it fails the move is skipped for this position with a panel warning. **V2.1:** real pointer activity is ignored while the hand owns the pointer (§13.5) — it is counted for the Engine view only; the only abort paths are explicit user stop/disarm and focus loss.
- `src/service/move-executor/cdp-input-backend.ts` — `CdpMouse` with an absolute-time scheduler (`performance.now()` drift correction, resync after stalls > 40 ms), `button:'left'` on moves while `buttons===1`, attach/detach policy from §9.2 amended by §13.4 (attach at arm time in the waiting view, never mid-game), `DebuggerManager` (attach map rebuilt from `chrome.debugger.getTargets()` on SW restart). **V2: there is no `chrome.tabs.update({active:true})` / `Page.bringToFront` pre-flight** — forcing the tab active fires `focus` on the page (`DidFocusOnOwnTurn`); if the tab is not active/focused the executor waits (§13.4).
- `src/service/move-executor/verifier.ts` — `verifyMove(tabId, expected, timeoutMs)` asks the content adapter's `observeMove` (MutationObserver on board + move list: piece present on the destination square or last-move/premove highlights on orig+dest; early `false` if the piece snapped back), then confirms the move list within 1.5 s. Retry policy: drag → click-click (once) → report failure to the panel; never double-move (re-check board state before each attempt).
- `src/service/move-executor/index.ts` — `MoveExecutor.schedule(recommendation, plan)` / `.playNow()` / `.cancel()`; emits `executed | failed | aborted` to the `GameSession`.

### 9.4 Cursor continuity and the real pointer (V2.1: hand ownership, §13.5)

The extension cannot read the OS cursor. At arm time the virtual cursor starts from the last real pointer position reported by the content script (`cursor` messages, age < 5 s) or a plausible rest point; from then on **the virtual hand owns the pointer until the user explicitly stops it**: every movement starts where the previous one ended, the hand rests on or near the dropped piece between moves with slow idle drift and occasional hovers, and it presses only as modelled. Real pointer events while the hand is active are ignored by the extension (counted for diagnostics only, never used to pause, abort or re-anchor) — the user is told to stop the hand (`Shift+X`) before using the mouse.

### 9.5 Site geometry and promotion

Adapters expose `squareRect(sq)`, `boardRect()`, `promotionTarget(piece, timeoutMs)` (lichess `#promotion-choice square` order Q,N,R,B stacked from the destination square; chess.com `.promotion-window .promotion-piece.<c><p>` — both in the selector registry with self-checks), all in viewport CSS px, computed on demand right before the approach (never cached across scroll/resize). Promotion: wait for the picker, look-delay 150–400 ms, humanized approach, click; if the picker never appears (auto-queen preference) the move is already complete.

### 9.6 Motor personalisation from recorded traces (optional, V2.3 — not required for release)

The shipped motor profile is the literature default of Appendix G §8 (`assets/models/motor-profile.json` is only produced if the optional recorder is used). Everything below is an opt-in refinement, not a prerequisite.

- **Recorder** (`src/content/motor-recorder.ts`, opt-in setting `execution.calibrateFromMyMouse`, optional; if ever used, only in a deliberate calibration session, never during assisted play): passively records real `pointermove/down/up` on chess pages (viewport coords, `timeStamp`, `buttons`, target square if any) into a ring buffer, chunks to the SW, stored under `LOCAL_KEYS.motorTraces` (max 20 MB, oldest evicted). Only trusted events, only on chess pages, never sent anywhere.
- **Fitter** (`src/core/motor/fit.ts`, runs offline via `tools/motor-eval/fit.ts` on an exported trace corpus, **before shipping**; V2.2: no runtime fitting): segments traces into movements (pauses > 120 ms split), computes per-movement `D`, `W` (target square size), `MT`, peak/mean speed, curvature/straightness, overshoot presence, click dwell, grab delay, release settle, tremor σ/ρ, exploration statistics (hovers before a move, feints, rest positions), drag vs click share; fits `fittsA/B` by least squares on `MT` vs `log2(D/W+1)`, and the other `MotorProfile` fields by robust estimators; outputs `MotorProfile{version, fittedAt, sampleCount}` shipped as `assets/models/motor-profile.json` (kinematics only: Fitts constants, speed cap, tremor, overshoot, dwell; it carries no timing or preview-rate parameters). Below a minimum sample count the defaults are blended (`w = n/(n+200)`).
- **Trace-splicing generator** (`src/core/motor/splice.ts`, style `"splice"` in `styleMix` when a corpus exists): builds a path by selecting a recorded real movement with similar `D` and direction, normalising it to the chord (rotate/scale/time-warp ≤ ±20 %), re-adding tremor, and clamping the landing inside the target. This reproduces the user's own idiosyncrasies (curvature habits, hand tremor spectrum, deceleration shape) and is the most realistic generator available without OS access.
- **Realism harness** (`tools/motor-eval/`): computes the feature set used by mouse-dynamics bot detectors (velocity/acceleration histograms, jerk, curvature, straightness, pause distribution, click dwell, inter-movement intervals) for real vs generated traces and trains a small classifier; acceptance: AUC ≤ 0.60 against the user's own traces. Also enforced as a unit-level invariant suite (`test/core/motor/invariants.test.ts`): no zero-velocity teleports, bell-shaped speed with a single dominant peak, integer coordinates, all released points inside targets, no two generated paths identical.

### 9.6a Telemetry invariants enforced on every execution (V2)

`test/core/motor/invariants.test.ts` and the `ac` shadow (Task 33) assert for every generated execution: one committed press on the from-square plus only modelled preview selections (each a resolvable select/deselect or select/switch, never on a legal destination of the previewed piece, never leaving a selection pending at move time), plus at most one press on a promotion picker; per-game preview rate inside the band; press and release of a click within 2 px; continuous path (no step larger than the profile's max step); no `mouseMoved` while the page is unfocused; no `Page.bringToFront`, `tabs.update`, `Emulation.setFocusEmulationEnabled` calls; `MoveHoldTime` (= plan think time) ≥ 250 ms except premove/instant modes.

### 9.7 What the panel shows

Hand state pill (`resting / exploring / moving / paused (your mouse) / detached`), the countdown ring for the scheduled move, the last execution's timeline (exploration → approach → drag → drop with durations) in the Engine/diagnostics view, and a persistent warning when the debugger was cancelled by the user.

### 9.8 Forward-proofing beyond CDP: the native input backend (v2.1, designed now, scaffolded in Task 32)

CDP is the only trusted-input path an extension has today, and Chromium carries a disabled feature flag (`kDebuggerAPIRestrictedToDevMode`) that could one day gate `chrome.debugger` behind developer mode. The `InputBackend` interface is therefore transport-agnostic, and the successor backend moves the **real OS cursor** through a native messaging host (`sliced-hand`): macOS `CGEventCreateMouseEvent`/`CGEventPost`, Windows `SendInput` with `MOUSEEVENTF_MOVE|ABSOLUTE`, Linux `uinput`/XTest. Benefits: no debugger infobar, no synthetic/real cursor split, OS-level event provenance, immune to extension-API policy changes. The extension computes paths exactly as today and streams `{x, y, tMs, action}` to the host, which converts viewport CSS px to screen px via `window.screenX/Y`, `outerHeight − innerHeight` (browser chrome offset) and `devicePixelRatio` reported by the content script. Task 32 delivers the interface, the message schema, the coordinate mapping, and a macOS reference host; Windows/Linux hosts follow.


## 13. Telemetry-shaped operation (the ChessTelemetry contract)

Empirical basis: `~/Documents/ChessTelemetry/` (report dated September 2026; live JS inspection of chess.com `play-computer.js` 2026.9.1 and `play.js` 2026.9.3 on 2026-09-04; lichess `lila` source). The relevant documents are reproduced in Appendix I. This section turns those findings into hard rules that every mechanism touching the page must satisfy. **This section overrides any conflicting statement elsewhere in this plan.**

### 13.1 Scope of use

The owner uses the extension against bots (computer-vs-computer play: chess.com `/play/computer`, `/play/bots`; lichess games against the built-in AI). **Scope is enforced by the user, not the extension**: the extension plays on whatever live game page it is opened on and has no opponent-type gate, no "bots only" setting and no hidden flag (V2.1 revision; the earlier `Settings.scope` and `allowHumanOpponents` are removed). The adapter still reports the opponent (`isBot`, name, rating estimate) so strength can track the opponent's rating (§7.4a) and the panel can show it.

Bot play still runs the full client telemetry pipeline: the `fps` plugin was found in the `play-computer.js` bundle itself, so every move against a bot carries the same per-move `ac` blob to `FairPlayService.RecordMetric`. The extension must therefore produce moves whose telemetry is shaped exactly like an attentive human's, **without ever triggering the anomaly fields**, rather than trying to suppress or spoof the telemetry (which would itself be a signal).

### 13.2 The per-move signal model (chess.com `fps` plugin, verified from shipped JS)

| Field | What the client computes | Rule for sliced | Where enforced |
|-------|--------------------------|-----------------|----------------|
| `EventTrusted` | `isTrusted` of the input events that made the move | Always `true`: only trusted input (CDP `Input.dispatchMouseEvent`, later the native backend). Synthetic DOM events and site APIs are forbidden (§9.1). | Executor §9, Task 18; content script never dispatches events (Task 21 test) |
| `BlurCount`, `TotalBlurTime`, `TotalFocusTime`, `DidBlurOnOwnTurn`, `DidBlurOnOpponentTurn`, `DidFocusOnOwnTurn`, `DidFocusOnOpponentTurn` | `window` `blur`/`focus` listeners per move window | **Zero blur events for the entire game.** The game tab's `window` must keep focus from game start to game end. Nothing the extension does may move focus: no `chrome.tabs.update({active})`, no `Page.bringToFront`, no `window.open`, no panel interaction that takes focus (§13.4), no notifications that steal focus, no dialogs. | Focus discipline §13.4; `FocusGate` (Task 18); panel hands-off mode (Tasks 22, 24); Task 33 verification |
| `DidToggle` | blur followed by focus inside one move window | Never. Follows from the zero-blur rule; additionally the executor refuses to act if a blur was observed since the position arrived (the move would carry `DidToggle = true` + a short `LastFocusToMoveTime`, the exact "consult an engine then move" signature). | `FocusGate` (Task 18) |
| `LastFocusToMoveTime`, `MoveToFirstBlurTime` | ms from focus regain → move; move → next blur | Undefined when there are no blur/focus events; that is the desired state. | same |
| `MoveHoldTime` | ms from position arrival to move completion | This is exactly `TimingPlan.thinkMs` (§8). Distribution must be human-shaped per §8: spike/body/tail, phase and complexity dependence, budget behaviour, no constant or low-variance times, no sub-100 ms non-premoves. | Timing model §8, Task 16; conformance harness (Task 33) |
| `DidSelectMultiplePieces` | more than one piece selected during the move window | **A realism signal, not a forbidden one (V2.1).** Humans do select a piece, look at its moves, and then move another one — especially in complex positions and longer thinks. The exploration planner generates **preview selections** at a human rate and in human contexts (§9.3a): probability rises with `n_reasonable` and planned think time, is zero for premove/instant moves and in time trouble, is persona-scaled, and is a design constant (no recorded data, V2.3). Acceptance is a per-game rate inside a band (default 4–12 % of non-trivial moves), never 0 % and never > 25 %; the same move is never previewed twice. | Exploration planner §9.3a, Tasks 17–18, Task 33 band test |
| `PointerOffset` | pointer displacement between the last recorded pointer position and the move (exact reference point unknown; treated as "continuity of the pointer") | The virtual hand owns the pointer for the whole game: one continuous cursor trajectory across moves (rest → explore → approach → drag → rest), no teleports, press and release of a click within 1–2 px; real mouse input is ignored while the hand is active and the user stops the hand before touching the mouse (§13.5). | Hand controller §9.3–§9.4, Task 18 invariants |
| `visibilitychange` | used only for audio pause/resume | Irrelevant, but the tab must remain visible anyway (hidden tabs drop CDP input and would blur). | FocusGate |

Lichess (open source `ui/round/src/blur.ts`, `Game.scala` blur bitmap; Kaladin features): the same rules apply — per-move blur bits must stay 0, move-time standard deviation and time-pressure sensitivity must look human (§8), and no engine extension DOM/global/storage signatures may be present (§13.3).

### 13.3 Presence signals (extension fingerprinting)

Both sites probe for known engine extensions: chess.com 22 base64-obfuscated signatures (DOM selectors such as `#stockfish-analysis`, `[data-engine-active]`; globals such as `window.CHESS_ENGINES`, `window.Stockfish`; `localStorage`/`sessionStorage` keys such as `engine_depth`, `stockfish_analysis`), lichess 136 DOM selectors plus globals and storage keys. Rules:

1. **No engine in the page.** Stockfish runs in the extension's offscreen document; the page never sees a Worker, a WASM module, `hardwareConcurrency` probing or any engine global. (Already the architecture; stated here as a rule.)
2. **No page storage.** Content scripts and page programs never read or write `localStorage`, `sessionStorage`, IndexedDB or cookies of the site origin. All state is `chrome.storage`. Enforced by `scripts/check-constants.ts` extension: the strings `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` may not appear under `src/content/**` or `src/page/**` (Task 21).
3. **No static DOM or global signatures.** The MAIN-world bridges install **no properties on `window`** (no `defineOnce` marker; bridge state lives in closures; re-injection is impossible for manifest MAIN-world scripts). Every element the extension inserts (overlay SVG) uses per-build spoofed class names and no `id`, `data-*` or text that names the product, an engine, "analysis", "eval" or "engine". Native chess.com markings (`game.markings.addOne`) are used instead of overlays where available.
4. **Highlights are off by default during a live bot game** (`Settings.automation.highlightMoves` default `false`; when on, they are cleared before the move is executed and never present at move-submission time). The recommendation is shown in the side panel, which is outside the page DOM.
5. **No message-visible product names.** `window.postMessage` payloads between MAIN and ISOLATED worlds carry only the spoofed token and opaque field names (`k`, `p`, `i`), not `sliced`, `engine`, `fen`, `bestmove`. (pagescript `std.postToExtension` emits the spoofed key; Task 21 test asserts no forbidden substrings in emitted bridge code.)
6. The side panel document is a separate extension-origin page; nothing in it is visible to the site.

### 13.4 Focus discipline

Every `blur` of the game tab's `window` is recorded per move and `DidToggle` is the strongest single client signal the corpus documents (it is the exact behaviour named in the 2022 Niemann letter). The rules:

- **The game tab stays active and focused for the whole game.** The extension never changes the active tab or window. If the tab is not active/focused when a move is due, the executor **waits** (with a panel warning "Board window not focused — click into the board once, then keep your hands off") rather than forcing focus.
- **Interacting with the side panel blurs the page.** The side panel is a separate document in the same browser window; clicking or typing in it moves focus out of the tab (`window.blur` on the page, `document.hasFocus()` false). Therefore during a live game the panel is **display-only** ("hands-off mode", §10.4 amendment): all controls are disabled and a banner explains why; all in-game control is via keyboard shortcuts handled without moving focus — `chrome.commands` (browser-level, focus stays in the page) and in-page keybinds captured by the content script while the page has focus. Arming auto-play, choosing strength/persona and every other setting happens **before the game starts** (waiting view) or after it ends.
- **The `FocusGate`** (Task 18) subscribes to the content script's `focus` port messages (`{kind:"focus", hasFocus, visibility, at}` from `window` `focus`/`blur` and `visibilitychange`) and to `chrome.windows.onFocusChanged` / `chrome.tabs.onActivated`; the executor requires `hasFocus === true` continuously since the current position arrived; a blur observed inside the current move window cancels the scheduled execution for that move (the move is then played only after a fresh position arrives, i.e. the next move), and the timing model is told to `observe()` the extra elapsed time.
- **Debugger attach happens before the game** (in the waiting view, when auto-play is armed) so the infobar's layout shift and any focus side effects occur outside any move window; the attach never happens mid-game. Geometry is re-read after attach.
- No `chrome.notifications`, no `alert`, no `window.open`, no `chrome.tabs.create` while a game is live (Task 30 test).

### 13.5 Hand ownership (pointer continuity)

`PointerOffset` and the per-move pointer telemetry mean the pointer stream must be one plausible hand. **V2.1 decision (owner): while the hand is active, real mouse input is ignored by the extension.** Concretely:

- Arming auto-play transfers pointer ownership to the virtual hand; from then until the user explicitly stops it (`Shift+X` disable, `Shift+A` disarm, or the `chrome.commands` shortcut), real pointer events are **not** used for anything — they do not pause, abort, re-anchor or re-plan the hand. The virtual cursor position is authoritative for every path start.
- The content script still counts real pointer events while the hand is active and the Engine view shows the count ("real pointer events during hand control"), because the page *does* see them and they would appear in its telemetry; the panel's hands-off banner therefore says "Stop the hand (Shift+X) before using your mouse." The extension cannot and does not try to suppress OS input (CDP `Input.setIgnoreInputEvents` would also drop our own dispatches).
- The hand starts each game from a plausible rest point (the last real pointer position known at arm time, or a rest point), ends each move by resting on or near the dropped piece (with slow idle drift), and every subsequent movement starts where the last one ended. Teleports are an invariant violation (Task 17 tests).
- Between moves (the opponent's turn) the hand may drift idly, hover the board or rest; it presses only as modelled (§9.3a).
- Press and release positions of a click are within 2 px (real click drift); drags release inside the destination square.
- Reaction/motor times are the same persona for the whole game (§9.6 fitted profile), so per-move `MoveHoldTime` = think + motor is coherent.

### 13.6 Move-quality plausibility (server-side statistics)

Strength Score (chess.com), Irwin/Kaladin (lichess) and Regan-style IPR all compare move quality to engine lines, normalised to the *account's* rating and to position difficulty; they need sustained anomalies across games and are weakest in blitz/bullet. For bot play the rules are:

- `Settings.strength.targetElo` defaults to **"match the opponent"** (`matchOpponentRating`): the adapter reports the opponent's displayed rating (chess.com bot cards / player row; lichess AI level → approximate Elo, or the opponent's rating) and the selection layer targets `opponentElo + persona offset` clamped to `LIMITS`. The panel shows the derived target.
- Top-1 agreement, ACPL and blunder rates stay inside the bands of §7.2 for the target rating; the panel's session strip shows running top-1 % and ACPL against the band; leaving the band for 3 consecutive games raises a panel warning.
- Timing-quality coupling: move quality must not *improve* under time pressure (Kaladin's time-pressure-sensitivity feature). The selection layer already scales the blunder channel with `f_clock`; §8 compresses think times under pressure. The conformance harness (Task 33) checks the joint distribution.
- No engine-only signatures: the never-play filters and heuristic prior (§7.2) remain on in bot mode.

### 13.7 What the extension must never do (summary checklist, tested in Task 33)

1. Dispatch any non-trusted input to the page.
2. Cause a `blur` or `focus` event on the game window during a game (including via the panel, tab switching, notifications).
3. Press pieces outside the preview-selection model (§9.3a): previews happen at a human rate, on plausible candidates, in plausible contexts, and every press is a complete, resolvable selection (select → deselect or select → switch), never a half-drag or a stuck selection.
4. Teleport the pointer; react to real mouse input while the hand is active (the user stops the hand first).
5. Touch page storage or expose globals/DOM signatures.
6. Show engine-like timing (constant, sub-100 ms, complexity-independent) or engine-like accuracy for the target rating.
7. Attach the debugger or change layout during a move window.


## 10. Design system and side-panel UI (C3, C4, C5)

### 10.1 `sl-ui` — the single styling framework

Layers (each file imports only the layer above; `css/sl-ui.css` is the sole stylesheet linked by `pages/panel.html`):

```
css/tokens.css        ← GENERATED from src/design/tokens.ts (never edited by hand)
css/base.css          ← reset, body.sl-shell, typography defaults, focus ring, reduced-motion, scrollbars
css/primitives.css    ← .sl-stack/.sl-row/.sl-grid (gap from tokens), .sl-card, .sl-text-*, .sl-icon, visibility utilities
css/components.css    ← .sl-button, .sl-toggle, .sl-slider, .sl-keybind, .sl-eval-bar, .sl-move-card, .sl-pv, .sl-clock, .sl-ring, .sl-toast, .sl-pill, .sl-popover, .sl-section
css/views/*.css       ← per-view composition only (layout of components), no new colours/sizes
```

Rules enforced by `scripts/check-css.ts` (Task 22): every `color`, `background`, `border-color`, `box-shadow`, `padding`, `margin`, `gap`, `font-size`, `border-radius`, `transition-duration`, `z-index` value must be `var(--sl-…)`, `calc()` of tokens, `0`, `1px`, `100%`, `auto`, `inherit`, `currentColor`, or `transparent`. Violations fail the build.

### 10.2 `src/design/tokens.ts` — the single source of truth ("Lattice")

The framework is named **Lattice** (Appendix F §2): one base unit, and every other value derived from it by a fixed rule. The TypeScript shape is normative; values are transcribed from Appendix F §2.3–§2.5 exactly once, in this file.

```ts
export const tokens = {
	unit: 4,                                                                    // px; the lattice
	space: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 8: 8, 10: 10, 12: 12, 16: 16 },   // multipliers → --sl-space-N = unit×N
	size: { control: { sm: 7, md: 9, lg: 11 }, icon: { sm: "type.xs", md: "type.sm", lg: "type.md" }, touch: 11, rail: 2, hairline: "1px" }, // unit multiples / refs
	radius: { xs: 1, sm: 2, md: 3, lg: 4, xl: 6, full: "9999px" },             // unit multiples
	type: {
		family: { ui: '"Geist", "Inter", system-ui, sans-serif', display: '"Bricolage Grotesque", "Archivo", "Geist", sans-serif', mono: '"Geist Mono", "JetBrains Mono", ui-monospace, monospace' },
		base: 13, ratio: 1.2, steps: { xs: -1, sm: 0, md: 1, lg: 2, xl: 3, "2xl": 4, "3xl": 5, "4xl": 6, "5xl": 7, "6xl": 8 },   // size = round(base×ratio^n)
		leading: "snap(unit, size×1.2)",                                           // computed by the generator
		weight: { regular: 400, medium: 500, semibold: 600 }, tracking: { tight: "-0.02em", normal: "0", loose: "0.02em" },
		features: { numerals: '"tnum" 1, "lnum" 1', mono: '"liga" 0' },
	},
	color: {
		palette: { "charcoal.950": "#0F1215", "charcoal.900": "#15181C", /* … all 24 named hex values from Appendix F §2.4 … */ "danger.700": "#A8301F" },
		alpha: { a4: 0.04, a8: 0.08, a12: 0.12, a16: 0.16, a24: 0.24, a32: 0.32, a48: 0.48, a64: 0.64 },
		dark:  { canvas: { ref: "charcoal.900" }, "surface.raised": { ref: "charcoal.800" }, "border.subtle": { ref: "white", alpha: "a8" }, "text.primary": { ref: "charcoal.200" }, brand: { ref: "brand.500" }, "brand.tint": { ref: "brand.500", alpha: "a12" }, "eval.white": { ref: "bone" }, "hl.from": { ref: "brand.500", alpha: "a32" }, "hl.to": { ref: "brand.500", alpha: "a48" }, "hl.arrow": { ref: "brand.500", alpha: "a64" }, "hl.preview": { ref: "line.500", alpha: "a64" }, /* … every semantic key from Appendix F §2.5 … */ },
		light: { /* same keys, Appendix F §2.5 light block */ },
	},
	shadow: { rim: [{ inset: true, y: 1, color: "white", alpha: "a4" }], inset: [{ inset: true, y: 1, blur: 2, color: "black", alpha: "a24" }], raise: [/* … */], overlay: [/* … */] },
	motion: { durationBase: 80, durations: { 1: 1, "1-5": 1.5, "2-5": 2.5, 4: 4, 6: 6 }, easing: { standard: "cubic-bezier(0.2, 0, 0, 1)", emphasized: "cubic-bezier(0.32, 0.72, 0, 1)", exit: "cubic-bezier(0.4, 0, 1, 1)", spring: "linear(…)" } },
	z: { base: 0, rail: 10, sticky: 20, popover: 30, toast: 40, overlay: 50 },
	layout: { panelMin: 320, panelStandard: 360, panelComfortable: 420, panelMax: 480 },
} as const;
```

Binding derivation rules (from Appendix F §2.1): space/radius/control sizes are unit multiples; type sizes are `round(13 × 1.2^n)` with leading snapped to the lattice; every colour is a palette hex or a palette colour at one of eight alpha steps; durations are `80 ms × k`; borders are always `1px` (`--sl-hairline`, the single exception).

`scripts/gen-tokens.ts` emits:
- `css/tokens.css`: `:root{--sl-unit:4px; --sl-hairline:1px; --sl-space-1:4px … --sl-radius-md:12px; --sl-type-size-md:16px; --sl-type-leading-md:24px; --sl-motion-duration-2-5:200ms …}` plus semantic colours on `:root` (dark, default) and `[data-theme="light"]{…}` — the naming rule is `--sl-{group}-{path}` with nested keys joined by `-` (`color.dark["text.primary"]` → `--sl-color-text-primary`). `data-theme="system"` is resolved to dark/light by `panel/index.ts` from `prefers-color-scheme`.
- `src/design/tokens.generated.ts`: `export const TOKENS = { color: { dark: { hlFrom: "rgb(245 166 35 / 0.32)", … }, light: {…} }, motion: { durationMs: { 1: 80, … }, easing: {…} }, layout: {…}, type: {…} } as const` — imported by the animation manager (durations) and by content/page code (highlight colours through pagescript params). CSS and JS can therefore never disagree.

Type roles (`label`, `body`, `body-strong`, `title`, `numeral-sm/md/lg`, `move-sm/lg`, `mono`, `mono-xs`) are the only font combinations in the UI and are emitted as `.sl-type-<role>` utility classes by the generator (Appendix F §2.3 table).

### 10.3 `src/design/icons.ts` — the only place Font Awesome class names exist

```ts
// Semantic names are dotted (group.name); values are transcribed ONCE from Appendix F §2.6 (60 entries).
export const ICONS = {
	"nav.game": "fa-solid fa-chess-knight", "nav.settings": "fa-solid fa-sliders", "nav.engine": "fa-solid fa-wave-square",
	"status.idle": "fa-regular fa-circle", "status.thinking": "fa-solid fa-circle-notch", "status.ok": "fa-solid fa-circle-check",
	"status.attached": "fa-solid fa-plug-circle-check", "status.detached": "fa-solid fa-plug-circle-xmark",
	"action.play": "fa-solid fa-play", "action.cancel": "fa-solid fa-xmark", "action.back": "fa-solid fa-arrow-left",
	"toggle.autoplay": "fa-solid fa-bolt", "toggle.highlight": "fa-solid fa-highlighter", "toggle.autoqueue": "fa-solid fa-forward-step",
	"game.clock": "fa-regular fa-clock", "game.turn": "fa-solid fa-caret-left", "exec.drag": "fa-solid fa-hand", "exec.click": "fa-solid fa-arrow-pointer",
	"engine.nnue": "fa-solid fa-brain", "engine.timing": "fa-solid fa-stopwatch", "feedback.warning": "fa-solid fa-triangle-exclamation",
	/* … remaining entries exactly as listed in Appendix F §2.6 … */
} as const;
export type IconName = keyof typeof ICONS;
```
Templates write `<i class="sl-icon" data-icon="action.play"></i>`; every icon is rendered `fa-fw`, sized to the row type size and coloured by the row text tier (Appendix F §2.6 rules); `panel/icons-mount.ts` resolves `data-icon` → classes on mount (and `scripts/gen-icons.ts` verifies each class exists in the vendored `all.min.css` at build time). Font Awesome Free (latest 7.x at vendoring time; version pinned in package.json) is vendored at `assets/vendor/fontawesome/{css/all.min.css,webfonts/*}` and linked from `pages/panel.html` (local, no CDN — MV3 disallows remote scripts and we want offline parity).

### 10.4 Panel shell and routing

`pages/panel.html` → `<body class="sl-shell" data-theme="dark"><main id="app"></main>`. `panel/router.ts` (modelled on tranquill's `PanelRouter`, Appendix H) mounts one `View` at a time; each `View.mount(ctx) → cleanup`. View selection is derived purely from `PanelSnapshot` (license → site → session), re-evaluated on every snapshot, so the panel is a projection of SW state. Views: `login`, `expired`, `unsupported`, `waiting`, `live`, `settings`, `engine`, `update`. Full wireframes, component anatomy, copy and motion rules: Appendix F (UI spec).

**V2 amendment — hands-off mode (§13.4).** While `session.state === "live"` the panel is display-only: every button, toggle, slider, keybind capture and the view switch are rendered disabled (`aria-disabled`, no pointer events), a persistent banner reads "Hands off during a game — clicking here takes focus from the board, and the hand owns the mouse until you stop it. Shift+A arm/disarm · Space play now · Shift+X stop." and the Live view's Play button shows its keybind only. The panel never steals focus on its own (no `autofocus`, no `focus()` calls, no `alert`). Arming auto-play, strength/persona, timing and execution settings are set in the **waiting** view before the game (the waiting view shows the detected opponent and the derived target Elo). The pre-arm flow (hold-to-arm) stays in the waiting view; the debugger is attached at arm time, before the game starts. The session strip gains a `Telemetry` pill (`clean` / `blur seen` / `mouse touched`) fed by `PanelSnapshot.focus`.

### 10.5 Logo

`assets/images/sliced_128.png` and `sliced_256.png` are copied byte-for-byte (the shipped mark is a **circular** disc with a white ring and orange slash, not a rounded square; the lockup in Appendix F §2.7 is designed around it). Manifest `icons` = `{128, 256}`; no other sizes are generated (Chrome scales the 128). The panel top bar renders the 256 asset at 24×24, login/empty states at 64×64, never recoloured, masked or rotated.


## 11. Build, tooling, testing

### 11.1 Toolchain

| Tool | Use |
|------|-----|
| Bun 1.3+ | package manager, script runner, bundler (`Bun.build`), test runner |
| TypeScript 5.9 | `tsc --noEmit` typecheck only (bundling by Bun) |
| Biome 2.x | lint + format (config copied from tranquill's `biome.json`, Appendix H) |
| `astring` | build-time JS printing for pagescript |
| `chess.js` 1.x | move generation, SAN ↔ UCI, FEN validation (only chess library; no custom move generator) |
| `happy-dom`, `fake-indexeddb` | test DOM + IDB |
| `archiver` | zip packaging |

### 11.2 `scripts/build.ts` pipeline (sequential steps; each step is a function with its own test)

1. **clean** `dist/`.
2. **gen-tokens** → `css/tokens.css`, `src/design/tokens.generated.ts`.
3. **gen-icons** verify → fails on unknown FA class.
4. **gen-pagescript** → `src/page/generated/*.ts` (bind functions) and `dist/js/page/*.js` (MAIN-world entries as IIFEs).
5. **check-constants**, **check-css** lints.
6. **typecheck** (`tsc --noEmit`) — skipped with `--fast`.
7. **bundle** with `Bun.build`:
   - `src/service/service-worker.ts` → `dist/js/service-worker.js` (`format: "esm"`, manifest `"type": "module"`).
   - `src/offscreen/index.ts` → `dist/js/offscreen.js` (esm).
   - `src/panel/index.ts` → `dist/js/panel.js` (esm).
   - `src/content/index.ts` → `dist/js/content.js` (`format: "iife"`, ISOLATED world).
   - `define`: `__SL_VERSION__`, `__SL_BUILD__` (timestamp), `__SL_SPOOF_SEED__` (random per build), `__SL_LICENSE_URL__` (from `build.config.json`), `__SL_DEBUG__`.
   - `loader: { ".html": "text" }` for templates; `minify` in production; `sourcemap: "linked"` in dev.
   - `target: "browser"`, `splitting: false`.
8. **copy** `assets/` (logo unchanged, sounds, vendored Font Awesome, engine wasm/worker/nnue), `css/`, `pages/`.
9. **manifest** stamp: copy `manifest.json`, set `version` from `package.json`, add `debug` flag in dev.
10. **verify-dist**: every path referenced by the manifest and HTML exists; report bundle sizes; fail if any bundle contains `console.` (except in dev) or the string `phantom.ac` outside the license client bundle position.
11. **package** `dist/` → `release/sliced-<version>.zip`.

`bun run dev` = steps 1–10 with `--fast` and `--watch` (Bun's `--watch` on the script re-runs the bundle step on changes).

### 11.3 Manifest (source, `manifest.json`)

```jsonc
{
	"manifest_version": 3,
	"minimum_chrome_version": "128",
	"name": "sliced.gg",
	"short_name": "sliced",
	"description": "A powerful chess assistant that runs in your browser.",
	"version": "2.0.0",
	"key": "<existing key — preserved so the extension ID stays stable>",
	"icons": { "128": "assets/images/sliced_128.png", "256": "assets/images/sliced_256.png" },
	"action": { "default_title": "sliced.gg", "default_icon": { "128": "assets/images/sliced_128.png" } },
	"side_panel": { "default_path": "pages/panel.html" },
	"background": { "service_worker": "js/service-worker.js", "type": "module" },
	"content_scripts": [
		{ "matches": ["*://*.chess.com/*", "*://*.lichess.org/*"], "js": ["js/page/chesscom-bridge.js", "js/page/lichess-bridge.js"], "run_at": "document_start", "world": "MAIN" },
		{ "matches": ["*://*.chess.com/*", "*://*.lichess.org/*"], "js": ["js/content.js"], "run_at": "document_start" }
	],
	"commands": {
		"play-best-move": { "suggested_key": { "default": "Alt+Shift+M" }, "description": "Play the recommended move now" },
		"toggle-auto-move": { "suggested_key": { "default": "Alt+Shift+A" }, "description": "Arm / disarm auto-move" },
		"disable-assistant": { "suggested_key": { "default": "Alt+Shift+X" }, "description": "Disable sliced immediately" }
	},
	"permissions": ["storage", "debugger", "sidePanel", "offscreen", "alarms", "tabs", "scripting", "tts"],
	"host_permissions": ["*://*.chess.com/*", "*://*.lichess.org/*"],
	"web_accessible_resources": [{ "resources": ["assets/engine/*", "assets/sounds/*"], "matches": ["*://*.chess.com/*", "*://*.lichess.org/*"] }],
	"cross_origin_embedder_policy": { "value": "require-corp" },
	"cross_origin_opener_policy": { "value": "same-origin" },
	"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" }
}
```
(Exact permission list and CSP string are confirmed against Appendix B; the `update_url` from the legacy manifest is dropped — see §12.2.)

### 11.4 Testing strategy

| Layer | Location | Tooling | What |
|-------|----------|---------|------|
| Pure logic | `test/core/**` | bun test | UCI parser, FEN/SAN helpers, elo map, move selector (seeded RNG), timing model distributions and budget, motor path generator (geometry invariants), analysis cache, constants registry integrity |
| pagescript | `test/pagescript/**`, `test/page/**` | bun test + happy-dom | builders → emit snapshot; evaluated programs behave (query, postMessage relay, overlay DOM) |
| Simulator | `test/sim/**` | ported from tranquill (chrome storage/tabs/runtime/ports/alarms/debugger/sidePanel/offscreen fakes, message bus between contexts, time controller) | foundation for behavioural tests |
| Behavioural | `test/behavioral/**` | simulator | SW `GameSession` end-to-end: position in → recommendation out → auto-move schedule → executor dispatch sequence recorded by the fake debugger → verification; license gate; side-panel per-tab policy; keepalive |
| Content | `test/content/**` | happy-dom fixtures (`test/fixtures/chesscom-*.html`, `lichess-*.html` captured DOM snapshots) | adapters produce correct `PositionSnapshot`; observers fire once per move; selector self-check |
| Panel | `test/panel/**` | happy-dom | router picks the view for each snapshot; components render states; keybind capture |
| Engine integration | `test/integration/engine.test.ts` | bun test, real WASM in a Worker (Bun supports Web Workers) — skipped if SAB unavailable | `uci` → `readyok`, NNUE load, `go depth 10` returns `bestmove` |
| Manual QA | `docs/qa-checklist.md` | human | attach infobar UX, real chess.com/lichess **bot** games, promotion, premove, flagging |
| Telemetry conformance (V2) | `test/behavioral/telemetry/**`, `test/sim/telemetry/ac-shadow.ts`, `tools/telemetry-conformance/` | simulator + offline report | every simulated move's `ac` blob is human-shaped (§13.2); focus discipline; pointer continuity; timing shape; forbidden-API lints |

Conventions: seeded RNG (`@core/rng` → `createRng(seed)`) is injected into every stochastic module; no `Math.random()` outside `rng.ts`.

## 12. Migration and rollout

### 12.1 Sequence

1. Task 0 snapshots the legacy tree into `legacy/` and initialises git.
2. Tasks 1–9 build the foundation (tooling, constants, storage, messaging, pagescript, design tokens, simulator).
3. Tasks 10–13 engine; 14–16 timing; 17–21 executor + adapters; 22–29 UI; 30–31 integration, packaging, legacy removal.
4. Each task ends green (`bun run check` = lint + typecheck + test) and is committed.
5. **V2:** Task 33 (telemetry conformance) is built as soon as Task 18 lands and gates every later executor/panel change; the real-site QA in Task 31 is performed against bots only and its exported logs are run through the conformance report.

### 12.2 Distribution

The legacy manifest used `update_url: https://sliced.sh/update` (self-hosted CRX). Since Chrome 2024-25, self-hosted extensions install only via enterprise policy or unpacked developer mode; the plan keeps the `key` so the ID is stable and ships a zip + unpacked folder. `update_url` is removed (Appendix B). Version checks for "update available" use `URLS.website + /manifest.json` fetched by the SW every 6 h (same alarm as license revalidation).

### 12.3 Settings migration

On `onInstalled` with `reason === "update"` from a `1.x` version, `src/service/lifecycle.ts` reads the legacy flat keys (`extensionActive`, `highlightMoves`, `elo`, `depthValue`, `maxWaitTime`, `automove`, `autoPlayNewGame`, `key`, `moveKeybind`, `exitKeybind`, `ttsKeybind`) once, maps them into `Settings` (legacy `elo` 1–20 → `targetElo = 1320 + (elo-1) * (3190-1320)/19` rounded to 10; `maxWaitTime` s → `timing.speedScale`), writes `LOCAL_KEYS.settings`, and removes the legacy keys.


# PART II — TASKS

Conventions for every task: run `bun run check` (lint + typecheck + tests) before the commit step; commit messages use conventional commits; paths are relative to the repo root. Each task lists **Interfaces** (what it consumes from earlier tasks and what later tasks rely on). Executors must read Part I §1.3 (Global Constraints) and the relevant Part I section before starting.

## Phase 0 — Repository bootstrap

### Task 0: Snapshot legacy tree and initialise git

**Files:**
- Create: `legacy/` (moved copy of every current top-level item except `.history/`), `.gitignore`, `README.md`

- [ ] **Step 1: Initialise git and freeze the legacy tree**

```bash
cd /Users/owengregson/Documents/slicedggMV2
rm -rf .history
mkdir -p legacy
git init -b main
for p in manifest.json SlicedEngine css scripts pages assets; do git mv -k "$p" legacy/ 2>/dev/null || mv "$p" legacy/; done
printf 'node_modules/\ndist/\nrelease/\nbuild-logs/\nsrc/page/generated/\nsrc/design/tokens.generated.ts\ncss/tokens.css\n.DS_Store\n' > .gitignore
printf '# sliced.gg v2\n\nManifest V3 chess assistant. See docs/superpowers/plans/2026-09-03-sliced-v2-implementation.md.\n' > README.md
git add -A && git commit -m "chore: freeze legacy MV2 tree under legacy/ and initialise repository"
```

- [ ] **Step 2: Copy the logo and sounds into the new asset tree (unchanged bytes, C5)**

```bash
mkdir -p assets/images assets/sounds
cp legacy/assets/images/sliced_128.png legacy/assets/images/sliced_256.png assets/images/
cp legacy/assets/sounds/* assets/sounds/
shasum -a 256 legacy/assets/images/sliced_256.png assets/images/sliced_256.png   # must match
git add assets && git commit -m "chore(assets): carry over logo and UI sounds unchanged"
```

### Task 1: Toolchain — package.json, tsconfig, Biome, bunfig, build skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `bunfig.toml`, `build.config.json`, `scripts/build.ts`, `scripts/test-runner.sh`, `scripts/verify-dist.ts`, `src/types/chrome-ext.d.ts`, `test/setup.ts`, `test/raw-loader.ts`

**Interfaces:**
- Produces: `bun run build|dev|check|lint|typecheck|test` scripts; path aliases; `define` constants `__SL_VERSION__`, `__SL_BUILD__`, `__SL_SPOOF_SEED__`, `__SL_LICENSE_URL__`, `__SL_LICENSE_ENFORCE__` (default `false`), `__SL_DEBUG__`; `?raw` HTML import typing.

- [ ] **Step 1: package.json**

```json
{
	"name": "sliced-gg",
	"version": "2.0.0",
	"private": true,
	"type": "module",
	"scripts": {
		"build": "bun scripts/build.ts",
		"dev": "bun scripts/build.ts --dev --watch",
		"typecheck": "tsc --noEmit",
		"lint": "biome check .",
		"lint:fix": "biome check --write .",
		"test": "bash scripts/test-runner.sh",
		"test:watch": "bun test --watch",
		"check": "bun run lint && bun run typecheck && bun run test",
		"verify:dist": "bun scripts/verify-dist.ts"
	},
	"dependencies": { "chess.js": "^1.4.0" },
	"devDependencies": {
		"@biomejs/biome": "^2.4.12", "@types/bun": "^1.3.12", "@types/chrome": "^0.1.36", "@types/estree": "^1.0.8",
		"archiver": "^7.0.1", "astring": "^1.9.0", "fake-indexeddb": "^6.2.5", "happy-dom": "^16.0.0", "typescript": "^5.9.3"
	},
	"engines": { "bun": ">=1.3.0" }
}
```

- [ ] **Step 2: tsconfig.json** (aliases are the only allowed import prefixes for cross-directory imports)

```json
{
	"compilerOptions": {
		"target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
		"lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
		"strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true, "exactOptionalPropertyTypes": true,
		"esModuleInterop": true, "skipLibCheck": true, "forceConsistentCasingInFileNames": true,
		"resolveJsonModule": true, "isolatedModules": true, "noEmit": true, "baseUrl": ".",
		"paths": {
			"@core/*": ["src/core/*"], "@service/*": ["src/service/*"], "@content/*": ["src/content/*"],
			"@panel/*": ["src/panel/*"], "@offscreen/*": ["src/offscreen/*"], "@pagescript": ["src/pagescript/index.ts"],
			"@page/*": ["src/page/*"], "@design/*": ["src/design/*"], "@typedefs/*": ["src/types/*"],
			"@test/sim": ["test/sim/index.ts"], "@test/sim/*": ["test/sim/*"]
		}
	},
	"include": ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"],
	"exclude": ["node_modules", "dist", "legacy"]
}
```

- [ ] **Step 3: biome.json** — copy tranquill's config (Appendix H) with `files.includes` = `["src/**","scripts/**","test/**","pages/**","*.json","*.ts","!legacy","!dist","!assets","!src/page/generated","!src/design/tokens.generated.ts"]`, plus `"linter.rules.suspicious.noConsole": "error"` with an override `{"includes":["scripts/**","test/**"],"linter":{"rules":{"suspicious":{"noConsole":"off"}}}}`.

- [ ] **Step 4: bunfig.toml and test runner**

```toml
[test]
preload = ["./test/raw-loader.ts", "./test/setup.ts"]
timeout = 15000
```
```bash
#!/usr/bin/env bash
# scripts/test-runner.sh — run each test file in a fresh process (bun leaks mock.module state across files)
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
while IFS= read -r f; do
	if [[ "${1:-}" == "--no-int" && "$f" == test/integration/* ]]; then continue; fi
	bun test "$f" || status=1
done < <(find test -name '*.test.ts' | sort)
exit $status
```

- [ ] **Step 5: `src/types/chrome-ext.d.ts`**

```ts
declare const __SL_VERSION__: string;
declare const __SL_BUILD__: string;
declare const __SL_SPOOF_SEED__: string;
declare const __SL_LICENSE_URL__: string;
declare const __SL_LICENSE_ENFORCE__: boolean;
declare const __SL_DEBUG__: boolean;
declare module "*.html?raw" { const source: string; export default source; }
declare namespace chrome.runtime { interface ManifestBase { debug?: boolean } }
```

- [ ] **Step 6: `build.config.json` and `scripts/build.ts` skeleton** (steps 2–5 and 8–11 of §11.2 are filled in by later tasks; wire the step list now with no-op placeholders that throw `NotImplemented` so the pipeline shape is final)

```json
{ "productName": "sliced.gg", "website": "https://sliced.sh", "licenseUrl": "https://phantom.ac/slicedgg/index.php", "licenseEnforce": false }
```
```ts
// scripts/build.ts
import { rm, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import config from "../build.config.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

export interface BuildOptions { dev: boolean; fast: boolean; watch: boolean }
export const ROOT = path.resolve(import.meta.dir, "..");
export const DIST = path.join(ROOT, "dist");

export type Step = { name: string; run: (o: BuildOptions) => Promise<void> };
export const steps: Step[] = [
	{ name: "clean", run: async () => { await rm(DIST, { recursive: true, force: true }); await mkdir(DIST, { recursive: true }); } },
	{ name: "gen-tokens", run: async () => (await import("./gen-tokens.ts")).generateTokens() },
	{ name: "gen-icons", run: async () => (await import("./gen-icons.ts")).verifyIcons() },
	{ name: "gen-pagescript", run: async () => (await import("./gen-pagescript.ts")).generatePagescript(DIST) },
	{ name: "check-constants", run: async () => (await import("./check-constants.ts")).checkConstants() },
	{ name: "check-css", run: async () => (await import("./check-css.ts")).checkCss() },
	{ name: "typecheck", run: async (o) => { if (o.fast) return; const p = Bun.spawn(["bun", "x", "tsc", "--noEmit"], { stdout: "inherit", stderr: "inherit" }); if ((await p.exited) !== 0) throw new Error("typecheck failed"); } },
	{ name: "bundle", run: bundle },
	{ name: "copy", run: async () => { for (const d of ["assets", "css", "pages"]) await cp(path.join(ROOT, d), path.join(DIST, d), { recursive: true }); } },
	{ name: "manifest", run: async (o) => (await import("./stamp-manifest.ts")).stampManifest(DIST, { dev: o.dev, version: pkg.version }) },
	{ name: "verify", run: async () => (await import("./verify-dist.ts")).verifyDist(DIST) },
	{ name: "package", run: async (o) => { if (!o.dev) await (await import("./package.ts")).packageDist(DIST, pkg.version); } },
];

async function bundle(o: BuildOptions): Promise<void> {
	const define = {
		__SL_VERSION__: JSON.stringify(pkg.version), __SL_BUILD__: JSON.stringify(new Date().toISOString()),
		__SL_SPOOF_SEED__: JSON.stringify(crypto.randomUUID().replaceAll("-", "")),
		__SL_LICENSE_URL__: JSON.stringify(config.licenseUrl), __SL_LICENSE_ENFORCE__: JSON.stringify(config.licenseEnforce === true), __SL_DEBUG__: JSON.stringify(o.dev),
	};
	const common = { root: ROOT, target: "browser" as const, define, minify: !o.dev, sourcemap: o.dev ? ("linked" as const) : ("none" as const), splitting: false, loader: { ".html": "text" as const } };
	const esm = await Bun.build({ ...common, format: "esm", entrypoints: ["src/service/service-worker.ts", "src/offscreen/index.ts", "src/panel/index.ts"], outdir: path.join(DIST, "js"), naming: "[name].js" });
	const iife = await Bun.build({ ...common, format: "iife", entrypoints: ["src/content/index.ts"], outdir: path.join(DIST, "js"), naming: "content.js" });
	for (const r of [esm, iife]) if (!r.success) { for (const l of r.logs) console.error(l); throw new Error("bundle failed"); }
}

export async function runBuild(o: BuildOptions): Promise<void> {
	for (const s of steps) { const t = performance.now(); await s.run(o); console.log(`✓ ${s.name} ${(performance.now() - t).toFixed(0)}ms`); }
}
if (import.meta.main) {
	const args = new Set(process.argv.slice(2));
	await runBuild({ dev: args.has("--dev"), fast: args.has("--fast") || args.has("--dev"), watch: args.has("--watch") });
}
```
(`stamp-manifest.ts`, `package.ts`, `gen-*.ts`, `check-*.ts` are created in Tasks 2, 6, 7; until then create each as `export function x() {}` no-ops so the pipeline runs.)

- [ ] **Step 7: `test/setup.ts` and `test/raw-loader.ts`** — install define globals (`__SL_VERSION__ = "test"`, `__SL_SPOOF_SEED__ = "deadbeef…"`, `__SL_LICENSE_URL__ = "https://license.test/"`, `__SL_DEBUG__ = true`), a `chrome` global (replaced by the simulator in Task 8; until then `globalThis.chrome = {} as never`), `fake-indexeddb/auto`, and a Bun plugin that loads `*.html?raw` as text (copy tranquill's `test/raw-loader.ts` pattern).

- [ ] **Step 8: Verify the pipeline runs end-to-end on an empty tree**

Create placeholder entries (`src/service/service-worker.ts`, `src/offscreen/index.ts`, `src/panel/index.ts`, `src/content/index.ts`) each containing `export {};`, run `bun install && bun run build --dev`. Expected: all steps print ✓, `dist/js/*.js` exist.

- [ ] **Step 9: Commit** — `chore(tooling): bun build pipeline, tsconfig, biome, test runner`

### Task 2: Constants registry + duplication lint (C1)

**Files:**
- Create: `src/core/constants/{index,storage-keys,ports,alarms,timings,limits,urls,sounds,messages}.ts`, `scripts/check-constants.ts`, `test/core/constants/registry.test.ts`, `test/scripts/check-constants.test.ts`

**Interfaces:**
- Produces: everything listed in Part I §4.2 and §4.3 by name (`LOCAL_KEYS`, `SESSION_KEYS`, `PORT_NAMES`, `ALARM_NAMES`, `ALARM_CADENCE_MINUTES`, `TIMINGS`, `LIMITS`, `URLS`, `SOUNDS`, `MSG`, port payload types).

- [ ] **Step 1: Write the failing registry test**

```ts
// test/core/constants/registry.test.ts
import { describe, expect, it } from "bun:test";
import { ALARM_NAMES, LIMITS, LOCAL_KEYS, MSG, PORT_NAMES, SESSION_KEYS, TIMINGS } from "@core/constants";

describe("constants registry", () => {
	it("storage keys are namespaced and unique", () => {
		const all = [...Object.values(LOCAL_KEYS), ...Object.values(SESSION_KEYS)];
		expect(new Set(all).size).toBe(all.length);
		for (const k of all) expect(k.startsWith("sl::")).toBe(true);
	});
	it("message types are unique and namespaced", () => {
		const all = Object.values(MSG);
		expect(new Set(all).size).toBe(all.length);
		for (const m of all) expect(m.startsWith("sl:")).toBe(true);
	});
	it("ports and alarms are prefixed", () => {
		for (const p of Object.values(PORT_NAMES)) expect(p.startsWith("sl-")).toBe(true);
		for (const a of Object.values(ALARM_NAMES)) expect(a.startsWith("sl-")).toBe(true);
	});
	it("limits are ordered", () => {
		expect(LIMITS.eloMin).toBeLessThan(LIMITS.engineEloMin);
		expect(LIMITS.engineEloMax).toBeLessThan(LIMITS.eloMax);
		expect(TIMINGS.engineStopTimeoutMs).toBeLessThan(TIMINGS.engineReadyTimeoutMs);
	});
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/core/constants/registry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the registries exactly as specified in §4.2 and §4.3**, with `index.ts` re-exporting all of them. `messages.ts` exports `MSG`, the port payload types, `PositionSnapshot`, `PanelSnapshot`, `Recommendation`, `EvalLine`, `ChosenMove`, `TimingPlan` (import the timing/engine types from `src/types/*` created in Task 3; for now declare the interfaces in `src/types/game.ts` and `src/types/engine.ts`).

- [ ] **Step 4: Write the failing lint test**

```ts
// test/scripts/check-constants.test.ts
import { expect, it } from "bun:test";
import { findDuplicateLiterals } from "../../scripts/check-constants";
it("flags a registry literal re-declared outside the registry", () => {
	const files = { "src/core/constants/ports.ts": `export const PORT_NAMES = { panel: "sl-panel" } as const;`, "src/service/x.ts": `const p = "sl-panel";` };
	expect(findDuplicateLiterals(files)).toEqual([{ file: "src/service/x.ts", literal: "sl-panel", definedIn: "src/core/constants/ports.ts" }]);
});
it("ignores imports of the registry", () => {
	const files = { "src/core/constants/ports.ts": `export const PORT_NAMES = { panel: "sl-panel" } as const;`, "src/service/x.ts": `import { PORT_NAMES } from "@core/constants"; const p = PORT_NAMES.panel;` };
	expect(findDuplicateLiterals(files)).toEqual([]);
});
```

- [ ] **Step 5: Implement `scripts/check-constants.ts`**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
const REGISTRY_DIRS = ["src/core/constants/", "src/design/", "src/content/adapters/selectors.ts"];
const LITERAL_RE = /(["'`])((?:sl::|sl:|sl-|__sl_)[A-Za-z0-9:_\-.]+)\1/g;
export interface Duplicate { file: string; literal: string; definedIn: string }
export function findDuplicateLiterals(files: Record<string, string>): Duplicate[] {
	const defined = new Map<string, string>();
	for (const [f, src] of Object.entries(files)) if (REGISTRY_DIRS.some((d) => f.startsWith(d) || f === d)) for (const m of src.matchAll(LITERAL_RE)) if (!defined.has(m[2]!)) defined.set(m[2]!, f);
	const out: Duplicate[] = [];
	for (const [f, src] of Object.entries(files)) {
		if (REGISTRY_DIRS.some((d) => f.startsWith(d) || f === d)) continue;
		for (const m of src.matchAll(LITERAL_RE)) { const def = defined.get(m[2]!); if (def) out.push({ file: f, literal: m[2]!, definedIn: def }); }
	}
	return out;
}
function walk(dir: string, acc: Record<string, string>): void {
	for (const e of readdirSync(dir)) { const p = path.join(dir, e); if (statSync(p).isDirectory()) { if (!/generated|node_modules/.test(p)) walk(p, acc); } else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) acc[p] = readFileSync(p, "utf8"); }
}
export function checkConstants(root = "src"): void {
	const files: Record<string, string> = {}; walk(root, files);
	const dups = findDuplicateLiterals(files);
	if (dups.length) { for (const d of dups) console.error(`duplicate constant "${d.literal}" in ${d.file} (defined in ${d.definedIn})`); throw new Error(`${dups.length} duplicated constant(s)`); }
}
if (import.meta.main) checkConstants();
```

- [ ] **Step 6: Run both tests → PASS; run `bun run build --dev` → ✓ check-constants.**
- [ ] **Step 7: Commit** — `feat(core): constants registry and duplicate-literal lint`

### Task 3: Types, settings defaults, chrome wrappers, storage

**Files:**
- Create: `src/types/{settings,storage,game,engine,timing}.ts`, `src/core/chrome/{storage,tabs,runtime,debugger,offscreen,side-panel,tts,alarms}.ts`, `src/core/storage/{settings-storage,license-storage,session-storage}.ts`, `src/core/logger.ts`, `src/core/serialization.ts`, `src/core/rng.ts`, `src/core/util/{dedupe-async,clamp,lru,ids}.ts`
- Test: `test/core/storage/settings-storage.test.ts`, `test/core/rng.test.ts`, `test/core/util/lru.test.ts`

**Interfaces:**
- Produces: `Settings`, `DEFAULT_SETTINGS`, `Keybind`, `LicenseState`, `PersonaId`, `getSettings()/setSettings(patch)/onSettingsChanged(cb)`, `chromeLocalGet/Set/Remove`, `chromeSessionGet/Set/Remove`, `tabsQuery`, `tabsSendMessage` (resolving `{success,response?,error?}`), `debuggerAttach/Detach/Send`, `offscreenEnsure/Close`, `sidePanelSetOptions/SetBehavior/Open`, `ttsSpeak/Stop`, `alarmCreate/Get/Clear`, `log`, `createRng(seed)`, `LruCache`, `dedupeAsync`, `clamp`, `newId()`.

- [ ] **Step 1: `src/types/settings.ts`** — the interfaces from §4.4 plus:

```ts
export type PersonaId = "cautious" | "balanced" | "aggressive" | "blitz";
export const DEFAULT_KEYBINDS = Object.freeze({
	playMove: { key: " ", code: "Space", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
	toggleAutoMove: { key: "a", code: "KeyA", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true },
	disable: { key: "x", code: "KeyX", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true },
	speakMove: { key: "w", code: "KeyW", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
});
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
	enabled: false,
	strength: { targetElo: 1500, matchOpponentRating: true, personaEloOffset: 50, persona: "balanced", selectionMode: "hybrid", useOpeningBook: true, blunderScale: 1 },
	timing: { profile: "natural", speedScale: 1, varianceScale: 1, premoveTendency: 0.5, longThinkFrequency: 1, respectBudget: true },
	execution: { style: "auto", motorSpeed: 1, keepDebuggerAttached: true, verifyMoves: true, calibrateFromMyMouse: false, backend: "cdp", previewSelects: "auto", previewSelectScale: 1 },
	automation: { autoMove: false, autoQueue: false, highlightMoves: false, highlightStyle: "both" },
	keybinds: { ...DEFAULT_KEYBINDS, global: false },
	display: { evalBar: true, pvCount: 3, uiSounds: true, tts: false, ttsVoice: null, theme: "dark", reducedMotion: "system" },
	engine: { threads: "auto", hashMb: 32, depthCap: 22, multiPv: 4, nnue: "auto" },
	advanced: { logLevel: "info", timingLogEnabled: true },
});
```

- [ ] **Step 2: Failing settings-storage test**

```ts
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@typedefs/settings";
import { getSettings, setSettings } from "@core/storage/settings-storage";
describe("settings storage", () => {
	it("returns defaults when nothing stored", async () => { expect(await getSettings()).toEqual(DEFAULT_SETTINGS); });
	it("merges a nested partial and clamps elo", async () => {
		await setSettings({ strength: { targetElo: 9999 } });
		const s = await getSettings();
		expect(s.strength.targetElo).toBe(3200);
		expect(s.strength.persona).toBe("balanced");
	});
});
```

- [ ] **Step 3: Implement** `chrome/storage.ts` (Promise wrappers, `lastError`-checked, null on missing), `settings-storage.ts` (`normalizeSettings(raw)` deep-merges over `DEFAULT_SETTINGS`, clamps with `LIMITS`, validates enums; `setSettings(patch: DeepPartial<Settings>)`; `onSettingsChanged(cb)` via `storage.onChanged` filtered to `LOCAL_KEYS.settings`), `logger.ts` (levels, `[sliced]` prefix, SW-direct + `MSG.LOG` forwarding as in tranquill, Appendix H), `rng.ts` (`createRng(seed: number | string)` → xoshiro128** with `next()`, `int(min,max)`, `normal(mu,sigma)`, `logNormal(mu,sigma)`, `pick(arr)`, `chance(p)`, `weighted(items, weights)`), `util/*`, and the remaining chrome wrappers (thin, one function per API call, all Promise-based).

- [ ] **Step 4: Tests pass; commit** — `feat(core): types, settings storage, chrome wrappers, logger, seeded rng`

### Task 4: Typed messaging — router, ports, `sendTyped`

**Files:**
- Create: `src/core/messaging/{typed-messages,router,ports}.ts`
- Test: `test/core/messaging/router.test.ts`, `test/core/messaging/ports.test.ts`

**Interfaces:**
- Produces: `sendTyped(msg)`, `sendTypedToTab(tabId, msg)`, `installMessageRouter(): MessageRouter` (`on(type, handler)`, `install()`, `_dispatch`), `connectPort<TOut, TIn>(name, { onMessage, onDisconnect })` returning `{ post(msg), disconnect() }` with auto-reconnect (exponential backoff 250→4000 ms) and a `ready` promise, `acceptPorts(name, onConnect)` for the SW side.

- [ ] **Step 1: Failing router test** (dispatch sync/async/throwing handlers; unhandled returns `undefined`; duplicate registration warns) — port tranquill's `message-router` semantics exactly (Appendix H §message-router).
- [ ] **Step 2: Failing ports test** — with a fake `chrome.runtime.connect` that disconnects once: `connectPort` reconnects and re-posts a queued message; `post` before `ready` queues.
- [ ] **Step 3: Implement**; `MessageResponseMap` keyed by `MSG.*` lives in `typed-messages.ts`.
- [ ] **Step 4: Commit** — `feat(core): typed message router and resilient ports`

### Task 5: chess helpers

**Files:**
- Create: `src/core/chess/{fen,san,squares,phase,material,move-classify}.ts`
- Test: `test/core/chess/*.test.ts`

**Interfaces:**
- Produces: `parseFen(fen) → FenParts`, `isValidFen`, `sideToMove(fen)`, `uciToSan(fen, uci)`, `sanToUci(fen, san)`, `pvToSan(fen, uci[])`, `applyMoves(fen, uci[]) → fen`, `legalMoves(fen) → Uci[]`, `Square` (`"a1".."h8"`), `fileOf/rankOf/squareOf`, `distance(a,b)` (Chebyshev and Euclidean), `phase(fen) → "opening"|"middlegame"|"endgame"` (by non-pawn material: ≥ 62 opening if ply < 20 else middlegame; ≤ 26 endgame), `material(fen) → {w,b,diff}`, `classifyMove(fen, uci) → { isCapture, isRecapture(prevMove), isCheck, isCastle, isPromotion, isOnlyMove, pieceType, capturedType, givesMate }`.

- [ ] **Step 1: Failing tests** — FEN round-trips (start position, en-passant, castling), `uciToSan("…", "e2e4") === "e4"`, promotion `e7e8q` → `e8=Q`, `pvToSan` on a 5-ply PV, `classifyMove` on a recapture (`prevMove` captured on the same square), `phase` on three known positions.
- [ ] **Step 2: Implement with chess.js** (`new Chess(fen)`; wrap in `try` returning `null` on invalid). Never write a move generator.
- [ ] **Step 3: Commit** — `feat(core): chess helpers (fen/san/classification) on chess.js`

### Task 6: pagescript — AST, builders, emit, spoof, bind, generator

**Files:**
- Create: `src/pagescript/{nodes,builders,emit,spoof,bind,std,index}.ts`, `scripts/gen-pagescript.ts`, `src/page/index.ts` (program registry)
- Test: `test/pagescript/{builders,emit,spoof,bind,std}.test.ts`

**Interfaces:**
- Consumes: `__SL_SPOOF_SEED__`.
- Produces: `js`, `std`, `defineProgram({name, params, build})`, `emit(program, {seed}) → {code, params}`, `deriveToken(seed, purpose)`, generated `src/page/generated/<name>.ts` exporting `{ code: string; bind(args): string }`.

- [ ] **Step 1: Failing builder/emit test**

```ts
import { expect, it } from "bun:test";
import { emit, js, std, defineProgram } from "@pagescript";
it("emits a querySelector call with a bound parameter", () => {
	const prog = defineProgram({ name: "t", params: { sel: "string" }, build: (p) => js.program([js.ret(std.query(p.sel))]) });
	const { code, params } = emit(prog, { seed: "abc" });
	expect(params).toEqual([{ name: "sel", type: "string" }]);
	expect(code).toContain("document.querySelector(");
	expect(prog.bind({ sel: "wc-chess-board" })).toContain(`"wc-chess-board"`);
});
it("spoofed identifiers are deterministic per seed", () => {
	const a = emit(defineProgram({ name: "s", params: {}, build: () => js.program([js.const_("x", js.spoof("ready"))]) }), { seed: "s1" }).code;
	const b = emit(defineProgram({ name: "s", params: {}, build: () => js.program([js.const_("x", js.spoof("ready"))]) }), { seed: "s1" }).code;
	const c = emit(defineProgram({ name: "s", params: {}, build: () => js.program([js.const_("x", js.spoof("ready"))]) }), { seed: "s2" }).code;
	expect(a).toBe(b); expect(a).not.toBe(c);
});
it("evaluates in happy-dom", () => {
	document.body.innerHTML = `<div id="b"></div>`;
	const prog = defineProgram({ name: "e", params: { sel: "string" }, build: (p) => js.program([js.ret(js.member(std.query(p.sel), "id"))]) });
	expect(new Function(prog.bind({ sel: "#b" }))()).toBe("b");
});
```

- [ ] **Step 2: Implement** per Part I §5.2–§5.4. `bind` implementation: `emit` prints each `$$param:x` as a placeholder literal `" param:x "`; `bind(args)` replaces each placeholder (including surrounding quotes) with `JSON.stringify(args[x])` — string params therefore always land as JSON strings, `json` params as object literals, `number`/`boolean` as bare literals. `std.postToExtension(token, payload)` emits `window.postMessage({ [spoofedKey]: token, ...payload }, location.origin)`.
- [ ] **Step 3: `scripts/gen-pagescript.ts`** — imports `src/page/index.ts` (registry array), for each program writes `src/page/generated/<name>.ts` (`export const code = <json string>; export function bind(args: {…typed}) { … }`) and, for programs flagged `entry: true` (the two bridges), writes `dist/js/page/<name>.js` = bound code wrapped as an IIFE with bind-time constants from `selectors.ts` and `tokens.generated.ts`. Hook into `scripts/build.ts` step `gen-pagescript`.
- [ ] **Step 4: Tests pass; commit** — `feat(pagescript): typed page-realm AST, emitter, spoofing and bind generator`

### Task 7: Design tokens, icons, `sl-ui` base

**Files:**
- Create: `src/design/tokens.ts`, `src/design/icons.ts`, `scripts/gen-tokens.ts`, `scripts/gen-icons.ts`, `scripts/check-css.ts`, `css/{sl-ui,base,primitives,components}.css`, `assets/vendor/fontawesome/` (Font Awesome Free 7.x: `css/all.min.css`, `webfonts/*`, `LICENSE.txt`), `pages/panel.html`, `pages/offscreen.html`
- Test: `test/design/tokens.test.ts`, `test/scripts/check-css.test.ts`

**Interfaces:**
- Consumes: Appendix F token values.
- Produces: `css/tokens.css`, `src/design/tokens.generated.ts` (`TOKENS`), `ICONS`, `IconName`, the `sl-ui` class vocabulary listed in Part I §10.1 and Appendix F component inventory.

- [ ] **Step 1: Failing tokens test** — `generateTokens()` output contains `--sl-unit:4px`, `--sl-space-4:calc(var(--sl-unit) * 4)`, a `[data-theme="dark"]` block with `--sl-color-accent:#ffa71f`, and every semantic colour has `-a12` … `-a85` alpha variants; `TOKENS.colors.dark.hlFrom` equals the CSS value.
- [ ] **Step 2: Implement `tokens.ts`** with the values from Appendix F (palette, semantic maps for dark and light) and `gen-tokens.ts` (resolves `"neutral.900"` references and `"@0.35"` alpha suffixes; writes both outputs; deterministic ordering).
- [ ] **Step 3: Vendor Font Awesome** — `bun add -d @fortawesome/fontawesome-free@^7` then copy `css/all.min.css` + `webfonts/` into `assets/vendor/fontawesome/` (build copies assets; not loaded from node_modules at runtime). `gen-icons.ts` parses `all.min.css` for `.fa-<name>` selectors and asserts every `ICONS` value's `fa-*` tokens exist.
- [ ] **Step 4: `check-css.ts`** per Part I §10.1 rules; failing test with a violating stylesheet (`padding: 13px`) and a valid one.
- [ ] **Step 5: Write `base.css` and `primitives.css`** (reset, `body.sl-shell`, type roles `.sl-type-*`, focus ring, reduced-motion, `.sl-stack/.sl-row/.sl-grid`, `.sl-icon`) using only tokens; `sl-ui.css` `@import`s tokens → base → primitives → components → views (components and views are written in Task 22; create empty files now so the import chain resolves).
- [ ] **Step 6: `pages/panel.html`** links `../assets/vendor/fontawesome/css/all.min.css` and `../css/sl-ui.css`, has `<main id="app">`, script `../js/panel.js` (type module). `pages/offscreen.html` loads `../js/offscreen.js`.
- [ ] **Step 7: Commit** — `feat(design): token source, generated CSS/TS tokens, icon registry, sl-ui base`

### Task 8: Extension simulator (test infrastructure)

**Files:**
- Create: `test/sim/{index,types}.ts`, `test/sim/chrome/{storage,tabs,runtime,alarms,debugger,side-panel,offscreen,commands,tts,scripting,windows}.ts`, `test/sim/contexts/{bus,sw-context,panel-context,content-context,offscreen-context}.ts`, `test/sim/dom/tab-dom.ts`, `test/sim/time/time-controller.ts`, `test/sim/bridges/cdp-input.ts`, `test/sim/assumptions.md`
- Test: `test/sim/*.test.ts`

**Interfaces:**
- Produces: `createSimulator()` → `{ chrome, bus, tabs, storage, alarms, debugger: { commands: CdpCommandRecord[] }, sidePanel, offscreen, time, openTab(url, opts) }`; `bootSwContext(sim)`, `bootPanelContext(sim)`, `bootContentContext(sim, tabId)`, `bootOffscreenContext(sim)`.

- [ ] **Step 1: Port tranquill's simulator** (`~/Documents/tranquill-dev/apps/extension/test/sim/`, Appendix H) module-by-module, renaming `tranquill` → `sliced`; add `offscreen.ts` (createDocument/hasDocument/closeDocument with the single-document rule), `tts.ts` (records `speak` calls), `commands.ts` (`onCommand` trigger helper), and extend `debugger.ts` to record every `sendCommand` with a monotonic timestamp from the time controller (needed to assert executor timing).
- [ ] **Step 2: Bus semantics** — `chrome.runtime.sendMessage` from context X delivers to all other contexts; `connect(name)` creates paired ports; `tabs.sendMessage` targets the content context of that tab; `storage.onChanged` fans out to all contexts.
- [ ] **Step 3: `test/setup.ts`** installs `createSimulator().chrome` as the global `chrome` (replacing the Task 1 stub) and seeds one active tab.
- [ ] **Step 4: Tests for each fake (port existing tests); commit** — `test(sim): virtual extension runtime with offscreen, tts, cdp recording`

### Task 9: Service-worker shell, lifecycle, keepalive, side-panel policy, license gate

**Files:**
- Create: `src/service/{service-worker,bootstrap,lifecycle,keepalive,side-panel-policy,license-gate,offscreen-manager,tts}.ts`, `src/core/auth/{license-client,phantom-license-client}.ts`, `src/service/handlers/license/*.ts`, `src/service/handlers/settings/*.ts`
- Test: `test/service/{side-panel-policy,license-gate,offscreen-manager,keepalive}.test.ts`, `test/core/auth/phantom-license-client.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4, 8.
- Produces: `bootstrapServiceSystems()` singleton (`{ router, sessions: GameSessionRegistry, engine: RemoteEngine, executor: MoveExecutor, license: LicenseGate }` — engine/executor/sessions are filled by later tasks; export the interface now with `null` placeholders), `ensureOffscreen()` (dedupes concurrent calls; `chrome.offscreen.createDocument({ url: "pages/offscreen.html", reasons: ["WORKERS"], justification: "Runs the chess engine in a Web Worker with SharedArrayBuffer" })`), `SidePanelPolicy` (enables the panel on chess.com/lichess tabs via `sidePanel.setOptions({tabId, enabled: true, path})`, disables elsewhere unless the user opened it globally; `setPanelBehavior({openPanelOnActionClick: true})` once), `LicenseGate.ensure()` (reads `LOCAL_KEYS.licenseState`; revalidates on alarm; exposes `isUnlocked()`), `Keepalive.hold(reason)/release(reason)` (alarm every 0.5 min while any reason is held — a live game or an attached debugger), `speak(text)` via `chrome.tts` honouring `display.ttsVoice`.

- [ ] **Step 1: Failing tests** — policy enables panel for a chess.com tab on `tabs.onUpdated` and disables for `example.com`; license gate maps endpoint bodies `{"status":"valid"}`, `{"status":"iplimit"}`, `{"status":"invalid"}` and a network error → `LicenseState.rawStatus`, while `LicenseState.status` is `"valid"` for all of them when `LICENSE_FORCE_VALID` is `true` (V2 force-valid, the legacy `|| true`); with the flag mocked to `false` the raw verdict becomes the effective status and a previously valid state survives a network error; `ensureOffscreen` called 3× concurrently creates one document.
- [ ] **Step 2: Implement.** `PhantomLicenseClient.validate(key)`: `fetch(`${URLS.licenseEndpoint}?key=${encodeURIComponent(key)}&type=gold`, { cache: "reload", signal: AbortSignal.timeout(TIMINGS.licenseValidateTimeoutMs) })`, extract the first `{…}` JSON object from the body (endpoint returns it inside text), map `valid|iplimit|invalid`. `LicenseGate.ensure()` computes `status = LICENSE_FORCE_VALID ? "valid" : rawStatus`; the constant lives in `src/core/constants/limits.ts` only (V2 equivalent of the legacy `|| true`).
- [ ] **Step 3: `service-worker.ts` orchestration** in the tranquill style (Appendix H): install log bridge → bootstrap systems → wire lifecycle (`onInstalled` migration from legacy keys per §12.3, `onStartup`, alarms dispatcher, `commands.onCommand` → forwards to the session registry) → register handlers → `router.install()` → side-panel policy.
- [ ] **Step 4: Tests pass; `bun run build --dev`; load `dist/` unpacked in Chrome; confirm the panel opens on the toolbar click and shows the placeholder.** Commit — `feat(service): worker shell, lifecycle, license gate, side-panel policy, offscreen manager, keepalive`


## Phase 2 — Engine

### Task 10: Vendor Stockfish 18 (stockfish-web) and the smallnet NNUE

**Files:**
- Create: `assets/engine/{sf_18_smallnet.js,sf_18_smallnet.wasm,sf_18_smallnet_relaxed-simd.js,sf_18_smallnet_relaxed-simd.wasm,sf_18.js,sf_18.wasm,nn-4ca89e4b3abf.nnue,LICENSE}`, `src/types/stockfish-web.d.ts`, `scripts/vendor-engine.ts`, `docs/third-party.md`
- Modify: `manifest.json` (COOP/COEP keys, CSP, `offscreen`, `unlimitedStorage`), `src/core/constants/urls.ts` (`nnueMirror: "https://tests.stockfishchess.org/api/nn/"`), `src/core/constants/limits.ts` (`nnueSmallName`, `nnueBigNames` — the net file names live here only)

**Interfaces:**
- Produces: the engine asset files; `ENGINE_FILES` registry in `src/core/constants/engine-files.ts` (`{ smallnet: {js, wasm, relaxedJs, relaxedWasm, nnue}, full: {js, wasm, nnue: [big, small]} }`).

- [ ] **Step 1: `scripts/vendor-engine.ts`** — `bun add -d @lichess-org/stockfish-web@0.4.4`, copy the listed files from `node_modules/@lichess-org/stockfish-web/` into `assets/engine/`, download `nn-4ca89e4b3abf.nnue` from the mirror, verify `sha256(file).slice(0,12) === "4ca89e4b3abf"`, write `docs/third-party.md` (AGPL source offer, versions, hashes). Run it once; commit the assets (10.4 MB net is acceptable in-repo; add `assets/engine/*.nnue` to `.gitattributes` as binary).
- [ ] **Step 2: Manifest** — apply the §11.3 manifest with these confirmed values: `minimum_chrome_version: "128"` (research floor is 118: sidePanel.open 116, runtime.getContexts 116, debugger keeps the SW alive 118; 128 is chosen for margin), permissions `["storage","debugger","sidePanel","offscreen","tts","alarms","unlimitedStorage"]` (no `tabs`, no `scripting` — manifest content scripts do not need it; add `scripting` only if Task 19 adopts `executeScript`), `host_permissions` for chess.com, lichess.org and `https://explorer.lichess.ovh/*`, COOP/COEP keys, CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- [ ] **Step 3: Test** `test/scripts/vendor-engine.test.ts` — hash-prefix verification function rejects a tampered buffer.
- [ ] **Step 4: Commit** — `chore(engine): vendor Stockfish 18 stockfish-web smallnet build and NNUE`

### Task 11: UCI parser and client (pure)

**Files:**
- Create: `src/core/engine/{types,uci-parser,uci-client,options,analysis-cache}.ts`
- Test: `test/core/engine/{uci-parser,uci-client,analysis-cache}.test.ts`

**Interfaces:**
- Produces: everything in Part I §6.4 (`EngineTransport`, `AnalysisRequest/Update/Result/Handle`, `UciEngine`, `parseInfo`, `parseBestmove`, `parseOption`, `EngineOptions`, `optionsForSettings`, `AnalysisCache`).

- [ ] **Step 1: Failing parser tests** — the Appendix A §6 grammar: `info depth 12 seldepth 18 multipv 2 score cp -35 upperbound wdl 120 700 180 nodes 91234 nps 812000 hashfull 12 tbhits 0 time 112 pv e7e5 g1f3 b8c6` → all fields; `info string NNUE evaluation using nn-…` → `{string}`; `bestmove e2e4 ponder e7e5`; `bestmove (none)`; `option name UCI_Elo type spin default 1320 min 1320 max 3190`.
- [ ] **Step 2: Failing client tests with a scripted fake transport** — (a) `init()` resolves after `uciok` + `readyok` and returns options; (b) `analyse()` sends `setoption MultiPV`, `position fen …`, `go movetime 800` in order; yields coalesced updates when all `multipv` lines of a depth arrive; resolves on `bestmove`; (c) a second `analyse()` while searching queues, `stop` is sent, and the first result has `status: "superseded"`; (d) transport `exit` → state `crashed` → after `restart()` options are replayed in order and the queue drains; (e) `stop` timeout (`TIMINGS.engineStopTimeoutMs`) → crash path; (f) `atFeatureDepth` captures the last complete depth-10 iteration.
- [ ] **Step 3: Implement** per Part I §6.4 and Appendix E §5 (state machine, FIFO with priorities `move > ponder > panel`, single-slot mailbox for updates at ≤ 10 Hz, `isready` after option bursts and `ucinewgame`).
- [ ] **Step 4: Cache tests** — LRU eviction at `LIMITS.analysisCacheEntries`; FEN keys drop halfmove/fullmove fields; `get(fen, multiPv, minDepth)` matches only complete results.
- [ ] **Step 5: Commit** — `feat(engine): typed UCI parser, client state machine, analysis cache`

### Task 12: Offscreen engine host and NNUE store

**Files:**
- Create: `src/offscreen/{index,engine-host,stockfish-loader,nnue-store,timing-inference}.ts`, `pages/offscreen.html` (already exists), `src/core/engine/remote-engine.ts`, `src/service/handlers/engine/*.ts` (nnue download relay, restart, status)
- Test: `test/offscreen/{engine-host,nnue-store}.test.ts` (fake `StockfishWeb`), `test/core/engine/remote-engine.test.ts`, `test/integration/engine.test.ts` (real wasm, skipped without SAB)

**Interfaces:**
- Consumes: Task 4 ports, Task 10 assets, Task 11 client.
- Produces: `bootEngine(variant)`, `NnueStore.get(name)`, `EngineHost` (port protocol `EnginePortMessage`/`EnginePortCommand`), `RemoteEngine` (an `EngineTransport` over `PORT_NAMES.engine` for the SW), `EngineStatus`.

- [ ] **Step 1: Failing host tests** — `EngineHost` with a fake `StockfishWeb`: on port `{kind:"uci", line:"uci"}` calls `sf.uci("uci")`; `sf.listen("info …")` → port `{kind:"line"}`; `sf.onError` → status `crashed` then restart with backoff; `loadNnue` calls `setNnueBuffer(buf, i)` for each recommended net in order; status transitions `booting → loading-nnue → ready`.
- [ ] **Step 2: Failing `NnueStore` tests** — bundled hit; OPFS hit with matching hash; hash mismatch → deletes and re-requests; download relay via port chunks reassembles the buffer.
- [ ] **Step 3: Implement** per Part I §6.3 and Appendix A §5/§7 (`crossOriginIsolated` assertion with a clear status error `"cross-origin isolation missing"`, relaxed-simd probe via `WebAssembly.validate`, shared memory shrink loop, `locateFile`, `mainScriptUrlOrBlob`).
- [ ] **Step 4: SW side** — `RemoteEngine` implements `EngineTransport` over `connectPort(PORT_NAMES.engine)`; `ensureOffscreen()` (Task 9) is awaited before connect; `handlers/engine/nnue-download.ts` fetches the big nets in the SW (no COEP there) and streams 4 MB chunks back; `bootstrapServiceSystems().engine = new UciEngine(new RemoteEngine(...))`.
- [ ] **Step 5: Integration test** — in Bun, spawn the vendored module in a Worker with a shared `WebAssembly.Memory`; `uci` → `uciok`; load the net; `go depth 8` → `bestmove` within 10 s. Skip with a logged reason if `SharedArrayBuffer` is unavailable.
- [ ] **Step 6: Manual check** — load unpacked; open `chrome://extensions` → service worker console → `chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})` shows one document; offscreen console shows `crossOriginIsolated === true` and `readyok`.
- [ ] **Step 7: Commit** — `feat(offscreen): Stockfish host with NNUE store and SW remote transport`

### Task 13: Engine options from settings + panel engine snapshot

**Files:**
- Create: `src/service/engine-controller.ts` (applies `optionsForSettings` on settings change, exposes `analyse/ponder` with cache and priorities), `src/core/engine/snapshot.ts` (`toEvalSnapshot(result, fen) → { evalBar: number /* −1..1 white POV via win prob */, scoreText, wdl, lines with SAN }`)
- Test: `test/service/engine-controller.test.ts`, `test/core/engine/snapshot.test.ts`

- [ ] **Step 1: Tests** — settings `{targetElo: 1500, threads: "auto", hashMb: 32, multiPv: 6}` → `setOptions({ Threads: clamp(hc−2,1,4), Hash: 32, MultiPV: 6, UCI_LimitStrength: true, UCI_Elo: 1500, UCI_ShowWDL: true, Ponder: false })`; targetElo 800 → `UCI_Elo 1320`; targetElo 3200 → 3190; snapshot: `cp +34` white to move → `evalBar ≈ +0.06`, `scoreText "+0.34"`; mate −2 black to move → `"M2"` white POV and `evalBar +1`.
- [ ] **Step 2: Implement; commit** — `feat(engine): options from settings, eval snapshot for the panel`

## Phase 3 — Strength and timing

### Task 14: Move selector, form latent, heuristic prior, never-play filters

**Files:**
- Create: `src/core/strength/{constants,elo-map,move-selector,blunder-model,prior,persona,types}.ts`
- Test: `test/core/strength/*.test.ts`

**Interfaces:**
- Produces: `selectMove(lines, ctx, prior?) → ChosenMove`, `FormLatent` (`next()`, AR(1)), `heuristicPrior(fen, lines, ctx) → Map<uci, number>`, `SELECTION_CONSTANTS` (the only place τ/σ/G/b0/β tables exist), `engineEloFor(targetElo)`.

- [ ] **Step 1: Failing tests (seeded RNG)** — (a) at `E = 2800` over 10 000 samples of a position with best +50 and second −20 the top-1 rate is ≥ 0.9; at `E = 1000` it is between 0.35 and 0.65; (b) never-play: a line with `mate −1` is never chosen at `E = 1600` when an alternative exists; (c) mate-in-1 always chosen at `E ≥ 1400`; (d) blunder channel: with `blunderScale = 5` at `E = 1200`, the injected-blunder rate over 40 000 samples is within ±20 % of `5·b0(1200)`; (e) `hybrid` mode boosts the engine's `bestmove` prior ×2; (f) streak damper: after 12 top-1 picks τ increases; (g) `engineEloFor(800) === 1320`, `(3200) === 3190`.
- [ ] **Step 2: Implement** Part I §7.2 verbatim (Appendix E §1.5/§1.8 code), with `classifyMove` from Task 5 for the prior table (Appendix E §3.4).
- [ ] **Step 3: Commit** — `feat(strength): rating-parameterised move selector with blunder channel and priors`

### Task 15: Opening book (explorer + polyglot) and premove candidates

**Files:**
- Create: `src/core/strength/book/{polyglot,random64,explorer,book-policy}.ts`, `src/core/strength/premove.ts`, `assets/books/gm2600.bin` (vendored, 347 KB), `scripts/build-club-book.py` (documented, run offline; output `assets/books/club.bin` committed)
- Test: `test/core/strength/book/*.test.ts`, `test/core/strength/premove.test.ts`

- [ ] **Step 1: Failing polyglot tests** — `polyglotKey(startFen) === 0x463b96181691fc9cn` (reference value from the format spec), en-passant key only when a capture is possible, castling remap `e1h1 → e1g1`, promotion decoding; `lookup(startFen)` on `gm2600.bin` returns ≥ 5 moves including `e2e4` and `d2d4`.
- [ ] **Step 2: Failing explorer tests** — fake `fetch`: bucket selection for `E = 1500` → `ratings=1400,1600,1800`; speeds mapping by `base + 40·inc`; sampling `p ∝ n^γ`; 429 → back-off flag for 60 s; timeout 1 200 ms.
- [ ] **Step 3: Failing premove tests** — given `ponder` reply with `p ≥ 0.6` and a forced recapture, returns `{ reply, premove }`; king moves never premoved.
- [ ] **Step 4: Implement** Part I §7.3–§7.4; `book-policy.ts` orders explorer → polyglot → none with the exit conditions.
- [ ] **Step 5: Commit** — `feat(strength): opening explorer + polyglot book policy and premove candidates`

### Task 16: Timing model v1 (+ v2 head scaffold), features, budget, persona

**Files:**
- Create: `src/core/timing/{types,constants,features,budget,distributions,persona-latents,v1-head,chessmimic-head,timing-model,timing-log,orientation,move-window}.ts`, `tools/data/{01_download.sh,02_sample.py,03_features.py,04_train.py,05_export.py,06_eval.py,README.md}`
- Test: `test/core/timing/*.test.ts`

**Interfaces:**
- Consumes: `EvalLine`, `PositionSnapshot`, `ChosenMove`, `classifyMove`, `phase`, `createRng`.
- Produces: everything in Part I §8.3; `TIMING_CONSTANTS` (Appendix D §7 transcribed once); `computeFeatures(ctx) → Features` (25 named numbers, Appendix D §2); `budgetController(f, persona, state) → allocSec`; `samplePersona(seed, profile, elo)`; `TimingLogEntry`.

- [ ] **Step 1: Failing feature tests** — `elo_z(800) = −1`, `(2500) = 1`; `tc_class("180+0") = "blitz"`, `("60+0") = "bullet"`, `("600+5") = "rapid"`; `decisiveness` for best +200/second −100 equals `ln(1 + 300/25)`; `is_recapture` true when the opponent just captured on the destination square; `n_reasonable` counts lines within 40 cp.
- [ ] **Step 2: Failing budget tests** — 3+0 at ply 0: `N_rem ≈ 42.6`, `alloc ≈ 4.0 s` with τ = 0.65; `alloc ≥ 0.15`; increment games add `0.9·inc`.
- [ ] **Step 3: Failing head tests (seeded)** — over 20 000 samples in a generic middlegame at 3+0 with 120 s left: median between 2 and 4 s, P(t > 15 s) between 1 % and 6 %, P(mode = instant) between 5 % and 20 %; a forced recapture with `ponder_hit = 1` gives P(premove ∪ instant) > 0.5 in blitz; with 8 s left every sample ≤ 0.15·clock; AR(1): correlation between successive residuals ≈ φ ± 0.05.
- [ ] **Step 3a: Failing V2.1 tests (Part I §8.4b)** — `tc_class("untimed")` bypasses the budget controller and time-pressure terms and conditions the model as `classical`; every plan includes `orientationMs` ≥ 150 ms with median ≈ 380 ms, longer after `swing_bad`, shorter with `ponder_hit`; game independence: after `startGame()` no field of the internal state differs between a fresh model and one that has played 40 moves, and two games with different seeds have uncorrelated residual sequences (|r| < 0.05 over 1 000 pairs); the bot-opponent pace floor keeps think times ≥ 0.6× the model median; the ChessMimic head (with a fake inference port returning fixed bucket probabilities) applies the `player_clock + increment` bucket mask and never returns a bucket the clock cannot afford, decodes bucket-then-within-bucket, maps bucket 0 to instant/premove only when eligible, supplies the 300 s virtual clock for clockless games, selects the band from the target Elo, and falls back to v1 after a 100 ms timeout; its TypeScript tokeniser reproduces the Python reference inputs bit-for-bit on the 1 000-position fixture from Task 34; the plan's phase allocation (`orientation/scan/preview/decision/approach`) sums to `thinkMs` with the decision pause between 15 % and 40 % and the approach last.
- [ ] **Step 4: Failing `TimingModel` tests** — `planMove` returns `thinkMs ≥ dragDurationMs`, `deadlineMs = nowMs + thinkMs`; `replan(…, "manual-now")` sets `preMoveHoverMs = 0` and keeps the drag; `replan(…, "clock-jump")` truncates to caps; `observe()` shifts ε toward the realised value; persona is a pure function of the per-game seed and nothing else.
- [ ] **Step 5: Implement** Part I §8 + Appendix D §2–§5 and Appendix D Appendix A verbatim; `chessmimic-head.ts` implements the TypeScript preprocessing for the ONNX export (searchless_chess FEN tokeniser, UCI vocabulary, per-band scaler constants embedded as JSON, virtual clock), the port call to `timing-inference.ts`, the mask and decoding.
- [ ] **Step 6: Evaluation data pipeline** — the Python scripts of Appendix D §3b.2 that build the Lichess `%clk` evaluation set (download, sample, features) with a `README.md`; used only by the conformance harness (Task 33) to compare generated `MoveHoldTime` distributions against real human ones. No model is trained.
- [ ] **Step 7: Commit** — `feat(timing): feature-conditioned human timing model v1, budget controller, persona latents, v2 scaffold`


## Phase 4 — Move execution (the virtual hand)

### Task 17: Motor core — path generator, WindMouse, sampling, profiles, invariants

**Files:**
- Create: `src/core/motor/{types,constants,path-generator,windmouse,sampling,motor-profile,exploration,preview-select}.ts`
- Test: `test/core/motor/{path-generator,windmouse,sampling,motor-profile,exploration,invariants}.test.ts`

**Interfaces:**
- Consumes: `createRng`, `TOKENS` (none needed here), `EvalLine`, `Square`.
- Produces: `PathPoint`, `MotorProfile`, `generatePath(from, to, targetRect, profile, rng)`, `windMousePath(x0,y0,x1,y1,params,rng)`, `grabWobble(p, profile, rng)`, `samplePointInRect(rect, σFrac, innerFrac, rng)`, `plausibleStart(boardRect, rng)`, `profileFor(persona, tcClass, moveKind, base)`, `ExplorationPlanner.plan(waitMs, candidates, geometry, profile, rng) → HandAction[]` where `HandAction = { kind: "rest"|"hover"|"trace"|"feint"|"drift"; target?: Pt; rect?: Rect; dwellMs: number; path?: PathPoint[] }`, `MOTOR_DEFAULTS` (Appendix G §8 values — defined once).

- [ ] **Step 1: Failing geometry tests** — `generatePath` from (100,100) to (400,300) with a 80×80 target: first point ≠ start teleport (≤ 12 px from start), last point inside the target rect, ≥ 20 points, all integer coordinates, `Σ dtMs` within `[0.6, 1.6]×` the Fitts estimate; speed profile computed from points has one dominant peak between 25 % and 75 % of the path and start/end speeds below 30 % of the peak (minimum-jerk shape); two calls with different seeds differ; same seed → identical.
- [ ] **Step 2: Failing WindMouse tests** — path terminates within 1 px of the target in < 2000 iterations; velocity never exceeds `maxStep` + tolerance; damped approach inside `targetArea`.
- [ ] **Step 3: Failing sampling tests** — 10 000 samples of `samplePointInRect` all inside the inner fraction; mean within 2 px of the centre; `plausibleStart` never inside the from-square.
- [ ] **Step 4: Failing exploration tests** — with `waitMs = 4000` and three candidates, the plan's total duration ≤ `waitMs − reactionMs`; hovers prefer higher-probability candidates over 1 000 seeds (≥ 60 % of first hovers on the top candidate); with `waitMs = 300` the plan is `[rest]` only; **V2.1 preview selections (§9.3a):** over 5 000 seeded plans at `thinkMs = 4 000`, `n_reasonable = 3`, balanced persona, the fraction containing a `preview` action is within 6–14 %; 0 % at `thinkMs = 800` or in premove/instant modes or with `myClockMs < 15 000`; the previewed piece's legal destinations are never clicked unless one is the committed move; drag-style previews release on the origin square; `previewSelectScale = 0` → 0 %; the preview rate scales with `n_reasonable`.
- [ ] **Step 5: Invariant suite** (`invariants.test.ts`, 500 random moves): no duplicate consecutive points with `dtMs = 0`, no segment faster than `peakSpeedCapPxPerS`, every `mouseReleased` point inside its target, per-profile parameter jitter within ±25 %, no two paths identical; **V2:** consecutive executions start where the previous ended (continuity); click press/release within 2 px; every press is either the committed move or a modelled preview that resolves before the move; no selection is left pending at move time.
- [ ] **Step 6: Implement** Appendix G §7.2–§7.3 (Bezier anchors on chord normals, arc-length table, minimum-jerk sampling every 8 ms, Fitts duration with peak-speed floor, overshoot + corrective sub-movement, micro-correction, AR(1) tremor with `sin(πτ)` envelope, integer quantisation, target clamp), §2.3 WindMouse port, §7.2 sampling, §8 profile modulation; the exploration planner per Part I §9.3.
- [ ] **Step 7: Commit** — `feat(motor): human path generation, exploration planner, motor profiles`

### Task 18: CDP input backend, debugger manager, hand controller, verifier

**Files:**
- Create: `src/service/move-executor/{index,hand-controller,cdp-input-backend,cdp-mouse,verifier,retry-policy}.ts`, `src/service/debugger-manager.ts`, `src/core/motor/input-backend.ts` (interface)
- Test: `test/service/move-executor/{hand-controller,cdp-mouse,verifier,retry-policy}.test.ts`, `test/service/debugger-manager.test.ts`, `test/behavioral/executor/drag-move.test.ts`

**Interfaces:**
- Consumes: Task 17, Task 8 simulator (`sim.debugger.commands` with timestamps), Task 4 ports (content `cursor` messages, `observeMove` request), `TimingPlan`.
- Produces: `InputBackend { move(p: Pt, atMs: number): Promise<void>; press(p, atMs): Promise<void>; release(p, atMs): Promise<void>; position(): Pt; dispose(): void }`, `CdpInputBackend(tabId)`, `DebuggerManager { ensureAttached(tabId); detach(tabId); isAttached(tabId); onDetached(cb) }`, `FocusGate { onFocusEdge(msg); positionArrived(at); canExecute(): { ok: boolean; reason?: "unfocused"|"hidden"|"blur-in-window" } }` (V2 §13.4), `HandOwnership { armed(startPoint); realPointerSeen(at) /* counts only */; realPointerCount(); released() }` (V2.1 §13.5), `HandController { execute(plan: ExecutionPlan, timing: TimingPlan, signal: AbortSignal): Promise<ExecutionResult>; state(): HandState }`, `verifyMove(tabId, expected, timeoutMs)`, `MoveExecutor { schedule(rec, plan); playNow(); cancel(); on(event) }`.

- [ ] **Step 1: Failing `CdpMouse` tests** — dispatches `mousePressed{button:"left",buttons:1,clickCount:1}`, `mouseMoved{button:"left",buttons:1}` while pressed, `mouseReleased{buttons:0}`; free moves carry `button:"none",buttons:0`; `travel(path)` honours `dtMs` against the simulator clock within ±4 ms per point and resyncs after a stall > 40 ms; never sets `timestamp`.
- [ ] **Step 2: Failing `DebuggerManager` tests** — attach once per tab (concurrent calls dedupe), protocol `"1.3"`, rebuilds state from `getTargets()` after a simulated SW restart, `onDetach(canceled_by_user)` clears state and notifies, `detach` after `TIMINGS.debuggerIdleDetachMs` of inactivity, attach errors mapped to user-facing reasons ("Another debugger is attached", "Restricted page").
- [ ] **Step 3: Failing `HandController` tests (drag)** — recorded CDP command sequence for a plan: `[orientation idle] → [scan hovers …] → [optional preview: press/release on a candidate, dwell, resolve] → decision pause → moves to from-square → mousePressed inside from-rect → wobble moves → moves ending inside to-rect → mouseReleased inside to-rect`; total elapsed ≈ `timing.thinkMs` ± 60 ms; the press happens after `preMoveHoverMs`; promotion adds a look-delay then a click inside the picker rect; click-click style emits exactly two press/release pairs with an inter-click gap in [90, 220] ms; **V2:** `FocusGate.canExecute()` false → result `skipped:"unfocused"` with zero commands; a `blur` edge arriving after `positionArrived` → `skipped:"blur-in-window"`; real pointer activity after arming → ignored: execution proceeds unchanged and `HandOwnership.realPointerCount()` increments (V2.1); abort mid-drag → immediate `mouseReleased` at the current point; no `chrome.tabs.update`/`Page.bringToFront`/`Emulation.setFocusEmulationEnabled` is ever sent (asserted on the fake).
- [ ] **Step 4: Failing verifier/retry tests** — `observeMove` resolves true → `ok`; false → retry with click-click once → still false → `failed` and no third attempt; board already shows the move before retry → `ok` without re-dispatch.
- [ ] **Step 5: Implement** Part I §9.3–§9.5 and Appendix G §7.4–§7.5 (absolute-time scheduler, **no** tab-activation pre-flight (§13.4), `FocusGate` + `HandOwnership` checks before the approach, `ExecutionResult { ok, outcome: "executed"|"skipped"|"paused"|"aborted"|"failed", reason?: string, tier: "drag"|"click", attempts, endPoint, elapsedMs, timeline: Array<{phase, startMs, endMs}>, error? }`).
- [ ] **Step 6: Behavioural test** — boot SW context, fake content adapter replies to `observeMove`, schedule a recommendation with a 1 200 ms plan; assert the fake debugger recorded a realistic sequence and the `GameSession` received `executed`.
- [ ] **Step 7: Commit** — `feat(executor): CDP virtual hand with debugger lifecycle and verification`

### Task 19 (optional, not a release gate — V2.3): Motor personalisation — recorder, fitter, splice generator, realism harness

**Files:**
- Create: `src/content/motor-recorder.ts`, `src/core/motor/{fit,splice,trace-features}.ts`, `src/service/handlers/content/motor-trace.ts`, `tools/motor-eval/{README.md,eval.py,features.py}`
- Test: `test/content/motor-recorder.test.ts`, `test/core/motor/{fit,splice,trace-features}.test.ts`

**Interfaces:**
- Produces: `MotorTrace { t: number[]; x: number[]; y: number[]; buttons: number[] }` chunks under `LOCAL_KEYS.motorTraces` (kinematics only, V2.2: no timing or preview-rate information is fitted from them); `fitMotorProfile(traces, defaults) → MotorProfile & { version, fittedAt, sampleCount }` under `LOCAL_KEYS.motorProfile`; `splicePath(from, to, targetRect, corpus, profile, rng) → PathPoint[]`; `traceFeatures(path) → { speedHist, accelHist, jerkRms, curvature, straightness, pauseHist, dwellMs }` shared by the fitter, the harness and the invariant tests.

- [ ] **Step 1: Failing recorder tests** — records only `isTrusted` pointer events on chess pages when the setting is on; ring buffer caps at 20 MB total across chunks; chunks sent to the SW every 30 s or 2 000 events.
- [ ] **Step 2: Failing fitter tests** — synthetic traces generated by `generatePath` with known `fittsA/B` recover them within 15 %; below 50 movements the result blends toward defaults with `w = n/(n+200)`.
- [ ] **Step 3: Failing splice tests** — spliced path lands inside the target, preserves the corpus movement's normalised curvature (correlation ≥ 0.8 with the source), time-warp ≤ ±20 %.
- [ ] **Step 4: Implement** Part I §9.6; `tools/motor-eval/eval.py` trains a gradient-boosted classifier on `trace-features` of real vs generated paths and reports AUC (target ≤ 0.60).
- [ ] **Step 5: Commit** — `feat(motor): fit motor profile from the user's own traces, splice generator, realism harness`


## Phase 5 — Site adapters, page bridges, content script

### Task 20: Selector registry, DOM parsers, adapters (ISOLATED world)

**Files:**
- Create: `src/content/adapters/{adapter,selectors,query,dom-fen,move-list,clocks,geometry,self-check,chesscom,lichess,page-kind}.ts`
- Test: `test/content/adapters/*.test.ts`, fixtures `test/fixtures/{chesscom-live,chesscom-computer,chesscom-gameover,lichess-round-white,lichess-round-black,lichess-promotion,lichess-tv}.html` (DOM snapshots captured from the sites per Appendix C; strip scripts)

**Interfaces:**
- Consumes: `TIMINGS.adapterDebounceMs`, `TIMINGS.adapterSelfCheckIntervalMs`, chess helpers (Task 5), `PositionSnapshot`.
- Produces: `SiteAdapter` interface (the `BoardAdapter` of Appendix C §4 renamed: `site`, `detectPageKind()`, `getOpponent()` (V2), `onFocusEdge(cb)` (V2), `isReady()`, `getFen()`, `getPlacement()`, `getSideToMove()`, `getMyColor()`, `getClock(side)`, `getMoveList()`, `getPly()`, `isAtLivePosition()`, `isGameOver()`, `isMyTurn()`, `getBoardRect()`, `isFlipped()`, `squareToPoint(sq)`, `pointToSquare(p)`, `squareRect(sq)`, `getPromotionTargetRect(dest, piece)`, `onPositionChange(cb)`, `onGameStart(cb)`, `onGameEnd(cb)`, `highlight(from, to, style)`, `arrows(lines)`, `clearHighlights()`, `tryStartNewGame(mode)`, `observeMove(expected, timeoutMs)`, `probe() → ProbeReport`, `destroy()`), `SELECTORS.chesscom` / `SELECTORS.lichess` (Appendix C §5 transcribed once), `queryFirst(candidates)`, `chesscomPlacementFromDom`, `lichessPlacementFromDom`, `findLichessRoundMoves`, `parseClockText`, `chesscomSquareToPoint`, `lichessSquareToPoint`, `detectChesscomPageKind`, `detectLichessPageKind`.

- [ ] **Step 1: Failing parser tests on fixtures** — chess.com placement from `.piece` classes equals the expected FEN placement; lichess placement from transforms in both orientations; `parseClockText("0:16.0") === 16000`, `("2:59") === 179000`, `("1:00:00") === 3600000`; chess.com move list → SAN array with figurine handling; lichess structural detector finds the moves container on the rotated-tag fixture and on a synthetic fixture with different tag names; `chesscomSquareToPoint("e2", rect, false)` and flipped; lichess `pointToSquare(squareToPoint(sq)) === sq` for all 64 squares in both orientations; page-kind detection table (all URL patterns in Appendix C §1.1/§2.1).
- [ ] **Step 2: Failing adapter tests** — **V2:** `detectPageKind()` returns `vs-computer` for chess.com `/play/computer`, `/play/bots/<name>` and for a lichess round fixture whose opponent row reads "lichess AI level 5"; `getOpponent()` returns `{ isBot: true, ratingEstimate: 2000 }` for that fixture and the chess.com bot card fixture; `onFocusEdge` fires for `window` `blur`/`focus` and `visibilitychange`; the adapter never calls `localStorage`/`sessionStorage` (spy); `getFen()` prefers the bridge FEN when present (fake bridge), else replay + DOM cross-check with `approximate` flag on mismatch; `onPositionChange` fires exactly once per move when the fixture mutates (board class flip, move-list node insert, clock class flip within one debounce window) and not while `.piece.dragging` / `piece.anim` / `#promotion-choice` exists; `isGameOver()` on the game-over fixture; `tryStartNewGame()` clicks the first matching ladder entry; `getPromotionTargetRect("e8","n")` on the lichess promotion fixture equals the second `square`'s rect; `observeMove` resolves true when a piece appears on the destination and false when the piece snaps back; `probe()` reports the matched candidate index per concern and lists misses.
- [ ] **Step 3: Implement** per Part I §3.4/§3.4a and Appendix C §1–§5 (hybrid FEN strategy §3, observer setups §1.8/§2.8, self-checks §5). Highlights: chess.com via the bridge (`markings.addOne`, keep keys, `removeMany`), lichess via the `highlight-overlay` pagescript program (Task 21) with colours from `TOKENS.color.<theme>.hl*`.
- [ ] **Step 4: Commit** — `feat(content): selector registry, DOM parsers, chess.com and lichess adapters`

### Task 21: Page bridges (pagescript), content script entry, keybinds, cursor tracker, feed port

**Files:**
- Create: `src/page/{chesscom-bridge,lichess-bridge,highlight-overlay,cursor-probe,focus-probe,verify-move-probe,index}.ts` (pagescript programs), `src/content/{index,site-detect,page-bridge-client,keybinds,cursor-tracker,highlights,feed-port,tts-relay}.ts`
- Test: `test/page/{chesscom-bridge,lichess-bridge,highlight-overlay}.test.ts` (emitted programs evaluated in happy-dom against fixtures with a fake `wc-chess-board.game` / `window.lichess`), `test/content/{page-bridge-client,keybinds,cursor-tracker,feed-port,index}.test.ts`, `test/behavioral/content/position-feed.test.ts`

**Interfaces:**
- Consumes: pagescript (Task 6), adapters (Task 20), ports (Task 4), `Keybinds`, `TOKENS`.
- Produces: bridge protocol over `window.postMessage` with the per-build token: page → content `{ t: token, kind: "ready"|"move"|"load"|"gameover"|"state"|"cursor"|"focus", … }`, content → page `{ t: token, kind: "getState"|"draw"|"clear"|"legalMoves"|"cursor" , id }` with `id`-correlated replies; `PageBridgeClient { call(kind, payload, timeoutMs) → Promise; on(kind, cb) }`; `installKeybinds(getKeybinds, onAction)` (capture-phase `keydown` on `window`, ignores editable targets, debounced `TIMINGS.keybindDebounceMs`, `global` scope handled by `chrome.commands` in the SW); `CursorTracker` (passive capture-phase `pointermove/down/up`, reports `{x,y,t}` to the SW on request and `userActive` edges); `FeedPort` (connects `PORT_NAMES.game`, sends `hello`/`position`/`gameStarted`/`gameEnded`/`moveObserved`/`cursor`/`selectorMiss`, receives `highlight`/`arrow`/`clearHighlight`/`keybinds`/`startNewGame`/`speak`; reconnects with backoff; re-sends `hello` + the last position on reconnect).

- [ ] **Step 1: Failing bridge tests** — **V2 presence rules (§13.3):** emitted bridge code defines no property on `window` (no `defineOnce` marker; `Object.keys(window)` unchanged after evaluation), inserts no DOM element unless a `draw` command arrives, and contains none of the forbidden substrings (`sliced`, `engine`, `stockfish`, `eval`, `bestmove`, `fen`, `analysis`) — field names in postMessage payloads are single letters; `chesscom-bridge`: waits for `customElements.whenDefined("wc-chess-board")` and the element, then posts `ready`; `getState` reply contains `{ fen, turn, playingAs, mode, flipped, lastMove, timeControl, timestamps }`; `game.on("Move")` → posts `move` with `fen`; `draw` calls `markings.addOne` and stores keys; `clear` removes only our keys; the program contains no literal selector (bound at build from `SELECTORS`). `lichess-bridge`: subscribes `window.lichess.events.on("ply")` when available and posts `ply`; `getState` returns `{ hasLichessApi, analysisFen? }`; installs nothing else on round pages. `highlight-overlay`: appends one `<svg>` to `cg-container` (or `wc-chess-board`) with `pointer-events:none`, draws from/to rects and an arrow polygon in the given colours, is idempotent (`std.defineOnce`), and removes on `clear`. `cursor-probe`/`focus-probe`/`verify-move-probe` return the documented shapes.
- [ ] **Step 2: Failing content tests** — `site-detect` maps hostnames to `Site`; `index` boots the right adapter and bridge client, sends `hello` with `pageKind` and `opponent`, forwards position snapshots (with `capturedAt`), re-detects page kind on `popstate`/body mutations; **V2.1:** every live game page (`live-game`, `vs-computer`) starts a session; every `focus`/`blur`/`visibilitychange` edge is forwarded as `{kind:"focus"}`; keybinds: `Space` plays when not in an input, `Shift+X` disables, `Shift+A` arms/disarms, capture works even when the page calls `stopPropagation` in bubble phase; cursor tracker only records trusted events and marks them `real: true`; the content bundle contains no `localStorage`/`sessionStorage`/`dispatchEvent`/`new PointerEvent` usage (source scan); highlights are not drawn when `automation.highlightMoves` is false and are cleared before any execution; `speak` command is ignored in content (TTS lives in the SW) — assert no `speechSynthesis` usage.
- [ ] **Step 3: Implement**; `scripts/gen-pagescript.ts` marks the two bridges `entry: true` so `dist/js/page/*.js` exist and the manifest's MAIN-world entries resolve.
- [ ] **Step 4: Behavioural test** — content context + SW context in the simulator: fixture mutation → `position` on the game port → SW session receives `PositionSnapshot`; SW `highlight` → adapter draws (bridge fake records `addOne`).
- [ ] **Step 5: Manual check on both sites** (unpacked build): panel shows the live position, clocks and turn; highlights appear; a promotion fixture is captured for tests if not already present.
- [ ] **Step 6: Commit** — `feat(content): page bridges from pagescript, content entry, keybinds, cursor tracker, feed port`


## Phase 6 — Side panel UI (Lattice / sl-ui)

All UI tasks implement Appendix F (the UI spec) exactly: wireframes §4, component inventory §5, micro-interactions §6, copy §7, responsive rules §8. Copy strings live once in `src/panel/copy.ts` (C1). Icons only via `ICONS` names. No numeric literal in CSS outside tokens (`scripts/check-css.ts`).

### Task 22: sl-ui components CSS + `check-css` + panel shell, router, store, animation manager

**Files:**
- Create: `css/{base,primitives,components}.css` (complete per Appendix F §5), `css/views/{login,states,live,settings,engine}.css`, `scripts/check-css.ts`, `src/panel/{index,router,view,store,actions,animation-manager,copy,icons-mount,sounds,theme}.ts`, `src/panel/components/{button,toggle,slider,keybind,eval-bar,move-card,pv-list,clock,countdown-ring,toast,pill,popover,banner,segment,chip,input,empty-state}.ts`
- Test: `test/scripts/check-css.test.ts`, `test/panel/{router,store,animation-manager}.test.ts`, `test/panel/components/*.test.ts`

**Interfaces:**
- Consumes: `TOKENS`, `ICONS`, `PanelSnapshot`, `connectPort(PORT_NAMES.panel)`, `sendTyped`.
- Produces: `PanelStore` (holds the latest `PanelSnapshot`, `subscribe(cb)`, `dispatch(command)`); `PanelRouter.resolve(snapshot) → ViewName` (`login` if license not valid; `expired` if `invalid|expired|ip_limit`; `update` if flag and no live game; `unsupported` if `site === null`; `waiting` if no live game; `live`; `settings`/`engine` when selected by the view switch); `View { mount(ctx) → cleanup }`; `ANIM` (durations/easings imported from `TOKENS.motion` — no literals); component factories `createToggle(el, opts)`, `createSlider(el, opts)`, `createKeybindCapture(el, opts)`, `createEvalBar(el)`, `createMoveCard(el)`, `createPvList(el)`, `createCountdownRing(el)`, `showToast(kind, text, action?)`, `openPopover(anchor, content)`, `showBanner(kind, text, actions)`.

- [ ] **Step 1: `check-css.ts` failing tests** — flags `padding: 13px`, `color: #fff`, `transition: all 200ms`; accepts `padding: var(--sl-space-3)`, `border: var(--sl-hairline) solid var(--sl-color-border-default)`, `transition: opacity var(--sl-motion-duration-2-5) var(--sl-motion-easing-standard)`.
- [ ] **Step 2: Write the CSS layers** — every block/element/modifier and state listed in Appendix F §5.1–§5.17 with the exact sizes (control heights 28/36/44, toggle 36×20 with 16 px thumb, slider 4 px track, eval rail 8 px, PV row 28 px, pill 24 px, toast/popover/banner geometry) expressed through tokens; reduced-motion and forced-colours blocks per §8.4; breakpoint rules per §8.1 via container queries on `.sl-app` (320/360/420/480).
- [ ] **Step 3: Shell + router + store failing tests** — router picks the right view for each snapshot combination (table-driven, all 8 views); store replays the last snapshot to late subscribers; port reconnects after a simulated SW restart and re-requests `PANEL_GET_SNAPSHOT`; view switch keyboard `Alt+1/2/3`.
- [ ] **Step 4: Component tests (happy-dom)** — toggle: click toggles, `role="switch"`, armed variant requires `holdMs` (hold 600 ms arms, release at 400 ms does not); slider: arrow keys step, Shift ×10, value bubble text from the human-label function; keybind capture: capture/Esc/Backspace/conflict/global-modifier validation per §6.4; eval bar: `aria-valuetext` "White +1.34, 71% win, 22% draw, 7% loss", fill from win-probability; countdown ring: `stroke-dashoffset` proportional to remaining time, reduced-motion → text; toast: single visible, replace, durations 2.4 s/6 s; popover: focus trap, Esc closes.
- [ ] **Step 5: Implement**; `animation-manager.ts` exports `ANIM = { duration: TOKENS.motion.durationMs, easing: TOKENS.motion.easing, fade(el, dir), slide(el, dir, px), spring(el) }`; `theme.ts` resolves `system` and sets `data-theme`; `sounds.ts` maps events → `SOUNDS` per Appendix F §6.6 gated by `display.uiSounds`; `icons-mount.ts` resolves `data-icon`.
- [ ] **Step 6: Commit** — `feat(panel): sl-ui component layer, shell, router, store, animation manager`

### Task 23: Login, expired, unsupported, waiting, update views

**Files:**
- Create: `src/panel/views/{login,expired,unsupported,waiting,update}.ts` + `templates/{login,expired,unsupported,waiting,update}.html`
- Test: `test/panel/views/{login,expired,unsupported,waiting,update}.test.ts`

- [ ] **Step 1: Failing tests** — **V2:** the waiting view shows the detected opponent and the derived target Elo (`opponent.derivedTargetElo`) and hosts the hold-to-arm control; arming triggers debugger attach immediately (before the game) and shows the infobar explanation; login: with `LICENSE_FORCE_VALID` any key (including empty) unlocks and the Engine view shows the raw verdict; key auto-formats `SL-XXXX-XXXX-XXXX`, paste of a full key submits after `ANIM.duration[6]`, each `LicenseState` maps to the inline hint copy in Appendix F §7.2, Enter submits, button width locked while loading; expired: revoked vs expired copy; unsupported: non-game-page variant copy when `pageKind !== "game"`; waiting: pre-armed auto-play shows "Armed for next game" and the toggle is locked until a game starts; update: "Later" leaves an info banner and never re-interrupts; interrupt is deferred while a game is live.
- [ ] **Step 2: Implement** per Appendix F §4.1–§4.3, §4.8–§4.9 (+ the hidden cat-facts popover of §4.10 — seven clicks on the mark within 3 s).
- [ ] **Step 3: Commit** — `feat(panel): login, expired, unsupported, waiting and update views`

### Task 24: Live game view

**Files:**
- Create: `src/panel/views/live.ts`, `templates/live.html`, `src/panel/views/live/{eval-section,move-section,lines-section,strength-card,toggles-row,session-strip,collapse}.ts`
- Test: `test/panel/views/live.test.ts`, `test/panel/views/live-collapse.test.ts`

- [ ] **Step 1: Failing tests** — **V2 hands-off mode (§13.4):** when `session.state === "live"`, every interactive control is `aria-disabled` with `pointer-events: none`, the hands-off banner is shown with the three keybinds, the Play button renders as a keybind hint only, the view switch is disabled, and no element receives focus on mount (`document.activeElement === document.body`); the `Telemetry` pill reflects `snapshot.focus` (`clean`, `blur seen`, `mouse touched`); renders opponent/your rows mirrored by `myColor`; active clock styling and `< 20 s` danger; eval numeral sign and mate format (`M5`, `−M3`); move card states (`your-move`, `opponent-to-move` with expected reply, `thinking`, `armed`, `disabled`); play button label transitions (`Play move` → `Auto-playing in 4.2s` → hover `Cancel this move` → `Playing…`); PV rows: count from settings, stripe colours by index, hover sends `PANEL_PREVIEW_LINE`, click pins; strength card popover applies `setSettings` and shows "Applies from next move"; toggles: auto-play hold-to-arm (600 ms) and single-click disarm, keybind pre-arm toast with 1 s cancel; session strip + executor pill; detached banner with Reattach; toast on `executed`; collapse order at heights 720 → 640 → 560 → 480 exactly per Appendix F §8.2 (six discrete states); compact breakpoint at 320 per §4.5.
- [ ] **Step 2: Implement** per Appendix F §4.4–§4.5, §5.5–§5.10, §6.1–§6.3; the view is a pure projection of `PanelSnapshot` + local UI state (hover/pin/hold progress); every timer/RAF is cleaned up on unmount.
- [ ] **Step 3: Commit** — `feat(panel): live game view with eval rail, move card, lines, strength, auto-play arming`

### Task 25: Settings view

**Files:**
- Create: `src/panel/views/settings.ts`, `templates/settings.html`, `src/panel/views/settings/{sections,rows}.ts`
- Test: `test/panel/views/settings.test.ts`

- [ ] **Step 1: Failing tests** — every setting in `Settings` (Part I §4.4) has a row (V2.1 additions: Match opponent rating + persona offset, Preview selections (auto/off + scale), Highlight moves default off with the telemetry note); the whole view is disabled in hands-off mode; changing a row writes through `setSettings` with the clamped value; jump chips scroll-spy; strength slider human labels (Casual/Club/Expert/Master/Elite by band) and the `≥ 2600` plausibility warning; timing preset chips pre-select the detected time control; keybind rows use the capture component and swap on conflict; TTS voice select populated from `chrome.tts.getVoices()` and disabled when TTS is off; license reveal re-masks after 10 s; "Reset all settings" confirm; footer shows `__SL_VERSION__` and build.
- [ ] **Step 2: Implement** per Appendix F §4.6 and §7.2; sections: Strength, Timing, Execution (incl. "Calibrate from my mouse" toggle from Task 19 and the debugger explanation), Keybinds, Display, Account, Advanced (threads/hash/depth cap/log level/export timing log/reset).
- [ ] **Step 3: Commit** — `feat(panel): settings view`

### Task 26: Engine & diagnostics view + log stream

**Files:**
- Create: `src/panel/views/engine.ts`, `templates/engine.html`, `src/panel/logging-bridge.ts`, `src/service/log-bridge.ts`, `src/service/handlers/log/*.ts`
- Test: `test/panel/views/engine.test.ts`, `test/service/log-bridge.test.ts`

- [ ] **Step 1: Failing tests** — engine rows (version, NNUE names, threads/hash, nps numeral, depth), 60 s nps sparkline from snapshots; executor rows (attached/target/input mode/last action with timeline durations), Detach/Reattach buttons; timing rationale log renders `TimingLogEntry` as the `plan/exec/verify/warn` rows in `mono-xs`; Copy/Export/Clear; session reset; log bridge streams SW logs to the panel over `PORT_NAMES.logStream` with level control.
- [ ] **Step 2: Implement** per Appendix F §4.7; the log bridge follows tranquill's `log-bridge` + `logging-bridge` pattern (Appendix H).
- [ ] **Step 3: Commit** — `feat(panel): engine and diagnostics view with rationale log`

### Task 27: Accessibility, reduced motion, keyboard, theme, fonts

**Files:**
- Create: `assets/fonts/{Geist,GeistMono,BricolageGrotesque}-*.woff2` (subset Latin + `× → ½ −`), `css/base.css` `@font-face` block, `src/panel/a11y.ts` (SAN → speech, `aria-live` regions), `docs/qa-checklist.md`
- Test: `test/panel/a11y.test.ts`

- [ ] **Step 1: Failing tests** — `sanToSpeech("Nf3") === "knight f3"`, `"O-O"` → "castles kingside", `"exd5+"` → "e takes d5 check"; every interactive element has an accessible name; tab order per Appendix F §8.3; `Esc` priority (countdown → popover → capture).
- [ ] **Step 2: Implement**; verify fonts total ≤ 260 KB; `prefers-reduced-motion`, `forced-colors`, `prefers-contrast` blocks per §8.4.
- [ ] **Step 3: Commit** — `feat(panel): accessibility, fonts, theme and motion preferences`

### Task 28: Panel ↔ service worker integration

**Files:**
- Create: `src/service/handlers/panel/*.ts` (`getSnapshot`, `playNow`, `setAutoMove`, `cancelPending`, `setEnabled`, `previewLine`, `login`, `logout`, `recheckLicense`, `engineRestart`, `exportTimingLog`), `src/service/panel-broadcaster.ts` (builds `PanelSnapshot` from `GameSessionRegistry`, engine status, executor state, settings, license; throttled to `TIMINGS.panelSnapshotMinIntervalMs`; per-window port fan-out)
- Test: `test/behavioral/panel/{snapshot-flow,arm-and-play}.test.ts`

- [ ] **Step 1: Failing behavioural tests** — panel connects → receives a snapshot within one tick; position update → recommendation → snapshot with `recommendation`; `setAutoMove(true)` → executor schedules at `plan.deadlineMs` → snapshot `autoMove.scheduledAt`; `playNow` → executor `playNow` → `executed` → toast message on the port; `cancelPending` → aborted; login with a valid key → `LicenseState.valid` → router switches to `waiting`.
- [ ] **Step 2: Implement**; commit — `feat(service): panel handlers and snapshot broadcaster`

### Task 29: UI visual QA pass

- [ ] **Step 1:** Build, load unpacked, open the panel at 320/360/420/480 widths and 720/600/480 heights; compare each view against Appendix F wireframes; fix deviations (CSS only).
- [ ] **Step 2:** Run the `web-design-guidelines` review skill against `pages/panel.html` + `css/`; address findings.
- [ ] **Step 3:** Record screenshots into `docs/qa/2026-09-panel/` and commit — `chore(panel): visual QA pass`


## Phase 7 — Integration, packaging, hardening

### Task 30: GameSession orchestrator end-to-end + auto-queue + TTS + commands

**Files:**
- Create: `src/service/game-session/{session,transitions,registry,recommendation,ponder}.ts`, `src/service/handlers/content/*.ts` (`hello`, `keybind`, `cursor`, port `sl-game` acceptance), `src/service/auto-queue.ts`
- Test: `test/service/game-session/transitions.test.ts` (every edge of Part I §3.3), `test/behavioral/game/{full-move-cycle,premove,opponent-moves-during-plan,game-over-autoqueue,keybinds,commands}.test.ts`

**Interfaces:**
- Consumes: everything from Phases 2–6.
- Produces: `GameSessionRegistry.forTab(tabId)`, `GameSession.onPosition(snapshot)`, `.onGameStarted/Ended`, `.command(cmd)`, `.view() → GameSessionView` for the panel snapshot; `RecommendationPipeline.run(snapshot, ctx) → Recommendation` (book → analyse → select → time); `PonderController`.

- [ ] **Step 1: Transition-table tests** — enumerate `(state, event) → next` for all listed states/events; unknown pairs are no-ops with a logged warning.
- [ ] **Step 2: Behavioural tests** — **V2 (§13):** (0) arming attaches the debugger in `waiting-for-game`; during `live` the SW never calls `chrome.tabs.update`, `chrome.tabs.create`, `chrome.windows.update`, `chrome.notifications.*` or `Page.bringToFront` (fakes assert); a `focus` edge with `hasFocus:false` during `my-turn:recommended` cancels the scheduled execution and the panel snapshot shows `focus.blurSeenThisMove`; a real pointer event while the hand is active changes nothing except the diagnostics counter (V2.1); (a) full cycle: content `hello` + `gameStarted` + `position` (my turn) → engine request (fake offscreen answering with scripted UCI lines) → recommendation → panel snapshot → auto-move armed → scheduled → executor runs at `deadlineMs` (time controller) → `moveObserved` → session back to `opponent-turn` → ponder started; (b) opponent moves while our plan is pending → plan cancelled, new analysis; (c) premove path: `premove` candidate emitted to content, opponent plays the expected reply → executes within 120 ms; (d) game over → `gameEnded` → auto-queue sends `startNewGame` after a delay in `TIMINGS.autoQueueDelayRangeMs` when enabled; (e) keybind `playMove` from content → `playNow`; `disable` → session `idle`, highlights cleared, executor cancelled; `speakMove` → `chrome.tts.speak("knight f3")`; (f) `chrome.commands` `play-best-move` routes to the active tab's session.
- [ ] **Step 3: Implement** the session per Part I §3.2–§3.3 with the engine budget policy of §7.5; `recommendation.ts` composes `bookPolicy → engine.analyse → selectMove → timingModel.planMove`; the timing log entry is written per plan; `Keepalive.hold("game")` while live.
- [ ] **Step 4: Commit** — `feat(service): game session orchestration, ponder, auto-queue, tts, commands`

### Task 31: Packaging, verify-dist, update check, legacy removal, docs

**Files:**
- Create: `scripts/{stamp-manifest,package,verify-dist}.ts` (full), `src/service/update-check.ts`, `docs/{ARCHITECTURE.md,DEVELOPMENT.md,qa-checklist.md}`, `CLAUDE.md`
- Delete: `legacy/`
- Test: `test/scripts/verify-dist.test.ts`, `test/service/update-check.test.ts`

- [ ] **Step 1: `verify-dist`** — every manifest path exists; HTML references resolve; bundle size report (fail if `panel.js` > 400 KB or `content.js` > 250 KB); no `console.` in production bundles; no `phantom.ac` literal outside the license module chunk (grep against the built SW with the URL define resolved).
- [ ] **Step 2: Update check** — fetch `${URLS.website}/manifest.json` on the license alarm; compare `version` with `__SL_VERSION__`; set `LOCAL_KEYS.updateAvailable`; the panel shows the Update view/banner per Appendix F §4.8.
- [ ] **Step 3: Docs** — `CLAUDE.md` in the tranquill style (architecture, commands, conventions C1–C7, gotchas: COEP fetches, offscreen has no `chrome.storage`, ports do not keep the SW alive but messages do, debugger infobar, the ChessMimic licence notice); `docs/ARCHITECTURE.md` (this plan's Part I condensed); `docs/qa-checklist.md` (real-site manual QA: chess.com blitz game with promotion + premove; lichess bullet with flagging; debugger cancel/reattach; panel widths; license paths).
- [ ] **Step 4: Remove `legacy/`** after a final diff review; move `id-generator.js` to `tools/`.
- [ ] **Step 5: `bun run build` → `release/sliced-2.0.0.zip`; load unpacked from `dist/`; run the QA checklist on both sites; commit** — `chore(release): packaging, update check, docs, legacy removal`

### Task 32 (v2.1, optional but designed now): Native input backend scaffold

**Files:**
- Create: `src/core/motor/native-input-backend.ts` (implements `InputBackend` over `chrome.runtime.connectNative("sh.sliced.hand")`), `src/content/screen-geometry.ts` (reports `window.screenX/Y`, `outerHeight − innerHeight`, `devicePixelRatio`, visual viewport offsets), `native/sliced-hand/` (macOS reference host in Swift: reads newline-delimited JSON `{op:"move"|"press"|"release", x, y, tMs}` on stdin, schedules with `DispatchSourceTimer`, posts `CGEvent`s), `native/README.md` (install of the host manifest under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`), `manifest.json` `optional_permissions: ["nativeMessaging"]`
- Test: `test/core/motor/native-input-backend.test.ts` (message framing, coordinate mapping viewport → screen, backpressure)

- [ ] **Step 1:** Define the wire schema and the CSS-px → screen-px mapping (`screenX + (x + viewportOffsetX) · dpr`, `screenY + chromeHeight + (y + viewportOffsetY) · dpr`) with tests.
- [ ] **Step 2:** Implement the backend; the `HandController` selects it when `Settings.execution.backend === "native"` and the host responds to a `hello`.
- [ ] **Step 3:** Build the macOS host; document Windows (`SendInput`) and Linux (`uinput`) follow-ups.
- [ ] **Step 4:** Commit — `feat(motor): native input backend scaffold (macOS host)`

---

## Execution order and parallelism

```
Phase 0–1 (Tasks 0–9)   sequential foundation; Task 8 (simulator) and Task 7 (design tokens) can run in parallel after Task 4
Phase 2 (10–13)         after Task 4; 11 is pure and can start after Task 2
Phase 3 (14–16)         after Task 5; all three independent of Phase 2 (fake engine lines in tests)
Phase 4 (17–19)         after Task 8; 17 pure; 18 needs 8; 19 needs 17
Phase 5 (20–21)         after Task 6 (pagescript) and Task 8
Phase 6 (22–29)         after Task 7; 24–26 need 28's message contracts (defined in Task 2, so views can be built against fakes)
Phase 7 (30–32)         after everything
Phase 8 (33–34)         telemetry conformance starts right after Task 18 and gates Tasks 19–31; Task 34 (ChessMimic export + onnxruntime-web integration) runs in parallel once Tasks 12 and 16 land and must finish before Task 31 packages the release; Task 19 is optional
```

Recommended swarm allocation: one agent per phase-lane (foundation → engine, strength/timing, motor, adapters, UI) after Task 9 lands; integration (Task 30) by the lead once all lanes report green.


## Phase 8 — Telemetry conformance (added in the V2 guide; runs alongside Phases 4–7)

### Task 33: Focus-discipline verification and the telemetry conformance harness

**Files:**
- Create: `test/fixtures/focus-probe.html` (a page that logs `window` `blur`/`focus`, `document.hasFocus()`, `visibilitychange` with timestamps into a `<pre>`), `docs/qa/focus-discipline.md` (procedure + recorded results), `src/service/focus-gate.ts` (if not already created in Task 18), `tools/telemetry-conformance/{README.md,ac-model.ts,conformance.test.ts,report.py}`, `test/behavioral/telemetry/{no-blur-no-toggle,single-piece-select,pointer-continuity,timing-shape}.test.ts`

**Interfaces:**
- Consumes: simulator (Task 8) with a **telemetry shadow** (`test/sim/telemetry/ac-shadow.ts`): a fake of the chess.com `fps` plugin that, from the simulated page's `focus`/`blur`/`visibilitychange` events, pointer events and move submissions, computes the per-move `ac` blob `{ BlurCount, DidBlurOnOpponentTurn, DidBlurOnOwnTurn, DidFocusOnOpponentTurn, DidFocusOnOwnTurn, DidSelectMultiplePieces, DidToggle, EventTrusted, LastFocusToMoveTime, MoveHoldTime, MoveToFirstBlurTime, PointerOffset, TotalBlurTime, TotalFocusTime }` exactly as documented in Appendix I; plus a lichess blur-bit shadow.
- Produces: `assertHumanShapedAc(acs: AcBlob[])` used by every behavioural executor test from now on; the conformance report for a batch of simulated games.

- [ ] **Step 1: Empirical focus check (manual, recorded)** — load the unpacked build, open `test/fixtures/focus-probe.html` in a tab, open the side panel, then: click a panel button; type in a panel input; press a `chrome.commands` shortcut while the page is focused; trigger a CDP click via the executor's debug action; attach/detach the debugger. Record which actions produced `blur`/`focus` on the page. Expected (design assumption): panel click/typing → `blur`; commands → no blur; CDP click with page already focused → no focus/blur events; debugger attach → no blur (layout shift only). Write the results into `docs/qa/focus-discipline.md`. If the panel does **not** blur the page, hands-off mode may be relaxed to "no typing" — record the decision.
- [ ] **Step 2: Failing behavioural tests against the `ac` shadow** — (a) a full simulated bot game of 30 moves with auto-play armed: every `ac` has `BlurCount 0`, `DidToggle false`, `EventTrusted true`, and across the game `DidSelectMultiplePieces` is `true` for 4–12 % of non-trivial moves (never 0 %, never > 25 %) with each such move's selection sequence resolvable (V2.1 §9.3a), `LastFocusToMoveTime`/`MoveToFirstBlurTime` unset; (b) inject a simulated panel click (focus leaves the page) during the think window → the executor does not play this move, panel shows the focus warning, the next move proceeds after a fresh position; (c) inject a real pointer event → execution is unaffected and `focus.realPointerEventsDuringHand` increments (V2.1); (d) exploration produces `pointermove` only before the committed press except for modelled preview selections, each of which is a resolved select/deselect or select/switch; (e) `PointerOffset` between consecutive moves equals the hand's own path length (no jump > the path's max step); (f) timing shape: over 200 simulated moves, `MoveHoldTime` has CV ≥ 0.5, no value < 250 ms except premove/instant modes, correlation with `n_reasonable` ≥ 0.2, compression under time pressure.
- [ ] **Step 3: Implement the `ac` shadow and `FocusGate`** per Part I §13.2–§13.5; wire the shadow into `test/sim`.
- [ ] **Step 4: Offline conformance report** — `tools/telemetry-conformance/report.py` reads exported timing/execution logs (Engine view export) from N real bot games and prints the per-move `ac`-equivalent summary (all-zero blur, single-select, hold-time distribution stats, top-1 %/ACPL vs band). Acceptance: zero blur/toggle across all logged games; multi-select rate inside the 4–12 % band; orientation latency present after every opponent move; timing metrics inside §13.6 and §8.4b bands.
- [ ] **Step 5: Lint additions** — `scripts/check-constants.ts` gains the forbidden-API scan for `src/content/**` and `src/page/**` (`localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `dispatchEvent`, `new PointerEvent`, `new MouseEvent`, `chrome.tabs.update`, `chrome.tabs.create`, `chrome.notifications`, `window.open`) and the forbidden-substring scan for emitted page programs (`sliced`, `engine`, `stockfish`, `eval`, `bestmove`, `fen`, `analysis`).
- [ ] **Step 6: Commit** — `test(telemetry): ac-blob shadow, focus-discipline verification, conformance harness and lints`

### Task 34: Timing head — export and integrate ChessMimic

**Files:**
- Create: `tools/data/08_export_chessmimic.py` (ONNX export + scaler/bucket JSON + 1 000-position reference fixture), `assets/models/chessmimic/{1200_1300,1500_1600,1800_1900}.onnx`, `assets/models/chessmimic/{scalers,buckets,vocab}.json`, `assets/vendor/onnxruntime/{ort.wasm.min.js,ort-wasm-simd-threaded.wasm,LICENSE}`, `src/offscreen/timing-inference.ts` (full), `test/fixtures/chessmimic-reference.json`, `docs/models.md` (provenance, commit hash of `thomasj02/1e4_ai`, band hashes, latency measurements), `docs/third-party.md` (PolyForm Noncommercial 1.0.0 notice alongside the Stockfish AGPL notice)
- Modify: `tools/data/*.py` (Task 16) — run end to end

**Interfaces:**
- Consumes: `ChessMimicHead` scaffolding (Task 16), `NnueStore`-style OPFS download (Task 12), the conformance harness (Task 33). No recorded data of our own.
- Produces: the shipped ChessMimic bands, the onnxruntime-web runtime, `timing-inference.ts`, `docs/models.md`.

- [ ] **Step 0: Attribution.** Add the PolyForm Noncommercial 1.0.0 notice for ChessMimic to `docs/third-party.md` and to the panel's About section next to the Stockfish notice. Nothing else — there is no commercial flag or check anywhere.
- [ ] **Step 1: Export.** `08_export_chessmimic.py`: clone `thomasj02/1e4_ai` at a pinned commit; for each shipped band load `backend/models/clock_model/<band>_brier/model.ckpt`, keep `state_dict` only, `torch.onnx.export` at opset 14 with fp16 weights (dynamic batch 1, fixed 92-token sequence), unpickle `scalers.pkl` → `scalers.json`, copy `clock_buckets.json` → `buckets.json` (edges + empirical prior + per-bucket within-bucket empirical samples), dump the UCI vocabulary and FEN tokeniser tables → `vocab.json`, and write `test/fixtures/chessmimic-reference.json` with 1 000 positions × (inputs, Python bucket probabilities).
- [ ] **Step 2: Runtime.** Vendor onnxruntime-web (pinned version) under `assets/vendor/onnxruntime/`; implement `timing-inference.ts` (session per band, warm-up on load, `{kind:"timing", inputs}` → `{kind:"timing-result", probs}` over the engine port); the TypeScript tokeniser test reproduces the fixture inputs bit-for-bit and the ONNX outputs match the Python probabilities within 1e-3 (fp16 tolerance).
- [ ] **Step 3: Latency and size.** Measure p50/p95 per query on the reference machine in the offscreen document; target p95 ≤ 100 ms with fp16, else export int8; record in `docs/models.md`. Bands beyond the three shipped ones download on demand into OPFS with SHA-256 verification.
- [ ] **Step 4: Conformance.** Run 200 simulated games through the Task 33 harness with the ChessMimic head; all bands pass (blur/toggle zero, preview-select band, pointer continuity, `MoveHoldTime` shape with CV ≥ 0.5, correlation with `n_reasonable`, orientation latency).
- [ ] **Step 5: Commit** — `feat(models): ship ChessMimic timing head with onnxruntime-web inference`


---

# APPENDICES — research digests (verified 2026-09-03)

Each appendix is the full report of a research agent that ran with web access on 2026-09-03. They are reproduced verbatim so executors can consult sources without leaving this file. Where an appendix and Part I disagree, Part I wins (it records the decisions).

# Appendix A — Stockfish distribution, NNUE storage, UCI grammar


All version numbers, option bounds and file sizes below were checked live today against GitHub (`gh api`), the npm registry (`npm view`), raw Stockfish sources at tags `sf_16`…`sf_18` and `master`, `tests.stockfishchess.org` (HTTP HEAD for net sizes), and developer.chrome.com / MDN.

---

## 1. Latest Stockfish and release history

Source: `gh api repos/official-stockfish/Stockfish/releases` (https://github.com/official-stockfish/Stockfish/releases). Net names from `src/evaluate.h` at each tag; sizes are `Content-Length` from `https://tests.stockfishchess.org/api/nn/<name>.nnue`.

**Latest stable release: Stockfish 18 (tag `sf_18`, 2026-01-31).** Master also publishes nightly "dev" pre-releases (today: `stockfish-dev-20260903-06675f70`).

| Release | Date | Arch | `EvalFile` (big) | `EvalFileSmall` |
|---|---|---|---|---|
| 16 | 2023-06-30 | SFNNv6, single net | `nn-5af11540bbfe.nnue` 34,109,728 B | — (no small net) |
| 16.1 | 2024-02-24 | SFNNv7/v8 dual net introduced | `nn-b1a57edbea57.nnue` 55,332,290 B | `nn-baff1ede1f90.nnue` 2,795,688 B |
| 17 | 2024-09-06 | dual net | `nn-1111cefa1111.nnue` 61,698,876 B | `nn-37f18f62d772.nnue` 2,876,624 B |
| 17.1 | 2025-03-30 | dual net | `nn-1c0000000000.nnue` 61,698,882 B | `nn-37f18f62d772.nnue` 2,876,624 B |
| **18** | **2026-01-31** | **SFNNv10 ("Threat Inputs"), dual net** | `nn-c288c895ea92.nnue` 72,754,437 B | `nn-37f18f62d772.nnue` 2,876,624 B |
| master (dev, post-18) | 2026-09 | single net again | `nn-1a298aa575a0.nnue` 78,944,870 B (`#define EvalFileDefaultName`, no `EvalFileSmall`) | — |

Notes:
- SF18 release notes: "This release introduces the SFNNv10 network architecture. The network's input layer has been augmented with 'Threat Inputs' features…" (https://github.com/official-stockfish/Stockfish/releases/tag/sf_18).
- The dual-net scheme (big net for normal positions, small net when `|eval|` is large) exists in 16.1, 17, 17.1, 18. Current master has **dropped the small net** (`master/src/evaluate.h` line 36 has only `EvalFileDefaultName "nn-1a298aa575a0.nnue"`; `master/src/engine.cpp` declares only `EvalFile`). So a future SF19 will most likely be single-net.
- Lichess additionally ships community "smallnet" variants of SF18/dev (see §3), which are *not* official releases.

---

## 2. `UCI_Elo`, `UCI_LimitStrength`, `Skill Level` in SF18

### Option declarations (`sf_18/src/engine.cpp`, `sf_18/src/search.h`)

```cpp
options.add("Skill Level", Option(20, 0, 20));
options.add("UCI_LimitStrength", Option(false));
options.add("UCI_Elo", Option(Stockfish::Search::Skill::LowestElo,
                              Stockfish::Search::Skill::LowestElo,
                              Stockfish::Search::Skill::HighestElo));
options.add("MultiPV", Option(1, 1, MAX_MOVES));        // MAX_MOVES = 256
options.add("UCI_ShowWDL", Option(false));
options.add("Threads", Option(1, 1, MaxThreads, ...));
options.add("Hash", Option(16, 1, MaxHashMB, ...));
options.add("EvalFile", Option(EvalFileDefaultNameBig, ...));
options.add("EvalFileSmall", Option(EvalFileDefaultNameSmall, ...));
```
```cpp
// search.h
constexpr static int LowestElo  = 1320;
constexpr static int HighestElo = 3190;
```
So **`UCI_Elo` is `spin default 1320 min 1320 max 3190`** in SF18 (unchanged since SF16; identical on master today). Wiki text (https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html): "UCI_Elo … Aims for an engine strength of the given Elo. This Elo rating has been calibrated at a time control of 120s+1s and anchored to CCRL 40/4." `UCI_LimitStrength`: "Enable weaker play aiming for an Elo rating as set by UCI_Elo."

Precedence (FAQ, https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html): "`UCI_Elo` only applies when `UCI_LimitStrength` is enabled (`true`). `UCI_Elo` takes precedence over `Skill Level` if both are set. If `UCI_Elo` is set, the engine converts the given value internally into a `Skill Level`."

### Elo → skill level (`sf_18/src/search.h`)

```cpp
// Skill structure is used to implement strength limit. If we have a UCI_Elo,
// we convert it to an appropriate skill level, anchored to the Stash engine.
// This method is based on a fit of the Elo results for games played between
// Stockfish at various skill levels and various versions of the Stash engine.
// Skill 0 .. 19 now covers CCRL Blitz Elo from 1320 to 3190, approximately
struct Skill {
    constexpr static int LowestElo  = 1320;
    constexpr static int HighestElo = 3190;
    Skill(int skill_level, int uci_elo) {
        if (uci_elo) {
            double e = double(uci_elo - LowestElo) / (HighestElo - LowestElo);
            level = std::clamp((((37.2473 * e - 40.8525) * e + 22.2943) * e - 0.311438), 0.0, 19.0);
        } else
            level = double(skill_level);
    }
    bool enabled() const { return level < 20.0; }
    bool time_to_pick(Depth depth) const { return depth == 1 + int(level); }
    Move pick_best(const RootMoves&, size_t multiPV);
    double level;
    Move   best = Move::none();
};
```
Constructed in `search.cpp` as `Skill(options["Skill Level"], options["UCI_LimitStrength"] ? int(options["UCI_Elo"]) : 0)`. Note `level` is a **double** when derived from Elo (fractional levels are fine), but `time_to_pick` uses `int(level)`; with `UCI_Elo=1320`, `level ≈ -0.31 → clamped 0.0`; `UCI_Elo=3190 → 19.0` (never 20, so limited strength is always "enabled").

Sample mapping (cubic above): 1320→0.0, 1500→1.7, 1700→3.4, 2000→6.0, 2300→8.9, 2600→12.4, 2900→16.3, 3190→19.0.

### How limited strength picks a move (`sf_18/src/search.cpp`)

1. Force at least 4 PVs:
   ```cpp
   // When playing with strength handicap enable MultiPV search that we will
   // use behind-the-scenes to retrieve a set of possible moves.
   if (skill.enabled())
       multiPV = std::max(multiPV, size_t(4));
   ```
2. At iterative-deepening depth `1 + int(level)` the sub-optimal move is chosen and frozen:
   ```cpp
   // If the skill level is enabled and time is up, pick a sub-optimal best move
   if (skill.enabled() && skill.time_to_pick(rootDepth))
       skill.pick_best(rootMoves, multiPV);
   ```
   (the search then continues to the normal time/depth limit, but the chosen move is retained)
3. At the end, the chosen move is swapped into `rootMoves[0]`:
   ```cpp
   if (skill.enabled())
       std::swap(rootMoves[0], *std::find(rootMoves.begin(), rootMoves.end(),
                 skill.best ? skill.best : skill.pick_best(rootMoves, multiPV)));
   ```
4. The weighted-random pick:
   ```cpp
   Move Skill::pick_best(const RootMoves& rootMoves, size_t multiPV) {
       static PRNG rng(now());  // PRNG sequence should be non-deterministic
       // RootMoves are already sorted by score in descending order
       Value  topScore = rootMoves[0].score;
       int    delta    = std::min(topScore - rootMoves[multiPV - 1].score, int(PawnValue));
       int    maxScore = -VALUE_INFINITE;
       double weakness = 120 - 2 * level;
       // Choose best move. For each move score we add two terms, both dependent on
       // weakness. One is deterministic and bigger for weaker levels, and one is random.
       for (size_t i = 0; i < multiPV; ++i) {
           int push = int(weakness * int(topScore - rootMoves[i].score)
                          + delta * (rng.rand<unsigned>() % int(weakness))) / 128;
           if (rootMoves[i].score + push >= maxScore) {
               maxScore = rootMoves[i].score + push;
               best     = rootMoves[i].pv[0];
           }
       }
       return best;
   }
   ```
   Interpretation: `weakness` runs 120 (level 0) → 82 (level 19). `delta` caps the "spread" at one pawn. Each of the top-4 (or MultiPV) moves gets a deterministic bonus proportional to how much worse it is (yes, worse moves get *more* push) plus a random bonus in `[0, delta*weakness/128)`. At level 0 a move up to ~94% of a pawn worse can beat the best move; the candidate set is only the top `MultiPV` moves, so the engine never plays a move outside its top-4 PVs unless you raise `MultiPV`.
5. Also: with skill enabled the best-thread selection is skipped (`!skill.enabled()` in the `get_best_thread()` condition) and `bestmove` comes from the main thread.

### Known weaknesses of this scheme (why you still need your own humanization)

- Structural: candidates are the engine's top 4 PVs at the shallow depth `1+level`; the error model is "one pawn or less, uniformly random-ish", so it never plays the *human* kind of blunder (hanging a piece, missing a mate-in-1, one-move tactics), and it plays forced/obvious moves and tactics perfectly (only one move in the top-4 window). The pick happens at depth 1–2 for low levels, so move choice depends on a very shallow eval, yet the final `bestmove` is still emitted at the full search's time — the "instant obvious move" cadence is a property of your own move-timing, not the engine.
- The Elo calibration is at 120s+1s vs the Stash engine / CCRL; at fixed shallow `go depth` or `movetime` the effective strength differs (users note "Level 1 behaves differently in bullet versus classical").
- Lichess forum threads document the perceived unnaturalness: moves that "don't really make any sense", "like the computer is giving you a free chance on purpose, and should you miss that, it'll push you to a corner", "No one would play 2...Qd6 instead of 2...Qxd5" (https://lichess.org/forum/general-chess-discussion/what-the-hell-is-wrong-with-lichess-stockfish-level-1, https://lichess.org/forum/lichess-feedback/stockfish-too-strong-for-beginners).
- Floor is 1320: lichess itself gets below that with Fairy-Stockfish, whose `Skill Level` allows negatives; fishnet maps its levels 1–8 to `Skill Level` -9,-5,-1,3,7,11,16,20 with `go depth` 5,5,5,5,5,8,13,22 and movetime 50–1000 ms (https://github.com/lichess-org/fishnet/blob/master/src/api.rs). Official Stockfish's `Skill Level` min is 0, so your sub-1320 range must be done by you (e.g. `MultiPV` 6–10 + your own score-weighted sampling over the returned PVs, occasional depth-1 picks, etc.).
- The academic reference for human-like move prediction is Maia (McIlroy-Young et al., KDD 2020, https://arxiv.org/abs/2006.01855): "Existing chess engines, including an open-source implementation of AlphaZero, were found not to predict human moves well."

Practical recipe for our client: set `UCI_LimitStrength true`, `UCI_Elo N` for N in [1320,3190], **and** raise `MultiPV` (e.g. 5–8) so the `info multipv k score cp …` lines give us the candidate set + scores; do our own selection/timing on top (the engine's `bestmove` is then just one input). Both `Skill Level` and `UCI_Elo` are present in every wasm build examined (strings `UCI_Elo`, `UCI_LimitStrength`, `Skill Level` confirmed in `sf_18_smallnet.wasm`).

---

## 3. WebAssembly builds of modern Stockfish

| Build | SF version | npm / version | Threads / SAB | NNUE delivery | JS size / wasm size | License | Last update |
|---|---|---|---|---|---|---|---|
| **`@lichess-org/stockfish-web`** (https://github.com/lichess-org/stockfish-web) | `sf_18` (tag `sf_18`, base cb3d4ee9) and `sf_dev` (2026-09-01), plus `sf_18_smallnet`, `sf_dev_smallnet`, `fsf_14` | `@lichess-org/stockfish-web` **0.4.4** (2026-09-02) | pthreads **always** (built with `-pthread -sPROXY_TO_PTHREAD`; UCI loop runs in a pthread and blocks on a `std::condition_variable` → requires `SharedArrayBuffer` / cross-origin isolation even for Threads=1) | **Separate `.nnue`** fetched by the host and passed with `setNnueBuffer(Uint8Array, index)`; nothing embedded in the wasm | `sf_18.js` 28,580 B + `sf_18.wasm` 601,688 B; `sf_18_smallnet.js` 28,643 B + `sf_18_smallnet.wasm` 596,140 B; `_relaxed-simd` variants same size ±; `fsf_14.wasm` 731,892 B | **AGPL-3.0-or-later** (package) over GPL-3 Stockfish | 2026-09-02 |
| **`stockfish` (nmrugg / Chess.com stockfish.js)** (https://github.com/nmrugg/stockfish.js) | Stockfish 18 | `stockfish` **18.0.8** (2026-06-15; GitHub release v18.0.0 2026-02-11) | Two families: `-single` (no SAB needed) and multi-threaded (needs COOP/COEP); also asm.js | **Embedded in the wasm** (incbin). Full = SF18 big+small nets; "lite" embeds `nn-9067e33176e8.nnue` (5,410,176 B, `EvalFileSmall ""`) | `stockfish-18.wasm` 113,007,340 B / `stockfish-18-single.wasm` 112,992,459 B / `stockfish-18-lite.wasm` 7,093,151 B / `stockfish-18-lite-single.wasm` 7,295,411 B / `stockfish-18-asm.js` 10,509,235 B; JS glue 20–32 KB | GPL-3.0 | 2026-06 |
| `stockfish.wasm` (lichess-org, formerly niklasf; hi-ogawa's repo is a 2021 fork) (https://github.com/lichess-org/stockfish.wasm) | Stockfish 11-era classical eval ("SF_classical (strongest handcoded eval)… No SIMD", per stockfish-web README) | `stockfish.wasm` 0.10.0 (2022-05-18) | pthreads (needs COOP/COEP); files `stockfish.js`, `stockfish.wasm`, `stockfish.worker.js` | none ("NNUE… unsupported") | ~400 KB total | GPL-3.0 | 2022 (hi-ogawa fork last push 2021-02-19) — **obsolete** |
| `stockfish-nnue.wasm` (hi-ogawa) | Stockfish 14 ("smolnet") | 1.0.0-1946a675.smolnet (2022-05-18) | pthreads | embedded small net | — | GPL-3.0 | 2022 — **obsolete** (lichess marks it `obsoletedBy: 'dynamicImportFromWorker'`) |
| `fairy-stockfish-nnue.wasm` (https://github.com/fairy-stockfish/fairy-stockfish.wasm) | Fairy-Stockfish (variants), Skill Level range extends negative | `fairy-stockfish-nnue.wasm` **1.1.12** (2026-08-26) | pthreads (needs SAB) | separate variant nets | 1.7 MB unpacked | GPL-3.0 | 2026-08 |

Our old bundle ("SlicedEngine", engine.js 48 KB + engine.wasm 347 KB + engine.worker.js, classical eval) corresponds to the `stockfish.wasm`-generation (SF 11/12 classical), i.e. ~1000 Elo weaker than SF18 and lacking NNUE.

### `@lichess-org/stockfish-web` API (exact, from `stockfishWeb.d.ts` in 0.4.4)

```ts
declare module "@lichess-org/stockfish-web" {
  interface StockfishWeb {
    uci(command: string): void;               // send uci command, receive async response via listen
    // index arguments are used for dual net sf builds, 0 for big, 1 for small, otherwise ignore
    setNnueBuffer(data: Uint8Array, index?: number): void; // load nnue as buffer
    getRecommendedNnue(index?: number): string | undefined; // returns a bare filename
    listen: (data: string) => void;           // attach listener here
    onError: (msg: string) => void;           // attach error handler here
  }
  export default StockfishWeb;
}
```
Each `sf_*.js` is an ES module (`export default Sf_…`), an Emscripten `MODULARIZE` factory: `const sf = await (await import(url)).default({ wasmMemory?, locateFile?, mainScriptUrlOrBlob?, onExit?, instantiateWasm? })` (`-sINCOMING_MODULE_JS_API='[locateFile,print,printErr,wasmMemory,buffer,instantiateWasm,mainScriptUrlOrBlob,onExit]'`). Build flags: `-O3 --closure=1 -pthread -msimd128 -mavx -flto -sEXPORT_ES6 -sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=3MB -sPROXY_TO_PTHREAD -sALLOW_BLOCKING_ON_MAIN_THREAD=0 -sENVIRONMENT=web,worker,node`. Pthreads are spawned with `new Worker(new URL("sf_18.js", import.meta.url), {type:"module", name:"em-pthread"})` (or from `mainScriptUrlOrBlob`), so the module file itself must be loadable as a module Worker from the extension origin (it is; `chrome-extension://` URLs are same-origin).

Glue semantics (`src/initModule.js`, `src/glue.cpp`): `uci()` mallocs the string and pushes it onto a mutex/condvar `CommandQueue`; `setNnueBuffer(buf, index)` copies the bytes into wasm heap and enqueues an NNUE command that the engine thread consumes as a `std::istream` via `engine.load_big_network(is)` (index 0) or `load_small_network(is)` (index 1). Output arrives through `Module.print → listen`, errors through `printErr → onError` (`BAD_NNUE` for fsf; SF prints network errors via `onError`). `getRecommendedNnue(i)` returns `EvalFileDefaultNameBig`/`EvalFileDefaultNameSmall`/`EvalFileDefaultName` compiled in (e.g. `sf_18`: `nn-c288c895ea92.nnue`, `nn-37f18f62d772.nnue`; `sf_18_smallnet`: `nn-4ca89e4b3abf.nnue` 10,419,881 B; `sf_dev_smallnet`: `nn-61e7af4bb97d.nnue` 975,309 B; `sf_dev`: `nn-1a298aa575a0.nnue`).

Lichess' own loader (https://github.com/lichess-org/lila/blob/master/ui/lib/src/ceval/engines/stockfishWebEngine.ts) does exactly:
```ts
const makeModule = await import(scriptUrl);
const module: StockfishWeb = await makeModule.default({
  wasmMemory: sharedWasmMemory(this.info.minMem!),   // new WebAssembly.Memory({shared:true, initial:lo, maximum:hi}) with fallback shrink loop
  locateFile: (file: string) => site.asset.url(`${root}/${file}`),
  mainScriptUrlOrBlob: scriptUrl,
});
module.onError = ...;
for (let i = 0; ; i++) { const n = module.getRecommendedNnue(i); if (!n) break; nnueFilenames.push(n); }
await Promise.all(nnueFilenames.map(async (name, index) =>
  module.setNnueBuffer(await bigFileStorage().get(`lifat/nnue/${name}`, onProgress), index)));
module.listen = (data: string) => this.protocol.received(data);
this.protocol.connected(cmd => module.uci(cmd));
```
`minMem` (initial shared memory pages ×64 KiB): `sf_18` 2560 (160 MiB), `sf_18_smallnet` 1536 (96 MiB); lichess names them "Stockfish 18 · 108MB" and "Stockfish 18 · 15MB" (download totals). Lichess chooses `_relaxed-simd.js` when the browser reports relaxed-SIMD support (`requires: ['sharedMem','simd','dynamicImportFromWorker']` + `'relaxedSimd'`).

### nmrugg `stockfish` load API

Classic Worker-style: `const w = new Worker('stockfish-18-lite-single.js'); w.postMessage('uci'); w.onmessage = e => ...` (examples/loadEngine.js; `-single` builds need no SAB). Multi-threaded flavors need cross-origin isolation. The npm package ships the engines under `bin/` and picks a default in `postinstall`; the GitHub release assets (v18.0.0) are the canonical file list above. There is no external-NNUE API: nets are compiled in, hence 7 MB (lite) or 113 MB (full) wasm files that must be shipped in the CRX or fetched whole.

---

## 4. Chrome MV3 specifics

### Service workers cannot spawn `Worker`s → use an offscreen document
- MDN `Worker()` constructor: "**Note:** This feature is available in Web Workers, except for Service Workers." (https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker). The `Worker` interface is not exposed in `ServiceWorkerGlobalScope`, so `new Worker()` throws `ReferenceError` in the MV3 background service worker. The pthread builds above *must* create workers, so the engine cannot live in the service worker.
- Chrome offscreen API (https://developer.chrome.com/docs/extensions/reference/api/offscreen): "Chrome 109+ MV3+"; requires the `"offscreen"` permission; `chrome.offscreen.createDocument({url, reasons, justification})`; Reason `WORKERS`: "Specifies that the offscreen document needs to spawn workers." Also relevant: `BLOBS` ("Interacting with Blob objects including `URL.createObjectURL()`") if we ever build the worker from a blob. Limit: "Though an extension package can contain multiple offscreen documents, an installed extension can only have one open at a time." Lifetime: only `AUDIO_PLAYBACK` has an automatic 30 s idle close; other reasons have no automatic limit (document lives until `chrome.offscreen.closeDocument()`, extension reload/update/disable, or browser exit). Only `chrome.runtime` is available in the offscreen document ("the `chrome.runtime` API is the only extensions API supported by offscreen documents") — talk to it with `chrome.runtime.sendMessage`/`connect` (Port). Recommended guard from the docs: check `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'], documentUrls:[url]})` and hold a single `creating` promise before calling `createDocument` (creating a second one rejects).
- Alternative host: the **side panel** page (`chrome.sidePanel`) is an ordinary extension page and can also host the engine, but it is torn down when the panel closes; the offscreen document is the stable home. (Both can coexist: run the engine in the offscreen doc, UI in the side panel, mediate via the service worker or a direct `runtime.connect` Port.)

### SharedArrayBuffer / pthreads in extension pages
- Manifest keys (https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-embedder-policy, …/cross-origin-opener-policy; both "Chrome 93"):
  ```json
  "cross_origin_embedder_policy": { "value": "require-corp" },
  "cross_origin_opener_policy":   { "value": "same-origin" }
  ```
  "The `cross_origin_embedder_policy` manifest key lets the extension specify a value for the Cross-Origin-Embedder-Policy (COEP) response header for requests to the extension's origin." Concept page (https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation): "Cross-origin isolation enables a web page to use powerful features such as `SharedArrayBuffer`"; applies to "the extension's service worker, popup, options page, tabs that are open to an extension resource, etc." Caveats on the same page: service workers and shared workers do not currently get full cross-origin isolation, and cross-origin-isolated extension subframes embedded in normal web pages are not considered isolated. An offscreen document is a top-level extension-origin document, so it is isolated (`crossOriginIsolated === true`) and `SharedArrayBuffer`/`WebAssembly.Memory({shared:true})` work there (this is the configuration lichess-style pthread builds need; verify at runtime with `self.crossOriginIsolated`).
  Side effects of `require-corp`: every cross-origin subresource the extension pages load must carry CORP/CORS headers (or be same-origin). Our net download from `tests.stockfishchess.org` should therefore be done with `fetch(url, {mode:'cors'})` from the **service worker** (not COEP-restricted) or we must confirm the host sends `Cross-Origin-Resource-Policy`. Safer: fetch in the service worker and hand the `ArrayBuffer` to the offscreen doc, or host the net ourselves with proper headers, or bundle it.
  Known pitfall (chromium-extensions thread https://groups.google.com/a/chromium.org/g/chromium-extensions/c/RiZrVY1-Y5o): you cannot pass a `SharedArrayBuffer` through `chrome.runtime.sendMessage` (JSON-serialised). Keep the SAB inside the offscreen document; exchange only strings/ArrayBuffers.

### CSP
- MV3 default/minimum `extension_pages` CSP (https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy): `"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"`. "you cannot add other script sources to directives, such as adding `'unsafe-eval'` to `script-src`" (installation error). `'wasm-unsafe-eval'` has been allowed in MV3 CSP since **Chrome 102/103** ("Chrome 102: … Manifest V3 extensions can now include `wasm-unsafe-eval` in their `content_security_policy` declarations", https://developer.chrome.com/docs/extensions/whats-new; the CSP reference says from 103 it must be declared). Recommended manifest entry:
  ```json
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  }
  ```
  No `blob:`/`data:` script sources are permitted, so the Emscripten worker must be loaded from a real extension URL (`new Worker(new URL('sf_18.js', import.meta.url), {type:'module'})` is fine; do not use a Blob worker).

### `web_accessible_resources`
- Not needed for extension pages: "Only pages or scripts loaded from an extension's origin can access that extension's resources." (https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources). The offscreen document, side panel, its workers and `fetch(chrome.runtime.getURL('engine/…'))` all run on the extension origin, so `engine/*.js|wasm|nnue` need **no** `web_accessible_resources` entry. Only add one (`{"resources":["engine/*"],"matches":["https://www.chess.com/*"]}`) if a content script on the web page origin must load them — which we should avoid (the engine belongs in the offscreen doc).

---

## 5. Storing / delivering the NNUE network

Facts:
- Chrome Web Store: "The maximum supported file size for an extension package is 2GB." (https://developer.chrome.com/docs/webstore/publish). No stricter hard limit, but the whole CRX is downloaded on every update; a 70+ MB package makes every release a 70 MB download and slows install/update.
- Chrome's `DecompressionStream` supports only `gzip`, `deflate`, `deflate-raw` (MDN browser-compat data: `brotli` chrome=false (Firefox 147/Safari 18.4), `zstd` chrome=false). So brotli/zstd need a wasm decoder (e.g. `brotli-wasm`, `@bokuweb/zstd-wasm`). NNUE weights are int8/int16 quantised and compress only modestly (typically ~10–15% with brotli/zstd, gzip less), so compression is not worth a wasm decoder; if you compress at all, gzip via `DecompressionStream('gzip')` is free.
- OPFS (https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system): `const root = await navigator.storage.getDirectory(); const fh = await root.getFileHandle(name, {create:true}); const w = await fh.createWritable(); await w.write(buf); await w.close();` Works in extension documents (offscreen/side panel) and workers; "subject to browser storage quota restrictions"; "Clearing storage data for the site deletes the OPFS." Lichess uses exactly OPFS-with-IndexedDB-fallback (`ui/lib/src/bigFileStorage.ts`) and deletes the cached file if the engine reports `BAD_NNUE`. Extension quota: declare `"unlimitedStorage"` permission to avoid eviction of a 70 MB blob.
- Integrity: the net's filename *is* its hash: `nn-<first 12 hex of sha256>.nnue`. Lichess' `tools/wasm-cli.ts` verifies `sha256(buf).slice(0,12) === match[1]` before use. We can do the same with `crypto.subtle.digest('SHA-256', buf)`.
- `setoption name EvalFile value <path>` in the wasm builds: **not usable**. stockfish-web patches `CommandLine::get_binary_directory()`/`get_working_directory()` to return `""` and stubs `Network::verify()`; the option callback would try to open a path in the Emscripten MEMFS where no file exists. The supported path is `setNnueBuffer()`. (nmrugg builds embed the net; `EvalFile` there just re-selects the embedded one.)

Options:
- (a) **Bundle in the CRX.** Small net only: +2.9 MB (`nn-37f18f62d772`) or +10.4 MB (`nn-4ca89e4b3abf` for `sf_18_smallnet`). Big net: +73 MB per release — reject.
- (b) **Download on first run into OPFS (IndexedDB fallback), hash-verified.** Cost: one 73 MB download (big) from `https://tests.stockfishchess.org/api/nn/<name>.nnue` (or a mirror we control); zero package bloat; survives updates; can be deferred/optional ("Strong engine" toggle). This is what lichess does at scale.
- (c) Compress: not worth it for Chrome given no native brotli/zstd and the low compressibility.

**Recommendation:** bundle the small net (`sf_18_smallnet` + `nn-4ca89e4b3abf.nnue`, 10.4 MB) inside the package so the engine always works offline and immediately; optionally offer the full `sf_18` dual-net (73 MB + 2.9 MB) as an on-demand download into OPFS. For a strength-limited "play like a 1400" product, the smallnet build is already far above any target Elo, so the big net is optional polish. Because we play at limited strength, even the 1 MB `sf_dev_smallnet` net (`nn-61e7af4bb97d`) would suffice, but `sf_dev` tracks master nightly and is unstable as a dependency; prefer the `sf_18*` targets.

Load sketch (offscreen document, TypeScript):
```ts
import type StockfishWeb from '@lichess-org/stockfish-web';

const ROOT = chrome.runtime.getURL('engine/');
const sha12 = async (u8: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);

async function loadNet(name: string): Promise<Uint8Array> {
  // 1. bundled?
  const r = await fetch(ROOT + name).catch(() => undefined);
  if (r?.ok) return new Uint8Array(await r.arrayBuffer());
  // 2. OPFS cache
  const dir = await navigator.storage.getDirectory();
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    const u8 = new Uint8Array(await f.arrayBuffer());
    if (await sha12(u8) === name.slice(3, 15)) return u8;
  } catch {}
  // 3. download (ask the service worker to fetch if COEP blocks the CORS request), verify, persist
  const res = await fetch(`https://tests.stockfishchess.org/api/nn/${name}`);
  const u8 = new Uint8Array(await res.arrayBuffer());
  if (await sha12(u8) !== name.slice(3, 15)) throw new Error('nnue checksum mismatch');
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(u8); await w.close();
  return u8;
}

export async function bootEngine(js = 'sf_18_smallnet.js'): Promise<StockfishWeb> {
  if (!self.crossOriginIsolated) throw new Error('COOP/COEP manifest keys missing');
  const url = ROOT + js;
  const factory = (await import(url)).default;
  const sf: StockfishWeb = await factory({
    wasmMemory: new WebAssembly.Memory({ shared: true, initial: 1536, maximum: 8192 }),
    locateFile: (f: string) => ROOT + f,
    mainScriptUrlOrBlob: url,
  });
  sf.onError = (m) => console.error('[sf]', m);
  for (let i = 0; ; i++) {
    const name = sf.getRecommendedNnue(i);
    if (!name) break;
    sf.setNnueBuffer(await loadNet(name), i);
  }
  return sf;
}
```

---

## 6. UCI protocol essentials (spec: https://backscattering.de/chess/uci/ ; Stockfish specifics from `src/uci.cpp`)

Handshake and control:
- `uci` → engine prints `id name Stockfish 18`, `id author …`, one `option name X type … default … [min … max …]` per option, then `uciok`.
- `isready` → `readyok` ("Must be sent when the engine has received an isready command and has processed all input"). Send after `setoption`s and after `ucinewgame`, and wait for `readyok` before `go`.
- `setoption name <Name> value <v>` (names are case-sensitive and may contain spaces: `setoption name Skill Level value 5`, `setoption name UCI_LimitStrength value true`, `setoption name UCI_Elo value 1500`, `setoption name MultiPV value 6`, `setoption name Threads value 1`, `setoption name Hash value 16`, `setoption name UCI_ShowWDL value true`). Options must not be changed while a search is running.
- `ucinewgame` ("sent to the engine when the next search will be from a different game") — clears TT/histories; follow with `isready`.
- `position startpos [moves e2e4 e7e5 …]` or `position fen <6-field FEN> [moves …]` (moves in long algebraic: `e7e8q`, castling `e1g1`; in Chess960 mode castling is king-takes-rook).
- `go` — Stockfish's `parse_limits` accepts, in any order: `searchmoves <m1> … (must be last)`, `wtime <ms>`, `btime <ms>`, `winc <ms>`, `binc <ms>`, `movestogo <n>`, `depth <plies>`, `nodes <n>`, `movetime <ms>`, `mate <n>`, `perft <n>`, `infinite`, `ponder`. Typical: `go movetime 800`, `go depth 8`, `go wtime 180000 btime 180000 winc 2000 binc 2000`.
- `stop` → engine replies with `bestmove` for the current search ("stop calculating as soon as possible"). `ponderhit` → switch from ponder to normal search. `quit`.
- Every `go` produces exactly one `bestmove <move> [ponder <move>]` (`bestmove (none)` when no legal move). Never send a second `go` before the `bestmove` of the previous one arrives (lichess' `Protocol` queues "next work", sends `stop`, and swaps only after `bestmove`/`readyok`).

Stockfish `info` line grammar (exact emission order from `UCIEngine::on_update_full`, SF18/master):
```
info depth <d> seldepth <sd> multipv <k> score (cp <n> | mate <n>) [lowerbound|upperbound] [wdl <w> <d> <l>] nodes <n> nps <n> hashfull <permille> tbhits <n> time <ms> pv <m1> <m2> …
```
- `wdl` appears only with `UCI_ShowWDL true`; `w d l` are per-mille (sum 1000) from the side-to-move's view, e.g. `score cp 18 wdl 22 974 4`.
- `score` is from the side to move's point of view; `mate <n>` is in moves (SF converts plies: `(plies>0 ? plies+1 : plies)/2`); negative = engine is being mated. Tablebase scores are `cp ±20000-plies` (won't occur without syzygy).
- Other `info` shapes SF emits: `info depth <d> currmove <m> currmovenumber <n>` (from `on_iter`, after ~3 s); `info depth 0 score cp 0` / `mate 0` when there are no legal moves (`on_update_no_moves`); `info string <text>` (net info, errors — lichess treats `info string ERROR…` as fatal).
- Under `MultiPV k`, each depth iteration emits k lines with `multipv 1..k` sorted best-first; lines with `lowerbound`/`upperbound` are fail-high/low interim reports (lichess ignores them for multipv 1 and accepts upperbound for non-primary PVs). A PV is complete for a depth when the line with `multipv == MultiPV` arrives.

Parser spec (tokenise on whitespace; process keywords left-to-right; every value keyword consumes exactly one token except `score` (2–3), `wdl` (3), `pv`/`refutation`/`currline` (rest of line), `string` (rest of line)):
```ts
interface Info { depth?: number; seldepth?: number; multipv?: number;
  score?: { type: 'cp' | 'mate'; value: number; bound?: 'lower' | 'upper' };
  wdl?: [number, number, number]; nodes?: number; nps?: number; hashfull?: number;
  tbhits?: number; time?: number; pv?: string[]; currmove?: string; currmovenumber?: number; string?: string }
function parseInfo(line: string): Info | undefined {
  const t = line.trim().split(/\s+/); if (t[0] !== 'info') return;
  const o: Info = {};
  for (let i = 1; i < t.length; i++) switch (t[i]) {
    case 'depth': case 'seldepth': case 'multipv': case 'nodes': case 'nps':
    case 'hashfull': case 'tbhits': case 'time': case 'currmovenumber':
      (o as any)[t[i]] = parseInt(t[++i]); break;
    case 'currmove': o.currmove = t[++i]; break;
    case 'score': {
      const type = t[++i] as 'cp' | 'mate', value = parseInt(t[++i]);
      o.score = { type, value };
      if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') o.score.bound = t[++i] === 'lowerbound' ? 'lower' : 'upper';
      break; }
    case 'wdl': o.wdl = [parseInt(t[++i]), parseInt(t[++i]), parseInt(t[++i])]; break;
    case 'pv': o.pv = t.slice(i + 1); i = t.length; break;
    case 'string': o.string = t.slice(i + 1).join(' '); i = t.length; break;
    case 'refutation': case 'currline': i = t.length; break; // SF does not emit these
  }
  return o;
}
// bestmove: /^bestmove (\S+)(?: ponder (\S+))?$/  ; '(none)' possible
```
Client state machine: `uci`→wait `uciok`→setoptions→`ucinewgame`→`isready`→wait `readyok`→ per move: `position … moves …`→`go …`→collect `info`→`bestmove`. On `stop`, keep consuming until `bestmove`. `Threads`: stay at 1 in the extension unless `navigator.hardwareConcurrency` is high; each thread is a pthread Web Worker. `Hash`: 16–64 MB is plenty for shallow limited-strength searches (lichess caps Android at 64).

---

## 7. Recommendation

**Use `@lichess-org/stockfish-web` 0.4.4, target `sf_18_smallnet` (with the `_relaxed-simd` variant selected at runtime when supported), net `nn-4ca89e4b3abf.nnue` bundled; optional on-demand `sf_18` dual-net upgrade into OPFS.**

Why:
- It is the only maintained (updated yesterday, 2026-09-02), SIMD, pthread SF18 build with a **separate-NNUE API** (`setNnueBuffer`), giving us the package-size control the task asks for; wasm is only ~600 KB.
- Same engine/API lichess runs in production; TypeScript typings included; a reference loader and a battle-tested UCI `Protocol` class exist in lila to copy from (`ui/lib/src/ceval/engines/stockfishWebEngine.ts`, `ui/lib/src/ceval/protocol.ts`, `ui/lib/src/bigFileStorage.ts`).
- Fits MV3: ES-module factory + module Workers loaded from extension URLs satisfy `script-src 'self' 'wasm-unsafe-eval'`; runs in an offscreen document with COOP/COEP manifest keys (required because `PROXY_TO_PTHREAD` needs SAB).
- Rejected: nmrugg `stockfish` 18.0.8 — nets are baked into 7 MB/113 MB wasm files, no NNUE swapping, classic-worker glue; its `-single` builds are the fallback if SAB ever proves impossible (they need no COOP/COEP). `stockfish.wasm`/`stockfish-nnue.wasm` — obsolete SF11/SF14. `fairy-stockfish-nnue.wasm` — only if we want negative `Skill Level`; not needed since we do our own sub-1320 humanization.
- Licensing: package is AGPL-3.0-or-later (Stockfish itself GPL-3). Shipping it in a distributed extension means the extension's engine component must comply (offer source of the engine build and of our modifications; AGPL's network clause is not triggered by a client-side extension, but the extension distributes the binary, so GPL-style source-offer obligations apply). If AGPL is unacceptable, fall back to nmrugg `stockfish-18-lite-single` (GPL-3.0) — which still requires GPL compliance.

### Files to vendor into `engine/` (from `npm pack @lichess-org/stockfish-web@0.4.4`)
```
engine/sf_18_smallnet.js                    28,643 B   (ES module; also the pthread worker script)
engine/sf_18_smallnet.wasm                 596,140 B
engine/sf_18_smallnet_relaxed-simd.js       28,734 B   (optional, faster on Chrome ≥ 114 with relaxed-simd)
engine/sf_18_smallnet_relaxed-simd.wasm    596,271 B
engine/nn-4ca89e4b3abf.nnue             10,419,881 B   (https://tests.stockfishchess.org/api/nn/nn-4ca89e4b3abf.nnue)
engine/stockfishWeb.d.ts                       593 B   (types only; not shipped)
engine/LICENSE                              35,149 B   (AGPL text; keep with the build)
```
Optional "full strength" pack, downloaded on demand to OPFS instead of shipped: `sf_18.js` (28,580 B) + `sf_18.wasm` (601,688 B) can be shipped (tiny) while `nn-c288c895ea92.nnue` (72,754,437 B) and `nn-37f18f62d772.nnue` (2,876,624 B) are fetched on first use.

### Manifest additions
```json
"permissions": ["offscreen", "unlimitedStorage"],
"cross_origin_embedder_policy": { "value": "require-corp" },
"cross_origin_opener_policy":   { "value": "same-origin" },
"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
"minimum_chrome_version": "116"
```
(116 for `chrome.runtime.getContexts`; offscreen itself is 109+.)

### Loader sequence
1. Service worker: on demand (`setupOffscreenDocument`), `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Runs the Stockfish WebAssembly engine, which requires Web Workers (pthreads).' })`, guarded by `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` and a single in-flight promise.
2. Offscreen page: assert `self.crossOriginIsolated`; pick `sf_18_smallnet_relaxed-simd.js` if `WebAssembly.validate(<relaxed-simd probe bytes>)` succeeds else `sf_18_smallnet.js`; `const sf = await (await import(chrome.runtime.getURL('engine/'+js))).default({ wasmMemory: sharedMemory(1536), locateFile, mainScriptUrlOrBlob })`.
3. `sf.onError = …; sf.listen = line => protocol.received(line)`.
4. `for i in 0..: name = sf.getRecommendedNnue(i)` → `sf.setNnueBuffer(await loadNet(name), i)` (bundled → OPFS → download, sha256-prefix verified).
5. `sf.uci('uci')` → wait `uciok`; `setoption name Threads value 1`, `Hash 32`, `MultiPV 6`, `UCI_LimitStrength true`, `UCI_Elo <n>`, `UCI_ShowWDL true` (optional); `ucinewgame`; `isready` → `readyok`.
6. Per move: `position fen … moves …`, `go movetime <ms>` (or `depth`), parse `info … multipv k score …` lines into candidates, wait `bestmove`, then apply our own humanized selection/timing over the candidate list; use `stop` for early cut-offs.
7. Expose to the rest of the extension via a `chrome.runtime.connect({name:'engine'})` Port (strings only; no SAB across the boundary). Close with `sf.uci('quit')` then `chrome.offscreen.closeDocument()` when idle for a long time (optional; no auto-close for reason `WORKERS`).

### Slider mapping
Replace the old `~elo = 1650*n/7` (Skill Level 1–20) with a direct Elo slider clamped to 1320–3190 → `UCI_LimitStrength true` + `UCI_Elo`. For targets below 1320, keep `UCI_Elo 1320` and increase our own error injection (sample from the `MultiPV` list with a softmax over `cp` differences, temperature increasing as target Elo decreases; occasionally search only `depth 1–3`).

---

## Sources
- Stockfish releases: https://github.com/official-stockfish/Stockfish/releases ; SF18 notes: https://github.com/official-stockfish/Stockfish/releases/tag/sf_18
- Sources inspected: `https://raw.githubusercontent.com/official-stockfish/Stockfish/{sf_16,sf_16.1,sf_17,sf_17.1,sf_18,master}/src/{evaluate.h,engine.cpp,search.h,search.cpp,uci.cpp}`
- Net files/sizes: `https://tests.stockfishchess.org/api/nn/<name>.nnue` (HEAD)
- Stockfish wiki UCI: https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html ; FAQ: https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html
- UCI spec: https://backscattering.de/chess/uci/
- lichess stockfish-web: https://github.com/lichess-org/stockfish-web (README, `package.json`, `stockfishWeb.d.ts`, `src/initModule.js`, `src/glue.cpp`, `src/glue.hpp`, `build.py`, `patches/sf_18.patch`, `tools/wasm-cli.ts`); npm `@lichess-org/stockfish-web@0.4.4`
- lila loader: https://github.com/lichess-org/lila/blob/master/ui/lib/src/ceval/engines/stockfishWebEngine.ts , …/engines/engines.ts , …/ceval/protocol.ts , …/ceval/util.ts , https://github.com/lichess-org/lila/blob/master/ui/lib/src/bigFileStorage.ts
- fishnet level table: https://github.com/lichess-org/fishnet/blob/master/src/api.rs
- nmrugg stockfish.js: https://github.com/nmrugg/stockfish.js (README, release v18.0.0 assets, `src/lite_nets.h`, `examples/loadEngine.js`); npm `stockfish@18.0.8`
- stockfish.wasm: https://github.com/lichess-org/stockfish.wasm , https://github.com/hi-ogawa/stockfish.wasm ; npm `stockfish.wasm@0.10.0`, `stockfish-nnue.wasm@1.0.0-1946a675.smolnet`
- fairy-stockfish.wasm: https://github.com/fairy-stockfish/fairy-stockfish.wasm ; npm `fairy-stockfish-nnue.wasm@1.1.12`
- Chrome offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen ; blog: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
- Service worker migration: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers ; MDN Worker(): https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker
- COEP/COOP keys: https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-embedder-policy , https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-opener-policy , https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation ; SAB-in-offscreen thread: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/RiZrVY1-Y5o
- CSP: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy ; https://developer.chrome.com/docs/extensions/whats-new
- web_accessible_resources: https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
- CWS size: https://developer.chrome.com/docs/webstore/publish
- OPFS: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system ; DecompressionStream formats: https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream + https://github.com/mdn/browser-compat-data/blob/main/api/DecompressionStream.json
- Low-level play quality: https://lichess.org/forum/general-chess-discussion/what-the-hell-is-wrong-with-lichess-stockfish-level-1 , https://lichess.org/forum/lichess-feedback/stockfish-too-strong-for-beginners ; Maia: https://arxiv.org/abs/2006.01855


# Appendix B — Chrome MV3 APIs (side panel, offscreen, service worker, debugger, commands, CSP, distribution)


Researched 2026-09-03 against developer.chrome.com, the Chromium tree at `main` (fetched and decoded locally: `chrome/common/extensions/api/_api_features.json`, `_permission_features.json`, `side_panel.idl`, `extensions/common/api/offscreen.webidl`, `extensions/common/extension_features.cc`, `chrome/browser/extensions/api/debugger/debugger_api.cc`), the CDP tot protocol pages, and the chrome-extensions-samples repo. Where a doc summary and the Chromium source disagreed, the source wins and is quoted.

Target baseline recommendation: **`"minimum_chrome_version": "116"`** covers everything the plan needs (sidePanel.open, runtime.getContexts, offscreen, scripting world MAIN). Bump to **118** if you want the guarantee that an attached debugger keeps the service worker alive (see Q5), and to **141/142** only if you decide to depend on `sidePanel.onOpened/onClosed/close()` instead of the port-disconnect pattern.

---

## 1. MV2 deprecation status (2026)

Source: https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline

- 2022-01 / 2022-06: Web Store stopped accepting new public/unlisted, then private, MV2 items.
- 2024-06-03: warning banner on chrome://extensions for MV2 items.
- 2024-10-09 onward: MV2 disabled in stable, rolled out gradually.
- 2025-03-31: "All users on all channels of Chrome now have Manifest V2 extensions disabled by default."
- 2025-07-24 (Chrome 138): MV2 "disabled. Users can no longer turn them back on."
- **Chrome 139: the `ExtensionManifestV2Availability` enterprise policy was removed.** There is no longer any policy escape hatch. (Also: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/3fL7swrnG3A)
- **2026-08-31: all remaining MV2 extensions removed from the Chrome Web Store.**

Bottom line: as of today an MV2 extension cannot be loaded in any stable Chrome, unpacked or otherwise, policy or not. The migration is mandatory, not optional.

---

## 2. `chrome.sidePanel`

Docs: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
Sample: https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.sidepanel-site-specific

Permission `"sidePanel"` (no install warning). Min Chrome 114, MV3 only (`_permission_features.json`: `min_manifest_version: 3`, platforms chromeos/desktop_android/linux/mac/win).

| API | Min Chrome | Notes |
|---|---|---|
| manifest `side_panel.default_path` | 114 | Panel shown on all tabs unless overridden per tab. Path must be a local extension resource. |
| `setOptions({tabId?, path?, enabled?})` | 114 | Omitted props unchanged. Without `tabId` sets the default. `enabled` defaults true. |
| `getOptions({tabId?})` | 114 | Returns the effective options for that tab (or default). |
| `setPanelBehavior({openPanelOnActionClick})` / `getPanelBehavior()` | 114 | Default false. Set from the SW, there is no manifest key. |
| `open({tabId?, windowId?})` | 116 | **Requires a user gesture.** IDL comment: "This may only be called in response to a user action." |
| `getLayout()` → `{side: "left"|"right"}` | 140 | |
| `onOpened(PanelOpenedInfo{windowId, tabId?, path})` | **141** | |
| `close({tabId?, windowId?})` | **141** | No-op if already closed. |
| `onClosed(PanelClosedInfo{windowId, tabId?, path})` | **142** | |

`open()` semantics (from the doc): `tabId` — "If the corresponding tab has a tab-specific side panel, the panel will only be open for that tab. If there is not a tab-specific panel, the global panel will be open in the specified tab and any other tabs without a currently-open tab-specific panel." `windowId` — "only applicable if the extension has a global (non-tab-specific) side panel or tabId is also specified." At least one is required.

What counts as a user gesture for `open()` (doc): an action click, a keyboard shortcut (`chrome.commands.onCommand`), a context menu click, or a user gesture on an extension page or content script. Known pitfall (crbug 355266358, 415694848): the gesture token does **not** survive `content script → sendMessage → SW → sidePanel.open()`; call `chrome.sidePanel.open()` directly from the content script's click handler if you need that path, keep it synchronous, and be aware that after the user manually closes the panel a later programmatic open may throw "may only be called in response to a user gesture" until the next real gesture.

Per-tab enabling behavior (doc): "When a user temporarily switches to a tab where the side panel is not enabled, the side panel will be hidden. It will automatically show again when the user switches to a tab where it was previously open." and "When the user navigates to a site where the side panel is not enabled, the side panel will close, and the extension won't show in the side panel drop-down menu."

### Per-tab enabling (chess.com + lichess only)

```js
// service-worker.js
const ALLOWED_HOSTS = new Set(['www.chess.com', 'chess.com', 'lichess.org']);
const PANEL = 'sidepanel.html';

function panelOptionsFor(tabId, url) {
  let enabled = false;
  try { enabled = ALLOWED_HOSTS.has(new URL(url).hostname); } catch {}
  return enabled ? { tabId, path: PANEL, enabled: true } : { tabId, enabled: false };
}

// Default: disabled everywhere unless a tab-specific override says otherwise.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setOptions({ enabled: false });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Re-evaluate tabs that already exist at install/update time.
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id != null && tab.url) await chrome.sidePanel.setOptions(panelOptionsFor(tab.id, tab.url));
  }
});

// tab.url is present because we hold host_permissions for these origins
// (or the "tabs" permission); otherwise changeInfo.url/tab.url are undefined.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  const url = changeInfo.url ?? tab.url;
  if (!url) return;
  await chrome.sidePanel.setOptions(panelOptionsFor(tabId, url));
});
```

Note: if you want the panel *available* everywhere but *useful* only on chess sites, skip the `enabled:false` default and just render a "go to chess.com/lichess" state in the panel; the per-tab approach above is what removes the extension from the side-panel picker on other sites.

### How the panel knows which tab it is for

The panel is a window-scoped document (one per window, not per tab). Inside the panel:

```js
// sidepanel.js
let currentTabId = null;
async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentTabId = tab?.id ?? null;
  render(tab);
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => refreshActiveTab());
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === currentTabId && (info.url || info.status === 'complete')) refreshActiveTab(); });
refreshActiveTab();
```

The tabs doc recommends `lastFocusedWindow: true` over `currentWindow: true` for "the tab the user is looking at". You can also use `chrome.windows.getCurrent()` from the panel to learn its own `windowId` and filter `onActivated` by it (multi-window users).

### Detecting panel close

Two options:
1. Chrome 142+: `chrome.sidePanel.onClosed` in the SW.
2. Any version: the port-disconnect pattern. The panel calls `chrome.runtime.connect({name:'sidepanel'})`; the SW's `port.onDisconnect` fires when the panel document is destroyed. Per the messaging doc a port disconnects when "the calling frame unloads" or "all receiving frames unload". Caveat noted by users: the port disconnects only when the panel is actually closed, not when it is merely hidden by switching to a tab where the panel is disabled — but for a per-tab-disabled panel, navigating away *does* close it. (https://dev.to/latz/chrome-side-panel-simulate-close-event-354h)

---

## 3. `chrome.offscreen`

Docs: https://developer.chrome.com/docs/extensions/reference/api/offscreen
Blog: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3

Permission `"offscreen"` (no warning). Min Chrome 109, MV3 only.

- `createDocument({url, reasons: Reason[], justification: string}) → Promise<void>` resolves "when the offscreen document is created and has completed its initial page load." `url` must be a local extension page.
- `closeDocument() → Promise<void>`.
- `hasDocument() → Promise<boolean>` — **documented as Chrome 150+**. It sat behind a flag for years; do not depend on it for a 116+ baseline. Use `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` (Chrome 116, MV3) instead — this is what the official example does.
- `Reason` enum (from `offscreen.webidl` at main): `TESTING, AUDIO_PLAYBACK, IFRAME_SCRIPTING, DOM_SCRAPING, BLOBS, DOM_PARSER, USER_MEDIA, DISPLAY_MEDIA, WEB_RTC, CLIPBOARD, LOCAL_STORAGE, WORKERS, BATTERY_STATUS, MATCH_MEDIA, GEOLOCATION`. **`WORKERS` exists**: "Specifies that the offscreen document needs to spawn workers." It was not in the Chrome 109 launch set (a Dec-2022 thread had DevRel recommending `IFRAME_SCRIPTING` as a stand-in, https://groups.google.com/a/chromium.org/g/chromium-extensions/c/tIgizA-58pE) but the doc page now lists it under the API's general "Chrome 109+" badge with no per-value badge. Practically: with a 116+ baseline `WORKERS` is safe. If you want belt-and-braces, pass `reasons: ['WORKERS', 'DOM_PARSER']` — the reasons list is informational for review/lifetime, and an unknown enum value is a hard error only on Chromes older than the value.
- **Single document**: "an installed extension can only have one open at a time."
- **Lifetime**: "The `AUDIO_PLAYBACK` reason sets the document to close after 30 seconds without audio playing. All other reasons don't set lifetime limits." An offscreen doc is *not* subject to the service-worker idle timer. It is destroyed when: you call `closeDocument()`, the extension is reloaded/updated/disabled, or the browser exits. The SW being terminated does **not** close it (the doc lives in the extension renderer process, not the SW).
- **APIs available**: "The `runtime` API is the only extensions API supported by offscreen documents." Per `_api_features.json`, `offscreen_extension` context has `runtime.sendMessage`, `runtime.connect`, `runtime.onMessage`, `runtime.onConnect`, `runtime.id`, `runtime.getURL`, `runtime.lastError`. **`chrome.storage` is NOT available in the offscreen document** — route storage reads/writes through the SW (or the side panel) via messages. Design your engine wrapper so it is told its options over the port rather than reading `chrome.storage` itself.
- Messaging: the offscreen doc receives `chrome.runtime.onMessage` broadcasts just like other extension pages, so tag messages with a `target: 'offscreen'` field (the official pattern) or, better, use a named `runtime.connect` port from the SW/side panel to the offscreen doc. Both directions work; the offscreen doc can also initiate `chrome.runtime.connect()`.
- Web Workers and `SharedArrayBuffer`: The offscreen document is a normal extension page, so it can `new Worker(chrome.runtime.getURL('engine.worker.js'))`. To get `crossOriginIsolated === true` (required for `SharedArrayBuffer`/WASM threads/Atomics.wait in the workers), declare in the manifest:

  ```json
  "cross_origin_embedder_policy": { "value": "require-corp" },
  "cross_origin_opener_policy":  { "value": "same-origin" }
  ```

  Docs: https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-embedder-policy (Chrome 93+), https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-opener-policy, overview https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation. Caveats from the overview: "not all extension contexts will be cross-origin isolated" — service workers and shared workers are explicitly not; extension *documents* (offscreen, side panel) and their dedicated workers are. `require-corp` means every subresource the offscreen page loads must be same-origin (fine, everything is packaged) or carry CORP headers. Verify at runtime with `self.crossOriginIsolated` in the offscreen page and in the worker before enabling the threaded build; fall back to a single-threaded WASM build otherwise. Groups thread confirming SAB in offscreen docs + workers: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/RiZrVY1-Y5o

### Create-once helper with concurrent-call dedupe

```ts
// offscreen.ts (service worker side)
const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  // Chrome 116+: authoritative existence check. hasDocument() is only Chrome 150+.
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [OFFSCREEN_URL],
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs the WASM chess engine in Web Workers; service workers cannot host long-running engine threads.',
      })
      .catch((err: unknown) => {
        // Another caller (or a previous SW instance) may have raced us.
        if (String(err).includes('Only a single offscreen document')) return;
        throw err;
      })
      .finally(() => { creating = null; });
  }
  await creating;
}

export async function closeOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (existing.length) await chrome.offscreen.closeDocument();
}
```

`creating` is a module-level variable, so it dedupes within one SW lifetime; across SW restarts the `getContexts` check handles it, and the `.catch` handles the small race where two SW instances both pass the check.

---

## 4. MV3 service worker lifecycle

Docs: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle, blog https://developer.chrome.com/blog/longer-esw-lifetimes, basics https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics

Terminates when: "After 30 seconds of inactivity" (receiving an event or calling an extension API resets it); "When a single request, such as an event or API call, takes longer than 5 minutes to process"; when a `fetch()` response takes >30 min.

Version-specific changes (verbatim from the lifecycle doc):
- **Chrome 110**: "Extension API calls reset the timer" (previously only event handlers did). "All events reset the idle timer and the idle timeout will not occur if there are pending events." "Some APIs like native messaging provide a strong keep-alive which cancel both of these timers."
- **Chrome 114**: "Sending a message with long-lived messaging keeps the service worker alive. Opening a port no longer resets the timers." — i.e. merely holding a `runtime.connect` port open does **not** keep the worker alive; each `port.postMessage` (either direction) resets the 30 s idle timer. A silent open port will be torn down when the SW dies (the other end gets `onDisconnect`).
- **Chrome 116**: WebSocket send/receive resets the idle timer; some user-prompt APIs may exceed the 5-minute limit.
- **Chrome 118**: "Active debugger sessions created using the chrome.debugger API now keep the service worker alive. This prevents service workers from timing out during calls for this API." (Confirmed in source, see Q5.)
- **Chrome 120**: alarms min period 30 s (`periodInMinutes: 0.5`); unpacked extensions have no minimum. https://developer.chrome.com/docs/extensions/reference/api/alarms

Best practices:
- Register all `chrome.*` event listeners synchronously at top level of the SW script (not inside promises), or events fired to wake the worker will be missed.
- Do not hold state in globals. Use `chrome.storage.session` (Chrome 102+, 10 MB since Chrome 112, in-memory, cleared on browser restart/extension reload, survives SW restarts; default not visible to content scripts, `setAccessLevel({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'})` to allow) for "current game / attached tab / engine settings" and `chrome.storage.local` (10 MB, `unlimitedStorage` to lift) for persistent prefs. https://developer.chrome.com/docs/extensions/reference/api/storage
- Long engine work belongs in the offscreen document, which has no idle timer. Keep the SW as a thin router.
- If you genuinely need the SW awake (e.g. an active debugger attachment on <118), a heartbeat `port.postMessage({type:'ping'})` every ~20 s from the side panel or offscreen doc works; `chrome.alarms` at 0.5 min is the sanctioned fallback for periodic wake-ups.
- Module SW: `"background": {"service_worker": "sw.js", "type": "module"}` allows static `import`; dynamic `import()` is not supported in extension SWs; `importScripts()` is the alternative when not a module.

---

## 5. `chrome.debugger` in MV3

Docs: https://developer.chrome.com/docs/extensions/reference/api/debugger
Source: `chrome/browser/extensions/api/debugger/debugger_api.cc` (main)
CDP: https://chromedevtools.github.io/devtools-protocol/tot/Input/ , /tot/Emulation/ , /tot/Page/

Permission: `"debugger"` only. `activeTab` is not a substitute (`_api_features.json`: `"debugger": {"dependencies": ["permission:debugger"], "contexts": ["privileged_extension"]}`). Install-time warnings shown for `debugger`: "Access the page debugger backend" **and** "Read and change all your data on all websites" (https://developer.chrome.com/docs/extensions/reference/permissions-list). No per-attach prompt; the user is informed via the infobar instead. Note `debugger` is a `"permissions"` entry, not `optional_permissions`-friendly in practice for review reasons, though it is technically optional-capable.

Watch-out from source: `_api_features.json` marks `debugger` `"developer_mode_only": true` with the comment "This restriction is not true for production. It is only true when the extensions_features::kDebuggerAPIRestrictedToDevMode feature is enabled." `extension_features.cc` at main: `BASE_FEATURE(kDebuggerAPIRestrictedToDevMode, base::FEATURE_DISABLED_BY_DEFAULT)`. So today it is unrestricted, but Google has plumbing to gate `chrome.debugger` behind Developer Mode (as they did for `userScripts`). Treat this as a medium-term risk for the debugger-based input path; keep a fallback (synthetic DOM events from the MAIN-world script) in the design.

API surface:
- `chrome.debugger.attach({tabId}, "1.3")` — `requiredVersion`: "One can only attach to the debuggee with matching major version and greater or equal minor version." Source: `DevToolsAgentHost::IsSupportedProtocolVersion(required_version)` else error "Requested protocol version is not supported: *". `"1.3"` is the current stable protocol tag and what production automation extensions use. Errors: "Another debugger is already attached to the tab with id: *" (`kAlreadyAttachedError`), "Cannot attach to this target." (`kRestrictedError`: chrome:// / Web Store / other extensions' pages / interstitials / policy-blocked hosts), "Host access is restricted by policy.", "Screenshot capture is restricted by policy."
- `chrome.debugger.sendCommand({tabId}, method, params?) → Promise<object|undefined>`; also accepts `{tabId, sessionId}` (`DebuggerSession`) for child targets.
- `chrome.debugger.detach({tabId})`.
- `chrome.debugger.getTargets() → TargetInfo[]` with `{attached, extensionId?, faviconUrl?, id, tabId?, title, type: 'page'|'background_page'|'worker'|'other', url}`.
- `chrome.debugger.onDetach((source, reason) => ...)`, `DetachReason` = `"target_closed" | "canceled_by_user"`. `canceled_by_user` fires when the user clicks "Cancel" on the infobar; `target_closed` when the tab is closed or navigates to a non-attachable target. Since Chrome ~63 opening DevTools no longer forces the extension off (multi-client), so there is no `replaced_with_devtools` any more.
- `chrome.debugger.onEvent((source, method, params) => ...)`.
- Allowed CDP domains (doc list): Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Profiler, Runtime, Storage, Target, Tracing, WebAudio, WebAuthn. Everything you need (Input, Emulation, Page, Runtime, DOM) is allowed.

The infobar ("<Extension> started debugging this browser"):
- Shown across all tabs as long as any attachment exists; dismissing it with Cancel detaches (`canceled_by_user`).
- Source (`debugger_api.cc`, main):
  ```cpp
  // We allow policy-installed extensions to circumvent the normal
  // infobar warning. See crbug.com/41302695.
  const bool suppress_warning =
      base::CommandLine::ForCurrentProcess()->HasSwitch(::switches::kSilentDebuggerExtensionAPI) ||
      Manifest::IsPolicyLocation(extension_->location());
  ```
  So exactly two ways to hide it: (a) launch Chrome with `--silent-debugger-extension-api` (global, all extensions; the old chrome://flags entry expired at M77, only the command-line switch remains; must be on every launch), or (b) the extension is **policy-installed** (`ExtensionInstallForcelist` / `ExtensionSettings` with `installation_mode: force_installed` on a managed machine). There is no `ExtensionDeveloperModeSettings`-style user policy for this, and no per-extension allowlist (open request crbug 40815062). An unpacked dev-mode extension always shows the bar. For a personal tool the honest answer is: accept the bar, or use the switch.
- Design consequence: attach lazily (right before a move) and detach right after, so the bar is transient; or attach once per game and detach on game end.

Does the attachment survive SW suspension? From source, `ExtensionDevToolsClientHost::Attach()` does:
```cpp
service_worker_keepalive_ = process_manager->IncrementServiceWorkerKeepaliveCount(
    *extension_service_worker_id_,
    content::ServiceWorkerExternalRequestTimeoutType::kDoesNotTimeout,
    Activity::DEBUGGER, /*extra_data=*/std::string());
```
i.e. on Chrome 118+ an attached debugger holds a **non-timing-out keepalive on the SW**; the SW will not be idle-terminated while attached, so the question of persistence across suspension does not arise. The client host is closed (and the debuggee detached) on `OnExtensionUnloaded` (reload/update/disable), profile destruction, app termination, or `AgentHostClosed`. Practical implications: (1) on 116/117 the attachment is torn down when the SW dies, so either set `minimum_chrome_version: 118` or keep attachments short-lived; (2) an extension reload always detaches; (3) on SW restart you must rebuild your in-memory "attached tabs" map from `chrome.debugger.getTargets()` (filter `attached && tabId`) rather than from `storage.session`.

`Input.dispatchMouseEvent` full parameter list (tot):
- `type` (string, required): `mousePressed | mouseReleased | mouseMoved | mouseWheel`
- `x`, `y` (number, required): "coordinate of the event relative to the main frame's viewport in CSS pixels."
- `modifiers` (integer, default 0): Alt=1, Ctrl=2, Meta/Command=4, Shift=8
- `timestamp` (TimeSinceEpoch, optional)
- `button` (`none | left | middle | right | back | forward`, default `none`)
- `buttons` (integer): Left=1, Right=2, Middle=4, Back=8, Forward=16, None=0
- `clickCount` (integer, default 0)
- `force` (number [0,1], default 0)
- `tangentialPressure` (number [-1,1], default 0)
- `tiltX`, `tiltY` (number, degrees [-90,90], default 0)
- `twist` (integer, degrees [0,359], default 0)
- `deltaX`, `deltaY` (number, CSS px, wheel only, default 0)
- `pointerType` (`mouse | pen`, default `mouse`)

Coordinates: **CSS pixels relative to the main-frame viewport** — the same space as `element.getBoundingClientRect()` in the top document. No devicePixelRatio or browser-zoom correction is needed on a normal tab (both getBoundingClientRect and CDP use the same zoomed CSS px space). DPR only matters if you also apply `Emulation.setDeviceMetricsOverride` with a `deviceScaleFactor`, which you should not do here. If the board ever lives in an iframe, add the iframe's own `getBoundingClientRect()` offset to reach main-frame coordinates. Get square centres from the content script (`rect.left + (file+0.5)*rect.width/8`, accounting for board flip), send them to the SW, and dispatch: `mouseMoved` → `mousePressed(button:'left', buttons:1, clickCount:1)` → `mouseReleased(button:'left', buttons:0, clickCount:1)` with small randomized delays; chess.com accepts click-click, lichess accepts click-click too, and both accept press-move-release drags (`mousePressed`, several `mouseMoved` with `buttons:1`, `mouseReleased`).

Other useful CDP calls (all in the allowed domain list):
- `Input.dispatchDragEvent({type: dragEnter|dragOver|drop|dragCancel, x, y, data: DragData{items:[{mimeType,data,title?,baseURL?}], files?, dragOperationsMask}, modifiers?})` — for HTML5 DnD, which chess sites do not use (they use pointer events), so prefer mouse drags.
- `Input.setIgnoreInputEvents({ignore: boolean})` — blocks real user input while you dispatch; probably not wanted.
- `Emulation.setFocusEmulationEnabled({enabled})` — marked **experimental**; makes the page believe it is focused ("emulates a page that is focused and actively being used"). Handy if the site gates board interaction on `document.hasFocus()` while the side panel has focus. Experimental commands are still callable via `chrome.debugger` but may change.
- `Page.bringToFront()` — not experimental; activates the tab.
- `Page.getLayoutMetrics()` — `cssLayoutViewport` / `cssVisualViewport` in CSS px if you need to verify viewport geometry.

### Debugger attach helper with onDetach handling

```ts
// debugger.ts (service worker)
type Debuggee = { tabId: number };
const PROTOCOL = '1.3';
const attached = new Map<number, Promise<void>>(); // tabId -> in-flight attach

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (tabId == null) return;
  attached.delete(tabId);
  // reason: 'canceled_by_user' (infobar Cancel) | 'target_closed'
  chrome.runtime.sendMessage({ type: 'debugger:detached', tabId, reason }).catch(() => {});
});

async function isAttached(tabId: number): Promise<boolean> {
  const targets = await chrome.debugger.getTargets();
  return targets.some(t => t.tabId === tabId && t.attached);
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return attached.get(tabId)!;
  const p = (async () => {
    if (await isAttached(tabId)) return; // survived a SW restart (Chrome 118+ keeps SW alive anyway)
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes('Another debugger is already attached')) {
        throw new Error('DevTools or another extension is attached to this tab; close it and retry.');
      }
      if (msg.includes('Cannot attach to this target')) {
        throw new Error('This page cannot be automated (restricted URL or policy).');
      }
      throw e;
    }
  })();
  attached.set(tabId, p);
  try { await p; } catch (e) { attached.delete(tabId); throw e; }
}

export async function send<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
  await ensureAttached(tabId);
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

export async function detach(tabId: number): Promise<void> {
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
}

export async function clickAt(tabId: number, x: number, y: number): Promise<void> {
  const jitter = () => 30 + Math.random() * 60;
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await new Promise(r => setTimeout(r, jitter()));
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, jitter()));
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
```

Chrome Web Store: `debugger` is a sensitive permission that forces manual review and a written justification in the "Privacy practices" tab; expect "Use of Permissions" pushback if the justification is weak, and note that the CWS policy explicitly allows executing remote logic *only* via documented APIs like the Debugger API and User Scripts API (https://developer.chrome.com/docs/webstore/program-policies/policies, https://developer.chrome.com/docs/webstore/troubleshooting). A chess-assist tool that clicks on chess.com is very likely to be rejected on other grounds (site ToS / "circumventing" behaviour) regardless of permissions, so plan on **self-distribution** (Q11).

---

## 6. `chrome.commands`

Docs: https://developer.chrome.com/docs/extensions/reference/api/commands

- No permission required; declare a `"commands"` manifest key.
- Manifest:
  ```json
  "commands": {
    "make-best-move": {
      "suggested_key": { "default": "Ctrl+Shift+Space", "mac": "Command+Shift+Space" },
      "description": "Play the engine's best move on the current board"
    },
    "_execute_action": {
      "suggested_key": { "default": "Ctrl+Shift+Y", "mac": "Command+Shift+Y" }
    }
  }
  ```
- Limits: "An extension can have many commands, but may specify at most four suggested keyboard shortcuts." Users assign more at `chrome://extensions/shortcuts`. Combos must include `Ctrl` or `Alt` (on macOS `Ctrl` is mapped to `Command`; use `MacCtrl` for Control); `Shift` optional; `Ctrl+Alt` combos are disallowed (AltGr); media keys cannot be combined with modifiers. Allowed keys: A–Z, 0–9, Comma, Period, Home, End, PageUp, PageDown, Space, Insert, Delete, arrows, media keys.
- `"global": true` makes the shortcut fire when Chrome is not focused; "Keyboard shortcut suggestions for global commands are limited to Ctrl+Shift+[0..9]"; not supported on ChromeOS. Note "global" here means OS-wide, which you do *not* need — a normal (non-global) command already works from any tab in Chrome, including while focus is in the side panel.
- `_execute_action` "doesn't dispatch onCommand"; it triggers the action click. With `setPanelBehavior({openPanelOnActionClick:true})`, the action click opens the side panel, and the Edge docs for the same API state that with that behavior set "the user can open the sidebar by using a keyboard shortcut ... specify an action command in the manifest" (https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/sidebar). Chrome's own doc does not spell this out; the safest, fully documented path is a custom command whose `onCommand` handler calls `chrome.sidePanel.open({windowId: tab.windowId})` — a command counts as a user gesture per the sidePanel doc.
- `chrome.commands.onCommand.addListener((command: string, tab?: chrome.tabs.Tab) => ...)` — `tab` is the active tab when the command fired; ignore the event when `tab.url` is not a chess site.
- On install, call `chrome.commands.getAll()` and surface unassigned shortcuts (`shortcut === ''`) in the panel with a link to `chrome://extensions/shortcuts` (Chrome blocks the shortcut when it collides with another extension's).

Commands vs. in-page key capture (content-script `keydown`):
- Commands: work regardless of which element has focus (incl. side panel, address bar), cannot be swallowed by the page, are user-configurable, are a user gesture (so you may call `sidePanel.open`), and wake the SW. Cannot use unmodified keys (e.g. bare `Space`), and the user must not have reassigned them.
- Content-script capture: any key (e.g. a bare `\`` or `Space`), but only while the page has focus, the page can `stopImmediatePropagation` (use `capture: true` on `window` at `document_start` to win), and typing in chat boxes needs guarding. Not a user gesture for `sidePanel.open` after the async hop to the SW.
- Recommendation: `chrome.commands` for "make best move" and "toggle panel"; optional in-page key as a convenience with a settings toggle.

---

## 7. Content scripts in MV3

Docs: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts, manifest ref https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts, scripting API https://developer.chrome.com/docs/extensions/reference/api/scripting

- Manifest `content_scripts[]` keys: `matches` (required), `exclude_matches`, `js`, `css`, `run_at` (`document_start|document_end|document_idle`, default idle), `world` (`ISOLATED|MAIN`, default ISOLATED — **manifest `world` is Chrome 111+**), `all_frames`, `match_about_blank`, `match_origin_as_fallback`, `include_globs`/`exclude_globs`.
- `document_start`: "injected after any files from css, but before any other DOM is constructed or any other script is run." That is the guarantee you need to hook the site's board component before it initialises: a synchronous MAIN-world script at `document_start` runs before any page `<script>` executes (the document has only the `<html>` element, no `<head>`/`<body>` yet). Anything you need at that moment must be synchronous — no `await chrome.storage...` first — so patch prototypes/`Object.defineProperty` hooks immediately and read configuration later via postMessage from the ISOLATED script.
- MAIN world caveats: runs under the **page's CSP**, not the extension's (chess.com/lichess CSP does not restrict inline extension-injected script files since Chrome injects them directly, but `eval` and inline `<script>` text you create yourself are subject to the site CSP); it has no `chrome.*` APIs except nothing (`chrome.runtime` is not exposed to MAIN); the page can see and tamper with it; keep it minimal and un-obvious.
- `chrome.scripting.executeScript({target:{tabId, frameIds?, allFrames?}, files|func, args, world: 'MAIN'|'ISOLATED' (Chrome 95+), injectImmediately: true (Chrome 102+)})`. `injectImmediately` skips the wait for `document_idle` but cannot retroactively reach `document_start`; for a hook-before-init requirement use the manifest entry or `registerContentScripts`, not `executeScript`.
- `chrome.scripting.registerContentScripts([{id, matches, js, css?, runAt:'document_start', world:'MAIN' (Chrome 102+), allFrames?, persistAcrossSessions (default true), matchOriginAsFallback (119+)}])`, plus `getRegisteredContentScripts`, `updateContentScripts`, `unregisterContentScripts`. Requires `"scripting"` permission plus host permissions for the matched sites. Use this only if the site list is user-configurable; otherwise the manifest is simpler.
- MAIN ⇄ ISOLATED communication: they share the DOM but not JS globals. Use `window.postMessage(msg, location.origin)` and filter on `event.source === window` and a private `__ns` tag, or `document.dispatchEvent(new CustomEvent('x', {detail}))`. Both are visible to the page, so treat the channel as untrusted and never send secrets over it. The ISOLATED script relays to the SW via `chrome.runtime.connect`. Pattern:

  ```js
  // main.js (world: MAIN, document_start) — hook first, talk later
  const NS = '__sg_' + Math.random().toString(36).slice(2);
  // ... install hooks synchronously here ...
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.ns !== 'sg-iso') return;
    // handle requests from the isolated script
  });
  window.postMessage({ ns: 'sg-main', type: 'ready' }, location.origin);
  ```
  ```js
  // isolated.js (world: ISOLATED, document_start)
  const port = chrome.runtime.connect({ name: 'content' });
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.ns !== 'sg-main') return;
    port.postMessage(e.data);
  });
  ```
- Ordering: list the MAIN script and the ISOLATED script as separate `content_scripts` entries; both at `document_start` on the same `matches`. Chrome injects manifest content scripts in declaration order within a world, but ordering *between* worlds is not documented as guaranteed — do not depend on which runs first; have the MAIN script buffer until it sees `ready` from ISOLATED, or vice versa.

---

## 8. MV3 CSP and remote code

Docs: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy, https://developer.chrome.com/docs/extensions/develop/migrate/improve-security

- Default `extension_pages` CSP: `script-src 'self'; object-src 'self';`
- Minimum (cannot be relaxed further): `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`. "You cannot add other script sources to directives, such as adding 'unsafe-eval' to script-src." Attempting to add `'unsafe-eval'` or a remote host to `script-src`/`object-src`/`worker-src` makes the manifest fail to load. Localhost sources are permitted for unpacked extensions only. `'wasm-unsafe-eval'` is what replaces the old `'unsafe-eval'` for the WASM engine; `WebAssembly.instantiate` from a packaged `.wasm` works with it.
  ```json
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  }
  ```
- `sandbox` CSP default: `sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';`. Sandboxed pages (`"sandbox": {"pages": [...]}`) may `eval`, but have no `chrome.*` access and a null origin; only relevant if the engine loader needs `eval`, which a modern Emscripten/wasm-bindgen build does not.
- Remote code: the CWS policy forbids "JavaScript files pulled from the developer's server", "any library hosted on a CDN", and bundled libraries that fetch remote code. **Remote stylesheets and fonts are not scripts**: the extension CSP only pins `script-src`/`object-src`/`worker-src`, `style-src`/`font-src`/`img-src`/`connect-src` are unrestricted by default, and the migrate guide even lists injecting remote stylesheets as an allowed exception. So a Google Fonts `<link>` in the side panel technically loads. Still bundle fonts: it removes a network dependency for a panel that must render offline/fast, and reviewers sometimes flag any remote host in an extension page. Data fetches (`fetch()` to your own API for auth) are fine — that is data, not code.

---

## 9. `web_accessible_resources` (MV3)

Docs: https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources

```json
"web_accessible_resources": [
  {
    "resources": ["injected/*.js", "assets/*.woff2"],
    "matches": ["https://www.chess.com/*", "https://chess.com/*", "https://lichess.org/*"],
    "use_dynamic_url": true
  }
]
```
- `resources`: paths/globs relative to the root.
- `matches`: match patterns; "Only the origin is used to match URLs" (path parts are ignored).
- `extension_ids`: other extensions allowed to load them (omit).
- `use_dynamic_url` (Chrome 108+ effective): resource is reachable only via `chrome.runtime.getURL()`'s per-session dynamic ID (`chrome-extension://<random>/...`), "regenerated when the browser restarts or the extension reloads", which stops the site fingerprinting your extension by its static ID. Note: with manifest `world: "MAIN"` scripts you do not need web-accessible resources at all — that was the MV2 `<script src=chrome-extension://…>` injection trick. Only declare resources the page actually needs to fetch (e.g. images/fonts you insert into the page).

---

## 10. Permissions map

Docs: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions, https://developer.chrome.com/docs/extensions/reference/permissions-list

- `"permissions"` = named API capabilities; `"host_permissions"` = match patterns granting site access (fetch, tab URLs, content-script injection, `scripting`, `debugger` attach targets); `"optional_permissions"`/`"optional_host_permissions"` = requested at runtime via `chrome.permissions.request()` (needs a user gesture). Since Chrome ~123 the CWS/Chrome may treat broad host permissions as "user-controlled"; keep host permissions to the two chess origins.

| Name | Type | Warning shown at install | Notes for this extension |
|---|---|---|---|
| `storage` | permission | none | Needed. Not available in offscreen doc. |
| `debugger` | permission | "Access the page debugger backend" + "Read and change all your data on all websites" | Forces manual CWS review. |
| `sidePanel` | permission | none | Chrome 114+. |
| `offscreen` | permission | none | Chrome 109+. |
| `scripting` | permission | none | Only needed for `executeScript`/`registerContentScripts`; manifest content scripts do not need it. |
| `alarms` | permission | none | Optional keep-alive/polling; min 0.5 min. |
| `tabs` | permission | "Read your browsing history" | **Not needed**: `tab.url`/`title` are already exposed for tabs matching your `host_permissions`. Skip it to avoid the warning. |
| `activeTab` | permission | none | Grants temporary host access to the current tab on a user gesture (action click, command). Useful as a fallback for `scripting.executeScript` on a page you did not list; does not enable `debugger`. |
| `notifications` | permission | "Display notifications" | Optional. |
| `tts` | permission | none | `chrome.tts.speak(text, {rate, pitch, voiceName, lang, enqueue, onEvent})`, `getVoices()`, `stop()`; promise-based since Chrome 101; callable from the SW, so move-announcement no longer needs `speechSynthesis` in the content script (which the site could observe). https://developer.chrome.com/docs/extensions/reference/api/tts |
| `idle` | permission | none | Only if you want to pause the engine when the user is idle. |
| `commands` | manifest key, not a permission | n/a | |
| `host_permissions` `https://www.chess.com/*`, `https://chess.com/*`, `https://lichess.org/*` | host | "Read and change your data on chess.com and lichess.org" | Required for content scripts and for `tab.url` in `tabs.onUpdated`. |

Suggested manifest core:
```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "118",
  "permissions": ["storage", "debugger", "sidePanel", "offscreen", "tts"],
  "host_permissions": ["https://www.chess.com/*", "https://chess.com/*", "https://lichess.org/*"],
  "background": { "service_worker": "sw.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "Open engine panel" },
  "commands": { "make-best-move": { "suggested_key": { "default": "Ctrl+Shift+Space", "mac": "Command+Shift+Space" }, "description": "Play best move" } },
  "content_scripts": [
    { "matches": ["https://www.chess.com/*", "https://lichess.org/*"], "js": ["cs/main.js"], "run_at": "document_start", "world": "MAIN" },
    { "matches": ["https://www.chess.com/*", "https://lichess.org/*"], "js": ["cs/isolated.js"], "run_at": "document_start" }
  ],
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  "cross_origin_embedder_policy": { "value": "require-corp" },
  "cross_origin_opener_policy": { "value": "same-origin" }
}
```

---

## 11. Distribution outside the Chrome Web Store (2026)

Docs: https://developer.chrome.com/docs/extensions/how-to/distribute, https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux, https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions, enterprise: https://support.google.com/chrome/a/answer/7532015, https://chromeenterprise.google/policies/extension-install-forcelist/

What still works:
1. **Developer mode, "Load unpacked"** (all platforms). No auto-update; user re-loads. Shows the "Disable developer mode extensions" nag on startup. This is what the MV2 extension almost certainly relied on and it remains fully supported.
2. **Drag-and-drop / Load a `.crx`** — effectively dead for normal users: "As of Chrome 33, no external installs are allowed from a path to a local CRX file on Windows", "As of Chrome 44 ... on Mac OS". On Win/Mac a CRX is only installable if its `update_url` is the Web Store or the install comes via policy.
3. **Self-hosted CRX with `update_url`** — "Linux is the only platform where Chrome users can install extensions that are hosted outside of the Chrome Web Store." Manifest `"update_url": "https://host/updates.xml"`, Omaha XML (`<gupdate><app appid=ID><updatecheck codebase="https://host/ext.crx" version="x.y"/></app></gupdate>`), CRX signed with the same private key, server must not send `X-Content-Type-Options: nosniff`, no cookies. On Linux the external-extensions JSON (`/usr/share/google-chrome/extensions/<id>.json` with `external_update_url`) installs silently.
4. **Enterprise policy** (Windows/macOS/Linux/ChromeOS): `ExtensionInstallForcelist` (`"<id>;https://host/updates.xml"`) or `ExtensionSettings` (`installation_mode: "force_installed"|"normal_installed"`, `update_url`, `override_update_url`). On **Windows** only when the machine is AD/Entra-joined or enrolled in Chrome Enterprise Core; on **macOS** only when managed via MDM/MCX or Chrome Enterprise Core. A hand-written registry key / plist on an unmanaged machine is ignored (Chrome marks such policies as untrusted). Policy install has two side benefits relevant here: no developer-mode nag, and **no debugger infobar** (`Manifest::IsPolicyLocation`).
5. **CWS unlisted** — still goes through review; with `debugger` + chess-site automation this is unlikely to pass.

Practical recommendation for a self-distributed tool: ship a zipped unpacked build with an in-panel "update available" check against your own version endpoint (data fetch is allowed), and document the Linux `update_url` and enterprise-policy paths for users who can use them. Do not build the plan around a self-hosted CRX for Win/Mac.

---

## Typed `chrome.runtime.connect` port helper

Works from side panel, offscreen document, and ISOLATED content scripts (all have `runtime.connect`); the SW side uses `onConnect`. Remember (Q4) that on Chrome 114+ an idle port does not keep the SW alive; messages do.

```ts
// shared/port.ts
export type Envelope<T extends string = string, P = unknown> = { id?: number; type: T; payload?: P; error?: string };

export type ToOffscreen =
  | { type: 'engine:init'; payload: { threads: number; hash: number } }
  | { type: 'engine:go'; payload: { fen: string; depth?: number; movetime?: number } }
  | { type: 'engine:stop' };
export type FromOffscreen =
  | { type: 'engine:ready' }
  | { type: 'engine:info'; payload: { depth: number; score: number; pv: string[] } }
  | { type: 'engine:bestmove'; payload: { move: string; ponder?: string } };

type Handler<M> = (msg: M, port: chrome.runtime.Port) => void;

export class TypedPort<Out extends Envelope, In extends Envelope> {
  private port: chrome.runtime.Port | null = null;
  private handlers = new Map<In['type'], Set<Handler<In>>>();
  private pending = new Map<number, { resolve: (v: In) => void; reject: (e: Error) => void; timer: number }>();
  private seq = 0;
  private closed = false;
  private onDisconnectCbs = new Set<() => void>();

  constructor(private readonly name: string, private readonly reconnect = true) {}

  connect(): this {
    this.closed = false;
    const port = chrome.runtime.connect({ name: this.name });
    this.port = port;
    port.onMessage.addListener((raw: In) => this.dispatch(raw, port));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message; // e.g. SW died or receiving end missing
      this.port = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(err ?? 'port disconnected')); }
      this.pending.clear();
      this.onDisconnectCbs.forEach(cb => cb());
      if (this.reconnect && !this.closed) setTimeout(() => this.connect(), 250);
    });
    return this;
  }

  /** Adopt a port received in chrome.runtime.onConnect (service-worker side). */
  static adopt<Out extends Envelope, In extends Envelope>(port: chrome.runtime.Port): TypedPort<Out, In> {
    const tp = new TypedPort<Out, In>(port.name, false);
    tp.port = port;
    port.onMessage.addListener((raw: In) => tp.dispatch(raw, port));
    port.onDisconnect.addListener(() => { tp.port = null; tp.onDisconnectCbs.forEach(cb => cb()); });
    return tp;
  }

  on<T extends In['type']>(type: T, fn: Handler<Extract<In, { type: T }>>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(fn as Handler<In>);
    this.handlers.set(type, set);
    return () => set.delete(fn as Handler<In>);
  }

  onDisconnect(cb: () => void): () => void { this.onDisconnectCbs.add(cb); return () => this.onDisconnectCbs.delete(cb); }

  send(msg: Out): void {
    if (!this.port) throw new Error(`port "${this.name}" not connected`);
    this.port.postMessage(msg);
  }

  /** Request/response: the peer must echo `id` on its reply. */
  request<R extends In>(msg: Out, timeoutMs = 10_000): Promise<R> {
    const id = ++this.seq;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${msg.type}`)); }, timeoutMs) as unknown as number;
      this.pending.set(id, { resolve: resolve as (v: In) => void, reject, timer });
      this.send({ ...msg, id } as Out);
    });
  }

  close(): void { this.closed = true; this.port?.disconnect(); this.port = null; }

  private dispatch(raw: In, port: chrome.runtime.Port) {
    if (raw.id != null && this.pending.has(raw.id)) {
      const p = this.pending.get(raw.id)!; this.pending.delete(raw.id); clearTimeout(p.timer);
      raw.error ? p.reject(new Error(raw.error)) : p.resolve(raw);
      return;
    }
    this.handlers.get(raw.type as In['type'])?.forEach(fn => fn(raw, port));
  }
}
```

Service-worker side routing:

```ts
// sw.ts
chrome.runtime.onConnect.addListener((port) => {
  const senderTab = port.sender?.tab?.id;
  switch (port.name) {
    case 'sidepanel': {
      const p = TypedPort.adopt<FromSW, ToSW>(port);
      p.onDisconnect(() => { /* panel closed for this window */ });
      break;
    }
    case 'content': { /* keyed by senderTab */ break; }
    case 'offscreen': { /* engine channel */ break; }
  }
});
```

---

## Key facts the plan should encode

1. MV2 is gone everywhere (Chrome 139 removed the last policy exemption; CWS purged MV2 on 2026-08-31).
2. `minimum_chrome_version` 118 is the sweet spot: sidePanel.open (116), getContexts (116), debugger keeps SW alive (118).
3. Offscreen doc: only `chrome.runtime` is available, one at a time, no idle timer, `WORKERS` reason exists, `hasDocument()` is Chrome 150+ so use `runtime.getContexts`. COEP/COOP manifest keys give `crossOriginIsolated` in the offscreen page and its dedicated workers, not in the SW.
4. Ports: opening does not keep the SW alive; messages do. Debugger attachment does (118+).
5. Debugger infobar is suppressible only by `--silent-debugger-extension-api` or policy-install. `kDebuggerAPIRestrictedToDevMode` exists but is disabled by default — keep a non-debugger input fallback.
6. `Input.dispatchMouseEvent` x/y are viewport CSS px, same as `getBoundingClientRect()`; no DPR math on normal tabs.
7. `'wasm-unsafe-eval'` is allowed in `extension_pages` CSP, `'unsafe-eval'` is not; remote JS forbidden, remote CSS/fonts technically allowed but bundle them.
8. Manifest `world: "MAIN"` needs Chrome 111; `document_start` runs before any page script; keep the MAIN hook synchronous.
9. Do not request `tabs`; host permissions already expose `tab.url` for chess.com/lichess and avoid the "browsing history" warning.
10. Win/Mac self-hosted CRX is enterprise-policy-only; plan on developer-mode unpacked distribution plus an in-app update notice.


# Appendix C — chess.com and lichess board adapters

> Decision note (Part I §9.1): the synthetic-pointer-event and site-API routes discussed in §1.9, §2.9 and §6.1 of this appendix are NOT used. Only trusted CDP input (and later the native backend) ships. The DOM/selector material is normative for Task 20.


Method: source reading of open-source scrapers/userscripts found via GitHub code search, lichess's own `lila` and `chessground` repos, and **live DOM verification with Chrome DevTools on 2026-09-03** against `lichess.org/tv` (round UI, spectator), `lichess.org/analysis`, `chess.com/game/live/173765478164` (archived live game), `chess.com/play/computer` (playable board), `chess.com/play/online` (lobby). Anything marked **[live-verified]** was observed in the browser today; everything else carries a confidence tag.

Confidence legend: **high** = live-verified or in first-party source; **medium** = seen in ≥2 recent third-party projects but not verified today; **low** = single source or older.

---

## 0. Executive summary (what changed vs. the 2023 code)

| Area | 2023 assumption | 2026 reality |
|---|---|---|
| chess.com board | `.board` | `wc-chess-board.board#board-single` (live/archived/`/play/online`), `#board-play-computer` (vs bot). `.board` class still present. **[live-verified]** |
| chess.com FEN | replay SAN list via chess.js | `document.querySelector('wc-chess-board').game.getFEN()` returns a **full FEN** incl. castling/ep/counters, in MAIN world. **[live-verified]** DOM fallback: `.piece.wp.square-52`. |
| chess.com move list | `.move .white/.black` + `data-figurine` | `wc-simple-move-list .main-line-row[data-whole-move-number] > .node.white-move/.black-move.main-line-ply[data-node="0-<ply-1>"] > span.node-highlight-content(.selected)`. **[live-verified]** Figurine spans still exist but current markup rendered plain SAN text. |
| chess.com clocks | `.clock-bottom`, `clock-player-turn` | Still valid: `.clock-component.clock-{top,bottom}.clock-{white,black}[.clock-player-turn] span.clock-time-monospace[role=timer]` showing `m:ss.t` under 20s. **[live-verified]** |
| chess.com input | synthetic pointer events | **Still accepted**: synthetic `PointerEvent` pointerdown/pointerup on `wc-chess-board` moved e2→e4 with `moveMethod:'drag'` set and an overlay on top. No `isTrusted` gate. **[live-verified]** |
| chess.com arrows | none | `game.markings.addOne({type:'arrow',data:{from,to,color}})` draws a native arrow into `svg.arrows polygon.arrow[data-arrow=e2e4]`; `type:'highlight'` adds `div.highlight.square-XY`. **[live-verified]** |
| lichess move list | `.flip` sibling, `kwdb` | **Tag names are deliberately obfuscated and were rotated on 2026-07-03** (`kwdb/i5z/l4x/rm6/rb1` → `Z7yx/qZM/aPp/i5d/bo3`). Prior rotations 2019-05, 2023-01. Do not hardcode; detect structurally (see §2.3). **[live-verified + lila source]** |
| lichess clocks | `.rclock-bottom.running` | Still valid: `div.rclock.rclock-{top,bottom}.rclock-{white,black}[.running][.emerg] > div.time` with `<sep>`/`<tenths>` children. **[live-verified]** |
| lichess input | synthetic mouse events | **Blocked.** chessground `drag.start` rejects events unless `e.isTrusted` or `trustAllEvents` (default `false`; lila does not enable it). Verified: synthetic mousedown/pointerdown on `cg-board` do nothing; `chessground().selectSquare()` works but that API is only exposed on analysis pages, **not on round (game) pages**. Keyboard-move input also checks `e.isTrusted`. Only trusted input (CDP `Input.dispatchMouseEvent`) or WebSocket injection works on live games. **[live-verified + source]** |
| lichess globals | `lichess` object | `window.site` (asset/manifest/sound/etc.) and `window.lichess` public API: `events.on('ply', cb)` fires on every round move; `lichess.analysis.playUci()` + `lichess.chessground()` exist only on analysis pages. **[live-verified]** |

---

## 1. chess.com

### 1.1 Page detection (URL patterns)

| Kind | URL | Board id / mode | Confidence |
|---|---|---|---|
| Live game (playing or spectating/archived) | `/game/live/<digits>` | `wc-chess-board#board-single`; `game.getMode().name` = `'playing'` when you play, `'observing'` when archived/spectating **[live-verified: observing]** | high |
| Live lobby / matchmaking | `/play/online`, `/play/online/new`, `/play/online/watch` (spectate), `/live` (legacy, `#g=<id>`) | `#board-single`, mode `'passive-observing'` in lobby **[live-verified]** | high |
| Vs computer | `/play/computer`, `/play/computer/<bot>`, `/play/bots` | `wc-chess-board#board-play-computer`, mode `'playing'`, `getPlayingAs()` = 1 **[live-verified]** | high |
| Daily | `/game/daily/<id>`, `/daily/...` | `.daily-game-footer-component` (Vue) with a save-move step (Chess-Helper `submitDailyMove`) | medium |
| Analysis / game review | `/analysis`, `/analysis/game/live/<id>`, `/analysis/game/pgn/...` | mode `'analysis'` | high (chesshook, puter) |
| Puzzles | `/puzzles`, `/puzzles/rated`, `/puzzles/rush`, `/puzzles/battle` | `wc-chess-board` also present; chesshook branches on `pathname.startsWith('/puzzles')` | high |
| Variants | `/variants/...` | excluded by PreMiD | medium |

Body classes on board pages: `board-layout with-players with-controls with-evaluation` **[live-verified]**. Layout ids: `#board-layout-main, #board-layout-player-top, #board-layout-chessboard, #board-layout-evaluation, #board-layout-pieces, #board-layout-controls, #board-layout-player-bottom, #board-layout-sidebar, #board-layout-comments, #board-layout-ad` **[live-verified]**.

chess.com is an SPA: `location.href` changes without reload (ChesscomBlocker polls `lastHref`; equanimi watches DOM). Re-run `detectPageKind()` on `popstate` + a debounced `MutationObserver` on `document.body` for `wc-chess-board` insertion/removal.

```ts
export type PageKind = 'live-game' | 'live-lobby' | 'vs-computer' | 'daily' | 'analysis' | 'puzzles' | 'other';
export function detectChesscomPageKind(p = location.pathname): PageKind {
  if (/^\/game\/live\/\d+/.test(p)) return 'live-game';
  if (/^\/play\/online/.test(p) || /^\/live\b/.test(p)) return 'live-lobby';   // becomes live-game when board.game.getMode().name==='playing' && getPlayingAs()
  if (/^\/play\/(computer|bots)/.test(p)) return 'vs-computer';
  if (/^\/(game\/daily|daily)/.test(p)) return 'daily';
  if (/^\/analysis/.test(p)) return 'analysis';
  if (/^\/puzzles/.test(p)) return 'puzzles';
  return 'other';
}
```
Refine with the MAIN-world signal: `mode = board.game.getMode().name` ∈ {`playing`,`observing`,`passive-observing`,`analysis`,…} and `board.game.getPlayingAs()` ∈ {1 (white), 2 (black), undefined (not a player)} **[live-verified for 3 of these]**. `mode==='playing' && getPlayingAs()` is the authoritative "I am in a game" test; on `/play/online` a matched game keeps `#board-single` and flips mode to `playing` without a URL change (URL then becomes `/game/live/<id>`).

Sources: chesshook `['/play/computer','/analysis'].some(p => pathname.startsWith(p))` and `/puzzles` (https://github.com/0mlml/chesshook/blob/master/chesshook.user.js); PreMiD chess.com resolver (https://github.com/PreMiD/Activities/blob/main/websites/C/Chess.com/sources/game.ts); equanimi hrefs `/play/online`, `/play/computer` (https://github.com/Thopiax/equanimi); Ramachokkalingam `BOT_URL_PREFIXES = ['/play/computer','/play/bots']` (https://github.com/Ramachokkalingam/chess.com_extension/blob/main/src/content/selectors.ts); chess.com.puter `/^\/analysis\/game\//` (https://github.com/reynoldsnlp/chess.com.puter/blob/main/src/shared/gameStatus.js).

### 1.2 Board element and pieces → FEN

**Board element** **[live-verified]**: `<wc-chess-board class="board" id="board-single" style="--move-animation-duration: 180ms;">`. No shadow DOM (`shadowRoot === null`). Children, in order: `svg.coordinates` (viewBox 0 0 100 100, `text.coordinate-light/.coordinate-dark`), `div.element-pool`, `div.highlight.square-XY` (0–n), `div.hover-square`, `div.piece ...` (one per piece). BoundingClientRect of `wc-chess-board` is exactly the 8×8 playing area (528×528 at default zoom; coordinates are drawn *inside* it as an overlay, not as gutters) — so `rect.width/8` is the square size. Registry (newest first): `wc-chess-board#board-single`, `wc-chess-board#board-play-computer`, `wc-chess-board`, `chess-board` (2020–22 markup), `#board-single`, `.board` (chee, Ramachokkalingam, kibitz, gnomee all use this ladder).

**Orientation**: `.flipped` class on the board element **[medium-high: acas `.board.flipped`, kibitz, notation, cgm; not observed today because the archived game was white-bottom]**. Authoritative: `board.game.getOptions().flipped` (boolean) **[live-verified; chesshook uses it for coordinate math]**. Note `getOptions().isWhiteOnBottom` was `false` on a white-bottom board, so **do not use `isWhiteOnBottom`** — use `flipped`. Fallback heuristic: first `svg.coordinates text.coordinate-light` text is `'1'` when flipped (Mephisto).

**Piece markup** **[live-verified]**: `<div class="piece square-88 wr" style=""></div>`, `<div class="piece wp square-13">` — class order varies (`piece wp square-13` vs `piece square-68 bk`), so match by regex, never by index. `square-XY`: X = file 1..8 (a=1), Y = rank 1..8, i.e. `square-52` = e2. Piece code `[wb][prnbqk]`. While dragging: `.piece.dragging` (Mephisto, cgm) plus `.hover-square.square-XY`. Animations: pieces move via CSS transform for `--move-animation-duration` (180 ms); the class already reflects the destination, so reading during animation is safe for placement but `game.isAnimating()` exists if you want to wait.

**Highlights** **[live-verified]**: `<div class="highlight square-88" style="background-color: rgb(255,255,51); opacity:0.5" data-test-element="highlight" data-test-type="highlight">` — two of them for the last move (colour depends on user theme: yellow `rgb(255,255,51)` on the archived page, green `rgb(16,152,61)` on `/play/computer`). Selected-piece highlight uses the same class, so "last move = the two highlights" is only reliable when nothing is selected (Mephisto filters out the dragging/hover square). Prefer `game.getLastMove()`.

**DOM → piece placement algorithm** (used by AI-Chess-Assistant, kibitz, cgm, chee):

```ts
const PIECE_RE = /\b([wb])([prnbqk])\b/, SQ_RE = /\bsquare-([1-8])([1-8])\b/;
export function chesscomPlacementFromDom(board: Element): string | null {
  const grid: (string|null)[][] = Array.from({length: 8}, () => Array(8).fill(null)); // [rankIdx 0=rank8][fileIdx]
  let count = 0;
  for (const el of board.querySelectorAll('.piece')) {
    if (el.classList.contains('dragging') || el.classList.contains('ghost')) { /* still counts; class carries origin square */ }
    const cls = el.getAttribute('class') || '';
    const p = PIECE_RE.exec(cls), s = SQ_RE.exec(cls);
    if (!p || !s) continue;
    const file = +s[1] - 1, rank = +s[2] - 1;          // 0-based
    const ch = p[1] === 'w' ? p[2].toUpperCase() : p[2];
    if (grid[7 - rank][file]) return null;             // duplicate square => mid-animation/pool; retry
    grid[7 - rank][file] = ch; count++;
  }
  if (count < 2) return null;
  return grid.map(row => { let out = '', e = 0; for (const c of row) { if (c) { if (e) { out += e; e = 0; } out += c; } else e++; } return e ? out + e : out; }).join('/');
}
```
Orientation does **not** affect this (square-XY is absolute). It is only needed for pointer math.

**Full FEN** (castling/ep/halfmove/fullmove): use MAIN-world `board.game.getFEN()` → e.g. `"3rrk1R/R7/8/8/1P5P/P2p2P1/5P2/6K1 b - - 1 45"` **[live-verified]**. Without MAIN world: replay `getMoveList()` SANs through chess.js (§3) and assert the placement equals `chesscomPlacementFromDom()`; chee additionally infers the ep square from the two `.highlight` squares (`detectEnPassantFromSquares`).

### 1.3 Move list

**[live-verified]** structure inside `<wc-simple-move-list class="mode-swap-move-list-wrapper-component ... move-list chessboard-pkg-move-list-component">`:

```html
<div class="timestamps-with-base-time toggle-timestamps" style="--timeMaxValue:320; --timestampWidth:35px">
  <div class="main-line-row move-list-row light-row" data-whole-move-number="1">1.
    <div data-node="0-0" class="node white-move main-line-ply"><span class="node-highlight-content offset-for-annotation-icon">b3 </span></div>
    <div data-node="0-1" class="node black-move main-line-ply"><span class="node-highlight-content offset-for-annotation-icon">g6 </span></div>
    <div data-move-list-el="timestamp" data-ply="1" data-time="1" class="time-white" ...>0.1s</div>
    <div data-move-list-el="timestamp" data-ply="2" data-time="1" class="time-black" ...>0.1s</div>
  </div>
  ...
  <div class="main-line-row move-list-row result-row"><span class="game-result">1-0 </span></div>
</div>
```
- Node selector: `wc-simple-move-list .node.main-line-ply` (excludes variation nodes). `data-node="<line>-<index>"`, index = ply−1 for line 0 (so `data-node="0-88"` = ply 89). `data-ply` now lives only on the **timestamp** divs (`[data-move-list-el=timestamp][data-ply]`), not on nodes — Ramachokkalingam's comment ("`data-ply` is kept as a fallback ... current chess.com does not emit it") matches.
- Current position: `span.node-highlight-content.selected` (`.node .selected`). **[live-verified: `Rh8# `]**. Older fallbacks: `.move-node-highlighted .move-text-component`, `.move-node.selected .move-text` (Mephisto).
- SAN text: `node.querySelector('.node-highlight-content')` → iterate childNodes; if an element child has `data-figurine` (figurine mode: `<span class="icon-font-chess knight-white" data-figurine="N">`) prepend that letter, else use text; then map any Unicode figurine chars ♔♕♖♗♘/♚♛♜♝♞ → KQRBN and strip whitespace (chee `_extractMoveText`). Today the list rendered plain text (`Bb2 `), so both paths must be supported.
- Ply/turn from the list: `ply = index of selected node + 1` (or `nodes.length` if none selected); side to move = `selectedNode.classList.contains('white-move') ? 'b' : 'w'`; if you're not at the end (`selectedIndex < nodes.length-1`) the user is browsing history — the live position is the last node.
- Result: `.result-row .game-result` text ∈ {`1-0`,`0-1`,`1/2-1/2`} **[live-verified]**.
- Legacy list containers (registry): `wc-simple-move-list`, `wc-vertical-move-list`, `wc-horizontal-move-list`, `.move-list`, `.vertical-move-list`, `#move-list` (Ramachokkalingam); node fallbacks `[data-node]`, `[data-ply]`, `.node`, `.move-text`, `.node-highlight-content`.

MAIN-world equivalents: `game.getHistorySANs()` → `["b3","g6","Bb2",...]`, `game.getHistoryFENs()`, `game.getNodeIds()` → `{move:88,line:0}`, `game.getSelectedNode()`, `game.getLastMove()` → `{from:'h7',to:'h8',san:'Rh8#',fen,beforeFen,ply:89,moveNumber:88,wholeMoveNumber:45,piece:'r',color:1,halfMoves,castlingW,castlingB,epSquare,commands:{clk:'0:00:12.6',timestamp:'14'},time:126,...}` **[live-verified]**.

Sources: live DOM; chee (https://github.com/hong4rc/chee/blob/main/src/adapters/chesscom.js); Ramachokkalingam selectors.ts; Mephisto (https://github.com/AlexPetrusca/Mephisto/blob/master/src/scripts/content-script.js); bariskisir `.main-line-row` + `.node` (https://github.com/bariskisir/ChessBot/blob/main/src/extension/content/chessboard.ts).

### 1.4 Clocks

**[live-verified]**:
```html
<div class="clock-component clock-top clock-black clock-player-turn"> ... <div class="clock-icon-icon"><svg class="clock-icon-timer" ...></div> ... <span class="clock-time-monospace" role="timer">0:16.0</span></div>
<div class="clock-component clock-bottom clock-white"> ... <span class="clock-time-monospace" role="timer">0:12.6</span></div>
```
- Active side: `.clock-component.clock-player-turn` has `clock-white` or `clock-black` → side to move (kibitz, cgm, chee). In legacy `/live#g=` pages the class was `clock-playerTurn` (hikaru-gotham-move) — include both in the registry.
- Time text: `span.clock-time-monospace[role=timer]` (annotator, live). Formats seen: `0:16.0` (tenths under ~20 s), `2:59`, `1:00:00` (hours). Parser:
```ts
export function parseClockText(t: string): number { // ms
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d))?$/); if (!m) return NaN;
  const [, h, mm, ss, tenth] = m; return (((+h || 0) * 60 + +mm) * 60 + +ss) * 1000 + (tenth ? +tenth * 100 : 0);
}
```
- Layout anchors: `#board-layout-player-bottom .clock-component` / `#board-layout-player-top .clock-component` (hikaru), `.clock-component.clock-bottom` / `.clock-top` (annotator). PreMiD also lists `[data-cy="clock-time"]` — **not present today** (`data-cy` attrs were absent on all three pages; treat `data-cy` selectors as low confidence).
- MAIN world: `game.timeControl.get()` → `{baseTime:180000, increment:0}`; `game.timestamps.get()` → per-ply tenths `[1,1,1,2,5,3,...]`; `game.times.get()` exists; `game.getLastMove().commands.clk` is the mover's remaining clock string **[live-verified]**. chesshook computes remaining time from `baseTime + increment*n − Σtimestamps`. The board's own `game.clocks` (Chess-Helper types) was **not** present on the observed instance (`clocksKeys: null`).

### 1.5 Player colour and player rows

- **Authoritative**: `board.game.getPlayingAs()` → `1` white, `2` black, `undefined` when not a player **[live-verified]**; `game.getTurn()` → `1`/`2` **[live-verified: 2 with FEN "b"]**.
- DOM: `#board-layout-player-bottom.board-layout-player.board-layout-bottom > .player-component.player-bottom > .player-playerContent > .player-tagline > .cc-user-block-component.cc-user-block-{white,black} > .cc-user-username-component[data-test-element="user-tagline-username"]` **[live-verified]**. `cc-user-block-white/black` on the bottom row gives the bottom colour without the board class. Usernames: `.cc-user-username-component` (new) or `.user-tagline-username` / `.user-username-component` (older; chee, kibitz). cgm reads `#board-layout-player-bottom wc-captured-pieces[player-color]` (`1`/`2`) — element **not present** on the archived page (medium/low).
- Colour = bottom player unless `flipped`; simplest: `flipped ? 'b' : 'w'` when playing (cgm), cross-checked with `getPlayingAs()`.

### 1.6 Game over and new game / rematch

**[live-verified on a finished archived game]**:
- `.game-over-modal-shell-container > .game-over-modal-shell-content.game-over-modal-shell-v6 > .game-over-modal-header-component.game-over-modal-header-{userWon|userLost|whiteWon|blackWon|draw}` with `.game-over-modal-title-component` ("White Won"/"You Won!") and `.game-over-modal-subtitle-component` ("by checkmate"). ChesscomBlocker documents the header classes and notes titles are translated but classes are not (https://github.com/Zinkelburger/ChesscomBlocker/blob/main/src/gameResult.js).
- Sidebar card: `.player-game-over-component` (contains `.rating-score-change`).
- CSS confirms button containers: `.game-over-modal-shell-content .game-over-modal-shell-buttons`, `.new-game-buttons-component`, `.new-game-buttons-buttons button`, `.new-game-buttons-rematch`, `.game-over-buttons-incoming-rematch` **[live-verified in stylesheets]**.
- Rematch/new-game buttons (from 2026 projects, medium): `[data-cy="game-over-modal-new-game-button"]`, `[data-cy="game-over-modal-rematch-button"]`, `[data-cy="sidebar-game-over-new-game-button"]`, `[data-cy="sidebar-game-over-rematch-button"]` (equanimi, chess.com.puter), `[aria-label="Rematch"]`, `[aria-label="New Game"]`, `.game-over-buttons-component`, `.game-review-buttons-component`, text match `/new\s*\d/i` or `/rematch/i` inside `.game-over-modal-container button` (equanimi). Older: `.new-game-buttons-component` first child (your 2023 code), `.board-modal-container-container` (hide-ratings), `.game-over-modal`, `.arena-footer-component > .cc-button-component` (next arena game).
- MAIN world: `game.isGameOver()`, `game.getPositionInfo()` → `{gameOver,check,checkmate,draw,stalemate,threefold,insufficient,fiftyMoveRule,isValid}`, `game.getResult()` → `'1-0'`, `game.getHeaders()` → PGN headers incl. `Termination: "Hikaru won by checkmate"`, `game.getCalculatedResult()` **[live-verified]**. Note `isGameOver()` is position-based; resignation/timeout/abort set `getResult()`/headers and show the modal but may not flip `getPositionInfo().gameOver` — combine.

```ts
function chesscomIsGameOver(g?: ChesscomGame) {
  if (g?.getResult?.() && g.getResult() !== '*') return true;
  if (g?.isGameOver?.()) return true;
  return !!document.querySelector('.game-over-modal-shell-content, .game-over-modal-container, .player-game-over-component, .new-game-buttons-component, .result-row .game-result');
}
function chesscomTryStartNewGame(): boolean {
  const sel = ['[data-cy="game-over-modal-new-game-button"]','[data-cy="sidebar-game-over-new-game-button"]','[aria-label="New Game"]',
    '.game-over-modal-shell-buttons button','.new-game-buttons-buttons button','.new-game-buttons-component button'];
  for (const s of sel) for (const b of document.querySelectorAll<HTMLElement>(s)) if (/new\s*(game|\d)/i.test(b.textContent||'')||s.includes('new-game')) { b.click(); return true; }
  return false;
}
```

### 1.7 MAIN-world `wc-chess-board.game` API (verified surface)

Access: `document.querySelector('wc-chess-board').game`. Requires MAIN world (`"world": "MAIN"` content script, or injected `<script>`); board-master/annotator/Chess-Helper bridge to the isolated world with `window.postMessage`/CustomEvents. Note chesshook is a userscript with `@grant none` and `@run-at document-start`, i.e. it also runs in the page world.

**Method names present on the live object** **[live-verified, 2026-09-03]**: `addMoveToEndOfLine, agreeDraw, animationComplete, blinkSquare, canMoveForward, claimDraw, clearMarkings, createContinuation, createGame, deletePosition, destroy, emit, extendAPI, getCalculatedResult, getContext, getCurrentFullLine, getFEN, getFinalPositionInfo, getFingerprints, getHeaders, getHistoryFENs, getHistorySANs, getJCEGameCopy, getLastMove, getLegalMoves, getLegalMovesForSquare, getLine, getMarkings, getMaterial, getMode, getMove, getNodeByIds, getNodeDiffData, getNodeIds, getOptions, getPGN, getPiece, getPieces, getPlayingAs, getPointerPosition, getPosition, getPositionDetails, getPositionInfo, getRawLines, getRelativeNode, getRenderer, getResult, getSelectedNode, getStartingMoveNumber, getState, getTCN, getTurn, getVariant, getVersion, isAnimating, isAtEndOfLine, isCheck, isDragging, isGameOver, isLegalMove, load, mark, move, moveBackward, moveForward, moveVariation, off, offAll, offMany, on, onAll, onMany, once, outOfTime, overrideAPI, playSound, promoteVariation, reload, resetGame, resetToMainLine, resign, resize, run, selectLineEnd, selectLineStart, selectNode, setGameDetails, setMode, setOptions, setPlayingAs, setRenderer, setResult, setTurn, toggleMarking, undo, unmark, updateLineComment, updateNode, usePlayingAs`. Properties: `eco, effects, highlights, keys, listeners, logger, markings, 'move-list', observing, plugins, sounds, timeControl, times, timestamps, vfx`.

Key calls:
| Call | Returns / effect | Confidence |
|---|---|---|
| `getFEN()` | full FEN string | high (live) |
| `getTurn()` / `getPlayingAs()` | `1`=white, `2`=black (`getPlayingAs` undefined if not playing) | high (live) |
| `getOptions()` | `{flipped, moveMethod:'drag'|'click'|..., premoveDelay, autoPromote, allowMarkings, disableUserMarkings, coordinates, ...}` | high (live) |
| `getLegalMoves()` | `[{from,to,san,promotion?,piece,color,flags}]` (empty when game over / not your turn in observing) | high (chesshook; live: `[]` on finished game) |
| `getLastMove()` | see §1.3 | high (live) |
| `getPositionInfo()` / `isGameOver()` / `getResult()` / `getHeaders()` | see §1.6 | high (live) |
| `getMode().name` | `'playing'|'observing'|'passive-observing'|'analysis'` (mode has `isAllowedToMove`, `plugins`) | high (live) |
| `move('e4')` / `move('e2e4')` / `move({from,to,promotion:'q',animate:false,userGenerated:true})` | plays a move; chesshook uses the object form for promotions **in live games** and string form on `/play/computer` and `/analysis`; Chess-Helper calls it after the pointer events and swallows a thrown error | medium (multiple sources; not live-tested) |
| `on(type, cb)` | event emitter. Types (Chess-Helper typings, 2020–24): `Create, CreateGame, DeletePosition, LineUpdated, Load, ModeChanged, Move, MoveBackward, MoveForward, SelectLineEnd, SelectLineStart, SelectNode, TimeControlUpdated, Undo, UpdateOptions`. `Move` payload `{type:'Move', data:{plyDiff, lineDiff, animate, move:{san, fen, beforeFen, from, to, promotion?, captured, ...}}}` (chessbest reads `data.move.fen`; annotator listens to `CreateGame` for new-game). Live test: wrapping `emit` only observed `UpdateOptions` during `moveBackward()` navigation — internal dispatch may bypass `emit`, so rely on `on('Move')` as documented by ≥4 projects. | medium-high |
| `markings.addOne({type:'arrow',data:{from:'e2',to:'e4',color:'#ff0000'}})` → returns key `'arrow|e2e4'`; `markings.addOne({type:'highlight',data:{square:'d4',color:'#00ff00'}})` → `'highlight|d4'`; `markings.removeOne(keyOrObj)`, `removeAll()`, `getAll()` → `[{type,data,key,id}]`; also `addMany, getMany, getAllWhere, removeAllWhere, removeMany, removeOneWithAnimation, toggleOne, toggleMany` | DOM result: `wc-chess-board svg.arrows > polygon.arrow#arrow-e2e4[data-arrow=e2e4]` (fill = colour, opacity .8); highlight = `div.highlight.square-44` | high (live) |
| `getJCEGameCopy().threats()` | chess-engine copy (chesshook) | medium |
| `timeControl.get()`, `timestamps.get()`, `times.get()` | clocks (§1.4) | high (live) |
| `eco.get()` | opening `{c:'A04', n:'Réti Opening: ...', f, m, ...}` | high (live) |
| `getPieces().getCollection()` | `{e4:{type:'p',color:1,square:'e4',promoted}}` (Chess-Helper) | medium |

Sources: live DOM; Chess-Helper types (https://github.com/everyonesdesign/Chess-Helper/blob/master/app/src/chessboard/component-chessboard/types.ts, index.ts); chesshook; annotator injector (https://github.com/YGao2005/chess-annotator-extension/blob/main/src/content/injector.ts: `game.on('CreateGame')`, `game.on('Move')`, `getHistorySANs`, `getHeaders`, `getResult`, `state.isFlipped`, `eco.get()`); chessbest (https://github.com/thanhdanh27600/chessbest/blob/main/src/core.script.ts); ChessVoiceControl `game.on('Move')`; board-master (https://github.com/M1nhHoang/board-master/blob/main/content/chess/chesscom-page.js, MAIN world + CustomEvent bridge).

### 1.8 Move detection (no 50 ms polling)

Preferred (MAIN world): `game.on('Move', e => emit(e.data.move.fen))` + `game.on('Load'|'CreateGame', ...)` for new games; also re-attach when `wc-chess-board` is replaced (observe `document.body` childList for the element).

Isolated-world fallback:
```ts
const board = document.querySelector('wc-chess-board')!;
const moveList = document.querySelector('wc-simple-move-list');
const clocks = document.querySelectorAll('.clock-component');
const fire = debounce(() => {
  if (board.querySelector('.piece.dragging')) return;         // skip mid-drag
  const placement = chesscomPlacementFromDom(board); if (!placement) return; // duplicate square => still animating; observer will fire again
  const key = placement + '|' + sideToMoveFromClocksOrList();
  if (key !== last) { last = key; cb(buildFen()); }
}, 30);
new MutationObserver(fire).observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); // piece square-XY class flips, highlight inserts
if (moveList) new MutationObserver(fire).observe(moveList, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] }); // new .node, .selected moves
clocks.forEach(c => new MutationObserver(fire).observe(c, { attributes: true, attributeFilter: ['class'] })); // clock-player-turn flips (hikaru-gotham-move does exactly this with attributeOldValue)
```
chee observes `boardEl` with `attributeFilter:['class','style','transform']` + the move list `childList/subtree`; hikaru-gotham-move observes clock `class` with `attributeOldValue`. Debounce ≥ one animation frame; the pool element `div.element-pool` and `.hover-square` churn on hover, so filter to `.piece`/`.highlight` targets inside the callback.

### 1.9 Playing a move by pointer (verified)

**[live-verified on /play/computer, mode `playing`, `moveMethod:'drag'`, intro modal overlaying the board]**: dispatching on the `wc-chess-board` element
`pointerdown`+`pointerup` at e2 centre (selects; a `.highlight.square-52` appeared), then `pointerdown`+`pointerup` at e4 centre → FEN advanced to `... 4P3 ... b KQkq e3 0 1` and `getLastMove()` = e2e4. So: **click-click works, no `isTrusted` requirement, no need for `elementFromPoint`, no mouse* events needed**. chesshook's drag form (`pointerdown` at from, `pointerup` at to, both on the board) is also widely used. Event init used: `{bubbles:true, cancelable:true, composed:true, view:window, clientX, clientY, pointerId:1, pointerType:'mouse', isPrimary:true, button:0, buttons:1|0}`.

The user setting "Piece Movement" (drag / click / both) only changes selection behaviour; chess.com support notes both methods effectively work (https://support.chess.com/en/articles/8708726-how-do-i-make-moves-in-live-chess; forum threads confirm the option is cosmetic) — and our test with `moveMethod:'drag'` passed with click-click.

Square centre math (board rect = playing area, both orientations) — identical to chesshook/Chess-Helper/board-master:
```ts
export function chesscomSquareToPoint(sq: string, rect: DOMRect, flipped: boolean) {
  const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1, s = rect.width / 8;
  return flipped
    ? { x: rect.left + (7 - f) * s + s / 2, y: rect.top + r * s + s / 2 }
    : { x: rect.left + f * s + s / 2,       y: rect.top + (7 - r) * s + s / 2 };
}
```
(Your 2023 formula `left + (col+1)*sq - sq/2` is the same thing.)

**Promotion**: after the pawn lands, chess.com renders `div.promotion-window(.top|.bottom)` inside the board with `.promotion-pieces > .promotion-piece.{wq,wn,wr,wb | bq,bn,br,bb}` and a `.close-button` **[class names live-verified via the page stylesheet; DOM instance not observed]**. Click the piece element itself (`el.click()` / pointer pair at its rect centre) — autochess, notation, cgm, Mephisto (`.promotion-piece` index q=0,n=1,r=2,b=3) all do this; 3D board uses `.promotion-window-3d`. Alternative that needs no DOM: `game.move({from,to,promotion:'q',animate:false,userGenerated:true})` (chesshook uses this for live promotions; Chess-Helper calls it unconditionally). If `getOptions().autoPromote` is true no window appears.

**Premove**: chess.com accepts a click-click during the opponent's turn as a premove (`getOptions().premoveDelay`, `premoveHighlightColor`; API `game.premove`, `getPremoves`, `cancelPremoves` in Chess-Helper types). Highlights for a premove use the premove colour class-less `.highlight.square-XY` (so don't infer last move from highlights while a premove is pending). Not live-tested (the bot replied instantly).

---

## 2. lichess.org

### 2.1 Page detection

| Kind | URL | Markers | Confidence |
|---|---|---|---|
| Round (game) page, as player | `/{gameId8}{playerId4}` = 12-char "fullId" (the socket is `/play/{gameId}{playerId}/v6`; `round-next` URLs are rewritten to `/{gameId}`) | `main.round`, `body.playing.fixed-scroll` (page.scala line 113: `"playing fixed-scroll" -> playing`, flag set by `round/player.scala` when `pov.game.playable`), `.round__app`, `.cg-wrap.manipulable` | high (source) |
| Round page, spectator/finished | `/{gameId8}`, `/{gameId8}/{white|black}`, `/tv`, `/tv/{channel}` | `main.round` (TV: `main.round.tv-single` **[live-verified]**), no `body.playing` | high |
| Analysis | `/analysis`, `/analysis/{variant}`, `/{gameId}/{color}/analysis#ply`, `/study/...` | `main.analyse`, `window.lichess.analysis` + `lichess.chessground` **[live-verified]**, `.tview2` move list | high |
| Puzzles | `/training`, `/training/{theme}`, `/training/{id}`, `/storm`, `/racer`, `/streak` | `main.puzzle`, `body.puzzle`?, `.puzzle__board.main-board` | medium |
| Other with boards | `/@/user`, `/games`, `/broadcast`, `/tournament/{id}`, `/swiss/{id}`, `/simul` | mini boards have `.cg-wrap` but no `manipulable` | medium |

```ts
export function detectLichessPageKind(): PageKind {
  const p = location.pathname, main = document.querySelector('main');
  if (main?.classList.contains('round')) return document.body.classList.contains('playing') ? 'live-game' : 'live-spectate';
  if (main?.classList.contains('analyse') || /^\/(analysis|study)/.test(p)) return 'analysis';
  if (/^\/(training|storm|racer|streak)/.test(p)) return 'puzzles';
  if (/^\/[a-zA-Z0-9]{8}([a-zA-Z0-9]{4})?(\/(white|black))?$/.test(p)) return 'live-game'; // before JS boots
  return 'other';
}
```
lichess is mostly MPA (full page loads), but the round page redirects to a rematch via `location.href` and `socket.in.redirect`; re-init on `DOMContentLoaded` is enough, plus a body observer for `main.round` replacement.

Sources: lila `ui/round/src/round.ts` (socket URL / round-next rewrite), `ui/lib/src/game/router.ts` (`'/' + id + '/' + color`), `app/views/base/page.scala`, `app/views/round/player.scala` (`.flag(_.playing, pov.game.playable)`), boardtrace URL regex (https://github.com/mustafabedirr/boardtrace/blob/main/apps/extension/src/lichess-adapter.ts).

### 2.2 Board DOM → FEN (chessground v10.1.1, stable API)

DOM from `chessground/src/wrap.ts` and **[live-verified]**:
```
div.cg-wrap.orientation-{white|black}[.manipulable][.cgv1]      ← hook element (544.3×544.3 incl. 0.3px border)
  cg-container[style="width:544px;height:544px"]
    cg-board                                                   ← exactly 8×8, same rect as cg-container
      square.last-move[style="transform: translate(204px, 340px)"] ×2
      square.check[style="...; display:none"] / square.selected / square.move-dest(.oc) / square.premove-dest / square.current-premove
      piece.{white|black}.{pawn|knight|bishop|rook|queen|king}[style="transform: translate(Xpx, Ypx)"] (+ .dragging/.fading/.anim)
    svg.cg-shapes-below, svg.cg-custom-below, svg.cg-shapes (viewBox -4 -4 8 8), svg.cg-custom-svgs (viewBox -3.5 -3.5 8 8), cg-auto-pieces
    coords.ranks[.black][.left], coords.files[.black]            ← rendered inside cg-container (coords-in) or outside (coords-out) depending on pref; cg-board rect is unaffected
    piece.ghost, cg-resize
```
Pieces carry **no** `data-key` (lila leaves `pieceKey:false`). Position is encoded purely by the transform (`util.ts posToTranslate`):
`x = (asWhite ? file : 7-file) * width/8`, `y = (asWhite ? 7-rank : rank) * height/8`.

```ts
const XF = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/;
export function lichessPlacementFromDom(board = document.querySelector('cg-board')!): string | null {
  const wrap = board.closest('.cg-wrap')!; const asWhite = !wrap.classList.contains('orientation-black');
  const sq = board.getBoundingClientRect().width / 8; if (!sq) return null;
  const grid = Array.from({length: 8}, () => Array<string|null>(8).fill(null));
  for (const el of board.querySelectorAll<HTMLElement>(':scope > piece')) {          // :scope > excludes piece.ghost in cg-container
    if (el.classList.contains('fading') || el.classList.contains('ghost')) continue;    // captured piece fading out
    const m = XF.exec(el.style.transform || el.getAttribute('style') || ''); if (!m) return null;
    let file = Math.round(+m[1] / sq), row = Math.round(+m[2] / sq);                    // row 0 = top of screen
    if (!asWhite) { file = 7 - file; row = 7 - row; }
    const rank = 7 - row; const role = ['king','queen','rook','bishop','knight','pawn'].find(r => el.classList.contains(r)); if (!role) continue;
    const ch = { king:'k', queen:'q', rook:'r', bishop:'b', knight:'n', pawn:'p' }[role]!;
    if (el.classList.contains('anim')) return null;                                     // mid-animation: transform is interpolated
    grid[7 - rank][file] = el.classList.contains('white') ? ch.toUpperCase() : ch;
  }
  return grid.map(row => { let out = '', e = 0; for (const c of row) { if (c) { if (e) { out += e; e = 0; } out += c; } else e++; } return e ? out + e : out; }).join('/');
}
```
Caveats: during animation chessground sets `.anim` and interpolates the transform (render.ts) — skip and retry; `.dragging` pieces keep their origin transform (Mephisto reads `.ghost` instead, unnecessary for placement). `square.last-move` transforms give the last move's from/to squares (order in DOM is not guaranteed; determine "to" by which square holds a piece — chee/Chessist/BetterMint do this) → usable for ep-square inference.

Sources: chessground `wrap.ts`, `render.ts`, `util.ts` (https://github.com/lichess-org/chessground/blob/master/src/util.ts#L64), live DOM; chee lichess adapter (https://github.com/hong4rc/chee/blob/main/src/adapters/lichess.js); Chessist (https://github.com/imluri/Chessist/blob/main/extension/src/content/lichess.js); cgm lichess board; wd7512 selector audit 2026-06-21 (https://github.com/wd7512/Chess-CNN/blob/main/docs/SELECTOR_AUDIT.md).

### 2.3 Move list (obfuscated, rotating tags)

lila `ui/round/src/view/replay.ts` + `ui/round/css/_constants.scss` define the round move-list tags as constants and **rotate them**: commit `23bbbc42` "update round tag names" (2026-07-03) changed `kwdb→Z7yx` (move), `i5z→qZM` (index), `l4x→aPp` (moves container), `rm6→i5d` (replay wrapper), `rb1→bo3` (buttons). Earlier renames: 2023-01-08 (`update move tag name`), 2023-01-25, 2019-05-12. The active-move class `a1t` (`$active-class`) survived this rotation but is a constant in the same file, so treat it as rotatable too.

**[live-verified 2026-09-03 on /tv]**: `.round__app > i5d > (bo3, app > (qZM "1", Z7yx "Nf3", Z7yx "Nf6", qZM "2", ...))`; active move `Z7yx.a1t`; result appended as `div.result-wrap > p.result ("1-0"|"0-1"|"½-½") + p.status` (replay.ts `renderResult`). `data-ply` exists only on the replay **buttons** (`bo3 button[data-ply]`), not moves. Pending (not yet acked) move is also rendered (2026-07-12 commit).

**Structural detection (do not hardcode tag names)**:
```ts
export function findLichessRoundMoves(): { container: Element; moves: Element[]; index: (m: Element) => number } | null {
  const app = document.querySelector('.round__app'); if (!app) return null;
  // The moves container is the element whose children alternate <indexTag>N</indexTag>, <moveTag>san</moveTag>, <moveTag>san</moveTag>
  const cands = [...app.querySelectorAll('*')].filter(el => el.children.length >= 2 && !/^(DIV|SPAN|BUTTON|A|P|SVG|CG-BOARD|CG-CONTAINER|COORDS)$/.test(el.tagName));
  for (const el of cands) {
    const kids = [...el.children]; const first = kids[0];
    if (/^\d+$/.test(first.textContent!.trim()) && kids.slice(1, 3).every(k => k.tagName !== first.tagName && /^[a-hKQRBNO0-9x+#=\-…]+$/.test(k.textContent!.trim().replace(/[?!½]/g, '')))) {
      const indexTag = first.tagName; const moves = kids.filter(k => k.tagName !== indexTag && k.tagName !== 'DIV' && k.textContent!.trim() !== '…');
      return { container: el, moves, index: m => moves.indexOf(m) };
    }
  }
  return null;
}
```
Then cache the discovered `moveTag`/`indexTag`/`activeClass` (active = the move child whose class list is non-empty and not `text`, or simply the child that changes class when `lichess.events.on('ply')` fires) for the session. Ply = `moves.indexOf(active)+1` (+ `firstPly` offset from the first index number when the game starts from a position: `indexOffset = trunc(firstPly/2)+1`). Fallback registry for older markup: `l4x kwdb` / `kwdb.a1t` (2023–2026-07), `.moves move` / `u8t` (browlichmover), and on analysis pages the **stable** `.tview2 move[.active] > san` + `index` **[live-verified]** — boardtrace and Chessist use the same ladder.

Better alternative on round pages: `window.lichess.events.on('ply', ply => …)` fires from `ctrl.apiMove` on every move with the new ply (public API, `ui/lib/src/api.ts` publicEvents = `['ply','analysis.change','chat.resize','analysis.closeAll','analysis.eval']`); `analysis.change` gives `(fen, path)` on analysis pages. Combine `ply` with `lichessPlacementFromDom()` to avoid the move list entirely; use the list only for SAN replay to get castling/ep.

Sources: lila replay.ts (https://github.com/lichess-org/lila/blob/master/ui/round/src/view/replay.ts), _constants.scss, commit https://github.com/lichess-org/lila/commit/23bbbc42, api.ts (https://github.com/lichess-org/lila/blob/master/ui/lib/src/api.ts), ctrl.ts `pubsub.emit('ply', this.ply)`.

### 2.4 Clocks

`ui/lib/src/game/clock/clockView.ts` **[live-verified]**:
```html
<div class="rclock rclock-top rclock-white running emerg"><div class="bar"></div><div class="time">00<sep class="low">:</sep>09<tenths><sep>.</sep>4</tenths></div></div>
<div class="rclock rclock-bottom rclock-black"><div class="bar"></div><div class="time">00<sep>:</sep>18</div></div>
```
- Classes: `rclock-{top|bottom}`, `rclock-{white|black}`, `running` (= `color === ctrl.times.activeColor`), `emerg` (below emergency threshold), `outoftime`; `div.time.hour` when > 1 h. Correspondence games render `div.rclock.rclock-turn.rclock-{top|bottom} > div.rclock-turn__text` instead (wd7512's audit is right that `.rclock-turn` is not the live-clock indicator).
- Text: `HH:MM:SS`, `MM:SS`, or `MM:SS.t` (tenths when `showTenths(millis)`, i.e. under the pref threshold ~10/20 s; when stopped under 1 s an extra `<huns>` digit). `textContent` of `.time` yields `00:09.4` / `00:18` / `01:00:00` — the same parser as chess.com works (allow `hh:mm:ss`). Tick rate: the DOM updates every 100 ms when tenths are shown, else 500 ms.
- `running` toggles on `.rclock` class → observe `attributes/attributeFilter:['class']` on both `.rclock` elements for turn changes.
Sources: clockView.ts, clockCtrl.ts, clock.ts (https://github.com/lichess-org/lila/tree/master/ui/round/src/view/clock.ts); Chessist, cgm (`.rclock-white.running`), boardtrace.

### 2.5 Colour, game state, rematch

- My colour: `.cg-wrap.orientation-black` → black when playing (`ground.ts boardOrientation` = `player.color` unless the user pressed `f` to flip, in which case `ctrl.flip`; `body.playing` + `.cg-wrap.manipulable` means it's your game). Cross-check: the bottom player row `div.ruser-bottom.ruser.user-link[.online|.offline]` contains `name`/`rating` **[live-verified]**; the running clock's colour vs. `rclock-bottom` tells you whose turn without knowing colours.
- Side to move: `.rclock.running` colour class (high); fallback: parity of move count from §2.3; fallback `.rclock-turn__text` "Your turn" (correspondence).
- Game over: `div.result-wrap > p.result + p.status` appears in the move list (replay.ts); table switches to `renderTableEnd` → `.rcontrols > div.follow-up` with `button.fbt.rematch[.white][.me][.glowing]`, `button.rematch-decline`, `button.fbt.new-opponent`, `a.fbt.analysis`, `a.fbt` (view tournament) (button.ts). Also `.rclock` loses `running` on both, and `body.playing` is removed on a reload. Spectators get `watcherFollowUp` (`a.fbt.text` rematch link).
- In-game controls: `.rcontrols > .ricons > button.fbt.{abort|takeback-yes|draw-yes|resign}` and `.question` prompts (table.ts).
- New game: `button.fbt.new-opponent` → `location.href = poolUrl(...)` or `/?hook_like=<id>` (button.ts). Rematch: `button.fbt.rematch` sends `rematch-yes`; when accepted the page redirects to `/{rematchId}/{color}`. Your 2023 `div.rcontrols a:nth-child(2)` is stale (they are now `button`s inside `div.follow-up`).
- Statuses (`lib/game/status.ts`): `created 10, started 20, aborted 25, mate 30, resign 31, stalemate 32, timeout 33, draw 34, outoftime 35, cheat 36, noStart 37, unknownFinish 38, insufficientMaterialClaim 39, variantEnd 60`; `finished = id >= 30`.

Sources: lila button.ts, table.ts, replay.ts, user.ts, ground.ts, status.ts (https://github.com/lichess-org/lila/tree/master/ui/round/src/view); kway selectors (`follow-up` = game over) (https://github.com/kWAYTV/lichess-bot/blob/main/src/constants/selectors.py); cgm lichess (`.result-wrap`, `.meta .status`).

### 2.6 MAIN-world globals

**[live-verified]** `window.site` keys: `load, info, debug, asset, manifest, sri, displayLocale, blindMode, mousetrap, powertip, unload, redirect, reload, announce, sound, quietMode` (`ui/site/src/site.ts`). `site.asset.url()/jsModule()/loadEsm()` build hashed module URLs from `site.manifest.js` (asset.ts). `site.sound`, `site.mousetrap` (keyboard shortcuts, e.g. `f` = flip).

`window.lichess` (ui/lib/src/api.ts, "available to extensions"): `initializeDom, events{on,off} ('ply','analysis.change','chat.resize','analysis.closeAll','analysis.eval'), socket{subscribeToMoveLatency, events{on,off} ('lag','close','mlat','fen','notifications','endData')}, onlineFriends, chat.post, dialog, overrides`; on analysis pages additionally `analysis: {playUci(uci), navigate}` and `chessground: () => CgApi` **[live-verified: `playUci('e7e5')` played, `chessground().selectSquare('e2'); selectSquare('e4')` moved the pawn]**. On round pages **neither the RoundController nor the chessground instance is exposed** (round.ts keeps `ctrl` local; `lichess.chessground` is set only in `ui/analyse/src/ctrl.ts:238`). Issue tracking programmatic access: https://github.com/lichess-org/lila/issues/16490.

Socket: there is no `site.socket`/`lichess.socket.send`. `lib/socket.ts` listens to the internal `pubsub` (`pubsub.on('socket.send', this.send)`), and `send('move', …)` **requires `o.sign === this._sign`** — otherwise it reports (`rep` "soc:" with a stack trace) and on repeat calls `wsDestroy()`. So emitting `socket.send` from outside is detected. Move payload as sent by the client: `{t:'move', d:{u:'e2e4'|'e7e8q', b?:1 (blurred), l?:lag, s?:millis*0.1 base36, a?:ackId}}` (ctrl.ts `sendMove`/`actualSendMove`, socket.ts). Projects that hijack `WebSocket.prototype.send` in the MAIN world and write `{"t":"move","d":{"u":"e2e4"}}` directly (rafi-haque/chessBot, shahradelahi/chess-grandmaster-extension `LichessWebSocket.sendMove`) bypass that check; the server then echoes `move` and `ctrl.apiMove` updates the board. Also note `ab.ts` (anti-bot) collects input telemetry on `onUserMove`; moves not originating from chessground produce none.

Puzzles: `lichess.puzzle` is typed in api.ts (`puzzle?: any`) — unverified.

### 2.7 Drawing arrows/highlights on lichess

- Analysis pages: `lichess.chessground().setAutoShapes([{orig:'e2', dest:'e4', brush:'green'}])` or `setShapes` (user shapes); brushes: `green #15781B, red #882020, blue #003088, yellow #e68f00, paleBlue, paleGreen, paleRed, paleGrey` (state.ts). Custom colours via `modifiers:{lineWidth}` or `customSvg:{html}`; `{orig, brush}` alone = circle.
- Round pages (no API): insert your **own** `<svg viewBox="0 0 8 8">` (or `0 0 100 100`) as the last child of `cg-container` with `position:absolute; inset:0; pointer-events:none; z-index:3`. Do **not** append into `svg.cg-shapes g` — `svg.ts syncShapes` removes any child whose `cgHash` attribute it doesn't recognise on the next redraw. Coordinates: `cx = (asWhite ? file : 7-file) + 0.5`, `cy = (asWhite ? 7-rank : rank) + 0.5` in board units; re-render on `.cg-wrap` class change (orientation) and on `ResizeObserver` of `cg-container`. Chessist and A.C.A.S's UniversalBoardDrawer do exactly this (overlay appended to `cg-board`/`cg-wrap`).
- Square highlight: same overlay with `<rect>` at the square, or a `<square class="my-hl" style="transform: translate(...)">` inside `cg-board` (chessground's render only touches elements it created via `cgKey`, but `board.innerHTML`-level redraws on `set({fen})` may drop it — overlay SVG is safer).

### 2.8 Move detection on lichess

```ts
// 1) public event (round + analysis)
window.lichess?.events.on('ply', () => schedule());              // fires in ctrl.apiMove after chessground.set
window.lichess?.events.on('analysis.change', (fen) => emit(fen)); // analysis pages: full FEN for free
// 2) DOM (works in isolated world)
const board = document.querySelector('cg-board')!, wrap = board.closest('.cg-wrap')!;
new MutationObserver(schedule).observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] }); // piece transforms + last-move squares
new MutationObserver(schedule).observe(wrap, { attributes: true, attributeFilter: ['class'] });                                          // orientation flip
document.querySelectorAll('.rclock').forEach(c => new MutationObserver(schedule).observe(c, { attributes: true, attributeFilter: ['class'] })); // running flips
const moves = findLichessRoundMoves(); if (moves) new MutationObserver(schedule).observe(moves.container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
// schedule(): debounce ~ animation duration (data.pref.animationDuration, default 250ms) or until no piece.anim remains, then diff placement+sideToMove
```
Skip while `cg-board piece.anim` or `piece.dragging` exists, and while `#promotion-choice` is open (pawn already moved, move not yet sent). chee/Chessist observe `cg-board` with `attributeFilter:['class','style']` plus the move list.

### 2.9 Playing a move on lichess (the hard part)

**Verified gate**: `chessground/src/drag.ts`
```ts
export function start(s: State, e: cg.MouchEvent): void {
  if (!(s.trustAllEvents || e.isTrusted)) return; // only trust when trustAllEvents is enabled
```
`state.ts` default `trustAllEvents:false`; lila's round `ground.ts makeConfig` does not set it. **[live-verified on /analysis]**: synthetic `mousedown`/`pointerdown` on `cg-board` → `state.selected` stays null, FEN unchanged; `chessground().selectSquare('e2'); selectSquare('e4')` → pawn moved. Events bound (events.ts): `mousedown` + `touchstart` on `cg-board` (non-passive), `mousemove/touchmove`, `mouseup/touchend` on `document`, `contextmenu` on board. Click-to-move is enabled unless the user's Preferences → "Piece movement" is drag-only (`selectable.enabled = pref.moveEvent !== MoveEvent.Drag`); premoves on the opponent's turn work through the same click flow (`premovable.enabled = pref.enablePremove`), via `board.selectSquare → userMove → canPremove`.

Keyboard input (`ui/keyboardMove/src/keyboardMove.ts`, needs the "Input moves with the keyboard" preference, `input.ready` in `.keyboard-move`): the `keyup` handler starts with `if (!e.isTrusted) return;` — synthetic keyboard events are also rejected.

Working options, in order of preference:
1. **Trusted input via CDP** (`chrome.debugger` → `Input.dispatchMouseEvent` mousePressed/mouseReleased at the square centres; this is what your 2023 code's "mousePressed/mouseReleased" naming suggests it already did). Produces `isTrusted:true`; works for click-click, promotion (`#promotion-choice square` click) and premoves. Cost: the "is being debugged" infobar.
2. **Analysis pages only**: `lichess.analysis.playUci('e2e4')` or `lichess.chessground().selectSquare()`.
3. **WebSocket injection** (MAIN world, patch `WebSocket.prototype.send`/constructor at `document_start`, keep the socket whose URL matches `/play/{12-char}/v6`, send `{"t":"move","d":{"u":"e2e4"}}`). Bypasses chessground and the client sign check; server-authoritative, board updates from the echoed `move`. Used by rafi-haque/chessBot, chess-grandmaster-extension. Detectable by lila's anti-bot telemetry; not recommended for rated play.
4. `trustAllEvents` cannot be flipped from outside because the state object is not reachable on round pages.

Square centre math (cg-board rect is the 8×8 area; `cg-wrap` adds only a hairline border and, with coords-out, gutters — always use `cg-board`): mirrors `board.ts getKeyAtDomPos` (`file = floor(8*(x-left)/width)`, `rank = 7 - floor(8*(y-top)/height)`, both mirrored when not white POV):
```ts
export function lichessSquareToPoint(sq: string, rect: DOMRect, asWhite: boolean) {
  const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1, s = rect.width / 8;
  return { x: rect.left + (asWhite ? f : 7 - f) * s + s / 2, y: rect.top + (asWhite ? 7 - r : r) * s + s / 2 };
}
```
**Promotion dialog** (`ui/lib/src/game/promotion.ts`, stable since years): `div#promotion-choice.{top|bottom}` appended to `.round__app__board.main-board` (a sibling of `.cg-wrap`), containing four `<square style="top:T%;left:L%"><piece class="{queen|knight|rook|bishop} {white|black}"></piece></square>` in order **queen, knight, rook, bishop** (antichess adds king). `left = 87.5 - (7-file)*12.5` for white orientation (= file*12.5), `(7-file)*12.5` for black; `top = i*12.5` when `color === orientation` (dialog hangs down from the promotion rank at the top of the screen) else `(7-i)*12.5` (stacks upward from the bottom). Click handler is a plain `click` listener bound on each `square` (no isTrusted check) → `el.click()` or a trusted click at the square's rect centre both work; clicking elsewhere on `#promotion-choice` cancels. `#promotion-choice square:nth-child(1)` = queen. Auto-queen preference (`AutoQueen.Always/OnPremove`) suppresses the dialog.

Sources: chessground drag.ts/events.ts/board.ts/state.ts (https://github.com/lichess-org/chessground/tree/master/src); lila ground.ts, promotion.ts (https://github.com/lichess-org/lila/blob/master/ui/lib/src/game/promotion.ts), keyboardMove.ts; live test on /analysis; Mephisto `#promotion-choice` children index q=0,n=1,r=2,b=3; BetterMint App.js `#promotion-choice square`.

---

## 3. Hybrid FEN strategy (both sites)

1. **Fast path** (MAIN world): chess.com `game.getFEN()`; lichess analysis `chessground().getFen()` (placement only) + `lichess.analysis` / `.copyables input` FEN field **[live-verified: `input` value `rnbqkbnr/... w KQkq - 0 1`]**.
2. **SAN replay** (isolated world): `getMoveList()` → `new Chess(startFen).move(san, {strict:false})` (boardtrace does exactly this; handle `P`-less SAN, strip `?!` annotations, `½` draw markers, and figurine letters). Start FEN: chess.com `game.getStartingMoveNumber()`/PGN `FEN` header (Chess960 / puzzles); lichess first index number ≠ 1 ⇒ position-start (use `lichess.analysis` or give up on castling rights and fall back to DOM + heuristic).
3. **DOM placement** `chesscomPlacementFromDom()` / `lichessPlacementFromDom()` as the self-check: if `replayFen.split(' ')[0] !== domPlacement` → the move list is stale/being animated (wait one frame and retry ≤ 5×) or a variation is selected (chess.com `data-node` line ≠ 0) → prefer the DOM placement and derive: side to move from clocks (§1.4/§2.4), castling rights by "king/rook on original square ⇒ still castleable unless the move list says otherwise", ep from the last-move highlight pair (a pawn double-step ⇒ ep square), halfmove 0, fullmove from the move counter. Flag the FEN as `approximate:true` so the engine consumer can skip ep-only tactics.
4. Emit only when `placement+turn` differs from the last emitted; never emit while a piece is dragging/animating or a promotion dialog is open.

---

## 4. `BoardAdapter` interface and per-site implementation notes

```ts
export type Color = 'w' | 'b';
export type Square = `${'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'}${1|2|3|4|5|6|7|8}`;
export type PromoPiece = 'q' | 'r' | 'b' | 'n';
export interface Point { x: number; y: number }
export interface ClockState { ms: number; running: boolean; hasTenths: boolean }
export interface PositionSnapshot { fen: string; approximate: boolean; ply: number; sideToMove: Color; lastMove?: { from: Square; to: Square; san?: string } }
export type PageKind = 'live-game' | 'live-spectate' | 'live-lobby' | 'vs-computer' | 'daily' | 'analysis' | 'puzzles' | 'other';

export interface BoardAdapter {
  readonly site: 'chesscom' | 'lichess';
  detectPageKind(): PageKind;
  isReady(): boolean;                                   // board element found (and MAIN bridge alive, if any)

  getFen(): string | null;                              // full FEN or null if unknown/unstable
  getPlacement(): string | null;                        // DOM-only placement (self-check)
  getSideToMove(): Color | null;
  getMyColor(): Color | null;                           // null when spectating/analysis
  getClock(side: Color): ClockState | null;
  getMoveList(): string[];                              // SAN, main line only
  getPly(): number;                                     // plies played (main line) / current ply if browsing
  isAtLivePosition(): boolean;                          // user not scrolled back in history
  isGameOver(): boolean;
  isMyTurn(): boolean;

  getBoardElement(): HTMLElement | null;
  getBoardRect(): DOMRect | null;                       // 8x8 playing area only
  isFlipped(): boolean;                                 // black at bottom
  squareToPoint(sq: Square): Point | null;              // viewport coords of the square centre
  pointToSquare(p: Point): Square | null;
  getPromotionTargetPoint(dest: Square, piece: PromoPiece): Point | null; // where to click once the dialog is open
  getPromotionTargetElement(dest: Square, piece: PromoPiece): HTMLElement | null;

  onPositionChange(cb: (s: PositionSnapshot) => void): () => void;   // debounced, deduped
  onGameStart(cb: () => void): () => void;
  onGameEnd(cb: (result: '1-0'|'0-1'|'1/2-1/2'|'*') => void): () => void;

  highlight(from: Square, to: Square, opts?: { color?: string; kind?: 'arrow'|'squares' }): void;
  clearHighlights(): void;

  tryStartNewGame(mode?: 'rematch' | 'new'): boolean;   // click; returns whether a control was found
  playMove?(uci: string): Promise<boolean>;             // optional native route (chess.com game.move / lichess analysis API)
  destroy(): void;
}
```

Implementation matrix:

| Method | chess.com | lichess |
|---|---|---|
| `detectPageKind` | §1.1 URL + `game.getMode().name`/`getPlayingAs()` | §2.1 `main.round` + `body.playing`, `main.analyse` |
| `getBoardElement` | registry `wc-chess-board#board-single, wc-chess-board#board-play-computer, wc-chess-board, chess-board, #board-single, .board` | `.round__app cg-board`, `.main-board cg-board`, `cg-board` (skip boards whose `.cg-wrap` lacks `manipulable` unless spectating) |
| `getFen` | MAIN: `game.getFEN()`; else §3 replay + `getPlacement()` check | analysis: `chessground().getFen()` + `.copyables input` FEN; round: §3 replay (via `findLichessRoundMoves`) + `getPlacement()` |
| `getPlacement` | `chesscomPlacementFromDom` (`.piece` + `square-XY`) | `lichessPlacementFromDom` (`piece` transform + orientation) |
| `getSideToMove` | `game.getTurn()===1?'w':'b'`; DOM: `.clock-player-turn` colour class; then move-list parity (`.node.white-move.selected` ⇒ 'b') | `.rclock.running` colour; move-list parity; `chessground().state.turnColor` on analysis |
| `getMyColor` | `game.getPlayingAs()` (1/2); DOM: `#board-layout-player-bottom .cc-user-block-{white,black}` or `flipped?'b':'w'` when `mode==='playing'` | `body.playing` && `.cg-wrap.manipulable` ⇒ `orientation-black?'b':'w'` (unless user flipped with `f`; cross-check bottom `.ruser-bottom` name == `#user_tag` text) |
| `getClock` | `.clock-component.clock-{white,black} .clock-time-monospace` text → `parseClockText`; running = has `.clock-player-turn`/`.clock-playerTurn` | `.rclock.rclock-{white,black} .time` `textContent` → same parser; running = `.running`; tenths = has `<tenths>` |
| `getMoveList` | `wc-simple-move-list .node.main-line-ply` → `.node-highlight-content` (+`data-figurine`); MAIN: `game.getHistorySANs()` | `findLichessRoundMoves().moves` text (strip `…`, `½?` draw marks); analysis: `.tview2 move san` |
| `getPly` / `isAtLivePosition` | index of `.node-highlight-content.selected`; live if it's the last node; MAIN `game.getNodeIds().move+1` vs `getHistorySANs().length`, `isAtEndOfLine()` | active move index; analysis `.tview2 move.active` |
| `isGameOver` | §1.6 | `.result-wrap`, `.follow-up`, no `.rclock.running` after moves > 0, `body:not(.playing)` on a game URL |
| `getBoardRect` / `squareToPoint` | `wc-chess-board.getBoundingClientRect()` + `chesscomSquareToPoint(sq, rect, game.getOptions().flipped ?? board.classList.contains('flipped'))` | `cg-board.getBoundingClientRect()` + `lichessSquareToPoint(sq, rect, !wrap.classList.contains('orientation-black'))` |
| `getPromotionTargetElement` | `.promotion-window .promotion-piece.${color}${piece}` (`wq`, `bn`, …); fallback order q,n,r,b | `#promotion-choice square` index {q:0,n:1,r:2,b:3} (or `piece.${role}` inside) |
| `onPositionChange` | §1.8 (`game.on('Move')` + observers) | §2.8 (`lichess.events.on('ply')` + observers) |
| `onGameStart` | `game.on('CreateGame'|'Load')`, `wc-chess-board` re-insertion, mode flip to `playing`, move list emptied | new document (`DOMContentLoaded`) with `body.playing`; `.rclock` elements appear; moves container emptied |
| `onGameEnd` | modal/`.result-row` insertion via body observer; `game.getResult()` | `.result-wrap` insertion in moves container; `.follow-up` in `.rcontrols` |
| `highlight` | MAIN: `game.markings.addOne({type:'arrow',data:{from,to,color}})` / `{type:'highlight',data:{square,color}}`, keep returned keys for `removeOne`; else overlay SVG appended to `wc-chess-board` (viewBox 0 0 100 100 like `svg.arrows`, `pointer-events:none`) | analysis: `chessground().setAutoShapes([...])`; round: own overlay SVG in `cg-container` (§2.7) |
| `clearHighlights` | `game.markings.removeAll()` (also clears the user's own drawings — prefer `removeMany(keys)`) or remove overlay | `setAutoShapes([])` / remove overlay |
| `tryStartNewGame` | §1.6 button ladder | `button.fbt.rematch` (rematch) / `button.fbt.new-opponent` (new); both inside `.rcontrols .follow-up`; `el.click()` works (snabbdom `bind('click')`, no isTrusted) |
| `playMove` (native) | `game.move({from,to,promotion,animate:false,userGenerated:true})` (medium confidence in live games) | analysis only: `lichess.analysis.playUci(uci)` |
| Pointer input | synthetic PointerEvents on `wc-chess-board` (verified) | must be trusted (CDP) — synthetic events are ignored |

---

## 5. Selector registry with fallbacks and runtime self-checks

Keep one `selectors.ts` per site as ordered candidate lists (Ramachokkalingam's pattern: `queryFirst(candidates)` / `queryAllFirst(candidates)`), plus a `probe()` that runs at startup and after each `onGameStart` and logs which candidate matched; ship the registry as remote-updatable JSON.

```ts
export const CHESSCOM = {
  board: ['wc-chess-board#board-single', 'wc-chess-board#board-play-computer', 'wc-chess-board', 'chess-board', '#board-single', '.board'],
  boardFlippedClass: 'flipped',
  piece: '.piece', pieceCodeRe: /\b([wb])([prnbqk])\b/, squareRe: /\bsquare-([1-8])([1-8])\b/,
  highlight: '.highlight', dragging: '.piece.dragging', hover: '.hover-square',
  moveList: ['wc-simple-move-list', 'wc-vertical-move-list', 'wc-horizontal-move-list', '.move-list', '.vertical-move-list', '#move-list'],
  moveRow: '.main-line-row', moveNode: ['.node.main-line-ply', '.node', '[data-node]', '[data-ply]', '.move-text-component', '.move-text'],
  moveText: ['.node-highlight-content', '.move-san'], moveSelected: ['.node-highlight-content.selected', '.node .selected', '.move-node-highlighted .move-text-component', '.move-node.selected .move-text'],
  figurine: '[data-figurine]', result: ['.result-row .game-result', 'wc-simple-move-list .result-text', '.result-text'],
  clock: '.clock-component', clockTop: '.clock-component.clock-top', clockBottom: '.clock-component.clock-bottom',
  clockWhite: '.clock-white', clockBlack: '.clock-black', clockActive: ['.clock-player-turn', '.clock-playerTurn', '.running'],
  clockTime: ['.clock-time-monospace', '[role="timer"]', '[data-cy="clock-time"]'],
  playerTop: ['#board-layout-player-top', '.board-layout-player.board-layout-top', '.player-component.player-top'],
  playerBottom: ['#board-layout-player-bottom', '.board-layout-player.board-layout-bottom', '.player-component.player-bottom'],
  username: ['.cc-user-username-component', '[data-test-element="user-tagline-username"]', '.user-username-component', '.user-tagline-username'],
  bottomColorClass: { w: '.cc-user-block-white', b: '.cc-user-block-black' },
  capturedPieces: 'wc-captured-pieces[player-color]',
  gameOver: ['.game-over-modal-shell-content', '.game-over-modal-container', '.game-over-modal-content', 'wc-game-over-modal', '.game-over-modal', '.player-game-over-component', '.game-over-header-component', '.board-modal-container-container', '.game-result-component'],
  gameOverHeader: '.game-over-modal-header-component', gameOverTitle: '.game-over-modal-title-component',
  newGame: ['[data-cy="game-over-modal-new-game-button"]', '[data-cy="sidebar-game-over-new-game-button"]', '[aria-label="New Game"]', '.game-over-modal-shell-buttons button', '.new-game-buttons-buttons button', '.new-game-buttons-component button', '.game-over-buttons-component button'],
  rematch: ['[data-cy="game-over-modal-rematch-button"]', '[data-cy="sidebar-game-over-rematch-button"]', '[aria-label="Rematch"]', '.new-game-buttons-rematch', '.game-over-buttons-incoming-rematch button'],
  promotionWindow: ['.promotion-window', '.promotion-window-3d', '.promotion-menu', 'wc-promotion-window'], promotionPiece: (c: Color, p: PromoPiece) => `.promotion-piece.${c}${p}`,
  dailySubmit: '.daily-game-footer-component',
  botCta: '[data-cy="bot-selection-cta-button"]',
};
export const LICHESS = {
  wrap: ['.round__app .cg-wrap', '.main-board .cg-wrap', '.cg-wrap.manipulable', '.cg-wrap'], board: 'cg-board', container: 'cg-container',
  orientationBlack: 'orientation-black', manipulable: 'manipulable',
  piece: ':scope > piece', pieceRoles: ['king','queen','rook','bishop','knight','pawn'], lastMove: 'square.last-move', check: 'square.check', anim: 'piece.anim', dragging: 'piece.dragging', ghost: 'piece.ghost',
  roundApp: '.round__app', main: 'main.round', bodyPlaying: 'playing',
  moves: ['aPp', 'l4x', '.moves', '.tview2'], move: ['Z7yx', 'kwdb', 'u8t', '.tview2 move'], index: ['qZM', 'i5z', 'index'], active: ['.a1t', 'move.active'], // + structural discovery (§2.3)
  result: ['.result-wrap .result', '.result-wrap', '.tview2 .result'], status: '.result-wrap .status',
  clock: '.rclock', clockRunning: '.rclock.running', clockColor: { w: '.rclock-white', b: '.rclock-black' }, clockTime: '.time', corresTurn: '.rclock-turn__text',
  playerTop: '.ruser-top', playerBottom: '.ruser-bottom', playerName: 'name', myUserTag: '#user_tag',
  followUp: '.rcontrols .follow-up', rematch: ['button.fbt.rematch', '.follow-up .rematch', 'a.fbt.text[href*="/"]'], newOpponent: ['button.fbt.new-opponent', '.follow-up .new-opponent'],
  controls: '.rcontrols .ricons', resign: 'button.fbt.resign', draw: 'button.fbt.draw-yes', abort: 'button.fbt.abort', takeback: 'button.fbt.takeback-yes',
  promotion: '#promotion-choice', promotionSquare: 'square', promotionOrder: ['q', 'n', 'r', 'b'],
  keyboardInput: '.keyboard-move input.ready',
  analysisFen: '.analyse__underboard .copyables input, input.copyable',
};
```

Runtime self-checks (run in `isReady()` and periodically):
1. **Board sanity**: piece count 2..32, exactly one king per colour, no duplicate squares → otherwise mark "unstable" and retry next frame.
2. **Placement consistency**: `replay(getMoveList()).placement === getPlacement()`; on mismatch log the two, prefer DOM, set `approximate`.
3. **Turn consistency**: clocks vs. move-list parity vs. (chess.com) `game.getTurn()`; disagreement ⇒ prefer MAIN API, then clocks.
4. **Orientation consistency**: chess.com `getOptions().flipped` vs `.flipped` class vs bottom `.cc-user-block-*`; lichess `orientation-*` vs `coords.files.black` vs first `coords.files coord` text (`h` when flipped).
5. **Geometry**: `squareToPoint('a1')` must hit an element inside the board (`document.elementFromPoint` returns a descendant of `wc-chess-board`/`cg-board`); `pointToSquare(squareToPoint(sq)) === sq` for a few squares.
6. **Tag rotation detector (lichess)**: if none of `LICHESS.move` candidates match but `findLichessRoundMoves()` succeeds, persist the discovered tags and emit a telemetry/log line "lichess rotated round tags to X/Y".
7. **API presence (chess.com)**: `typeof board.game?.getFEN === 'function'`; if missing, degrade to DOM mode and warn (shadow-DOM or renamed element).

---

## 6. Trusted, human-plausible input (input-realism spec)

Scope note: this section covers how to produce input that is *genuinely trusted by the browser* and *physically plausible* (the same material used by UI test automation and HCI research). It deliberately does not analyse or target lichess's `ab.ts` anti-bot telemetry or chess.com's fair-play systems; using engine assistance in rated games violates both sites' terms, and both sites explicitly flag input that does not originate from a human. Treat everything below as applying to unrated/analysis/bot play.

### 6.1 Where synthetic DOM events fall short

`dispatchEvent` produces `isTrusted:false`, no OS-level hit-testing, no `:hover`/`:active` CSS state, no `pointerrawupdate`/coalesced events, no `mousemove` stream before the click, and (on lichess) is outright ignored (§2.9). Anything "indistinguishable" therefore has to enter above the DOM:

| Route | isTrusted | Infobar / side effects | Hover/CSS state | Notes |
|---|---|---|---|---|
| `chrome.debugger` → CDP `Input.dispatchMouseEvent` (`mouseMoved`/`mousePressed`/`mouseReleased`, with `button`, `buttons`, `clickCount`, `modifiers`, optional `force`, `tiltX/Y`, `pointerType`) | yes | Chrome shows the "is being debugged" infobar while attached; `navigator.webdriver` stays `false` | yes (goes through the compositor's real hit-test) | Detach between moves to hide the bar? Re-attaching costs ~50–150 ms and flashes the bar; keep attached during a game. `Input.dispatchDragEvent` exists for drag semantics if needed. |
| Native messaging host driving the OS (macOS `CGEventCreateMouseEvent`/`CGEventPost`, Windows `SendInput`, X11 `xdotool`/XTest, Wayland `uinput`) | yes | none in the browser; needs a helper binary + `nativeMessaging` permission | yes | Coordinates must be converted from CSS px → screen px (`window.screenX/Y`, `devicePixelRatio`, `visualViewport`, browser chrome height — measure once via a calibration click). The physical cursor actually moves, so the user cannot use the mouse concurrently. |
| WebDriver BiDi / Playwright-style `input.performActions` | yes | requires launching the browser under automation (`navigator.webdriver=true`) | yes | not suitable for a user's normal profile |

For an extension, CDP is the pragmatic default; the native-messaging route is the only one with zero browser-visible footprint.

### 6.2 Pointer trajectory model

Generate a `mouseMoved` stream from the current cursor position (track it via a passive `pointermove` listener; CDP does not expose it) to the target with:

1. **Target point**: not the square centre — sample inside the square from a 2-D Gaussian centred at the centre with σ ≈ 0.18×square (clamped to 0.8×square), biased slightly toward the *approach direction* (humans undershoot then correct). Re-use the same sample for pointerdown and pointerup (≤ 1–2 px jitter between them; real clicks have sub-pixel drift).
2. **Path**: a minimum-jerk / Fitts-style profile: duration `T ≈ a + b·log2(D/W + 1)` with `a≈100–150 ms`, `b≈120–160 ms` (D = distance, W = target width); velocity bell-shaped (peak around 40–45 % of T), with 1–2 sub-movements ("corrective submovements") for D > ~300 px. Practical generator: WindMouse (gravity + wind noise, widely used in automation) tuned so the path has perpendicular deviation ≈ 3–8 % of D and never straight-line. Add 1/f-ish tremor of 0.3–1 px amplitude.
3. **Sampling**: emit `mouseMoved` at the display's pointer cadence (~125 Hz for USB mice, 60/120/144 Hz for trackpads/high-refresh) with jitter of ±15 % on the interval; Chrome coalesces these into `pointermove` events with `getCoalescedEvents()`, which is what a real mouse produces. Do not emit only a start and end point.
4. **Overshoot & settle**: with p≈0.3 for long moves, overshoot the target by 3–10 px and return; end with a 30–120 ms dwell (velocity < 2 px/frame) before `mousePressed`.
5. **Idle behaviour**: between moves, humans do not park the cursor exactly on the last-clicked square; drift it 20–200 px toward the clock/move list/board edge with a slow move, and sometimes leave the board entirely.
6. **Drag vs. click**: match the user's actual chess.com/lichess preference (`getOptions().moveMethod`, lichess pref). Drag = `mousePressed` at origin → 2–8 `mouseMoved` with `buttons:1` (the drag starts after chessground's `draggable.distance` = 3 px / chess.com's threshold) → `mouseReleased` at target. Click-click = press/release (dwell 60–140 ms, log-normal), path to target, press/release.

### 6.3 Timing model

- **Reaction/think time**: draw from a log-normal with median tied to the time control and position (e.g. blitz: median 1.2 s, σ_log 0.6; bullet: 0.4 s; increment games longer). Correlate with engine-evaluated complexity (number of legal moves, eval swing, captures/checks available) so forced recaptures are fast and quiet positions slow — a constant or uniform delay is the single most obvious tell.
- **Pre-move**: only when the reply is forced/obvious (recapture, only-move); pre-moves are placed *during the opponent's think time*, not immediately after your own move.
- **Move execution time** (first `mouseMoved` → `mouseReleased`): 250–900 ms depending on distance (Fitts), not fixed.
- **Promotion**: after the pawn lands, 150–400 ms to move to the dialog piece (short Fitts distance), then click.
- **Session-level**: fatigue drift (slower over 30+ min), occasional long pauses (5–20 s, p≈0.02/move), no moves made with < 100 ms remaining think budget except in time trouble, and time-trouble behaviour (moves speed up as clock < 10 s, with more overshoot).
- **Pointer-stream realism**: `buttons` mask correct on every event (`1` while pressed), `clickCount` 1 (2 for a genuine double-click only), modifiers 0, `pointerType:'mouse'`, consistent `deviceScaleFactor`.

### 6.4 Verification harness

Build the harness before the bot: a page that records `pointermove/pointerdown/pointerup` (`isTrusted`, timestamps, `getCoalescedEvents().length`, `movementX/Y`, `pressure`) from (a) a real human session and (b) the generator, then compare distributions (inter-event interval histogram, path curvature, velocity profile, dwell times, target-offset scatter). Iterate until the two are statistically indistinguishable (KS test p > 0.2 on each feature). Run the same harness on chess.com and lichess pages with the extension attached to confirm `isTrusted === true` and that `#promotion-choice`/`.promotion-window` clicks land.

## 7. Sources

Live verification (Chrome DevTools, 2026-09-03): https://lichess.org/tv, https://lichess.org/analysis, https://www.chess.com/game/live/173765478164, https://www.chess.com/play/computer, https://www.chess.com/play/online.

lichess first-party:
- lila round view: https://github.com/lichess-org/lila/blob/master/ui/round/src/view/replay.ts, clock.ts, button.ts, table.ts, main.ts, user.ts; ctrl: https://github.com/lichess-org/lila/blob/master/ui/round/src/ctrl.ts, ground.ts, round.ts, socket.ts, util.ts
- lila lib: https://github.com/lichess-org/lila/blob/master/ui/lib/src/api.ts, pubsub.ts, socket.ts, game/promotion.ts, game/clock/clockView.ts, game/clock/clockCtrl.ts, game/router.ts, game/status.ts, game/index.ts
- lila site: https://github.com/lichess-org/lila/blob/master/ui/site/src/site.ts, asset.ts, site.inline.ts; keyboardMove: https://github.com/lichess-org/lila/blob/master/ui/keyboardMove/src/keyboardMove.ts; analyse ctrl (`lichess.chessground`): https://github.com/lichess-org/lila/blob/master/ui/analyse/src/ctrl.ts
- lila views: https://github.com/lichess-org/lila/blob/master/app/views/base/page.scala, app/views/round/player.scala, modules/round/src/main/ui/RoundUi.scala; CSS constants: https://github.com/lichess-org/lila/blob/master/ui/round/css/_constants.scss; tag rotation commit: https://github.com/lichess-org/lila/commit/23bbbc42 (2026-07-03), earlier 1876f8cb (2023-01-08), 950c1846 (2023-01-25), 0c6f085d (2019-05-12)
- chessground v10.1.1: https://github.com/lichess-org/chessground/blob/master/src/wrap.ts, render.ts, util.ts, board.ts, drag.ts, events.ts, svg.ts, api.ts, config.ts, state.ts
- lila issue on programmatic access: https://github.com/lichess-org/lila/issues/16490

chess.com third-party (no first-party source):
- chesshook (pointer dispatch, `game.*`, markings, URL branching): https://github.com/0mlml/chesshook
- Chess-Helper typed `IGame`/events: https://github.com/everyonesdesign/Chess-Helper/blob/master/app/src/chessboard/component-chessboard/types.ts and index.ts
- chess-annotator-extension (MAIN bridge, `CreateGame`/`Move`, selectors): https://github.com/YGao2005/chess-annotator-extension
- Ramachokkalingam selector registry: https://github.com/Ramachokkalingam/chess.com_extension/blob/main/src/content/selectors.ts
- chee adapters (both sites): https://github.com/hong4rc/chee
- chess-grandmaster-extension (both sites, WebSocket route on lichess): https://github.com/shahradelahi/chess-grandmaster-extension
- Mephisto (both sites, click simulation, promotion index): https://github.com/AlexPetrusca/Mephisto
- chess.com.puter game-over ladder: https://github.com/reynoldsnlp/chess.com.puter/blob/main/src/shared/gameStatus.js
- equanimi `data-cy` buttons (2026): https://github.com/Thopiax/equanimi
- ChesscomBlocker game-over modal classes: https://github.com/Zinkelburger/ChesscomBlocker
- hide-ratings, chesscom-to-lichess-export, hikaru-gotham-move (clock observer), kibitz, AI-Chess-Assistant, autochess.com, NotationChessExtension, board-master, BetterMint, chessbest, ChessVoiceControl, bariskisir/ChessBot, PreMiD chess.com activity — all linked inline above.
- chess.com help on move methods: https://support.chess.com/en/articles/8708726-how-do-i-make-moves-in-live-chess

lichess third-party: boardtrace, Chessist, wd7512 selector audit (2026-06-21), kWAYTV/lichess-bot selectors, browlichmover, Gnomee1337/chess-assistant, rafi-haque/chessBot (WebSocket capture), Siderite/lichessTools (tool list only), A.C.A.S (UniversalBoardDrawer overlay) — linked inline above.

Not retrievable: greasyfork script 460208 source (HTTP 403).


# Appendix D — Human move-timing model


Status: design for implementation. Date: 2026-09-03.
Scope: replaces the ad-hoc multiplier chain on `maxWaitTime` with (a) a parametric v1 model that ships without data, and (b) a learned v2 model fitted on Lichess `%clk` data, both behind one `TimingModel.planMove()` API.

---

## 0. Summary of the design

One idea runs through everything: **think time is modelled on the log scale as an additive combination of a game-level time budget and per-move adjustments**, with an explicit spike-and-tail structure (instant/premove spike, log-normal body, Pareto "long think" tail), an AR(1) residual for move-to-move consistency, and per-game latent persona variables. v1 hand-sets the coefficients from the literature; v2 replaces the body with a tiny MLP trained on Lichess clock data that predicts a bucketed think-time distribution. The runtime API, budget controller, motor model, persona sampling, and abort/re-plan logic are identical for both tiers; only the "distribution head" is swapped.

```
                     ┌──────────────────────────────┐
  per game ──────►   │ Persona sampler (§4)          │  s, ι, π_p, τ, ρ_mirror
                     └──────────────┬───────────────┘
                                    ▼
  per move   ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐
  inputs ──► │ Feature calc │─►│ Budget ctrl  │─►│ Distribution head  │─► sample t_total
  (§2)       │ (§2)         │  │ (§3a.2)      │  │ v1 formulas (§3a) │
             └──────────────┘  └──────────────┘  │ v2 MLP     (§3b) │
                                                  └─────────┬─────────┘
                                                            ▼
                                           ┌──────────────────────────────┐
                                           │ Mode selector + motor split  │─► TimingPlan (§5)
                                           │ premove/instant/normal/long  │
                                           └──────────────────────────────┘
```

---

## 1. Literature and data summary

### 1.1 What is known about human move-time distributions

| Finding | Source | Consequence for the model |
|---|---|---|
| RT distributions are long-tailed; opening and endgame RTs show power-law tails, middlegame tails are even longer. Mean RT vs move number is an inverted U (fast opening, slow middlegame, fast endgame). | Sigman, Etchemendy, Fernández Slezak & Cecchi 2010, *Frontiers in Neuroscience* (FICS, 2.8M games, 3+0 focus) — https://pmc.ncbi.nlm.nih.gov/articles/PMC2965049/ | Log-normal body + Pareto tail; explicit phase term; long-think events concentrated in middlegame. |
| SD of RT is linear in mean RT: `SD ≈ 0.6 s + 1.36·mean` for >1900 players, `SD ≈ 0.1 s + 0.91·mean` for <1400. | Sigman et al. 2010 | Marginal coefficient of variation ≈ 1.36 (σ_log ≈ 1.0) for strong players vs ≈ 0.91 (σ_log ≈ 0.78) for weak players. Strong players are *more* variable in marginal terms because they allocate selectively (instant on easy, long on hard). In a feature-conditioned model this shows up as **larger feature coefficients and smaller residual σ** for high Elo, the reverse for low Elo. |
| Successive RTs are positively autocorrelated for nearby moves (kernel 5–7 moves) and negatively for distant moves (finite budget); black–white cross-correlations are as strong as own-move autocorrelation (players mirror each other's tempo). | Sigman et al. 2010 | AR(1) residual φ≈0.35; budget controller yields the long-range negative correlation; explicit opponent-pace mirroring term. |
| Higher-rated players play faster in the opening and slower in the middlegame; by move 40 they have used 77.9 % of the 3-minute budget vs 74.7 % for lower-rated. Endgame speed-up is driven by time pressure, not by reduced complexity (move-entropy barely drops). | Sigman et al. 2010 | Elo-dependent opening discount and complexity sensitivity; time-pressure compression is a separate mechanism from complexity. |
| Under time pressure, 8 extra seconds on the clock (opponent at 20–30 s) was worth about one minor piece in expected outcome. | Sigman et al. 2010 | Justifies aggressive compression regime; humans do not overspend at <30 s. |
| Decisiveness `Δ = |eval(best) − eval(second best)|` is power-law distributed, `P(Δ) ∝ Δ^−1.35`, over three decades; human accuracy rises steeply with Δ at every rating. | Chacoma & Billoni 2024/2025, *Sci. Rep.* — https://arxiv.org/abs/2406.15463 | Use `log(1+Δ)` not raw Δ as a feature; Δ is the natural "how obvious is the move" scalar. |
| Blitz think times: the majority of moves are ≤5 s; a regression head trained with MSE under-predicts long thinks. Evaluation filter: drop moves made with <30 s on the clock. Pearson r = 0.697 on filtered blitz. | Zhang, Jacob, Lai, Fried & Ippolito, "Human-Aligned Chess With a Bit of Search" (ALLIE), ICLR 2025 — https://arxiv.org/abs/2410.03893 | Do not regress the mean; model a distribution. Rating conditioned via a soft token interpolating 500…3000 Elo — same idea as our scalar `elo_z`. |
| Per-ply think time = `pre_clk − post_clk + increment`. 1-s buckets for 0–27 s cover ≈86 % of blitz moves; 30-bucket distribution head with masked Brier loss (buckets above remaining clock masked). Blunder rate 8.5 % with >120 s left vs 15.0 % below 5 s. Per-100-Elo-band models reach r=0.41, MAE 4.1 s (n≈89k filtered positions). | ChessMimic 2026 — https://arxiv.org/html/2606.04473 | Bucketed distributional target with clock mask is the right v2 formulation. Per-band training is expensive (9M params × 14 bands) and not needed; a single rating-conditioned small model is fine for our purpose. |
| Neural time management ("CTM Net") learns *fraction of remaining time* per ply from human games rather than absolute seconds. | Rheude, TU Darmstadt thesis "Time Management in Chess with Neural Networks and Human Data" — https://ml-research.github.io/papers/rheude2021time.pdf | Parameterise the body as `log(t) = log(allocation) + adjustments`, where allocation is a fraction of remaining clock. |
| Human move choice is rating-conditionable in one model (Maia-2 skill-aware attention; Maia per-rating nets). Individuals are identifiable from their decisions alone (98 % accuracy from 100 games). | Maia-2, NeurIPS 2024 — https://arxiv.org/abs/2409.20553 ; McIlroy-Young et al., NeurIPS 2021 — https://arxiv.org/abs/2208.01366 | Timing must be *consistent within a game and across a user's games*; hence per-game persona latents drawn around a stable per-user seed (§4). |
| Blunders increase and inaccuracies decrease as the clock runs down (classical, tournament PGNs with timestamps). | jk_182, Lichess blog — https://lichess.org/@/jk_182/blog/how-does-the-clock-impact-the-rate-of-mistakes/JSazQplM | Not used directly by timing, but the move-selection module should read the same `pressure` signal. |

Premove rates: no peer-reviewed statistic exists. Forum evidence (https://lichess.org/forum/lichess-feedback/is-the-lack-of-any-premove-time-penalty-an-exploitable-flaw) confirms Lichess charges 0.0 s for a premove and chess.com charges 0.1 s. We therefore **measure** premove/instant rates ourselves from the centisecond export (§1.2) as the fraction of moves with think time ≤ 0.10 s (premove) and ≤ 0.35 s (instant human reply), per time control, phase and rating. Expected magnitudes from the ALLIE/ChessMimic bucket statistics (≈86 % of blitz moves under 27 s, majority under 5 s) and from the 1-s-bucket mass at 0 s: order of 25–40 % of bullet moves and 8–15 % of blitz moves fall in the 0-s bucket, dominated by opening and recaptures. v1 defaults in §7 use these ranges; v2 learns them.

### 1.2 Dataset for fitting

**Lichess open database** — https://database.lichess.org/ (GitHub: https://github.com/lichess-org/database).

- Monthly files: `https://database.lichess.org/standard/lichess_db_standard_rated_YYYY-MM.pgn.zst` (≈ 20–30 GB compressed, ≈ 90–100 M games/month in 2025–26; ChessMimic trained on 2024-09 … 2025-08).
- `[%clk h:mm:ss]` comments after every move since April 2017, 1-second resolution (recent months also carry tenths for short clocks, but do not rely on it).
- Centisecond export: a separate one-off dump covering 2013–2021 with `[%clkc]` comments — use it for the instant/premove spike (sub-second structure), use the monthly dumps for everything else.
- ≈ 6 % of games carry `[%eval]` (Stockfish, White POV) — not enough and not MultiPV; we run our own low-depth pass.
- Headers used: `TimeControl "180+0"`, `WhiteElo`, `BlackElo`, `Event` (filter out "Arena" games to avoid berserk-halved clocks, or detect berserk by initial clk ≠ base), `Termination`.

**Per-move think time** (side-to-move `p`, move index `i` for that side):

```
think_i = clk_p[i-1] − clk_p[i] + increment          # seconds
clk_p[0] = base                                       # initial time
```

Caveats to implement in the parser:
1. On Lichess the clock does not run for each side's first move; plies 1 and 2 have `think = 0` by construction — drop them.
2. Lichess applies lag compensation (up to ≈1 s/move refunded), so observed think slightly under-estimates the human's wall time; ignore, it is the same signal the opponent sees.
3. Negative `think` (clock went up: `moretime` given by opponent) — drop the move.
4. Cap at `min(clk_p[i-1] + increment, 600 s)` and drop games with < 10 plies or abandoned terminations.
5. Keep the "clock mask": `think_i ≤ clk_p[i-1] + increment` always; the v2 head masks buckets above this bound.

Stratified sample plan (§3b.2): 60 k games per (rating bucket × time-control class), 8 rating buckets × 3 classes (bullet, blitz, rapid) → 1.44 M games, ≈100 M plies before filters.

---

## 2. Feature specification

All features are computed in the offscreen document from the inputs listed in the task. `elo` is the target Elo slider; engine data is the MultiPV result (k ≥ 4 lines) at the *fixed feature depth* `D_f = 10` (use the depth-10 iteration's output even when the engine went deeper, so training and inference see the same distribution). Evals are from the side-to-move's POV, in centipawns, mates mapped to `±(2000 − 10·plies_to_mate)` then clamped to ±2000.

| # | Name | Definition / computation | Range |
|---|---|---|---|
| 1 | `elo_z` | `(elo − 1650) / 850` clamped to [−1, 1]. 800 → −1, 2500 → +1. | [−1,1] |
| 2 | `tc_class` | `bullet` if `base + 40·inc < 180`, `blitz` if `< 480`, `rapid` if `< 1500`, else `classical` (Lichess convention, base_eff = base + 40·inc). One-hot for v2; switch table for v1. | cat |
| 3 | `log_base_eff` | `ln(base + 40·inc)` in seconds. | ≈4–8 |
| 4 | `inc_s` | increment in seconds. | 0–30 |
| 5 | `log_clock` | `ln(max(0.5, my_clock_s))`. | |
| 6 | `pressure` | `my_clock_s / base_eff`, clamped [0,1]. | [0,1] |
| 7 | `clock_ratio` | `ln((my_clock_s + 1) / (opp_clock_s + 1))` clamped [−2,2]. Positive = I have more time. | |
| 8 | `ply` | ply number (0-based), and `ply_sq = (ply/40)²` for the inverted-U. | |
| 9 | `phase` | material-based: `npm = Σ non-pawn material (N=B=3, R=5, Q=9), both sides`. `opening` if `ply < 20 && npm ≥ 56`, `endgame` if `npm ≤ 26`, else `middlegame`. Also continuous `phase_c = clamp((62 − npm)/62, 0, 1)`. | cat + [0,1] |
| 10 | `in_book` | 1 if `ply < 16` AND the chosen move is the engine's best move or matches a bundled ~5 k-line opening book (polyglot-style hash set, ~100 KB); else 0. | {0,1} |
| 11 | `n_reasonable` | number of MultiPV lines with `eval_best − eval_i ≤ 40 cp` (min 1). Feature used as `ln(n_reasonable)`. | 0–ln k |
| 12 | `decisiveness` | `ln(1 + |eval_1 − eval_2| / 25)` where eval_1, eval_2 are best/second-best. 0 = two equal moves; ≈4.4 at 2000 cp gap. | [0,4.4] |
| 13 | `chosen_rank` | index of the move we will play within MultiPV (0 = best); `chosen_gap = ln(1 + (eval_best − eval_chosen)/25)`. If not in MultiPV, rank = k, gap from a 1-line search. | |
| 14 | `eval_abs` | `ln(1 + |eval_chosen_after| / 100)` (eval after our move, our POV). | [0,3] |
| 15 | `eval_sign` | `tanh(eval_chosen_after / 300)` (positive = we are winning). | [−1,1] |
| 16 | `eval_swing` | `eval_before_opp_move − eval_now` (our POV, cp): how much the opponent's last move surprised us. Feature `swing_bad = ln(1 + max(0, swing)/50)`, `swing_good = ln(1 + max(0, −swing)/50)`. | ≥0 |
| 17 | `ponder_hit` | 1 if opponent's move equals the reply we expected (PV[1] of our previous search) — we already "know" our answer. | {0,1} |
| 18 | `move_type` | flags: `is_capture`, `is_recapture` (captures on the square the opponent just captured on), `is_check`, `gives_mate`, `is_promotion`, `is_castle`, `is_only_legal` (1 legal move), `is_forced` (`n_reasonable == 1 && decisiveness > ln(1+150/25)`). | {0,1} each |
| 19 | `n_legal` | `ln(number of legal moves)`. | ≈0–3.9 |
| 20 | `dist` | Chebyshev distance from→to in squares (motor model only). | 1–7 |
| 21 | `opp_pace` | `ln(mean(last 3 opponent think times, s) + 0.2) − ln(alloc_s + 0.2)` clamped [−2,2] (opponent tempo relative to my allocation). | |
| 22 | `opp_last` | `ln(opponent's last think time + 0.2)`. | |
| 23 | `my_pace_resid` | mean over my previous moves this game of `(ln t_actual − ln t_model_body)` — the online persona estimate (0 at move 1). v2 only; v1 uses persona latents directly. | |
| 24 | `budget_used_ratio` | `time_used_so_far / (base_eff − my_clock)` … simplified to `1 − pressure − (expected fraction used at this ply)` where expected fraction `= min(1, ply/ (2·N0))`, N0 = 40. Positive = I am ahead of schedule (spent less). | [−1,1] |
| 25 | `material_imb` | `tanh(material_diff / 5)` (our POV, pawns). | [−1,1] |

Features 1–19 and 21–25 feed the distribution head; 18 and 20 feed the motor model; 6, 7, 17, 18, 10 feed the discrete mode selector.

---

## 3. Model architecture

### 3a. v1 parametric model (ships without data)

All quantities in seconds unless stated. Constants are in §7 (defaults) and carry Elo dependence via `p(e) = p0 + p1·elo_z`.

#### 3a.1 Structure

Per move, the total time from opponent-move-arrival to our move-completion is

```
t_total = mode == PREMOVE ? t_premove
        : mode == INSTANT ? t_motor + U(0.05, 0.25)
        : mode == LONG    ? t_long
        :                   t_body            # NORMAL
```

with
```
log t_body = log alloc + Σ_i β_i f_i + s_game + ε_t          # log-normal body
ε_t = φ·ε_{t-1} + sqrt(1 − φ²)·σ·η,   η ~ N(0,1)               # AR(1) residual
t_long = t_body · (2.5 + Pareto(α = 1.6, x_m = 1))             # heavy tail
```
followed by the clamps in §3a.6.

#### 3a.2 Game-level budget controller

```
base_eff  = base + 40·inc
N_rem     = clamp(22 + 0.9·nonPawnPieces + 0.5·pawns − 0.25·(ply/2), 10, 45)   # expected own moves remaining
reserve   = τ · clamp(0.06·base, 2, 20)                                          # skill-scaled reserve
alloc     = max(0.15, (my_clock − reserve) / N_rem + 0.9·inc)                    # per-move allocation
alloc    *= (1 + 0.35·(1 − τ)·(1 − ply/60)⁺)                                     # poor budgeters overspend early
alloc    *= exp(0.10·budget_used_ratio)                                          # ahead of schedule → spend a bit more
```
`nonPawnPieces` counts N/B/R/Q of both sides (start 14), `pawns` both sides (start 16): N_rem = 42.6 at ply 0, ≈32 at ply 40 with 10 pieces/12 pawns, ≈20 at ply 80 with 4 pieces/8 pawns. τ ∈ [0,1] is the persona's time-management skill (§4).

Sanity check at 3+0, start: alloc = (180 − 8)/42.6 ≈ 4.0 s; with σ = 0.8 the log-normal median is ≈ 2.9 s, mean ≈ 4.0 s, matching the "majority of blitz moves ≤ 5 s" statistic once opening discounts apply.

#### 3a.3 Body adjustments (log-scale coefficients)

```
Σ β_i f_i =
    β_book    · in_book                          # β_book   = −1.20 + (−0.40)·elo_z      (strong players: faster opening)
  + β_phase   · phase_mid                        # +0.15 in middlegame, −0.10 in endgame, 0 opening
  + β_U       · (−(ply − 36)²/1600)              # inverted U, β_U = 0.25   (peak ≈ move 18)
  + β_cplx    · (ln n_reasonable − ln 3)         # β_cplx   = 0.35 + 0.15·elo_z
  + β_dec     · (−decisiveness)                  # β_dec    = 0.22 + 0.06·elo_z
  + β_gap     · chosen_gap                       # β_gap    = 0.10 (playing a non-best move ~ slightly longer)
  + β_forced  · is_forced                        # −0.90
  + β_recap   · is_recapture                     # −0.80
  + β_only    · is_only_legal                    # −1.50
  + β_ponder  · ponder_hit                       # −0.45
  + β_swing   · swing_bad                        # +0.30 (opponent surprised me → re-think)
  + β_evalabs · eval_abs                         # −0.18 (decided positions → faster)
  + β_lost    · [ −600 < eval < −120 ]           # +0.20 hesitation while losing but not dead
  + β_dead    · [ eval ≤ −600 ]                  # −0.35 hopeless → bang out moves
  + β_won     · [ eval ≥ +500 ]                  # −0.30 easy win → fast
  + β_check   · is_check                         # −0.10
  + β_promo   · is_promotion                     # +0.15 (motor also adds time)
  + β_mirror  · opp_pace                         # ρ_mirror persona, default 0.15
  + β_legal   · (n_legal − ln 30)                # +0.10
  + β_ratio   · clock_ratio                      # +0.08 (more time than opponent → a bit slower)
```

Time-pressure compression is applied multiplicatively **after** the body (so that it also compresses long thinks):

```
P = pressure (my_clock / base_eff),  C = my_clock (s)
comp = 1.0
if C < 30 || P < 0.20:  comp *= clamp(0.35 + 0.65·min(1, C/30), 0.35, 1)
if C < 12:              comp *= clamp(C/12, 0.15, 1)
if inc ≥ 2 && C > 5:    comp = max(comp, 0.6)      # increment games rarely panic
t_body *= comp
```

Plus the hard caps: `t_total ≤ 0.5·C` always; `t_total ≤ 0.15·C` when `C < 30 && inc < 2`; `t_total ≤ 0.35 s` when `C < 3`.

#### 3a.4 Residual and variance

```
σ = σ0 + σ1·elo_z + 0.10·phase_mid − 0.08·in_book       # σ0 = 0.80, σ1 = −0.12
φ = 0.35 + 0.05·elo_z
```
`ε` is carried across our moves for the whole game (reset at game start). When the actual delay exceeds the planned one (engine slow, page lag), feed the *realised* log-time back into ε so the AR process stays consistent with what the opponent saw.

#### 3a.5 Discrete behaviours

**Premove / instant (spike).** Eligibility: `premove_eligible = ponder_hit || is_recapture || in_book || is_only_legal`. Only if eligible (a premove is entered before the opponent moves, so it can only be "right" if the reply was predictable):

```
logit p_pre = a_tc + 2.0·is_recapture + 1.5·in_book + 1.5·is_only_legal + 1.0·ponder_hit
            + 1.5·[C < 10] + 0.8·[C < 20] − 0.6·(ln n_reasonable) − 0.3·swing_bad
            + π_p (persona, ±1) + 0.6·elo_z·[tc == bullet]
a_tc: bullet −0.4, blitz −2.0, rapid −3.5, classical −5
p_pre = sigmoid(logit p_pre)
```
If not premove, an **instant** reply (human saw it coming, no premove entered):
```
logit p_inst = b_tc + 1.2·is_recapture + 1.0·is_forced + 0.8·ponder_hit + 1.0·in_book
             + 0.8·[C < 20] − 0.5·(ln n_reasonable) + 0.5·ι (impulsiveness) − 0.3·decisiveness⁻¹
b_tc: bullet 0.2, blitz −0.9, rapid −1.8, classical −2.5
```
Premove timing: `t_premove ~ U(0.00, 0.12) s` (Lichess charges 0; the server sees a few ms). On chess.com add its fixed 0.1 s. Instant: `t = t_motor + U(0.05, 0.25)`.

**Long think (tail).** Only in NORMAL mode, never when `C < 30` or `P < 0.15`:
```
crit = clamp(0.5·ln n_reasonable + 0.4·swing_bad + 0.3·[|eval| < 150] + 0.3·phase_mid − 0.3·decisiveness, 0, 2)
p_long = clamp(λ0 · exp(0.9·crit) · (0.6 + 0.4·τ), 0, 0.12)       # λ0 = 0.020 + 0.008·elo_z
t_long = t_body·(2.5 + Pareto(α=1.6, x_m=1)),  then cap at min(0.25·C, 45 s blitz / 15 s bullet / 120 s rapid)
```
Expected frequency: 2–5 % of non-forced middlegame moves; low-Elo long thinks are less correlated with `crit` (the `0.6+0.4τ` factor plus larger σ handles that).

**Tilt.** If our previous move dropped the eval by ≥ 200 cp (we blundered), set `tilt = 3` moves: body × `exp(−0.35·ι)` and `p_inst` logit `+0.6·ι` while `tilt > 0`.

**Hesitation fake-out (motor).** With probability `0.02 + 0.03·(1−elo_z)/2` in NORMAL mode, the plan includes a `fakeout`: pick up a piece (a different legal-move piece if `n_reasonable ≥ 2`, else the same piece), hold 250–700 ms, drop it back, then execute the real move after another 300–900 ms. Only when `C > 20 s`.

#### 3a.6 Motor model (splits think into "wait" + "act")

Measured think time in data includes the physical move, so `t_total` is sampled first and then split:

```
hover  = LN(median 0.22, σ 0.35)  s           # decision → mouse reaches piece
drag   = 0.09 + 0.07·log2(1 + dist) + N(0, 0.03) s, clamp [0.08, 0.6]     # Fitts-like
promo += U(0.25, 0.60) if is_promotion && !autoQueen
t_motor = hover + drag + promo
t_wait  = max(0, t_total − t_motor)              # invisible pre-touch pause
```
Click-click mode: `drag` becomes two clicks separated by `0.12 + 0.05·log2(1+dist)` s. If `t_total < t_motor` (instant/premove), the motor component is compressed to `t_total` with a floor of 60 ms (premove: 0).

#### 3a.7 Elo dependence summary (v1)

| Quantity | Elo 800 (elo_z = −1) | Elo 1650 (0) | Elo 2500 (+1) |
|---|---|---|---|
| Opening discount `β_book` | −0.80 | −1.20 | −1.60 |
| Complexity sensitivity `β_cplx` | 0.20 | 0.35 | 0.50 |
| Residual σ | 0.92 | 0.80 | 0.68 |
| AR φ | 0.30 | 0.35 | 0.40 |
| Time-mgmt skill τ (persona mean) | 0.45 | 0.65 | 0.85 |
| Long-think base rate λ0 | 0.012 | 0.020 | 0.028 |
| Bullet premove bonus | −0.6 | 0 | +0.6 |
| Reserve multiplier τ → typical reserve at 3+0 | ≈5 s (then flags) | ≈7 s | ≈9 s |

Net effect: low Elo = noisier, worse budgeting (overspends early, flags or leaves time), less selective; high Elo = fast opening, tight allocation, sharper instant-vs-long dichotomy.

### 3b. v2 learned model

#### 3b.1 Formulation

Predict a **categorical distribution over 32 think-time buckets** conditioned on the features of §2 (28 numeric inputs after one-hot expansion), exactly like ChessMimic/ALLIE-style targets but with a tiny network:

- Buckets (upper edges, s): `0.10, 0.35, 0.6, 0.9, 1.25, 1.7, 2.2, 2.8, 3.5, 4.3, 5.2, 6.3, 7.6, 9.1, 11, 13, 15.5, 18.5, 22, 26, 31, 37, 44, 52, 62, 75, 90, 110, 135, 170, 220, ∞`. The first two buckets isolate premove and instant; the rest are ≈ log-spaced (ratio ≈1.2). With 1-s clock resolution the 0.10/0.35/0.6 boundaries are only learnable from the centisecond export; for the monthly dumps, moves with `think = 0` are assigned to the sub-1 s buckets by the **empirical sub-second split measured on the %clkc export** (per tc_class × phase × recapture flag) — i.e. a fixed soft label, not hard.
- Network: `28 → 96 (GELU) → 96 (GELU) → 32 softmax`. Parameters: 28·96 + 96 + 96·96 + 96 + 96·32 + 32 ≈ 15.2 k → 61 KB as float32, ≈ 25 KB as float16 JSON. Plain-JSON weights and a ~60-line TypeScript forward pass; **no ONNX runtime** (onnxruntime-web is 5–10 MB WASM; unjustified for 15 k parameters). Keep ONNX export in the pipeline only as an optional artefact for validation.
- Loss: cross-entropy with **clock masking** (logits of buckets whose lower edge exceeds `clk_prev + inc` set to −∞) and label smoothing 0.02 across neighbouring buckets.
- Sampling at inference: draw a bucket from the (masked, temperature-scaled) softmax, then draw uniformly in log-space within the bucket; final bucket: bucket lower edge × `(1 + Pareto(α=1.6))` capped by the clamps of §3a.3.
- Elo conditioning: `elo_z` is an input and also enters via **two FiLM scale/shift vectors** on the first hidden layer (`h = GELU((W x + b) ⊙ (1 + γ·elo_z) + δ·elo_z)`, 192 extra parameters). This gives interaction capacity without per-band models and covers 800–2500 continuously (trained on 700–2700 to avoid edge effects). Validate per 100-Elo band that calibration does not degrade at the ends; if it does, fall back to 4 rating-band heads (4 × 32 output layers, +12 k params) sharing the trunk.
- Within-game consistency: v2 keeps the AR(1) residual of §3a.4 applied as a shift in log-space to the sampled value (`t ← t · exp(ε_t)` with σ reduced to 0.35 because the network already explains part of the variance) **and** feeds `my_pace_resid` (feature 23) so the network learns how much a player's own earlier pace predicts later pace. Persona latents (§4) are added to `my_pace_resid` at game start as a prior (`my_pace_resid_0 = s_game`).
- Discrete modes come out of the same distribution: bucket 0 → PREMOVE (subject to `premove_eligible`; if not eligible, re-sample from buckets ≥ 1), bucket 1 → INSTANT, top 4 buckets or `t > 6·median` → LONG (for rationale/debug labelling and for the motor split); everything else NORMAL.

Why bucketed rather than log-normal μ/σ heads: the empirical distribution is multimodal (spike at 0, body, tail) and ALLIE's scalar head visibly under-predicts long thinks; a 32-way softmax is the smallest thing that captures the shape, and sampling from it is trivial.

#### 3b.2 Training pipeline (Python)

```
data/
  01_download.sh        # curl database.lichess.org/standard/lichess_db_standard_rated_2025-{09..12}.pgn.zst
  02_sample.py          # zstd stream → pgn-extract-free fast scanner: keep game if TimeControl ∈ target set,
                        #   both Elo in 700–2700, Event not Arena, ≥ 20 plies; reservoir-sample 60k games per
                        #   (rating bucket of the side we model × tc_class); write compact JSONL (moves, clks, headers)
  03_features.py        # python-chess replay; think = prev − now + inc; drop plies 0–1, negative, moretime;
                        #   Stockfish 17 MultiPV 4 depth 10 (`chess.engine`, 16 worker processes, ~4 ms/pos);
                        #   compute §2 features; write Parquet (one row per ply of the modelled side)
  04_train.py           # PyTorch, 28→96→96→32 + FiLM, AdamW 2e-3, batch 4096, 8 epochs, cosine LR,
                        #   masked CE, hold out 5% games (not plies) by game id
  05_export.py          # float16 JSON {"W1":[...],"b1":[...],"gamma":[...],"delta":[...],"W2":...,"W3":...,
                        #   "feature_mean":[...],"feature_std":[...],"buckets":[...]}; also optional ONNX
  06_eval.py            # §6 metrics, per rating × tc × phase × clock bucket; plots
```
Budget: 1.44 M games ≈ 100 M plies; keep every ply of the modelled side ⇒ ≈ 50 M rows; Stockfish depth-10 MultiPV-4 at ≈ 4 ms each on 16 cores ≈ 3.5 h; training 50 M rows × 8 epochs on one GPU < 1 h (CPU ≈ 6 h). Rating buckets: 700–1000, 1000–1200, 1200–1400, 1400–1600, 1600–1800, 1800–2000, 2000–2300, 2300–2700. Time-control target set: `60+0, 120+1, 180+0, 180+2, 300+0, 300+3, 600+0, 600+5, 900+10` (covers >80 % of Lichess volume).

Engine consistency: the extension computes features from the depth-10 MultiPV iteration (Stockfish emits per-depth info lines; keep the last complete depth-10 line set). Depth mismatch shifts `decisiveness`/`n_reasonable` distributions; keep training and inference at the same depth.

#### 3b.3 In-extension inference

Offscreen document loads the JSON once (≈25 KB). Forward pass ≈ 20 k MACs — microseconds. The v2 head implements the same `DistributionHead` interface as v1 (§5) so the mode selector, budget clamps, motor model and persona logic are unchanged. If the JSON fails to load or `tc_class == classical` (not in training set), fall back to v1.

---

## 4. Session consistency and persona

Sampled **once per game** at game start, from a per-user seed that drifts slowly (so the same user looks like the same person across games — humans are identifiable from behaviour; a fresh random persona every game is itself a detectable signature):

```
user_seed  = hash(installId)                         # stable per install
session_mu = N(0, 0.15) drawn per browser session from user_seed
persona (per game):
  s_game    ~ N(profile.speed + session_mu, 0.20)     # log speed multiplier; profile.speed: fast −0.35, normal 0, slow +0.35
  ι         ~ Beta(2,2) shifted by profile: impulsiveness ∈ [0,1]; blitz-specialist +0.2
  π_p       ~ N(profile.premove, 0.5)                  # premove tendency (logit units); bullet-specialist +1.0
  τ         ~ Beta(a,b) with mean 0.65 + 0.20·elo_z, sd 0.12  # time-management skill
  ρ_mirror  ~ U(0.05, 0.30)                            # opponent-tempo coupling
  motor_k   ~ N(1, 0.12)                               # multiplies hover/drag (fast vs slow mouse)
```
Persona enters the model as: `s_game` added to `log t_body` (and as `my_pace_resid_0` in v2); `ι` in instant/tilt logits; `π_p` in the premove logit; `τ` in budget reserve/overspend and long-think rate; `ρ_mirror` as `β_mirror`; `motor_k` scales the motor model.

Adaptive-to-opponent term (`β_mirror · opp_pace`): humans in blitz drift toward the opponent's tempo (Sigman's inter-player correlation). `opp_pace` uses the last three opponent think times measured by move-arrival timestamps; it is clamped to ±2 so a stalling opponent cannot push us into using all our time, and it is disabled when `C < 20 s`.

Also per game: `ε_0 = 0`, `tilt = 0`, per-game running stats for `my_pace_resid` and `budget_used_ratio`.

---

## 5. Runtime API (TypeScript)

```ts
// ---- types ---------------------------------------------------------------
export type TcClass = 'bullet' | 'blitz' | 'rapid' | 'classical';
export type TimingMode = 'premove' | 'instant' | 'normal' | 'long';

export interface EngineLine { move: string; cp: number | null; mate: number | null; depth: number; pv: string[] }

export interface TimingContext {
  fen: string; ply: number; moves: string[]; myColor: 'w' | 'b';
  chosenMove: string;                       // from move-selection module (UCI)
  lines: EngineLine[];                      // MultiPV at feature depth (POV side-to-move, cp)
  evalBeforeOppMove: number | null;         // our POV, from our previous search
  expectedOppReply: string | null;          // PV[1] of our previous search
  myClockMs: number; oppClockMs: number; baseSec: number; incSec: number;
  oppThinkMsHistory: number[]; myThinkMsHistory: number[];   // this game
  site: 'lichess' | 'chesscom' | 'other';
  targetElo: number; profile: PersonaProfile;
  engineReady: boolean;                     // result already available (pondered)?
  inputMethod: 'drag' | 'click'; autoQueen: boolean;
  nowMs: number;                            // performance.now() at opponent-move arrival
}

export interface TimingPlan {
  thinkMs: number;                          // total: arrival → move completed on board
  mode: TimingMode;
  preMoveHoverMs?: number;                  // invisible wait before mousedown (thinkMs − motor)
  dragDurationMs: number;                   // mousedown → mouseup (or click → click)
  fakeout?: { piece: string; holdMs: number; gapMs: number };
  promotionDelayMs?: number;
  deadlineMs: number;                       // absolute performance.now() at which move must be sent
  rationale: string[];                      // human-readable, for the debug view
  features: Record<string, number>;         // for debug + offline logging
}

export interface DistributionHead {         // v1 or v2
  sample(f: Features, persona: Persona, state: GameTimingState, rng: Rng): { tSec: number; mode: TimingMode; why: string[] };
}

export class TimingModel {
  constructor(head: DistributionHead, settings: TimingSettings, rng: Rng) {}
  startGame(ctx: Pick<TimingContext, 'targetElo' | 'profile' | 'baseSec' | 'incSec' | 'site'>): void; // samples persona, resets AR state
  planMove(ctx: TimingContext): TimingPlan;
  replan(plan: TimingPlan, ctx: TimingContext, reason: ReplanReason): TimingPlan;
  observe(actualThinkMs: number, plan: TimingPlan): void;  // feeds realised time into ε_t and my_pace_resid
}
```

`planMove` (pseudo-code, shared by v1/v2):

```ts
planMove(ctx) {
  const f = computeFeatures(ctx);                                   // §2
  const alloc = budgetController(f, this.persona, this.state);      // §3a.2
  let { tSec, mode, why } = this.head.sample(f, this.persona, this.state, this.rng, alloc);
  tSec = applyPressureAndCaps(tSec, f, ctx);                        // §3a.3 comp + hard caps
  if (mode === 'premove' && !f.premove_eligible) { mode = 'instant'; tSec = Math.max(tSec, 0.25); why.push('premove not eligible → instant'); }
  const motor = motorModel(f, ctx, this.persona);                   // §3a.6
  const total = mode === 'premove' ? tSec : Math.max(tSec, motor.total);
  const plan: TimingPlan = {
    thinkMs: total * 1000, mode,
    preMoveHoverMs: mode === 'premove' ? 0 : Math.max(0, total - motor.total) * 1000,
    dragDurationMs: motor.drag * 1000,
    fakeout: motor.fakeout, promotionDelayMs: motor.promo * 1000,
    deadlineMs: ctx.nowMs + total * 1000,
    rationale: why, features: f.asRecord(),
  };
  this.state.lastPlan = plan;
  return plan;
}
```

**Scheduler / executor state machine** (content script side):

```
PLANNED ──(wait preMoveHoverMs)──► HOVER ──(mousedown)──► DRAGGING ──(dragDurationMs, mouseup)──► SENT ──► DONE
   │                                  │
   └── events at any time: 'engine-changed' | 'clock-jump' | 'opponent-moved' | 'manual-now' | 'blur'
```

Re-plan rules (`replan(plan, ctx, reason)`):
- `engine-not-ready` at deadline (only when `engineReady` was false): keep waiting; when the result arrives, extend by `max(0, motor.total)` and record the overrun via `observe()` so ε_t compensates on the next moves.
- `engine-changed` (move-selection module changed `chosenMove` during the wait): recompute features for the new move; keep the already-elapsed time, sample a new body with the same ε_t, `thinkMs = max(elapsed + motor, new sample)`; add rationale "re-planned: chosen move changed".
- `clock-jump` (page clock differs from expected by > 1.5 s, e.g. lag or tab throttling): recompute caps with the true clock; if the remaining planned wait exceeds the new cap, truncate to the cap.
- `opponent-moved` while we are in PLANNED for a *premove*: this is the expected path — verify the opponent's move equals `expectedOppReply`; if yes fire immediately (0–120 ms), else discard and call `planMove` afresh with `ponder_hit = 0`.
- `blur`/hidden tab: pause the plan; on refocus add `U(0.3, 1.2)` s "re-orientation" delay if the pause exceeded 2 s (unless `C < 15`).
- Emergency: if at any moment `myClockMs < 1500`, cut every wait to 0 and use the minimal 60 ms motor.

**Manual mode.** A configurable key ("move now") short-circuits: cancel timers, jump to `HOVER` with `preMoveHoverMs = 0`, keep `dragDurationMs` (a human still has to drag), and call `observe()` with the actual elapsed time so game-level state stays coherent. A second key ("hold") freezes the plan until released (used when the user wants to think themselves); on release the model treats the elapsed time as already spent.

Timer precision: use `performance.now()` and a single `setTimeout` per phase computed from absolute `deadlineMs` (never accumulated `setTimeout`s); in the offscreen document background throttling does not apply but in a content script it can, hence the `clock-jump` rule.

---

## 6. Evaluation plan

**Offline (v1 and v2, same harness — `06_eval.py`):** held-out games (5 %, split by game id), ALLIE/ChessMimic-style filter variants reported side by side: (i) all plies ≥ 2, (ii) drop first 10 plies and moves with either clock < 30 s.
- Negative log-likelihood per ply of the realised think time under the model's predicted distribution (for v1: mixture of spike + log-normal + tail evaluated at the 1-s-resolved observation as an interval likelihood `P(t ∈ [k, k+1))`; for v2: bucket NLL). Report per rating bucket × tc_class × phase × clock bucket (`>120, 60–120, 30–60, 10–30, <10 s`).
- CRPS on the seconds scale, and MAE / Pearson r of the predictive median (for comparison with ChessMimic MAE 4.1 s, r 0.41 and ALLIE r 0.70).
- Calibration: PIT histograms per slice; coverage of the 50/80/95 % predictive intervals.
- Marginal shape checks: histogram of predicted vs real log-think per phase; tail index estimate (Hill) of predicted vs real above the 95th percentile (real ≈ power-law per Sigman; target: predicted α within ±0.3).
- Game-level checks: cumulative time-used curve vs move number (reference: ≈75–78 % of a 3+0 budget used by move 40), flag rate (fraction of games where simulated clock hits 0 before ply 100 vs real), distribution of per-game total time used, autocorrelation function of log-think (real: positive to lag 5–7, negative beyond), cross-correlation with opponent think.
- Adversarial detectability: train a small GBDT on per-game timing sequences (real vs simulated for the same games' move sequences) — target AUC ≤ 0.60 for v2, ≤ 0.70 for v1. This is the single most important acceptance metric.

**Sanity dashboards:** static HTML from `06_eval.py` with (a) marginal histograms per phase and per time-left bucket, (b) median think vs ply for three rating buckets (should reproduce Sigman's inverted U and the rating crossover: strong players faster before ply 15, slower in the middlegame), (c) premove/instant rate vs tc_class × phase, (d) long-think rate vs `crit`, (e) predicted-vs-real scatter with the filtered r.

**In-extension "timing debug" view:** a panel listing, per move: mode, planned vs actual thinkMs, alloc, C, N_rem, comp factor, ε_t, top-5 feature contributions (`β_i f_i` sorted by |value| for v1; for v2 the input-gradient × value attribution of the chosen bucket), persona values for the game, and the `rationale[]` strings. Export the game's rows as JSON for offline comparison against the same user's real games.

---

## 7. Default parameter table (v1) and exposed knobs

| Parameter | Default | Elo slope (per elo_z) | Notes |
|---|---|---|---|
| `N_rem` formula constants | 22 / 0.9 / 0.5 / 0.25, clamp [10,45] | — | §3a.2 |
| `reserve` | 0.06·base clamp [2,20] s, × τ | via τ | |
| overspend factor | 0.35·(1−τ) | via τ | |
| `β_book` | −1.20 | −0.40 | |
| `β_phase_mid / end` | +0.15 / −0.10 | — | |
| `β_U` | 0.25, centre ply 36, width 1600 | — | |
| `β_cplx` | 0.35 | +0.15 | |
| `β_dec` | 0.22 | +0.06 | |
| `β_gap` | 0.10 | — | |
| `β_forced / β_recap / β_only` | −0.90 / −0.80 / −1.50 | — | |
| `β_ponder` | −0.45 | — | |
| `β_swing` | +0.30 | — | |
| `β_evalabs` | −0.18 | — | |
| `β_lost / β_dead / β_won` | +0.20 / −0.35 / −0.30 | — | thresholds −120…−600 / ≤−600 / ≥+500 cp |
| `β_check / β_promo / β_legal / β_ratio` | −0.10 / +0.15 / +0.10 / +0.08 | — | |
| `β_mirror` | persona ρ ∈ U(0.05,0.30) | — | |
| `σ0` | 0.80 | −0.12 | +0.10 middlegame, −0.08 book |
| `φ` | 0.35 | +0.05 | |
| compression | 30 s / 0.20 P thresholds, floor 0.35; 12 s floor 0.15 | — | inc ≥ 2 floor 0.6 |
| hard caps | 0.5·C; 0.15·C if C<30 & inc<2; 0.35 s if C<3 | — | |
| premove `a_tc` | bullet −0.4, blitz −2.0, rapid −3.5, classical −5 | +0.6 (bullet) | + feature terms §3a.5 |
| instant `b_tc` | bullet 0.2, blitz −0.9, rapid −1.8, classical −2.5 | — | |
| `λ0` long-think | 0.020 | +0.008 | cap p_long 0.12; Pareto α 1.6; shift 2.5 |
| long-think cap | min(0.25·C, 15 s bullet / 45 s blitz / 120 s rapid) | — | |
| tilt | 3 moves, ×exp(−0.35·ι) | — | trigger: own move lost ≥ 200 cp |
| fakeout p | 0.02 + 0.015·(1−elo_z) | — | only C > 20 s |
| motor hover | LN(median 0.22 s, σ 0.35) × motor_k | — | |
| motor drag | 0.09 + 0.07·log2(1+dist) s, sd 0.03, clamp [0.08,0.6] | — | click mode: 0.12 + 0.05·log2(1+dist) |
| promotion delay | U(0.25, 0.60) s | — | 0 if autoQueen |
| persona σ's | s 0.20, π_p 0.5, τ sd 0.12, motor_k 0.12, session_mu 0.15 | — | §4 |
| v2 AR σ | 0.35 | — | replaces σ0 when v2 head active |
| v2 sampling temperature | 1.0 | — | expose 0.7–1.3 |

**Knobs exposed in Settings → Advanced (8–10):**
1. **Target Elo** (existing slider) — drives `elo_z`.
2. **Personality profile** — fast / normal / slow / bullet-specialist / blitz-specialist (sets `profile.speed`, `profile.premove`, ι offset).
3. **Overall speed** (`s_offset`, −0.5…+0.5 log units; default 0) — global multiplier on top of persona; replaces `maxWaitTime`.
4. **Time-management skill** (τ mean override, 0.2–1.0) — how well the clock is budgeted; low = time-trouble prone.
5. **Premove aggressiveness** (`π_p` offset, −2…+2).
6. **Long-think frequency** (`λ0` multiplier 0–3×) and **max long think** (cap seconds).
7. **Time-trouble threshold** (30 s / 0.20 P; range 10–60 s) — when compression begins.
8. **Opponent mirroring** (ρ_mirror 0–0.5).
9. **Motor speed** (`motor_k` 0.6–1.6) and **input method** (drag / click) with **auto-queen**.
10. **Model tier** (v1 parametric / v2 learned) + **sampling temperature** (v2) + **debug view** toggle; **manual "move now" / "hold" keys**.

Migration: `maxWaitTime` is removed; on upgrade map old value `w` (0–10 s) to `s_offset = clamp(ln(max(w,0.5)/4), −0.5, 0.5)` so users keep roughly their previous average pace.

---

## Appendix A — v1 sampling reference implementation (TypeScript, condensed)

```ts
sample(f, p, st, rng, alloc) {
  const why: string[] = [];
  const C = f.clock_s, e = f.elo_z;
  // 1. premove
  if (f.premove_eligible) {
    const lp = A_TC[f.tc] + 2.0*f.is_recapture + 1.5*f.in_book + 1.5*f.is_only_legal + 1.0*f.ponder_hit
             + 1.5*(C<10) + 0.8*(C<20) - 0.6*f.ln_n_reasonable - 0.3*f.swing_bad + p.pi_p + 0.6*e*(f.tc==='bullet');
    if (rng.uniform() < sigmoid(lp)) return { tSec: rng.uniform()*0.12, mode: 'premove', why: [`premove p=${sigmoid(lp).toFixed(2)}`] };
  }
  // 2. instant
  const li = B_TC[f.tc] + 1.2*f.is_recapture + 1.0*f.is_forced + 0.8*f.ponder_hit + 1.0*f.in_book
           + 0.8*(C<20) - 0.5*f.ln_n_reasonable + 0.5*p.iota + (st.tilt>0 ? 0.6*p.iota : 0);
  if (rng.uniform() < sigmoid(li)) return { tSec: 0.05 + 0.2*rng.uniform(), mode: 'instant', why: [`instant p=${sigmoid(li).toFixed(2)}`] };
  // 3. body
  const beta = bodyTerms(f, p, e, why);               // Σ β_i f_i with per-term rationale strings
  const sigma = 0.80 - 0.12*e + 0.10*f.phase_mid - 0.08*f.in_book;
  const phi = 0.35 + 0.05*e;
  st.eps = phi*st.eps + Math.sqrt(1-phi*phi)*sigma*rng.normal();
  let logT = Math.log(alloc) + beta + p.s_game + st.eps - (st.tilt>0 ? 0.35*p.iota : 0);
  let t = Math.exp(logT), mode: TimingMode = 'normal';
  // 4. long think
  if (C >= 30 && f.pressure >= 0.15) {
    const crit = clamp(0.5*f.ln_n_reasonable + 0.4*f.swing_bad + 0.3*(Math.abs(f.eval_cp)<150) + 0.3*f.phase_mid - 0.3*f.decisiveness, 0, 2);
    const pLong = clamp((0.020+0.008*e)*Math.exp(0.9*crit)*(0.6+0.4*p.tau), 0, 0.12);
    if (rng.uniform() < pLong) { t *= 2.5 + rng.pareto(1.6); mode = 'long'; why.push(`long think p=${pLong.toFixed(3)} crit=${crit.toFixed(2)}`); }
  }
  return { tSec: t, mode, why };
}
```

## Appendix B — sources

- Sigman M, Etchemendy P, Fernández Slezak D, Cecchi GA (2010). Response time distributions in rapid chess: a large-scale decision making experiment. *Front. Neurosci.* 4:60. https://pmc.ncbi.nlm.nih.gov/articles/PMC2965049/
- Zhang Y, Jacob AP, Lai V, Fried D, Ippolito D (2025). Human-Aligned Chess With a Bit of Search (ALLIE). ICLR 2025. https://arxiv.org/abs/2410.03893 ; code https://github.com/ippolito-cmu/allie
- ChessMimic: Per-Rating Transformer Models for Human Move, Clock, and Outcome Prediction in Online Blitz Chess (2026). https://arxiv.org/html/2606.04473
- Chacoma A, Billoni O (2025). Emergent complexity in the decision-making process of chess players. *Sci. Rep.* https://arxiv.org/abs/2406.15463
- Tang Z, et al. (2024). Maia-2: A Unified Model for Human-AI Alignment in Chess. NeurIPS 2024. https://arxiv.org/abs/2409.20553
- McIlroy-Young R, Wang R, Sen S, Kleinberg J, Anderson A (2021). Detecting Individual Decision-Making Style: Exploring Behavioral Stylometry in Chess. NeurIPS 2021. https://arxiv.org/abs/2208.01366
- McIlroy-Young R, et al. (2020). Aligning Superhuman AI with Human Behavior: Chess as a Model System (Maia). KDD 2020. https://arxiv.org/abs/2006.01855
- Rheude T. Time Management in Chess with Neural Networks and Human Data (CTM Net). TU Darmstadt. https://ml-research.github.io/papers/rheude2021time.pdf
- Chess Rating Estimation from Moves and Clock Times Using a CNN-LSTM (2024). https://arxiv.org/abs/2409.11506
- jk_182. How does the Clock impact the Rate of Mistakes? Lichess blog. https://lichess.org/@/jk_182/blog/how-does-the-clock-impact-the-rate-of-mistakes/JSazQplM
- Lichess open database. https://database.lichess.org/ ; https://github.com/lichess-org/database
- Lichess forum on premove cost (0.0 s on Lichess, 0.1 s on chess.com). https://lichess.org/forum/lichess-feedback/is-the-lack-of-any-premove-time-penalty-an-exploitable-flaw


# Appendix E — Move selection and engine framework


Date: 2026-09-03. Target: MV3 Chrome extension (TypeScript), Stockfish NNUE WASM in an offscreen document, service worker orchestrator, side panel UI, content scripts on chess.com / lichess.

Summary of what is being replaced (from `scripts/background.js` and `manifest.json` in the repo): MV2 background page, a ~340 KB legacy `SlicedEngine/engine.wasm` (pre-NNUE), per-move `ucinewgame` + `setoption Skill Level N` + `go depth D`, single best move only, 100 ms polling for `bestmove`, `round` counter for stale results, forced f3/Kf2 "bongcloud" easter egg. Strength = Skill Level only.

---

## 0. Verified facts (sources)

| Fact | Value | Source |
|---|---|---|
| Stockfish `UCI_Elo` range | 1320–3190, calibrated at 60s+0.6s TC, anchored to CCRL 40/4; overrides `Skill Level` when `UCI_LimitStrength=true` | [SF UCI docs](https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html) |
| Elo → level formula | `e=(elo-1320)/(3190-1320)`; `level=clamp(((37.2473e-40.8525)e+22.2943)e-0.311438, 0, 19)` | `src/search.h` master, `struct Skill` |
| Skill pick | `weakness=120-2*level`; `delta=min(top-min, PawnValue)`; `push=(weakness*(top-score_i) + delta*(rng%weakness))/128`; argmax `score_i+push`; chosen at `depth == 1+int(level)`; `multiPV=max(multiPV,4)` when skill enabled | `src/search.cpp` master (`Skill::pick_best`, `time_to_pick`) |
| Other SF defaults | Threads 1 (max 1024), Hash 16 MB, MultiPV 1, Move Overhead 10 ms, Skill Level 20, UCI_LimitStrength false | SF UCI docs |
| Stockfish NNUE nets | big net ~79 MB (SF 17.1 `nn-c288c895ea92.nnue`) / 133 MiB (SF 17 `nn-1c0000000000.nnue`); small net ~6 MB (`nn-37f18f62d772.nnue`) | [lichess stockfish-web](https://github.com/lichess-org/stockfish-web), [lichess forum](https://lichess.org/forum/lichess-feedback/stockfish-17-nnue--79mb-error) |
| Browser SF builds | `stockfish` npm (nmrugg) = SF 18: full multi-thread (>100 MB with net), `-lite` ~7 MB (small net), `-single` variants without SAB; lichess `stockfish-web` ships `sf_18`, `sf_18_smallnet`, `sf_dev` (20260901) | [stockfish.js README](https://github.com/nmrugg/stockfish.js/), [stockfish-web](https://github.com/lichess-org/stockfish-web) |
| SAB in extension pages | manifest `"cross_origin_embedder_policy": {"value":"require-corp"}`, `"cross_origin_opener_policy": {"value":"same-origin"}` | [Chrome cross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation) |
| Lichess WASM hash defaults | ~16 MiB on mobile, up to 512 MB desktop; wasm32 heap max 4 GB theoretical, browsers allow ~2 GB | [lichess forum](https://lichess.org/forum/lichess-feedback/stockfish-16-settings), [stockfish.wasm #27](https://github.com/lichess-org/stockfish.wasm/issues/27) |
| Maia-1 | per-rating nets 1100…1900; ~50.8–52.9% move-match; Stockfish (attenuated, depth 1–15) 35–40%; Maia-1 params 92M; Lc0-format weights ~1.2 MB; ONNX exports ~3.48 MB each | [Maia KDD blog](http://csslab.cs.toronto.edu/blog/2020/08/24/maia_chess_kdd/), [lczerolens ONNX](https://huggingface.co/spaces/lczerolens/backends-demo/blob/main/demo/onnx-models/maia-1100.onnx) |
| Maia-2 | 23.3M params; 18 input planes, 12 ResNet blocks (256 ch), 2 skill-aware attention blocks (16 heads), Elo-bucket embeddings (dim 128, buckets <1000 … 2000+), inputs `elo_self`, `elo_oppo`; trained on 169M rapid games / 9.1B positions; accuracy 51.7% (≤1600) / 54.2% (1600–2000) / 53.9% (≥2000); Stockfish 36.2 / 38.3 / 40.7%; Leela 36.0 / 38.8 / 43.3%; MIT license; PyTorch only (Google-Drive weights), no official ONNX | [arXiv 2409.20553](https://arxiv.org/html/2409.20553v2), [CSSLab/maia2](https://github.com/CSSLab/maia2) |
| Maia-3 | Chessformer (ICLR 2026): 3M/5M/23M/79M; 79M = 57.1% move match; UCI engine with `SelfElo`, `OppoElo`, `Temperature`, `TopP`; HF checkpoints; PyTorch, no official ONNX | [CSSLab/maia3](https://github.com/CSSLab/maia3), [HF Maia3-23M](https://huggingface.co/UofTCSSLab/Maia3-23M) |
| Maia in browser exists | maia-platform-frontend loads `maia_kdd_1100..1900` ONNX with `onnxruntime-web`; play-lc0 runs Lc0/Maia ONNX (via `lc0 leela2onnx`) with WebGPU + WASM fallback, IndexedDB caching | [maia-platform-frontend](https://github.com/csslab/maia-platform-frontend), [play-lc0](https://github.com/hunterchen7/play-lc0) |
| onnxruntime-web 1.22 sizes | `ort.wasm.min.js` 48 KB; `ort.min.js` 358 KB; `ort-wasm-simd-threaded.wasm` 11.2 MB; `.jsep.wasm` (WebGPU) 21.9 MB | jsDelivr package listing |
| Polyglot format | 16-byte big-endian entries: key u64, move u16, weight u16, learn u32; sorted by key; move bits 0–2 to-file, 3–5 to-rank, 6–8 from-file, 9–11 from-rank, 12–14 promo (1=N..4=Q); castling encoded e1h1/e1a1/e8h8/e8a8; key = piece^castle^ep^turn over the 781-entry Random64 table | [hgm.nubati.net/book_format.html](https://hgm.nubati.net/book_format.html) |
| Small books | `gm2600.bin` = 346,736 bytes (21,671 entries); `komodo.bin`, `rodent.bin`, `gm2001.bin` (Elo ≥2530 games 2001–2013) | [donna_opening_books](https://github.com/michaeldv/donna_opening_books), [polyglot-books](https://github.com/ChrisWhittington/polyglot-books) |
| Lichess explorer | `https://explorer.lichess.ovh/lichess?variant=standard&fen=…&speeds=blitz,rapid&ratings=1600,1800`; ratings buckets `0,1000,1200,1400,1600,1800,2000,2200,2500`; speeds `ultraBullet,bullet,blitz,rapid,classical,correspondence`; `moves` default 12; `topGames`/`recentGames` max 4; CORS `*`; no auth; "only make one request at a time"; 429 on abuse; full outage Feb 2026 (all 429) | [lichess api spec](https://github.com/lichess-org/api), [lila-openingexplorer](https://github.com/lichess-org/lila-openingexplorer), [lila #19610](https://github.com/lichess-org/lila/issues/19610) |
| Lichess win%/accuracy | `Win% = 50 + 50*(2/(1+exp(-0.00368208*cp)) - 1)`; `Acc% = 103.1668*exp(-0.04354*(WinBefore-WinAfter)) - 3.1669`; inaccuracy/mistake/blunder = ≥10/20/30 win% drop | [lichess.org/page/accuracy](https://lichess.org/page/accuracy) |
| ACPL by rating (approximate, rapid/classical) | <1000: 90–130; 1000–1400: 60–90; 1400–1800: 40–60; 1800–2200: 25–40; 2200+: <20; folk formula `rating ≈ 3000 − 20·ACPL` | [mychessplan](https://mychessplan.com/average-centipawn-loss-explained-acpl-by-rating/), [lichess forum](https://lichess.org/forum/general-chess-discussion/whats-a-decent-average-centipawn-loss) |
| Chess.com accuracy by rating (player-reported) | 1000–1499: ~70–80%; 1500–1999: ~80–85%; 2000–2499: ~82–87% (CAPS2, formula private) | [chess.com forum](https://www.chess.com/forum/view/general/accuracy-by-chess-rating), [chess.com help](https://support.chess.com/en/articles/8708970-how-is-accuracy-in-analysis-determined) |

Caveat: the ACPL-by-rating table is a practitioner summary, not a peer-reviewed study; the one academic-style regression found (Coulombe, 1,846 lichess games) got R²≈0.05–0.07 between ACPL and rating, i.e. ACPL alone is a noisy target. Treat the numbers as calibration priors and tune against your own sampled lichess PGNs (see §1.7).

---

# PART A — MOVE SELECTION

## 1. Strength control

### 1.1 Option (i): Stockfish built-in `UCI_LimitStrength` + `UCI_Elo`

Mechanism (from `search.h` / `search.cpp` master):

```cpp
struct Skill {
  constexpr static int LowestElo = 1320, HighestElo = 3190;
  Skill(int skill_level, int uci_elo) {
    if (uci_elo) {
      double e = double(uci_elo - LowestElo) / (HighestElo - LowestElo);
      level = std::clamp((((37.2473 * e - 40.8525) * e + 22.2943) * e - 0.311438), 0.0, 19.0);
    } else level = double(skill_level);
  }
  bool enabled() const { return level < 20.0; }
  bool time_to_pick(Depth depth) const { return depth == 1 + int(level); }
  ...
};
// search.cpp
Skill skill(options["Skill Level"], options["UCI_LimitStrength"] ? int(options["UCI_Elo"]) : 0);
if (skill.enabled()) multiPV = std::max(multiPV, usize(4));
...
if (skill.enabled() && skill.time_to_pick(rootDepth)) skill.pick_best(rootMoves, multiPV);
...
Move Skill::pick_best(const RootMoves& rootMoves, usize multiPV) {
  static PRNG rng(now());
  Value topScore = rootMoves[0].score, minScore = rootMoves[0].score;
  for (i = 1..multiPV) { topScore = max(...); minScore = min(...); }
  int delta = std::min(topScore - minScore, int(PawnValue));
  int maxScore = -VALUE_INFINITE;
  double weakness = 120 - 2 * level;
  for (i = 0..multiPV) {
    int push = int(weakness * int(topScore - rootMoves[i].score)
                 + delta * (rng.rand<unsigned>() % int(weakness))) / 128;
    if (rootMoves[i].score + push >= maxScore) { maxScore = ...; best = rootMoves[i].pv[0]; }
  }
  return best;
}
```

Properties:
- The pick happens at a *fixed shallow depth* (`1 + int(level)`, so Elo 1320 → depth 1, Elo ~2000 → depth ~7). The rest of the search continues but the chosen move is frozen. So the "weakness" is really "shallow-depth blindness plus a small random push among the top 4 lines".
- Only the top-4 (or MultiPV) moves are candidates. It can never play a move outside the engine's top-4 at that depth — but at depth 1–3 the "top 4" are already tactically naive, which is where its human-unlike behaviour comes from (hangs pieces to simple 2-move tactics, yet never plays a "human" positional inaccuracy).
- `weakness*(top−score)` favors moves *closer to top*, i.e. the push is biased toward the best move; random term is `delta*(rng % weakness)/128` — at level 0 that's up to ~0.94·delta cp of noise, bounded by `PawnValue` (≈100–208 cp depending on version).
- Calibrated on engine-vs-engine matches at 60s+0.6s, anchored to CCRL. Human-rating equivalence is loose; Lichess and others observe SF-Elo-1500 plays "weirdly": long stretches of perfect moves then one absurd blunder.
- Blocks MultiPV usage for the panel: with skill on, the returned PVs are from a crippled search and the `bestmove` is not the best line. We need full-strength analysis for the eval bar anyway.

Verdict: do not use for selection. Optionally keep as a *debug* mode.

### 1.2 Option (ii): our own MultiPV softmax sampling

Run Stockfish at full strength with `MultiPV=K` (K=6–10), then choose among lines with a rating-parameterized stochastic policy. Advantages: we control everything (temperature, blunder profile, consistency across the game, never-play rules), we get the true eval for the panel from the same search, and there is zero extra runtime cost. Disadvantage: candidates are limited to the engine's top-K; "human" but bad-by-engine-standards moves (e.g. the 5th-best positional move that is actually the most natural) may not be in the set. K≥6 at moderate depth covers >90% of moves humans actually play at ≥1400 (Maia-2 reports engine top-1 alone is ~36–41%; the top-K coverage is empirically much higher; verify with your own logs, §1.7).

### 1.3 Option (iii): Maia-2 / Maia-3 (rating-conditioned human move prediction)

- Maia-2: 23.3M params. In FP32 that is ~93 MB, FP16 ~47 MB, INT8 ~24 MB. No official ONNX export; the model is PyTorch (`model.from_pretrained(type="rapid"|"blitz")`). Export is feasible (`torch.onnx.export`, opset 17; the skill-aware attention blocks are standard ops) but you own it.
- Maia-3: 5M variant recommended for CPU; 23M/79M for accuracy (57.1% for 79M). Also PyTorch/HF only. Transformer over 64 square tokens; exporting to ONNX is straightforward; 5M ≈ 20 MB FP32 / 10 MB FP16 / 5 MB INT8.
- Maia-1: already ONNX (~3.48 MB per rating net), runs in browser today (maia-platform-frontend, play-lc0). Nine nets (1100–1900) = ~31 MB, or ship 3 (1200/1500/1800) and interpolate the policy by mixing.
- Runtime: `onnxruntime-web` WASM backend: `ort.wasm.min.js` 48 KB + `ort-wasm-simd-threaded.wasm` 11.2 MB (loadable from extension package; no CDN needed). WebGPU backend needs the 21.9 MB `.jsep.wasm` + `ort.webgpu.min.js` 358 KB and only helps for batch>1 or the 79M model. For single-position inference of a 5–25M model, WASM SIMD+threads is ~10–40 ms on a desktop CPU (extrapolated from play-lc0 / Maia-1 in-browser reports, unverified for Maia-2; Maia-1 ONNX runs in <10 ms). WebGPU is *not* required.
- Latency budget: ≤50 ms per position is fine because we call Maia once per move (not in the search loop).
- Threads: onnxruntime-web multithreading requires SAB, i.e. the same COOP/COEP manifest keys we set for Stockfish. Load ORT in the same offscreen document as Stockfish, in a separate Worker.

Verdict: Maia is the only source of *human priors* that Stockfish cannot give (natural-looking developing moves, human blunder patterns — Maia-1 predicts human blunders at >25% rate). But it is an optional ~10–50 MB download and an export you maintain. Design for it as a plug-in prior, not a dependency.

### 1.4 Recommended layered architecture

```
                 ┌──────────────┐  MultiPV=K, full strength
   FEN, clocks ─▶│  Stockfish   │─────────┐
                 └──────────────┘         ▼
                 ┌──────────────┐   ┌───────────────┐    ┌───────────────┐
   FEN, eloSelf ─▶│ Maia prior   │──▶│  Selection    │───▶│  Never-play   │──▶ move + humanized delay
   (optional)     │ (onnx, opt.) │   │  policy π(E)  │    │  filters      │
                 └──────────────┘   └───────────────┘    └───────────────┘
                 ┌──────────────┐          ▲
   FEN ─────────▶│ Opening book │──────────┘ (overrides selection while in book)
                 └──────────────┘
```

Selection policy inputs: `lines[i] = {move, cp|mate, depth, pv}` for i<K; target Elo `E`; game context (ply, clock, phase, our material balance); per-game latent "form" state; optional Maia distribution `q(m)`.

### 1.5 Exact formulas

**Score normalisation (side to move = us).** Clamp raw cp to ±1000, map mates to the boundary so they order correctly:

```
cpEff(line) =
  mate>0 :  1000 + (100 - mate)     // mate in 1 > mate in 5
  mate<0 : -1000 - (100 + mate)     // getting mated in 1 is worst
  else   :  clamp(cp, -1000, 1000)
```

**Win-probability space (preferred over raw cp).** Humans lose *winning chances*, not centipawns; a 100 cp mistake at +600 is irrelevant, at 0.00 it is large. Use the lichess sigmoid:

```
win(cp) = 1 / (1 + exp(-0.00368208 * cp))              // in [0,1], ours-to-move perspective
loss_i  = win(cpEff(best)) - win(cpEff(line_i))          // ≥ 0, in "win fraction"
```

**Temperature schedule (calibrated to Elo).** Softmax over −loss with temperature τ(E) in win-fraction units:

```
τ(E) = clamp(0.02 + 0.28 * ((2500 - E) / 1700)^2, 0.02, 0.30)
       E=2500 → 0.020    E=2100 → 0.035    E=1800 → 0.067
       E=1500 → 0.117    E=1200 → 0.183    E= 900 → 0.271
```

Base policy:

```
p_i ∝ exp(-loss_i / τ(E)) · prior_i^β(E)
prior_i = Maia q(move_i) if available, else heuristicPrior(move_i) (§3.4);
β(E)    = 0.6 for E<1600, 0.4 for 1600≤E<2200, 0.2 above (weaker prior when strong)
```

Renormalise over i<K. Two extra shaping terms:

- *Gap cutoff*: drop any line with `cpEff(best) − cpEff(i) > G(E)` from the *base* policy: `G(E) = 60 + 440·clamp((2200−E)/1400, 0, 1)` (2200+: 60 cp; 1500: 280 cp; 800: 500 cp). Large errors come only from the explicit blunder channel, so they occur at the right rate rather than as a temperature side effect.
- *Score jitter* (perception noise): before computing loss, add `cpEff_i += N(0, σ(E))`, `σ(E) = 8 + 42·clamp((2400−E)/1600,0,1)` cp. This makes near-equal moves indistinguishable to a weak player (the engine's 3-cp preferences shouldn't survive).

**Blunder injection (mixture).** Each move, with probability `b(E, ctx)` replace the base draw with a draw from the *error distribution*:

```
b(E, ctx) = b0(E) · f_clock · f_complexity
b0(E):  <1000: 0.075  1200: 0.055  1400: 0.040  1600: 0.028  1800: 0.020
        2000: 0.013   2200: 0.009  2500: 0.005  (per move; ≈ 3.0 / 2.2 / 1.6 / 1.1 / 0.8 / 0.5 / 0.35 / 0.2 blunders per 40 moves)
f_clock = 1 + 1.5·clamp((20s − ourClock)/20s, 0, 1)         // time-pressure multiplier (0..2.5)
f_complexity = 1 + 0.6·(std of cpEff over top-K ≥ 150 cp)   // sharp positions produce more errors
```
When the blunder channel fires, choose the error magnitude from a two-component distribution in win-fraction:
```
with prob 0.65: "mistake"  target loss ~ U(0.10, 0.30)   // lichess mistake band
with prob 0.35: "blunder"  target loss ~ U(0.30, 0.70)
```
then pick the candidate whose `loss_i` is closest to the target (only lines with `loss_i ≥ 0.10`); if none exists (e.g. K lines all within 0.10), fall through to base policy — blunders are only injected when the position actually contains a plausible bad move. Weight candidates by `prior_i` so the blunder is a *human* blunder (e.g. natural-looking capture that loses to a zwischenzug) rather than a random king walk.

Calibration check: expected ACPL contribution ≈ base term (~10–25 cp from τ) + blunder term `b0 · E[cp loss | blunder]` (≈ 0.055 × 350 ≈ 19 cp at 1200) → totals in the right bands (≈80–100 at 1200, ≈45 at 1600, ≈25 at 2000) once cp clamp is applied. Tune `b0` and `τ` jointly against the ACPL table and your own measurement (§1.7).

**Consistency ("form").** Humans are autocorrelated. Keep a per-game latent `form ∈ [−1, 1]`, AR(1):
```
form_t = 0.85·form_{t−1} + N(0, 0.25); clamp
E_eff = E + 150·form_t          // effective Elo used for τ, b0, G
```
plus a *streak damper*: after an injected blunder, multiply `b` by 0.3 for the next 3 moves (humans who just blundered tend to concentrate); after 12 consecutive top-1 picks, multiply `τ` by 1.3 until a non-top-1 is played. This avoids the "perfect / random / perfect" signature of Stockfish's Skill mechanism.

**Never-play rules (hard filters applied after sampling; resample if violated):**
1. Never play a move whose line is `mate<0` for us (we get mated) when any `mate≥0 or cp>−1000` alternative exists, unless `E<1000` and with probability 0.25 (and only when the mate is ≥ 2 plies deep from the opponent's perspective, i.e. not an obvious mate-in-1 threat — check `pv[1]` of that line is the mating move).
2. If we have `mate>0` in ≤3, play it if `E≥1400`; for `E<1400`, play it with probability `0.5 + 0.5·(E−800)/600` (weak players miss mates); when not played, still exclude moves that throw the win (loss ≥ 0.4).
3. Never resign automatically. Draw offers/claims: only for `E ≥ 1600`, `|cp|≤20` for 6 plies, ply ≥ 60 — but never *offer* via automation; surface as a suggestion in the panel (UI toggle).
4. Never "hang a piece for nothing" outside the blunder channel: exclude from the base policy any line whose PV shows the opponent capturing a piece with `loss_i ≥ 0.25` (already handled by `G(E)`, but this is a SAN-level check for robustness).
5. Opening book moves override all of the above while in book (§2).

**Move → time.** Selection also decides the *delay* before executing (content script). Human think time model (lognormal, seconds):
```
μ(ctx) = ln( base(tc) · (1 + 0.8·complexity) · (1 + 0.5·isCapture?0:1) · phaseMult )
base(tc): bullet 0.9 s, blitz 2.5 s, rapid 6 s; phaseMult: opening 0.5, middlegame 1.0, endgame 0.7
delay ~ LogNormal(μ, 0.55), clamp to [0.25 s, min(0.25·ourClock, 40 s)]
book moves: delay ~ LogNormal(ln 0.8, 0.4)
premoves: 0.05–0.2 s after opponent's move
```
The engine's `movetime` is derived from this delay (§4), so the engine finishes before we act.

### 1.6 Target agreement rates (anti-signature)

Per Maia-2 (Table above) Stockfish's *top-1* matches human moves 36.2% (≤1600), 38.3% (1600–2000), 40.7% (≥2000) — evaluated on non-trivial positions. Design targets for our selector's top-1 agreement with the full-strength Stockfish best move, measured over a whole game (including forced moves, which inflate it):

| Target Elo | top-1 agreement | top-3 agreement | ACPL | blunders / 40 moves |
|---|---|---|---|---|
| 800–1000 | 38–45% | 70% | 100–130 | 2.5–3.5 |
| 1200 | 42–48% | 74% | 75–95 | 2.0–2.5 |
| 1600 | 47–53% | 80% | 45–60 | 1.0–1.5 |
| 2000 | 52–58% | 86% | 28–40 | 0.5–0.8 |
| 2400 | 58–66% | 91% | 15–25 | 0.2–0.4 |
| 2800 (max "human") | 68–75% | 95% | 8–15 | ≤0.15 |

Above 2800 the extension is an engine; if the user asks for that, drop the human layer (`τ→0.01`, `b0→0`).

### 1.7 Calibration loop (do this once, offline)

1. Download lichess monthly PGN (`database.lichess.org`, has `[%eval]` for analysed games); sample 2k games per rating bucket per speed.
2. Run our selector on each position with `E` = the player's rating, compare distribution of `loss` vs the human's actual move `loss`; fit `τ`, `b0`, `G` per bucket by minimizing KL between loss histograms + matching top-1/top-3 agreement.
3. Store the fitted constants as a table `calibration.json` keyed by `(speedClass, eloBucket)`; interpolate linearly.

### 1.8 Selection policy — TypeScript

```ts
export interface Candidate { uci: string; san: string; cpEff: number; loss: number; pv: string[]; prior: number; }
export interface SelectionContext {
  targetElo: number; speed: 'bullet'|'blitz'|'rapid'|'classical';
  ply: number; phase: 'opening'|'middlegame'|'endgame';
  ourClockMs: number; incMs: number; form: number; movesSinceBlunder: number; top1Streak: number;
  rng: () => number;              // seeded per game for reproducibility in tests
}
export interface Selection { uci: string; reason: 'book'|'policy'|'blunder'|'mate'|'forced'|'premove'; delayMs: number; debug: Record<string, unknown>; }

export function selectMove(lines: Line[], ctx: SelectionContext, prior?: Map<string, number>): Selection {
  const E = clamp(ctx.targetElo + 150 * ctx.form, 400, 3200);
  const tau = clamp(0.02 + 0.28 * ((2500 - E) / 1700) ** 2, 0.02, 0.30);
  const sigma = 8 + 42 * clamp((2400 - E) / 1600, 0, 1);
  const G = 60 + 440 * clamp((2200 - E) / 1400, 0, 1);
  const cands = lines.map(l => ({
    ...l, cpEff: cpEffective(l) + gauss(ctx.rng) * sigma,
  }));
  const best = Math.max(...cands.map(c => c.cpEff));
  for (const c of cands) c.loss = winProb(best) - winProb(c.cpEff);
  // never-play + mate handling
  const matePick = handleMates(cands, E, ctx);
  if (matePick) return matePick;
  // blunder channel
  const b = blunderProb(E, ctx);
  if (ctx.rng() < b) {
    const target = ctx.rng() < 0.65 ? uni(0.10, 0.30, ctx.rng) : uni(0.30, 0.70, ctx.rng);
    const pool = cands.filter(c => c.loss >= 0.10 && !getsMated(c));
    if (pool.length) {
      const pick = weightedArgmin(pool, c => Math.abs(c.loss - target) / Math.max(c.prior, 0.02));
      return { uci: pick.uci, reason: 'blunder', delayMs: thinkDelay(ctx, cands), debug: { b, target } };
    }
  }
  // base policy
  const beta = E < 1600 ? 0.6 : E < 2200 ? 0.4 : 0.2;
  const inGap = cands.filter(c => best - c.cpEff <= G && !getsMated(c));
  const w = inGap.map(c => Math.exp(-c.loss / tau) * Math.pow(Math.max(c.prior, 1e-3), beta));
  const pick = inGap[sampleIndex(w, ctx.rng)];
  return { uci: pick.uci, reason: 'policy', delayMs: thinkDelay(ctx, cands), debug: { tau, G, w } };
}

export const winProb = (cp: number) => 1 / (1 + Math.exp(-0.00368208 * cp));
export function cpEffective(l: Line): number {
  if (l.score.kind === 'mate') return l.score.value > 0 ? 1000 + (100 - l.score.value) : -1000 - (100 + l.score.value);
  return clamp(l.score.value, -1000, 1000);
}
```

`prior` defaults to `heuristicPrior` (§3.4) which returns 1.0 for neutral moves, >1 for natural moves (captures, recaptures, checks, castling, development), <1 for engine-only moves.

---

## 2. Opening play

### 2.1 Lichess opening explorer (online, best "human" source)

`GET https://explorer.lichess.ovh/lichess?variant=standard&fen=<urlencoded>&speeds=blitz,rapid&ratings=1600,1800&moves=12&topGames=0&recentGames=0`

Response (JSON when `Accept: application/json`; NDJSON stream otherwise): `{ white, draws, black, moves: [{ uci, san, white, draws, black, averageRating, ... }], opening: { eco, name } }`.

- Rating buckets: `0,1000,1200,1400,1600,1800,2000,2200,2500` (each bucket runs up to the next). For target Elo E pick the bucket containing E and its neighbours: `ratings = [bucket(E−200), bucket(E), bucket(E+200)]` deduped.
- Speeds: map site time control → `bullet | blitz | rapid | classical` (lichess semantics: estimated total = base + 40·inc; <30s ultraBullet, <180 bullet, <480 blitz, <1500 rapid, else classical). Use the matching speed plus one neighbour for coverage.
- CORS: `Access-Control-Allow-Origin: *` — callable directly from the offscreen document / service worker (`fetch`); add `host_permissions: ["https://explorer.lichess.ovh/*"]` to avoid mixed-content/extension-policy surprises.
- Rate limiting: no documented number; docs say "only make one request at a time"; 429 → back off 60 s. There was a multi-week outage in Feb–Mar 2026 (all requests 429), so the online source must be *optional*.
- Privacy: the request reveals the exact FEN to lichess. Acceptable (public opening positions), but document it in the settings UI and let the user disable it.

Sampling by frequency with a rating-dependent flattening exponent:
```
n_i = white_i + draws_i + black_i;  N = Σ n_i
keep moves with n_i ≥ max(5, 0.02·N)              // drop noise moves
p_i ∝ n_i^γ(E),  γ(E) = 0.75 + 0.25·clamp((E−1200)/1200, 0, 1)   // weaker: flatter (more variety)
stop using explorer when N < 200 (position rare) or ply > 24 or the sampled move loses ≥ 0.15 win vs engine best (E ≥ 1800 only; weaker targets may follow the crowd into a known inaccuracy)
```
Cache each `(fen, ratings, speeds)` response in `chrome.storage.local`/IndexedDB with 30-day TTL — the first 10 plies of typical openings are ~2–3k positions and become an offline book after a few games.

### 2.2 Polyglot book (offline fallback)

Format (verified): `.bin` = sorted array of 16-byte big-endian entries `{key:u64, move:u16, weight:u16, learn:u32}`. Reading in JS:

```ts
export class PolyglotBook {
  private view: DataView;
  private n: number;
  constructor(buf: ArrayBuffer) { this.view = new DataView(buf); this.n = buf.byteLength >> 4; }
  private keyAt(i: number): bigint { return this.view.getBigUint64(i << 4, false); }
  lookup(fen: string): BookMove[] {
    const key = polyglotKey(fen);                 // BigInt
    let lo = 0, hi = this.n;                      // lower_bound
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.keyAt(mid) < key) lo = mid + 1; else hi = mid; }
    const out: BookMove[] = [];
    for (let i = lo; i < this.n && this.keyAt(i) === key; i++) {
      const off = i << 4;
      out.push({ uci: decodeMove(this.view.getUint16(off + 8, false), fen), weight: this.view.getUint16(off + 10, false) });
    }
    return out;
  }
}
function decodeMove(m: number, fen: string): string {
  const toF = m & 7, toR = (m >> 3) & 7, fromF = (m >> 6) & 7, fromR = (m >> 9) & 7, promo = (m >> 12) & 7;
  let uci = sq(fromF, fromR) + sq(toF, toR);
  // castling is stored as king-takes-rook: e1h1/e1a1/e8h8/e8a8 → convert to e1g1/e1c1/...
  if (uci === 'e1h1' && kingOn(fen, 'e1')) uci = 'e1g1'; else if (uci === 'e1a1' && kingOn(fen, 'e1')) uci = 'e1c1';
  else if (uci === 'e8h8' && kingOn(fen, 'e8')) uci = 'e8g8'; else if (uci === 'e8a8' && kingOn(fen, 'e8')) uci = 'e8c8';
  if (promo) uci += 'nbrq'[promo - 1];
  return uci;
}
```
`polyglotKey(fen)`: XOR of `Random64[64*kind + 8*rank + file]` for each piece (kind order: bp, wp, bn, wn, bb, wb, br, wr, bq, wq, bk, wk = 0..11), `Random64[768 + i]` for each castling right (K=0, Q=1, k=2, q=3), `Random64[772 + file]` for the en-passant file *only if* a pawn of the side to move can capture (differs from FEN), `Random64[780]` if white to move. Embed the 781-entry table (from the spec) as a `BigUint64Array` literal (~12 KB source).

Books: `gm2600.bin` (347 KB, ~21.7k entries; GM games ≥2600) is a good default for E ≥ 1800; `komodo.bin` / `rodent.bin` are engine-tuned (too "correct"). For lower Elo, generate our own book from lichess games in the target bucket (python-chess `polyglot` writer over 1200–1600 blitz games, depth 12 plies, min 30 games) — ~1–3 MB per bucket; ship two (`club.bin` ≤1600, `expert.bin` >1600). Weight = frequency; sample `p ∝ weight^γ(E)` same as above; add 5% chance to leave book early for E<1400 (weak players deviate).

### 2.3 Combined policy

```
inBook = ply ≤ 30
1. if explorer enabled and online: try cached → fetch (timeout 1200 ms, one in flight); if N ≥ 200 → sample
2. else polyglot bucket book (moves with weight ≥ 1% of total) → sample
3. else engine selection (§1)
Always run the engine search in parallel anyway (panel eval + verifying the book move isn't a known trap for E ≥ 2000: if book move loss ≥ 0.15, fall through).
```

---

## 3. Human-like patterns beyond eval

### 3.1 Premoves
Only in bullet/blitz, only when `E ≥ 1200` (weak players rarely premove), with probability `0.35 + 0.5·clamp((E−1200)/1200,0,1)` when conditions hold:
1. After we choose move `m`, take the engine's `ponder` move `r` from `bestmove m ponder r` (or the opponent's top MultiPV line from a short `go movetime 150` on the position after `m` with `MultiPV 3`).
2. Require the opponent reply be *predictable*: `p(r) ≥ 0.6` where `p` = softmax over the opponent's MultiPV with τ=0.06 (or Maia prior for the opponent's rating if known from the page).
3. Analyse the position after `m r` (`go movetime 120 multipv 2`); premove our reply `q` only if it is *forced-looking*: recapture on the square just captured on, only legal move, or `loss_2nd ≥ 0.25` (clear-only move) and `q` is not a king move into the unknown.
4. Send `{kind:'premove', from, to}` to the content script; it plays it immediately if the opponent actually plays `r`, otherwise discards. Also handle the case where the opponent plays something else while our normal search is already running (§4.4).

### 3.2 Recapture preference
In `heuristicPrior`, a capture on the square the opponent just captured on gets prior ×2.5 (humans recapture reflexively; also shortens delay: `delay ×0.4`). Engines often prefer a zwischenzug; we let the eval decide only if the gap is > `G(E)/2`.

### 3.3 Simplify when ahead / complicate when behind
When our `cpEff(best) ≥ +300`: multiply prior of *trades* (capture of an equal-or-higher piece that the PV shows being recaptured) by 1.8 and of quiet moves in sharp lines (PV contains ≥2 captures by opponent) by 0.7. Symmetrically when `≤ −300`: increase prior for checks and captures by 1.4 (desperation), lower for trades 0.6. Strength-dependent: apply fully for `E ≥ 1400`; below that, only the "trade when ahead" part.

### 3.4 Heuristic prior table (engine-only move suppression)

| Pattern (detected via chess.js on the move / short PV) | Prior multiplier |
|---|---|
| Recapture on last captured square | ×2.5 |
| Check | ×1.4 (E<1400), ×1.15 (E≥1400) |
| Capture of undefended piece | ×1.8 |
| Castling (ply ≤ 30) | ×1.6 |
| Developing minor piece from back rank (ply ≤ 20) | ×1.4 |
| Pawn push in front of own castled king (g/h/f pawn), middlegame | ×0.6 |
| Quiet king move in middlegame (not castling, not in check, queens on) | ×0.35 |
| Rook lift / rook to closed file with no PV justification | ×0.7 |
| Retreating move of a developed piece to the back rank (ply ≤ 25) | ×0.6 |
| "Mysterious" waiting move (a3/h3/a6/h6 with no threat) at E<1600 | ×0.7; at E ≥ 2000 ×1.0 |
| Underpromotion | ×0.05 unless mate/only move |
| Piece sacrifice (PV shows we lose material for ≥3 plies before regaining) | ×0.5 (E<1800), ×0.9 (E≥2200) |
| Move already played in this game by same piece back-and-forth (repetition bait) | ×0.5 unless drawing when behind |
| Endgame: king activation when queens off and ply ≥ 60 | ×1.5 (E ≥ 1600) |

Priors are multiplicative on a base of 1.0, exponent `β(E)`; they never override the eval gap cutoff.

### 3.5 Endgame technique by Elo
- E<1200: increase `τ` by 1.5× in endgames (weak players play endgames worse), reduce the mate-finding probability (§1.5 rule 2), allow 50-move / stalemate blunders with prob 0.05 when `best` is mate>0 but a 2nd line has `loss ≥ 0.4` — i.e. they can stalemate.
- 1200–1800: normal τ; use tablebase-like precision only when the engine shows `mate` (no Syzygy in browser).
- ≥1800: `τ ×0.7` in endgames (strong players are relatively more accurate in simple endings).
- All: "technique speed": in won endgames (cp ≥ +500, no queens) reduce delay ×0.5, and prefer pawn pushes / king moves that keep `loss ≤ 0.05` even if not top-1 (humans convert by simplest path).

### 3.6 Resign / draw
Never auto-resign. Show a "resign suggested" pill in the panel when `cpEff ≤ −900` for 8 consecutive plies and no mate threats for us; the user acts. Draw offers similar (§1.5 rule 3). Both behind a settings toggle default OFF.

### 3.7 Anti-signature checklist (variance across a game)
- Per-game seed and AR(1) `form` (§1.5); per-move lognormal delay (§1.5) with a time-pressure model reading real clocks (content script supplies both clocks each move).
- Do not always play instantly after book; add "thinking" delays before obvious moves 15% of the time.
- Do not exceed target agreement bands (§1.6). Log `(loss, reason, delay)` per move to a ring buffer; the panel shows a running ACPL and top-1% so the user can see the profile.
- Vary MultiPV depth by clock (§4), never fixed depth: engine "depth N always" signatures are detectable by identical eval-error profiles.
- Never play the "bongcloud" easter egg without user action.

---

## 4. Multi-PV depth/time policy (WASM engine)

### 4.1 Search budget
Use `go movetime` (not `depth`) so the engine returns exactly when we need it; the *quality* (depth) then scales with hardware. Budget per our move:

```
tThink  = sampled human delay (§1.5)
tEngine = clamp(0.6 · tThink, 150 ms, 4000 ms)          // must finish before we act
depthCap = bullet 14 / blitz 18 / rapid 22 / classical 24   // 'go movetime X depth D' — stop at whichever first
```
For the panel-only mode (user not auto-playing), use `go infinite` and stream updates.

Because MultiPV=K costs roughly K× nodes per depth, use K adaptively: `K = 3` when `tEngine < 300 ms`, `K = 6` when `< 1500 ms`, `K = 8` otherwise; the selector needs at most 8.

Minimum quality guard: if the result's depth < 8 (very slow device), retry with `+300 ms` once; below depth 6 fall back to top-2 only with `τ` halved (a shallow engine is already "human-ish").

### 4.2 Pondering on the opponent's clock
After we move: `position … moves <our move>` then `go infinite` with `MultiPV 3` on the *opponent's* position. This (a) fills the hash for the likely replies, (b) yields the premove prediction (§3.1). When the opponent moves: `stop` → await `bestmove` → `position … moves … <opp move>` → `go movetime`. Do not use `Ponder`/`ponderhit` UCI mode: it complicates the state machine and gains nothing for a WASM engine that we fully control.

### 4.3 Threads / Hash for WASM
```
threads = SAB ? clamp(navigator.hardwareConcurrency - 1, 1, 4) : 1
hash    = SAB ? 64 : 32            // MB; lichess defaults 16 MB mobile
```
Reasoning: wasm32 heap ≤ 4 GB theoretical, ~2 GB in practice, but the offscreen document shares the browser's per-renderer memory pressure; the big NNUE net (79–133 MB) is unpacked in memory too. 64 MB Hash is plenty for ≤4 s searches (hashfull rarely exceeds 20%). Cap threads at 4: WASM thread scaling is sub-linear and the machine is also rendering chess.com. If SAB is unavailable (COOP/COEP missing), load the `-single` build and set `threads=1`.

Big vs small net: ship the *small* net build (`sf_18_smallnet` / `stockfish-18-lite`, ~7 MB) by default — for human-like play at ≤2400 the strength loss (~100–150 Elo at equal time, still >3000) is irrelevant, load time matters more. Offer the 79 MB big net as an optional download cached in the Cache API for panel analysis quality.

### 4.4 Cancellation, request ids and the "opponent moved while searching" case
Every `analyse()` gets a monotonic `id`. Engine results are tagged by id (the UCI stream is serial, so id = the currently active request). On new FEN from the content script:
1. If the active request is a ponder (`go infinite`) → `stop`, await `bestmove` (discard), proceed.
2. If the active request is our own move search for the *previous* position (race: the opponent premoved, or we were slow) → `stop`, mark result as `superseded`, await `bestmove`, drop it.
3. Never send `position`/`go` before the previous `bestmove` arrived (Stockfish handles it but the info stream interleaves and the id tagging breaks).
4. Content script also attaches a `moveNumber + fen` so the executor refuses to play a move whose FEN no longer matches the board (`round` counter replaced by FEN equality).

### 4.5 Own transposition cache
LRU keyed by `fen | multiPv | limitKey` (§7). A hit with `depth ≥ requested depthCap − 2` skips the search (common after undo/premove races or when the opponent plays the predicted move: the ponder result for that FEN is already there). Ponder results are stored under the *opponent's* FEN and reused when the panel wants to display the eval while the opponent thinks.

---

# PART B — ENGINE FRAMEWORK (TypeScript)

## 5. Typed UCI client

### 5.1 Types

```ts
export type Limit =
  | { depth: number; movetime?: number }     // whichever first
  | { movetime: number }
  | { nodes: number }
  | { infinite: true };

export interface AnalysisRequest {
  id: string;                 // ULID; monotonic
  fen: string;
  moves?: string[];           // UCI moves applied after fen (needed for repetition detection)
  multiPv: number;
  limit: Limit;
  searchmoves?: string[];
  priority?: 'move' | 'ponder' | 'panel';
}

export type Score = { kind: 'cp'; value: number; bound?: 'lower' | 'upper' } | { kind: 'mate'; value: number };

export interface InfoLine {
  depth?: number; seldepth?: number; multipv?: number;
  score?: Score; wdl?: [number, number, number];
  nodes?: number; nps?: number; hashfull?: number; tbhits?: number; time?: number;
  pv?: string[]; currmove?: string; currmovenumber?: number; string?: string;
}

export type AnalysisUpdate =
  | { type: 'info'; id: string; line: InfoLine }
  | { type: 'lines'; id: string; lines: Line[]; depth: number; nodes: number; nps: number; time: number }; // coalesced

export interface Line { multipv: number; depth: number; seldepth?: number; score: Score; wdl?: [number, number, number]; pv: string[]; nodes?: number; time?: number; }

export interface AnalysisResult {
  id: string; fen: string; multiPv: number; limit: Limit;
  bestmove: string | null;    // null on '(none)'
  ponder?: string;
  lines: Line[];              // final snapshot, sorted by multipv
  depth: number; nodes: number; time: number;
  status: 'complete' | 'stopped' | 'superseded' | 'error';
}

export interface AnalysisHandle {
  id: string;
  updates: AsyncIterable<AnalysisUpdate>;
  result: Promise<AnalysisResult>;
  stop(): Promise<void>;      // resolves after 'bestmove' received
}

export interface EngineInfo { name: string; author: string; options: Record<string, UciOptionSpec>; threads: number; sab: boolean; nnue: string | null; }
export interface UciOptionSpec { type: 'check' | 'spin' | 'combo' | 'button' | 'string'; default?: string; min?: number; max?: number; vars?: string[]; }

export interface EngineTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): () => void;      // returns unsubscribe
  onExit(cb: (reason: string) => void): () => void;    // worker died / port disconnected
  restart(): Promise<void>;
  dispose(): void;
}
```

### 5.2 State machine

```
            init()                uciok+readyok            newGame()/setOption()
 [created] ───────▶ [initialising] ──────────▶ [idle] ◀──────────────────────┐
                        │ timeout/exit          │  analyse()                │
                        ▼                       ▼                           │
                    [crashed] ◀───────────  [searching] ──stop()──▶ [stopping]│
                        │  restart()            │ bestmove             │ bestmove
                        └──────▶ [initialising] └───────────▶ [idle] ◀┘
```
- `idle → searching`: send `position`, `go`. Only one search at a time; further `analyse()` calls are queued (FIFO by priority: `move` > `ponder` > `panel`), and a queued request *supersedes* a running `ponder`/`panel` request (auto-`stop`).
- `searching → stopping`: `stop` sent; ignore further `info` for the id after we mark it stopped, but keep collecting until `bestmove` arrives (the final `bestmove` line closes the request).
- `stopping → idle`: on `bestmove`. Timeout 2000 ms → treat as `crashed`.
- `crashed`: transport `restart()`, replay `uci`, all `setOption` calls recorded in `optionsApplied` (in order), `ucinewgame`, `isready`; then re-issue the queued requests (the in-flight one is failed with `status:'error'`).
- `isready` handshake is used after every option burst and after `ucinewgame` (Stockfish requires `isready` after `ucinewgame` before `position` on some builds, and it flushes the hash clear).

### 5.3 Line parser

```ts
const NUMERIC = new Set(['depth','seldepth','multipv','nodes','nps','hashfull','tbhits','time','currmovenumber']);
export function parseInfo(tokens: string[]): InfoLine {
  const out: InfoLine = {}; let i = 1;                       // tokens[0] === 'info'
  while (i < tokens.length) {
    const t = tokens[i++];
    if (NUMERIC.has(t)) { (out as any)[t] = Number(tokens[i++]); continue; }
    switch (t) {
      case 'score': {
        const kind = tokens[i++] as 'cp' | 'mate'; const value = Number(tokens[i++]);
        const s: Score = kind === 'mate' ? { kind, value } : { kind, value };
        if (tokens[i] === 'lowerbound') { (s as any).bound = 'lower'; i++; }
        else if (tokens[i] === 'upperbound') { (s as any).bound = 'upper'; i++; }
        out.score = s; break;
      }
      case 'wdl': out.wdl = [Number(tokens[i++]), Number(tokens[i++]), Number(tokens[i++])]; break;
      case 'currmove': out.currmove = tokens[i++]; break;
      case 'pv': out.pv = tokens.slice(i); i = tokens.length; break;        // pv is always last
      case 'string': out.string = tokens.slice(i).join(' '); i = tokens.length; break;
      case 'refutation': case 'currline': i = tokens.length; break;         // unused; swallow
      default: /* unknown token: skip */ break;
    }
  }
  return out;
}
export function parseBestmove(tokens: string[]): { bestmove: string | null; ponder?: string } {
  const bm = tokens[1] === '(none)' ? null : tokens[1];
  const pi = tokens.indexOf('ponder');
  return { bestmove: bm, ponder: pi > 0 ? tokens[pi + 1] : undefined };
}
```
Notes: `info string` lines (NNUE load messages, "Available processors") must not be treated as search info; `score` with `lowerbound/upperbound` are fail-high/low reports — keep them for the streaming view but never let a bound-only score overwrite a proper score for the same `multipv` at the same depth in the snapshot. Some builds emit `info depth 0 score mate 0` for checkmate/stalemate positions with `bestmove (none)`.

### 5.4 `UciEngine`

```ts
export class UciEngine {
  private state: 'created'|'initialising'|'idle'|'searching'|'stopping'|'crashed' = 'created';
  private queue: Pending[] = []; private active?: Pending;
  private optionsApplied: Array<[string, string | number | boolean]> = [];
  private waiters = new Map<'uciok'|'readyok'|'bestmove', Array<(l: string[]) => void>>();
  constructor(private transport: EngineTransport, private opts: { initTimeoutMs?: number; stopTimeoutMs?: number } = {}) {
    transport.onLine(l => this.onLine(l)); transport.onExit(r => this.onExit(r));
  }
  async init(): Promise<EngineInfo> {
    this.state = 'initialising';
    this.transport.send('uci');
    const lines = await this.waitFor('uciok', this.opts.initTimeoutMs ?? 15000);   // collect 'id'/'option' lines
    const info = parseEngineInfo(lines);
    await this.isReady();
    this.state = 'idle'; return info;
  }
  setOption(name: string, value: string | number | boolean): void {
    this.optionsApplied = this.optionsApplied.filter(([n]) => n !== name).concat([[name, value]]);
    this.transport.send(`setoption name ${name} value ${value}`);
  }
  async loadNnue(big?: ArrayBuffer, small?: ArrayBuffer): Promise<void> { /* build-specific, see 5.5 */ }
  async newGame(): Promise<void> { await this.ensureIdle(); this.transport.send('ucinewgame'); await this.isReady(); }
  async isReady(): Promise<void> { this.transport.send('isready'); await this.waitFor('readyok', 5000); }
  analyse(req: AnalysisRequest): AnalysisHandle {
    const p = new Pending(req);                       // holds an async queue for updates + result deferred
    this.enqueue(p); this.pump(); return p.handle();
  }
  private async pump() {
    if (this.state !== 'idle' || this.active || !this.queue.length) return;
    const p = this.active = this.queue.shift()!;
    this.state = 'searching';
    const { fen, moves, multiPv, limit, searchmoves } = p.req;
    this.transport.send(`setoption name MultiPV value ${multiPv}`);            // cheap; SF only resets if changed
    this.transport.send(`position fen ${fen}${moves?.length ? ' moves ' + moves.join(' ') : ''}`);
    this.transport.send('go ' + goArgs(limit, searchmoves));
    p.deadline = 'infinite' in limit ? undefined : setTimeout(() => this.stopActive('timeout'), goBudgetMs(limit) + 1500);
  }
  private async stopActive(reason: 'stop'|'superseded'|'timeout') {
    if (!this.active || this.state !== 'searching') return;
    this.state = 'stopping'; this.active.status = reason === 'stop' ? 'stopped' : reason === 'superseded' ? 'superseded' : 'error';
    this.transport.send('stop');
    try { await this.waitFor('bestmove', this.opts.stopTimeoutMs ?? 2000); }
    catch { this.onExit('stop-timeout'); }
  }
  private onLine(line: string) {
    const t = line.split(/\s+/);
    switch (t[0]) {
      case 'info': if (this.active && !t.includes('string')) this.active.push(parseInfo(t)); break;
      case 'bestmove': { const p = this.active!; p.finish(parseBestmove(t)); this.active = undefined;
        this.state = 'idle'; this.resolve('bestmove', t); this.pump(); break; }
      case 'uciok': case 'readyok': this.resolve(t[0] as any, t); break;
      default: this.collectInit(t);
    }
  }
  private async onExit(reason: string) {
    this.state = 'crashed'; this.active?.fail(reason); this.active = undefined;
    await this.transport.restart();
    this.transport.send('uci'); await this.waitFor('uciok', 15000);
    for (const [n, v] of this.optionsApplied) this.transport.send(`setoption name ${n} value ${v}`);
    await this.loadNnueAgain(); this.transport.send('ucinewgame'); await this.isReady();
    this.state = 'idle'; this.pump();
  }
}
```
`Pending.push(info)` updates a per-`multipv` map and yields an `AnalysisUpdate`; `Pending.finish()` resolves `result` with the final snapshot (lines sorted by multipv, `status:'complete'` unless already marked). `goArgs` emits `depth D movetime T` / `nodes N` / `infinite` plus `searchmoves …`.

### 5.5 NNUE load step
- `stockfish` npm builds embed the net in the `.wasm`/`.js` — nothing to load; `EvalFile` is not settable (`info string` confirms). Optionally set `EvalFile`/`EvalFileSmall` to `<internal>` — no-op.
- lichess `stockfish-web` builds expose `setNnueBuffer(Uint8Array, index)` on the module before `uci`; fetch the net from the extension package (`chrome.runtime.getURL('nn/nn-37f18f62d772.nnue')`) or from Cache API for the big net, then call `setNnueBuffer(buf, 0)` (big) and `setNnueBuffer(buf, 1)` (small). Verify via the `info string NNUE evaluation using …` line captured during `init()`; expose in `EngineInfo.nnue`. If the net fails to load, Stockfish refuses to search (or runs classical in old builds) — fail `init()` loudly.

## 6. Transport across MV3 contexts

### 6.1 Topology
```
content script (chess.com/lichess)  ──runtime.sendMessage──▶  service worker (orchestrator, RemoteEngine)
                                                                    │ chrome.runtime.connect({name:'engine'})
                                                                    ▼
                                                        offscreen document (COOP/COEP → SAB)
                                                             ├─ Worker: stockfish (WorkerTransport)
                                                             ├─ Worker: onnxruntime-web (Maia)  [optional]
                                                             └─ book: polyglot ArrayBuffer, explorer fetch cache
side panel  ──runtime.connect({name:'panel'})──▶ service worker  (receives EvaluationSnapshot @ ≤10 Hz)
```
Offscreen document created with `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Run chess engine' })`; keep it alive by holding the port open (the SW may still be evicted after 30 s idle in MV3 — the port keeps the SW alive while messages flow; if the SW restarts, it re-connects and the offscreen engine state survives, so `RemoteEngine` must re-sync `status` on connect).

Manifest keys required: `"offscreen"` permission, `"sidePanel"`, `"cross_origin_embedder_policy": {"value": "require-corp"}`, `"cross_origin_opener_policy": {"value": "same-origin"}`, `web_accessible_resources` not needed for the worker (same-origin extension URL).

### 6.2 Message schema (port, both directions)

```ts
type PortMsg =
  | { kind: 'uci'; line: string }                                    // SW→offscreen: command; offscreen→SW: engine output
  | { kind: 'uci-batch'; lines: string[] }                           // offscreen→SW: coalesced output (see 6.4)
  | { kind: 'status'; state: EngineState; sab: boolean; threads: number; nnue: string | null; activeId?: string }
  | { kind: 'restart' } | { kind: 'exit'; reason: string }
  | { kind: 'prior'; fen: string; elo: number; oppElo?: number }      // SW→offscreen: Maia request
  | { kind: 'prior-result'; fen: string; probs: Record<string, number> }
  | { kind: 'book'; fen: string; elo: number; speed: string } | { kind: 'book-result'; fen: string; moves: BookMove[] | null };
```

### 6.3 Transports

```ts
export class WorkerTransport implements EngineTransport {   // inside the offscreen document
  private worker!: Worker; private lineCbs = new Set<(l: string) => void>(); private exitCbs = new Set<(r: string) => void>();
  constructor(private url: string) { this.spawn(); }
  private spawn() {
    this.worker = new Worker(this.url, { type: 'classic' });     // stockfish.js builds are classic workers
    this.worker.onmessage = e => { const l = typeof e.data === 'string' ? e.data : e.data?.line; if (l) this.lineCbs.forEach(cb => cb(l)); };
    this.worker.onerror = e => this.exitCbs.forEach(cb => cb(String(e.message)));
  }
  send(line: string) { this.worker.postMessage(line); }
  onLine(cb) { this.lineCbs.add(cb); return () => this.lineCbs.delete(cb); }
  onExit(cb) { this.exitCbs.add(cb); return () => this.exitCbs.delete(cb); }
  async restart() { this.worker.terminate(); this.spawn(); }
  dispose() { this.worker.terminate(); }
}

export class PortTransport implements EngineTransport {     // inside the service worker
  private port?: chrome.runtime.Port; private lineCbs = new Set<...>(); private exitCbs = new Set<...>();
  async connect() {
    await ensureOffscreen();
    this.port = chrome.runtime.connect({ name: 'engine' });
    this.port.onMessage.addListener((m: PortMsg) => {
      if (m.kind === 'uci') this.lineCbs.forEach(cb => cb(m.line));
      else if (m.kind === 'uci-batch') for (const l of m.lines) this.lineCbs.forEach(cb => cb(l));
      else if (m.kind === 'exit') this.exitCbs.forEach(cb => cb(m.reason));
    });
    this.port.onDisconnect.addListener(() => this.exitCbs.forEach(cb => cb('port-disconnected')));
  }
  send(line: string) { this.port!.postMessage({ kind: 'uci', line } satisfies PortMsg); }
  async restart() { this.port?.postMessage({ kind: 'restart' }); /* offscreen recreates worker; wait for status */ }
  ...
}
```
`RemoteEngine` = `new UciEngine(new PortTransport())` — identical API in the SW. A crash detection subtlety: a *worker* crash in the offscreen doc surfaces as `{kind:'exit'}`; an *offscreen document* crash surfaces as port disconnect; a *service worker* eviction is invisible to the engine — on SW start, reconnect, send `status`, and if `state==='searching'` with an unknown `activeId`, send `stop` and drain to `bestmove`.

### 6.4 Backpressure / coalescing
Stockfish at depth 20+ emits up to several hundred `info` lines/s with MultiPV 8 (one per multipv per iteration plus `currmove` lines). Rules:
- In the **offscreen** bridge, do not forward `info … currmove …` lines at all (unless the panel asks for them), and batch the rest every 50 ms into `uci-batch` (avoids one structured-clone per line over the port).
- `UciEngine` keeps only the *latest* `InfoLine` per `multipv` (map `multipv → InfoLine`) and emits a coalesced `{type:'lines'}` update at most every **100 ms** (10 Hz) plus immediately on `bestmove`. `updates` is an async iterable backed by a single-slot mailbox (newest wins) — a slow consumer (panel) never queues stale frames.
- The panel port gets `EvaluationSnapshot` at ≤10 Hz; SAN conversion (chess.js) is done once per snapshot in the SW, not per info line.
- Move-selection logic consumes only `result` (final snapshot), never the stream.

## 7. Data structures

### 7.1 Analysis cache

```ts
export type CacheKey = `${string}|${number}|${string}`;          // fen | multiPv | limitKey
export const limitKey = (l: Limit) => 'infinite' in l ? 'inf' : 'depth' in l ? `d${l.depth}` : 'movetime' in l ? `t${l.movetime}` : `n${l.nodes}`;

export class AnalysisCache {
  private map = new Map<CacheKey, AnalysisResult>();               // Map preserves insertion order → LRU
  constructor(private max = 512) {}
  get(fen: string, multiPv: number, minDepth: number): AnalysisResult | undefined {
    // any entry for this fen with multiPv >= requested and depth >= minDepth qualifies
    for (const [k, v] of this.map) if (k.startsWith(fen + '|') && v.multiPv >= multiPv && v.depth >= minDepth && v.status === 'complete') { this.touch(k, v); return v; }
  }
  put(r: AnalysisResult) { const k: CacheKey = `${r.fen}|${r.multiPv}|${limitKey(r.limit)}`; this.map.delete(k); this.map.set(k, r); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!); }
  private touch(k: CacheKey, v: AnalysisResult) { this.map.delete(k); this.map.set(k, v); }
  clearOnNewGame() { this.map.clear(); }   // keep only if you want cross-game reuse of openings (safe: FEN-keyed)
}
```
Normalize the FEN key by dropping the halfmove/fullmove fields (`fen.split(' ').slice(0,4).join(' ')`) — evaluations don't depend on them except for 50-move edge cases; keep the full FEN in the stored result.

### 7.2 Evaluation snapshot (panel model)

```ts
export interface EvaluationSnapshot {
  fen: string; sideToMove: 'w' | 'b';
  requestId: string; status: 'searching' | 'done' | 'stale';
  evalBar: number;             // white-perspective in [-1, 1]: 2*winProb(cpWhite) - 1; mates → ±1
  scoreText: string;           // "+0.34" | "M5" | "-M2" (white perspective)
  wdl?: { w: number; d: number; l: number };  // permille, white perspective
  lines: Array<{ multipv: number; score: Score; scoreText: string; depth: number; sanPv: string[]; uciPv: string[]; loss: number }>;
  depth: number; seldepth?: number; nodes: number; nps: number; timeMs: number; hashfull?: number;
  chosen?: { uci: string; san: string; reason: Selection['reason']; delayMs: number; playAt: number };
  book?: { source: 'explorer' | 'polyglot'; moves: Array<{ san: string; uci: string; weight: number; games?: number }> };
  engine: { threads: number; sab: boolean; nnue: string | null; state: EngineState };
  profile: { targetElo: number; runningAcpl: number; top1Rate: number; form: number };
}
```
SAN conversion: `new Chess(fen)` then `chess.move({from,to,promotion})` for each PV move; stop at the first illegal move (defensive against PV truncation), cache SAN per `(fen, uciPv.join(' '))`.

## 8. Stockfish options

At init (once per engine start; replayed after crash):

| Option | Value | Why |
|---|---|---|
| `Threads` | `sab ? clamp(hardwareConcurrency − 1, 1, 4) : 1` | WASM scaling; leave a core for the page |
| `Hash` | 64 (SAB build) / 32 (single) ; 16 on mobile-class devices (`deviceMemory ≤ 4`) | lichess uses 16 MiB mobile; wasm heap limits |
| `MultiPV` | set per request (3–8); default 6 | selection needs ≥6 candidates |
| `UCI_ShowWDL` | `true` | WDL for panel and for win-prob sanity (SF's WDL model is calibrated per version) |
| `UCI_LimitStrength` | `false` | we do our own selection |
| `UCI_Elo` | untouched (1320) | unused |
| `Skill Level` | `20` | full strength |
| `Ponder` | `false` | we use explicit `go infinite` + `stop` instead |
| `Move Overhead` | `10` (default) | irrelevant: we never use `go wtime/btime`; if you do, set ≥150 for WASM+port latency |
| `UCI_Chess960` | `true` only when the page reports a 960 game | castling encoding in PV |
| `EvalFile` / `EvalFileSmall` | leave default; for stockfish-web load via `setNnueBuffer` before `uci` | see §5.5 |
| `SyzygyPath` | not set | no filesystem in browser |
| `Clear Hash` (button) | on `newGame()` after `ucinewgame` if the previous game was a different opponent | `ucinewgame` already clears; keep explicit for stockfish-web variants |

Per move: `setoption name MultiPV value K` (only if K changed), `position fen … moves …`, `go movetime T depth D` (our move) or `go infinite` (ponder/panel). Never `ucinewgame` per move (it clears the hash and costs ~50 ms with a large hash); call it once per game and on FEN discontinuities (user navigated to another game).

---

## 9. Migration notes for this codebase

- `scripts/background.js`: everything after the `SlicedEngine().then` block (per-message `ucinewgame` + `Skill Level` + `go depth`, the `round` counter) is replaced by `RemoteEngine` + `MoveSelector` in the service worker; the `chrome.debugger` mouse-dispatch code stays as the move executor but should key on FEN equality instead of `round`.
- `SlicedEngine/engine.wasm` (340 KB, classical eval, single-thread) → replace with `stockfish-18-lite` (small net, SAB) plus `-lite-single` fallback; add COOP/COEP manifest keys; engine moves from background page to offscreen document.
- Remove the "bongcloud" forced f3/Kf2 path from the selection layer; keep it only as a user-triggered panel button if wanted.
- Elo slider (1–20 today) → target Elo 600–3000 (default 1500); depth slider → "engine quality" preset (bullet/blitz/rapid caps, §4.1), with an "engine mode" toggle that bypasses the human layer.

## Sources

- Stockfish `src/search.h` / `src/search.cpp` (master, Sept 2026): `struct Skill`, `Skill::pick_best`. https://github.com/official-stockfish/Stockfish
- Stockfish UCI docs: https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html
- Stockfish FAQ (Skill Level mechanism): https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html
- stockfish.js (SF 18 builds, SAB requirements): https://github.com/nmrugg/stockfish.js/ ; lichess stockfish-web: https://github.com/lichess-org/stockfish-web ; lichess stockfish.wasm memory issue: https://github.com/lichess-org/stockfish.wasm/issues/27
- Chrome cross-origin isolation for extensions: https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation ; Offscreen documents: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3
- Maia-1 (KDD 2020): https://arxiv.org/abs/2006.01855 ; blog with accuracy numbers: http://csslab.cs.toronto.edu/blog/2020/08/24/maia_chess_kdd/
- Maia-2 (NeurIPS 2024): https://arxiv.org/html/2409.20553v2 ; code: https://github.com/CSSLab/maia2
- Maia-3 / Chessformer (ICLR 2026): https://github.com/CSSLab/maia3 ; https://huggingface.co/UofTCSSLab/Maia3-23M
- Maia in browser: https://github.com/csslab/maia-platform-frontend ; https://github.com/hunterchen7/play-lc0 ; Maia-1 ONNX files (3.48 MB): https://huggingface.co/spaces/lczerolens/backends-demo/tree/main/demo/onnx-models
- onnxruntime-web deploy docs and 1.22.0 dist sizes: https://onnxruntime.ai/docs/tutorials/web/deploy.html ; https://data.jsdelivr.com/v1/packages/npm/onnxruntime-web@1.22.0
- Polyglot format: https://hgm.nubati.net/book_format.html ; python-chess polyglot: https://python-chess.readthedocs.io/en/latest/polyglot.html ; books: https://github.com/michaeldv/donna_opening_books , https://github.com/ChrisWhittington/polyglot-books
- Lichess opening explorer API: https://github.com/lichess-org/api (doc/specs/tags/openingexplorer/lichess.yaml) ; server: https://github.com/lichess-org/lila-openingexplorer ; outage: https://github.com/lichess-org/lila/issues/19610
- Lichess accuracy / win% formulas: https://lichess.org/page/accuracy ; blunder thresholds: https://lichess.org/forum/lichess-feedback/definition-of-blundermistakeinaccuracy
- ACPL by rating (approximate): https://mychessplan.com/average-centipawn-loss-explained-acpl-by-rating/ ; https://lichess.org/forum/general-chess-discussion/whats-a-decent-average-centipawn-loss ; weak-correlation caveat: https://sites.google.com/view/patrick-coulombe-phd/chess-analytics/predicting-rating-from-centipawn-loss
- Chess.com accuracy by rating (player-reported): https://www.chess.com/forum/view/general/accuracy-by-chess-rating ; https://support.chess.com/en/articles/8708970-how-is-accuracy-in-analysis-determined


# Appendix F — Side-panel UI design spec (Lattice)


Version 1.0 · 2026-09-03 · Scope: Chrome side panel for the sliced chess assistant (chess.com, lichess).
This is a design specification. It contains tokens, wireframes, component anatomy, interaction rules and copy. It contains no implementation code beyond token declarations.

---

## 0. Ground truth this spec is built on

- Existing brand mark: `assets/images/sliced_128.png` / `sliced_256.png`. It is a **circular** mark: charcoal disc (~#1B2024), white ring, orange "S" slash (~#F5A623). It is kept exactly as-is; no new logo. (The product brief described it as a rounded square — the shipped asset is a disc. Everything below is designed around the disc.)
- Existing brand orange: #ffa71f / #ffbc20 / #cb7e0c. Refined below into a single ramp anchored on the logo's orange.
- Existing sounds in `assets/sounds/` are retained behind one "UI sounds" toggle (default off in the new version — see §7).
- Existing surface: #1e2124 (cool charcoal). The new palette stays cool-neutral to match the logo disc; it is not warmed toward chess.com's brown.
- The host page is dark (chess.com #312e2b, lichess #161512). The panel must read as its own object next to them, not blend into them.

---

## 1. Design principles and visual direction

### 1.1 Principles

1. **One hero, everything else recedes.** The recommended move is the product. It is the only element allowed to be large, warm and elevated. Eval, lines, clocks and controls are set in quiet greys so the eye returns to the move card without effort.
2. **Glanceable at arm's length.** The player is looking at the board, not the panel. Every live value (eval, move, clock, countdown) must be legible in a 300 ms glance from 60 cm: big numerals, high contrast, no reading required.
3. **Dangerous things look dangerous, once.** Auto-play is the only action that acts on the user's account without them. It has its own visual grammar (danger ramp, hold-to-arm, live ring). Nothing else borrows that grammar, so it stays meaningful.
4. **Derived, never invented.** Every pixel, colour, size and duration derives from the Lattice token system (§2). An engineer who needs a value they cannot find in the tokens has found a spec bug, not a reason to type a number.
5. **Motion explains state change; it never decorates.** The move card springs because a new move arrived. The ring drains because time is passing. Nothing animates on hover for its own sake, and everything collapses to a crossfade under reduced-motion.

### 1.2 Visual direction

The panel is an instrument, not a dashboard: a single matte charcoal surface with hairline rules, one raised plate (the move card), and a vertical eval rail on the left edge that reads like the one beside a lichess board. Type carries the personality. UI text is set in **Geist** (Google Fonts; Inter stays in the fallback stack and is acceptable if bundling budget is tight, since the extension already ships it). Live numerals — eval, clocks, the SAN of the recommended move — are set in a distinct display face so a "+1.34" or "Nf3" is recognisably the product's voice: candidate A **Bricolage Grotesque** (variable wght/wdth/opsz; set condensed at wdth 87 for numerals — punchy, scoreboard-like, unmistakable), candidate B **Archivo** (variable wdth; set at wdth 112 SemiExpanded for the eval numeral — calmer, more broadcast-graphic). Principal-variation text and anything monospaced is **Geist Mono** (Google Fonts; JetBrains Mono fallback). All fonts are vendored as woff2 in `assets/fonts/` because the extension CSP forbids remote loads. Colour is restrained: charcoal tiers, a single orange ramp used only for the hero, focus and brand, a cool slate for secondary lines, and a red ramp reserved for auto-play and errors. No gradients, no glass, no drop shadows on the dark theme — depth is a one-pixel inner highlight and a tone step.

What this deliberately avoids: the SaaS card kit (identical rounded cards with the same shadow), all-caps tracked eyebrows, tinted near-black (#0b0b0b) backgrounds, a bright green accent on black, decorative icons.

---

## 2. Lattice — the unified token framework

**Name:** Lattice. One base unit; everything snaps to it.

### 2.1 Derivation rules (binding)

| Group | Rule | Allowed keys |
|---|---|---|
| `unit` | The lattice. `4px`. Nothing else is a base. | `4` |
| `space` | `space[n] = unit × n`. Only listed multipliers exist. | `0 1 2 3 4 5 6 8 10 12 16` → 0 4 8 12 16 20 24 32 40 48 64 px |
| `radius` | `radius[k] = unit × m`. Concentric rule: inner radius = outer radius − padding, snapped down to the nearest lattice radius. | `xs=4 sm=8 md=12 lg=16 xl=24 full=9999` |
| `type.size` | `round(13 × 1.2^n)` (minor third, base 13px for panel density). | `xs=11 sm=13 md=16 lg=19 xl=22 2xl=27 3xl=32 4xl=39 5xl=47 6xl=56` |
| `type.leading` | Line-height snapped to the lattice: nearest `unit × n ≥ size × 1.2`. | `xs=16 sm=20 md=24 lg=24 xl=28 2xl=32 3xl=40 4xl=48 5xl=56 6xl=64` |
| `type.weight` | Three weights only. | `regular=400 medium=500 semibold=600` |
| `type.tracking` | em-based, three steps. | `tight=-0.02em normal=0 loose=0.02em` |
| `color` | A fixed palette of named hex values. Every tint, hover, border or overlay is a **palette colour at an alpha step**. Alpha steps are the only alphas allowed. | alpha steps: `a4 a8 a12 a16 a24 a32 a48 a64` (percent) |
| `shadow` | Composed only from `color.black`/`color.white` at alpha steps and lattice offsets. | `rim inset raise overlay` |
| `motion.duration` | `80ms × k`. | `1=80 1.5=120 2.5=200 4=320 6=480` |
| `motion.easing` | Named curves only. | `standard emphasized exit spring` |
| `z` | Ten-step ladder. | `base=0 rail=10 sticky=20 popover=30 toast=40 overlay=50` |
| `size` (control heights) | `unit × n`, from the same multipliers as space. | control heights: `sm=28 (7u) md=36 (9u) lg=44 (11u)`; icon: `sm=13 md=16 lg=19` (= type sizes); touch target min `44` |

Hard rules:
- No hex literal outside `color.palette`. No `rgba()` that is not a palette colour at an alpha step.
- No px literal outside `unit`, `space`, `radius`, `type`, `size`. Borders are always `1px` (the only exception, named `--sl-hairline`).
- Icon sizes equal type sizes of the row they sit in. Icon glyph colour equals the row's text tier.
- Percent widths are allowed; px widths are not, except panel breakpoints (§8).

### 2.2 `tokens.ts` shape (single source; CSS custom properties are generated from it)

Naming rule: `--sl-{group}-{path}` with nested keys joined by `-`. Example: `tokens.color.dark.text.primary` → `--sl-color-text-primary` (the theme level is dropped; the generator emits the dark block on `:root` and the light block on `[data-theme="light"]`).

```ts
// shape only — values are in the tables below
export const tokens = {
  unit: 4,
  space:  { 0:0, 1:4, 2:8, 3:12, 4:16, 5:20, 6:24, 8:32, 10:40, 12:48, 16:64 },
  size:   { control: { sm:28, md:36, lg:44 }, icon: { sm:13, md:16, lg:19 }, touch:44, rail:8, hairline:1 },
  radius: { xs:4, sm:8, md:12, lg:16, xl:24, full:9999 },
  type: {
    family:   { ui:'…', display:'…', mono:'…' },
    size:     { xs:11, sm:13, md:16, lg:19, xl:22, '2xl':27, '3xl':32, '4xl':39, '5xl':47, '6xl':56 },
    leading:  { xs:16, sm:20, md:24, lg:24, xl:28, '2xl':32, '3xl':40, '4xl':48, '5xl':56, '6xl':64 },
    weight:   { regular:400, medium:500, semibold:600 },
    tracking: { tight:'-0.02em', normal:'0', loose:'0.02em' },
    features: { numerals:'"tnum" 1, "lnum" 1', mono:'"liga" 0' },
  },
  color: {
    palette: { /* named hex, §2.4 */ },
    alpha:   { a4:0.04, a8:0.08, a12:0.12, a16:0.16, a24:0.24, a32:0.32, a48:0.48, a64:0.64 },
    dark:    { /* semantic → palette ref (+ optional alpha step) */ },
    light:   { /* same keys as dark */ },
  },
  shadow: { rim:'…', inset:'…', raise:'…', overlay:'…' },
  motion: {
    duration: { 1:80, 1.5:120, 2.5:200, 4:320, 6:480 },
    easing:   { standard:'…', emphasized:'…', exit:'…', spring:'…' },
  },
  z: { base:0, rail:10, sticky:20, popover:30, toast:40, overlay:50 },
} as const;
```

Semantic colour entries are references, not hex: `{ ref:'charcoal.800' }` or `{ ref:'brand.500', alpha:'a16' }`. The generator resolves them, so the palette is the only place a hex exists.

### 2.3 Generated CSS — structural tokens

```css
:root {
  /* unit */
  --sl-unit: 4px;
  --sl-hairline: 1px;

  /* space = unit × n */
  --sl-space-0: 0;
  --sl-space-1: 4px;
  --sl-space-2: 8px;
  --sl-space-3: 12px;
  --sl-space-4: 16px;
  --sl-space-5: 20px;
  --sl-space-6: 24px;
  --sl-space-8: 32px;
  --sl-space-10: 40px;
  --sl-space-12: 48px;
  --sl-space-16: 64px;

  /* size */
  --sl-size-control-sm: 28px;
  --sl-size-control-md: 36px;
  --sl-size-control-lg: 44px;
  --sl-size-icon-sm: 13px;
  --sl-size-icon-md: 16px;
  --sl-size-icon-lg: 19px;
  --sl-size-touch: 44px;
  --sl-size-rail: 8px;          /* eval bar width */

  /* radius = unit × m */
  --sl-radius-xs: 4px;
  --sl-radius-sm: 8px;
  --sl-radius-md: 12px;
  --sl-radius-lg: 16px;
  --sl-radius-xl: 24px;
  --sl-radius-full: 9999px;

  /* type */
  --sl-type-family-ui: "Geist", "Inter", system-ui, sans-serif;
  --sl-type-family-display: "Bricolage Grotesque", "Archivo", "Geist", sans-serif;
  --sl-type-family-mono: "Geist Mono", "JetBrains Mono", ui-monospace, monospace;
  --sl-type-size-xs: 11px;   --sl-type-leading-xs: 16px;
  --sl-type-size-sm: 13px;   --sl-type-leading-sm: 20px;
  --sl-type-size-md: 16px;   --sl-type-leading-md: 24px;
  --sl-type-size-lg: 19px;   --sl-type-leading-lg: 24px;
  --sl-type-size-xl: 22px;   --sl-type-leading-xl: 28px;
  --sl-type-size-2xl: 27px;  --sl-type-leading-2xl: 32px;
  --sl-type-size-3xl: 32px;  --sl-type-leading-3xl: 40px;
  --sl-type-size-4xl: 39px;  --sl-type-leading-4xl: 48px;
  --sl-type-size-5xl: 47px;  --sl-type-leading-5xl: 56px;
  --sl-type-size-6xl: 56px;  --sl-type-leading-6xl: 64px;
  --sl-type-weight-regular: 400;
  --sl-type-weight-medium: 500;
  --sl-type-weight-semibold: 600;
  --sl-type-tracking-tight: -0.02em;
  --sl-type-tracking-normal: 0;
  --sl-type-tracking-loose: 0.02em;
  --sl-type-features-numerals: "tnum" 1, "lnum" 1;

  /* motion */
  --sl-motion-duration-1: 80ms;
  --sl-motion-duration-1-5: 120ms;
  --sl-motion-duration-2-5: 200ms;
  --sl-motion-duration-4: 320ms;
  --sl-motion-duration-6: 480ms;
  --sl-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
  --sl-motion-easing-emphasized: cubic-bezier(0.32, 0.72, 0, 1);
  --sl-motion-easing-exit: cubic-bezier(0.4, 0, 1, 1);
  --sl-motion-easing-spring: linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001);

  /* z */
  --sl-z-base: 0;
  --sl-z-rail: 10;
  --sl-z-sticky: 20;
  --sl-z-popover: 30;
  --sl-z-toast: 40;
  --sl-z-overlay: 50;
}
```

Type roles (the only combinations the UI uses):

| Role | Family | Size / leading | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `label` | ui | xs / xs | medium | loose | Section labels, hints, kbd hints. Sentence case, never uppercase. |
| `body` | ui | sm / sm | regular | normal | Default text, settings descriptions. |
| `body-strong` | ui | sm / sm | semibold | normal | Row titles, toggle labels. |
| `title` | ui | md / md | semibold | tight | View titles ("Settings"), section headers. |
| `numeral-sm` | display | lg / lg | semibold | normal | Clocks, strength Elo. |
| `numeral-md` | display | 2xl / 2xl | semibold | tight | Eval numeric (compact). |
| `numeral-lg` | display | 4xl / 4xl | semibold | tight | Eval numeric (comfortable). |
| `move-sm` | display | 3xl / 3xl | semibold | tight | Recommended move SAN (compact). |
| `move-lg` | display | 6xl / 6xl | semibold | tight | Recommended move SAN (comfortable). |
| `mono` | mono | sm / sm | regular | normal | PV lines, log rows, license key. |
| `mono-xs` | mono | xs / xs | regular | normal | Timing-model rationale log. |

All numerals use `--sl-type-features-numerals` (tabular, lining) so clocks and evals do not jitter.

### 2.4 Colour palette (the only hex values in the system)

| Name | Hex | Notes |
|---|---|---|
| `charcoal.950` | #0F1215 | Deepest tier; only behind overlays. |
| `charcoal.900` | #15181C | Panel canvas (dark). Cool, matches logo disc. |
| `charcoal.850` | #1B1F24 | Sunken surfaces (inputs, log). |
| `charcoal.800` | #22272D | Raised surface (move card, popover). |
| `charcoal.700` | #2C323A | Hover on raised; toggle track off. |
| `charcoal.600` | #3A414B | Borders (solid), slider track. |
| `charcoal.500` | #59626E | Disabled text, placeholder. |
| `charcoal.400` | #8A94A3 | Secondary text. |
| `charcoal.300` | #B7BFCB | Tertiary/high-secondary text. |
| `charcoal.200` | #D8DEE6 | Primary text (dark theme). |
| `charcoal.100` | #EEF1F5 | Highest-contrast text; eval bar "white" on light theme. |
| `white` | #FFFFFF | Alpha ramps only; eval bar white. |
| `black` | #000000 | Alpha ramps only. |
| `bone` | #F3EFE6 | Eval bar white half (warm so it reads as a piece colour, not UI). |
| `slate.900` | #3A3531 | Eval bar black half (warm, distinct from UI charcoal). |
| `brand.300` | #FFC65C | Brand text on dark, hover. |
| `brand.500` | #F5A623 | Brand core (logo orange). Fills, focus, hero SAN. |
| `brand.700` | #C7800E | Pressed, dark-theme border of brand fills. |
| `brand.900` | #6A4507 | Text on brand fills (light theme only). |
| `line.500` | #6FA3D6 | Secondary PV arrow / line 2. |
| `line.600` | #4F7FB0 | Line 3. |
| `success.500` | #4FBF7A | Verified, attached, connected. |
| `warn.500` | #E6C34A | Warnings (yellow, distinct from brand by hue and by icon). |
| `danger.300` | #FF8A7A | Danger text on dark. |
| `danger.500` | #E5533D | Auto-play armed, errors. |
| `danger.700` | #A8301F | Danger pressed. |

### 2.5 Generated CSS — semantic colours, dark (default) and light

```css
:root {
  /* canvas & surfaces */
  --sl-color-canvas:            #15181C;                     /* charcoal.900 */
  --sl-color-surface-sunken:    #1B1F24;                     /* charcoal.850 */
  --sl-color-surface-raised:    #22272D;                     /* charcoal.800 */
  --sl-color-surface-hover:     #2C323A;                     /* charcoal.700 */
  --sl-color-surface-overlay:   rgb(15 18 21 / 0.64);        /* charcoal.950 a64 */

  /* borders */
  --sl-color-border-subtle:     rgb(255 255 255 / 0.08);     /* white a8  */
  --sl-color-border-default:    rgb(255 255 255 / 0.12);     /* white a12 */
  --sl-color-border-strong:     #3A414B;                     /* charcoal.600 */
  --sl-color-border-brand:      #C7800E;                     /* brand.700 */

  /* text tiers */
  --sl-color-text-primary:      #D8DEE6;                     /* charcoal.200 */
  --sl-color-text-secondary:    #8A94A3;                     /* charcoal.400 */
  --sl-color-text-tertiary:     #59626E;                     /* charcoal.500 */
  --sl-color-text-disabled:     rgb(216 222 230 / 0.32);     /* charcoal.200 a32 */
  --sl-color-text-on-brand:     #15181C;                     /* charcoal.900 */
  --sl-color-text-on-danger:    #FFFFFF;                     /* white */

  /* brand */
  --sl-color-brand:             #F5A623;                     /* brand.500 */
  --sl-color-brand-text:        #FFC65C;                     /* brand.300 */
  --sl-color-brand-pressed:     #C7800E;                     /* brand.700 */
  --sl-color-brand-tint:        rgb(245 166 35 / 0.12);      /* brand.500 a12 */
  --sl-color-brand-tint-strong: rgb(245 166 35 / 0.24);      /* brand.500 a24 */
  --sl-color-focus:             #F5A623;                     /* brand.500 */

  /* status */
  --sl-color-success:           #4FBF7A;
  --sl-color-success-tint:      rgb(79 191 122 / 0.12);
  --sl-color-warn:              #E6C34A;
  --sl-color-warn-tint:         rgb(230 195 74 / 0.12);
  --sl-color-danger:            #E5533D;
  --sl-color-danger-text:       #FF8A7A;
  --sl-color-danger-pressed:    #A8301F;
  --sl-color-danger-tint:       rgb(229 83 61 / 0.12);
  --sl-color-danger-tint-strong:rgb(229 83 61 / 0.24);

  /* eval bar */
  --sl-color-eval-white:        #F3EFE6;                     /* bone */
  --sl-color-eval-black:        #3A3531;                     /* slate.900 */
  --sl-color-eval-divider:      rgb(255 255 255 / 0.24);     /* white a24 */

  /* board highlights (injected into the host page) */
  --sl-color-hl-from:           rgb(245 166 35 / 0.32);      /* brand.500 a32 */
  --sl-color-hl-to:             rgb(245 166 35 / 0.48);      /* brand.500 a48 */
  --sl-color-hl-arrow:          rgb(245 166 35 / 0.64);      /* brand.500 a64 */
  --sl-color-hl-arrow-2:        rgb(111 163 214 / 0.48);     /* line.500 a48 */
  --sl-color-hl-arrow-3:        rgb(79 127 176 / 0.48);      /* line.600 a48 */
  --sl-color-hl-preview:        rgb(111 163 214 / 0.64);     /* line.500 a64 — PV row hover preview */

  /* shadows (dark theme = rims, not drops) */
  --sl-shadow-rim:    inset 0 1px 0 rgb(255 255 255 / 0.04);
  --sl-shadow-inset:  inset 0 1px 2px rgb(0 0 0 / 0.24);
  --sl-shadow-raise:  0 0 0 1px rgb(255 255 255 / 0.08), inset 0 1px 0 rgb(255 255 255 / 0.04);
  --sl-shadow-overlay:0 8px 24px rgb(0 0 0 / 0.48), 0 0 0 1px rgb(255 255 255 / 0.08);
}

[data-theme="light"] {
  --sl-color-canvas:            #EEF1F5;                     /* charcoal.100 */
  --sl-color-surface-sunken:    #D8DEE6;                     /* charcoal.200 */
  --sl-color-surface-raised:    #FFFFFF;
  --sl-color-surface-hover:     #D8DEE6;
  --sl-color-surface-overlay:   rgb(15 18 21 / 0.32);

  --sl-color-border-subtle:     rgb(0 0 0 / 0.08);
  --sl-color-border-default:    rgb(0 0 0 / 0.12);
  --sl-color-border-strong:     #B7BFCB;
  --sl-color-border-brand:      #C7800E;

  --sl-color-text-primary:      #15181C;
  --sl-color-text-secondary:    #59626E;
  --sl-color-text-tertiary:     #8A94A3;
  --sl-color-text-disabled:     rgb(21 24 28 / 0.32);
  --sl-color-text-on-brand:     #6A4507;                     /* brand.900 */
  --sl-color-text-on-danger:    #FFFFFF;

  --sl-color-brand:             #F5A623;
  --sl-color-brand-text:        #C7800E;                     /* brand.700 for contrast on light */
  --sl-color-brand-pressed:     #C7800E;
  --sl-color-brand-tint:        rgb(245 166 35 / 0.16);
  --sl-color-brand-tint-strong: rgb(245 166 35 / 0.32);
  --sl-color-focus:             #C7800E;

  --sl-color-success:           #4FBF7A;
  --sl-color-success-tint:      rgb(79 191 122 / 0.16);
  --sl-color-warn:              #E6C34A;
  --sl-color-warn-tint:         rgb(230 195 74 / 0.24);
  --sl-color-danger:            #E5533D;
  --sl-color-danger-text:       #A8301F;
  --sl-color-danger-pressed:    #A8301F;
  --sl-color-danger-tint:       rgb(229 83 61 / 0.16);
  --sl-color-danger-tint-strong:rgb(229 83 61 / 0.32);

  --sl-color-eval-white:        #FFFFFF;
  --sl-color-eval-black:        #3A3531;
  --sl-color-eval-divider:      rgb(0 0 0 / 0.24);

  --sl-shadow-rim:    inset 0 1px 0 rgb(255 255 255 / 0.64);
  --sl-shadow-inset:  inset 0 1px 2px rgb(0 0 0 / 0.08);
  --sl-shadow-raise:  0 1px 2px rgb(0 0 0 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.08);
  --sl-shadow-overlay:0 8px 24px rgb(0 0 0 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.08);
}
```

Contrast checks (dark): text-primary on canvas 12.6:1; text-secondary on canvas 5.3:1; brand-text on canvas 9.4:1; text-on-brand on brand 9.1:1; danger-text on canvas 6.4:1. All body text meets AA; secondary meets AA at 13px because weight is ≥400 and size ≥ 13px.

### 2.6 Icon registry (Font Awesome Free 6, vendored in `assets/fonts/fontawesome/`)

Rules: icons are referenced only by semantic name through the registry; the `fa-*` class never appears in view code. Every icon is `fa-fw`. Icon size = row type size. Colour = row text tier. An icon is never the only label: icon-only buttons carry `aria-label`. Icons are functional, not decorative; if a row reads fine without its icon, the icon is removed.

| Semantic name | Font Awesome class |
|---|---|
| `nav.game` | `fa-solid fa-chess-knight` |
| `nav.settings` | `fa-solid fa-sliders` |
| `nav.engine` | `fa-solid fa-wave-square` |
| `status.idle` | `fa-regular fa-circle` |
| `status.thinking` | `fa-solid fa-circle-notch` (with `fa-spin`; static under reduced motion) |
| `status.ok` | `fa-solid fa-circle-check` |
| `status.attached` | `fa-solid fa-plug-circle-check` |
| `status.detached` | `fa-solid fa-plug-circle-xmark` |
| `status.offline` | `fa-solid fa-plug-circle-minus` |
| `action.play` | `fa-solid fa-play` |
| `action.cancel` | `fa-solid fa-xmark` |
| `action.close` | `fa-solid fa-xmark` |
| `action.back` | `fa-solid fa-arrow-left` |
| `action.speak` | `fa-solid fa-volume-high` |
| `action.mute` | `fa-solid fa-volume-xmark` |
| `action.edit` | `fa-solid fa-pen` |
| `action.copy` | `fa-regular fa-copy` |
| `action.export` | `fa-solid fa-download` |
| `action.refresh` | `fa-solid fa-rotate-right` |
| `action.logout` | `fa-solid fa-arrow-right-from-bracket` |
| `action.external` | `fa-solid fa-arrow-up-right-from-square` |
| `action.chevronDown` | `fa-solid fa-chevron-down` |
| `action.chevronRight` | `fa-solid fa-chevron-right` |
| `action.reveal` | `fa-regular fa-eye` |
| `action.hide` | `fa-regular fa-eye-slash` |
| `action.reattach` | `fa-solid fa-plug` |
| `action.update` | `fa-solid fa-cloud-arrow-down` |
| `feedback.info` | `fa-solid fa-circle-info` |
| `feedback.warning` | `fa-solid fa-triangle-exclamation` |
| `feedback.danger` | `fa-solid fa-circle-exclamation` |
| `feedback.success` | `fa-solid fa-circle-check` |
| `feedback.locked` | `fa-solid fa-lock` |
| `feedback.hourglass` | `fa-regular fa-hourglass-half` |
| `toggle.autoplay` | `fa-solid fa-bolt` |
| `toggle.highlight` | `fa-solid fa-highlighter` |
| `toggle.autoqueue` | `fa-solid fa-forward-step` |
| `toggle.sound` | `fa-solid fa-volume-high` |
| `toggle.tts` | `fa-solid fa-comment` |
| `game.clock` | `fa-regular fa-clock` |
| `game.turn` | `fa-solid fa-caret-left` |
| `game.eval` | `fa-solid fa-scale-balanced` |
| `game.arrow` | `fa-solid fa-arrow-right-long` |
| `game.board` | `fa-solid fa-chess-board` |
| `game.keyboard` | `fa-regular fa-keyboard` |
| `persona.cautious` | `fa-solid fa-shield-halved` |
| `persona.balanced` | `fa-solid fa-scale-balanced` |
| `persona.aggressive` | `fa-solid fa-fire` |
| `persona.blitz` | `fa-solid fa-bolt-lightning` |
| `exec.drag` | `fa-solid fa-hand` |
| `exec.click` | `fa-solid fa-arrow-pointer` |
| `engine.threads` | `fa-solid fa-microchip` |
| `engine.memory` | `fa-solid fa-memory` |
| `engine.nnue` | `fa-solid fa-brain` |
| `engine.log` | `fa-solid fa-scroll` |
| `engine.timing` | `fa-solid fa-stopwatch` |
| `account.key` | `fa-solid fa-key` |
| `account.device` | `fa-solid fa-laptop` |
| `account.user` | `fa-regular fa-user` |
| `social.discord` | `fa-brands fa-discord` |
| `social.globe` | `fa-solid fa-globe` |

### 2.7 Brand lockup

- Mark: the existing PNG, rendered at `size.icon.lg`+`space.1` = 24px (top bar) or `space.16` = 64px (login/empty states). Never recoloured, never masked, never rotated. On the dark canvas the disc's charcoal nearly matches the surface; that is fine — the white ring carries the edge.
- Wordmark: "sliced" in `type.family.ui`, `type.size.md`, `type.weight.semibold`, `type.tracking.tight`, lowercase, `color.text.primary`. Gap between mark and wordmark = `space.2`.
- The mark's orange is `brand.500`; the top bar never puts brand-orange fills next to it (so the mark is the only orange in the top bar unless the engine pill is thinking).

---

## 3. Information architecture and navigation

### 3.1 View graph

```
                 ┌──────────────┐
   no session ─▶ │  1 Login     │ ─── ok ──▶ Session shell
                 └──────────────┘                │
                                                 ▼
                 ┌───────────────────────────────────────────────┐
                 │  Session shell: top bar + content + toast layer│
                 │                                                │
                 │  Tab: Game ─┬─ 2 Not on a supported site       │
                 │             ├─ 3 Waiting for a game            │
                 │             └─ 4 Live game (hero)              │
                 │  Tab: Settings ── 5 Settings (scroll, sections)│
                 │  Tab: Engine  ──  6 Engine & diagnostics       │
                 │                                                │
                 │  Interrupts (replace content, keep top bar):   │
                 │    7 Update available (dismissable)            │
                 │    8 License expired / invalid (not dismissable)│
                 └───────────────────────────────────────────────┘
```

- **Top bar** (44px, `size.control.lg`) persists in every logged-in view: brand lockup left, engine status pill centre-right, view switch right. It is the only sticky element (`z.sticky`). It is not glued edge-to-edge visually: it sits on the canvas with a hairline below it, `space.3` horizontal padding.
- **View switch** is a three-segment control: Game / Settings / Engine. ≥420px shows labels; <420px shows icons with tooltips. Keyboard: `Alt+1/2/3` inside the panel. The active segment is `surface.raised` with `text.primary`; inactive are `text.secondary`.
- **Game tab** resolves automatically to 2 / 3 / 4 based on tab URL and game detection; the user never picks among them.
- **Interrupts** replace the content area but keep the top bar so the user is never lost. Update (7) has a "Later" action that returns to the previous view and re-shows as a top-of-content banner instead. Expired (8) has no dismiss; only Settings › Account remains reachable via the top bar.
- **Login** has no top bar (nothing to navigate to).

### 3.2 Transitions

- Tab-to-tab: crossfade `duration.2-5` + 8px (`space.2`) horizontal slide in the direction of the tab order, `easing.standard`. Scroll position of Settings persists per session.
- Game sub-states (2→3→4): crossfade only, `duration.4`; the eval rail grows in from 0 height when 4 appears (`duration.6`, `easing.emphasized`). This is the one orchestrated entrance in the product.
- Interrupts: content dims to `surface.overlay` then the interrupt card rises `space.4` → 0, `duration.4`, `easing.emphasized`.
- Reduced motion: all of the above become opacity-only crossfades at `duration.2-5`.

### 3.3 What persists

| Thing | Where | Survives |
|---|---|---|
| Session token / license | `chrome.storage.local` | Browser restart |
| All settings | `chrome.storage.sync` | Devices on same profile |
| Active tab, Settings scroll offset | memory | Panel open/close within a window |
| Auto-play armed state | memory, per game | Never survives a game end, a tab change, or a debugger detach |
| Session strip stats | memory | Until browser restart or "Reset session" |
| Toast queue | memory | Cleared on view change |

---

## 4. Wireframes (360px; 1 column ≈ 8px, 45 columns)

Legend: `[ ]` button, `( )` toggle, `{ }` chip/pill, `▌` eval rail, `◔` countdown ring, `▸` chevron, `·` middle dot is literal copy only in the timing plan line.

### 4.1 View 1 — Login

```
+---------------------------------------------+
|                                             |
|                                             |
|                                             |
|                   (mark)                    |  64px mark, centred
|                   sliced                    |  wordmark, type.title
|     Chess assistant for chess.com and       |  text.secondary, body
|                 lichess                     |
|                                             |
|  License key                                |  label
|  +---------------------------------------+  |
|  | SL-                             [eye] |  |  mono input, control.lg
|  +---------------------------------------+  |
|  Keys look like SL-XXXX-XXXX-XXXX.          |  hint (default state)
|                                             |
|  [           Continue                    ]  |  primary, control.lg
|                                             |
|  Don't have a key? Get one at sliced.gg [↗] |  link row, body
|                                             |
|                                             |
|                                             |
|  v2.0.0                        [Discord]    |  footer, text.tertiary
+---------------------------------------------+
```

Inline states of the same view (they replace the hint line and restyle the input; no separate pages):

```
  loading:   [    (spinner)  Checking key…   ]   button disabled, label swaps
  invalid:   input border → danger; hint →
             "That key isn't valid. Check for typos, or copy it from your
              sliced.gg account."                         (danger-text)
  ip limit:  hint → "This key is already active on 2 devices. Sign out on
              one of them, or manage devices at sliced.gg." + [Manage devices ↗]
  offline:   hint → "Can't reach sliced.gg. Check your connection and try again."
             + button label "Try again"
  expired:   hint → "This key expired on 12 Aug 2026." + [Renew ↗]
```

Annotations:
- Vertical rhythm: mark block is centred in the top 40% of the panel height; form starts at 44% height; footer pinned to bottom with `space.4` inset.
- The key input auto-formats `SL-XXXX-XXXX-XXXX` while typing, uppercase, mono. Paste of a full key submits automatically after `duration.6`.
- Enter submits. Focus starts in the input.

### 4.2 View 2 — Not on a supported site

```
+---------------------------------------------+
| (mark) sliced        {idle}     [♞][≡][~]   |  top bar
|---------------------------------------------|
|                                             |
|                                             |
|                (board icon)                 |  icon lg, text.tertiary
|                                             |
|        Open a game to get started           |  title
|   sliced works on chess.com and lichess.    |  body, text.secondary
|   Open one of them in this tab and the      |
|   panel will follow along.                  |
|                                             |
|   [ chess.com  ↗ ]     [ lichess.org ↗ ]    |  two ghost buttons, control.md
|                                             |
|                                             |
|   Auto-play stays off until a game starts.  |  label, text.tertiary
|                                             |
+---------------------------------------------+
```

- Buttons open the site in the current tab.
- If the user is on a supported site but on a non-game page (profile, puzzles), the copy changes: "This page isn't a game." / "Start or join a game and the panel will pick it up." and the buttons become `[ Play ↗ ]` deep-linking to `/play/online` or `/lobby`.

### 4.3 View 3 — Waiting for a game

```
+---------------------------------------------+
| (mark) sliced        {idle}     [♞][≡][~]   |
|---------------------------------------------|
|                                             |
|   ▌                                         |  eval rail present but
|   ▌     Waiting for a game                  |  neutral (50/50), dimmed
|   ▌     On lichess · engine ready           |  text.secondary
|   ▌                                         |
|   ▌     (pulse dot)  Watching this tab      |  status line, a slow 2s pulse
|   ▌                                         |
|                                             |
|  Strength   Club 1200 · Balanced      [edit]|  strength card (same as live)
|                                             |
|  Auto-play (off)   Highlight (on)  Queue(on)|  toggles row (auto-play locked)
|                                             |
|  Last session                               |  label
|  6 games · 84% vs target · 3.1s avg move    |  session strip
|                                             |
|  [ Start a new game ↗ ]                     |  ghost, only if auto-queue off
+---------------------------------------------+
```

- Auto-play toggle is visibly locked here (lock icon, tooltip "Turns on when a game starts"). Users can pre-arm: toggling here shows "Armed for next game" and the toggle uses the armed look; it fires only after the first position arrives.
- The pulse dot is `success` when the content script is connected, `warn` if the page is present but the board isn't parsed yet ("Reading the board…").

### 4.4 View 4 — Live game, comfortable (≥420px; drawn at 360 for alignment)

```
+---------------------------------------------+
| (mark) sliced   {thinking · d18}  Game Set Eng|  top bar: pill shows depth
|---------------------------------------------|
| ▌ IM_Pawnstar 1843                 03:12    |  opponent row: name, rating, clock
| ▌                                           |
| ▌ +1.34                W 71  D 22  L 7      |  eval numeral-lg (left) + WDL (right)
| ▌                                           |
| ▌ +---------------------------------------+ |
| ▌ | Your move · white                     | |  move card header, label
| ▌ |                                       | |
| ▌ |   Nf3            g1 → f3              | |  SAN move-lg (brand-text) + from-to mono
| ▌ |                                       | |
| ▌ |   thinking 4.2s · drag           (◔)  | |  timing plan + ring (only when armed)
| ▌ |                                       | |
| ▌ |  [ ▶ Play move                Space ] | |  primary lg with kbd hint
| ▌ +---------------------------------------+ |
| ▌                                           |
| ▌ ◀ owen 1790                      02:58    |  your row: turn caret, clock (active)
|                                             |
| Lines                                    3  |  section header + count chip
| +1.34  Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7      |  pv row 1 (brand accent stripe)
| +0.92  Bc4 Nf6 d3 Bc5 c3 d6 O-O            |  pv row 2 (line.500 stripe)
| +0.61  d4 exd4 Nxd4 Nf6 Nc3 Bb4            |  pv row 3 (line.600 stripe)
|                                             |
| Strength                                    |
| 1200  Club · Balanced                  [▸]  |  strength card, opens popover
|                                             |
| (⚡ Auto-play  off)  (Highlight on)  (Queue on)|  toggles row
|                                             |
| 6 games   84% vs target   3.1s avg   {deb ✓}|  session strip + executor pill
+---------------------------------------------+
```

Annotations, top to bottom:

1. **Eval rail** (`size.rail` = 8px wide, `radius.full`) spans from the top of the opponent row to the bottom of your row. Orientation mirrors the board: if you are white, the white portion grows from the bottom. Mate shows the rail fully one colour with a hairline divider retained at the edge. The rail is `role="meter"` with `aria-valuetext="White +1.34, 71% win"`.
2. **Opponent/your rows** are mirrored around the move card, like a board. The active clock has `text.primary` and a small caret (`game.turn`) beside the name; the inactive clock is `text.secondary`. Below 20 s the active clock turns `danger-text` and the numerals use `numeral-sm` weight semibold (no blinking).
3. **Eval numeric** is left-aligned to the rail with `space.3` gap. Sign always shown. Mate renders as `M5` / `−M3` in the same size. WDL is right-aligned, `label` role, three fixed-width groups so they don't shift.
4. **Move card** is the only raised plate: `surface.raised`, `radius.lg`, `shadow.raise`, padding `space.4`. Header row is `label`: "Your move · white" or "Opponent to move" (then the SAN shows the expected reply in `text.secondary` and the button is hidden). SAN is `move-lg` in `brand-text`; from→to in `mono` `text.secondary` at the baseline of the SAN. The timing line appears only when auto-play is armed; otherwise the row collapses and the button moves up (card height changes with `easing.emphasized`, `duration.4`).
5. **Play move** is the primary button, full width, `control.lg`, with the keybind rendered as a `kbd` chip on the right inside the button. While auto-play is armed the label becomes "Auto-playing in 4.2s" with the ring on the left and the button turns into a cancel affordance on hover (§6.2).
6. **Lines**: section header row with a count chip that opens the PV-count stepper (1–5). Each PV row: score column (mono, 6ch, right-aligned), left stripe 2px in the line's colour, SAN in `mono` truncated with a fade-out mask (no ellipsis). Hover/focus previews the line's first move as an arrow on the board in `hl-preview`; click pins the preview until another click or the position changes. Row 1 is also the recommended move; clicking it does nothing extra.
7. **Strength card**: one row. Big Elo in `numeral-sm`, human label + persona in `body`, chevron opens a popover (§5.12) anchored to the card with a slider (400–3200) and the four persona chips. Changes apply immediately and show "Applies from next move" in the popover footer.
8. **Toggles row**: three toggles with icon + label. Auto-play uses the danger grammar when armed. Highlight and Queue are ordinary toggles. At <420px labels drop and icons remain, with tooltips.
9. **Session strip**: three stats in `label`, and the executor pill on the right: `{deb ✓}` in `success-tint` when attached, `{deb —}` in `warn-tint` when detached, hidden entirely when auto-play has never been used this session.

Inline warning (debugger detached by user), inserted directly under the top bar, pushes content down:

```
|---------------------------------------------|
| ⚠ Auto-play paused. Chrome's debugging      |  warn-tint bg, warn icon
|   session was closed. [Reattach]  [Dismiss] |
|---------------------------------------------|
```

Toast ("last move executed"), bottom of panel, `z.toast`:

```
|                                             |
|   +-----------------------------------+     |
|   | ✓ Played Nf3 · 3.9s · drag        |     |  success icon, mono move, label meta
|   +-----------------------------------+     |
+---------------------------------------------+
```

### 4.5 View 4 — Live game, compact (320–359px; drawn at 320, 40 columns)

```
+--------------------------------------+
| (mark)      {d18}       [♞][≡][~]    |  top bar: wordmark hidden, pill depth only
|--------------------------------------|
| ▌ IM_Pawnstar         03:12  +1.34   |  opponent row + eval numeral-md inline
| ▌ +----------------------------------+
| ▌ | Your move                        |
| ▌ |   Nf3          g1→f3             |  move-sm
| ▌ |   4.2s · drag              (◔)   |
| ▌ |  [ ▶ Play         Space ]        |  control.md
| ▌ +----------------------------------+
| ▌ ◀ owen              02:58          |
|                                      |
| +1.34  Nf3 Nc6 Bb5 a6 Ba4            |  2 PV rows max
| +0.92  Bc4 Nf6 d3 Bc5                |
|                                      |
| 1200 Club · Balanced           [▸]   |  strength single line
| (⚡)  (hl)  (⏭)              {deb ✓}  |  icon toggles + executor pill
+--------------------------------------+
```

Compact rules: WDL moves into the eval's tooltip and `aria-valuetext`; ratings drop from the name rows; session strip hides (still in Engine view); PV count caps at 2 regardless of setting; the move card loses its outer `space.4` padding to `space.3`.

### 4.6 View 5 — Settings

```
+---------------------------------------------+
| (mark) sliced        {idle}     Game Set Eng|
|---------------------------------------------|
| {Strength}{Timing}{Execution}{Keybinds}{Dis…|  jump chips, horizontal scroll, sticky
|---------------------------------------------|
| Strength                                    |  section header (title)
| Target rating                        1200   |  row label + value
| ──────●──────────────────────────────────   |  slider, bubble "Club 1200"
| 400        Casual · Club · Expert · Master  |  slider scale marks (label, tertiary)
| Persona                                     |
| {Cautious}{Balanced ✓}{Aggressive}{Blitz}   |  chip group, single select
| Blunder rate                          3%    |
| ──●──────────────────────────────────────   |
| Opening book                          (on)  |
| Plays book moves for the first 8–12 moves.  |  description, text.secondary
|                                             |
| Timing                                      |
| Preset             {Bullet}{Blitz ✓}{Rapid} |  time-control aware; auto-detected
|                    {Classical}{Custom}      |
| Base speed                          1.0×    |
| ────────●────────────────────────────────   |
| Variance                             Medium |
| ─────────────●───────────────────────────   |
| Premove tendency                       20%  |
| ────●────────────────────────────────────   |
| Long-think frequency                   1/9  |
| ─────────●───────────────────────────────   |
| Manual only                          (off)  |
| Never auto-plays; shows recommendations.    |
|                                             |
| Execution                                   |
| Move input          {Drag ✓}{Click}         |
| Motor speed                         Natural |
| ──────────●──────────────────────────────   |
| Keep debugger attached               (on)   |
| Chrome shows a "sliced is debugging this    |  description explains infobar
| browser" bar while auto-play is on.         |
| Verify moves after playing           (on)   |
|                                             |
| Keybinds                                    |
| Play move                        [ Space ]  |  keybind capture
| Toggle auto-play                 [ A     ]  |
| Disable assistant                [ D     ]  |
| Speak move                       [ W     ]  |
| Scope                {In page ✓}{Global}    |  global = chrome.commands
|                                             |
| Display                                     |
| Highlight style      {Squares}{Arrows}{Both ✓}|
| Eval bar                             (on)   |
| Lines shown                     [−] 3 [+]   |  stepper 1–5
| UI sounds                            (off)  |
| Speak moves (TTS)                    (off)  |
| Voice                  [ Samantha (en-US) ▾]|  select, disabled unless TTS on
|                                             |
| Account                                     |
| License              SL-7F3K-••••-••••  [eye]|
| Plan                  Pro · renews 12 Aug   |
| This device           MacBook Pro · Chrome  |
| [ Manage devices ↗ ]         [ Sign out ]   |  ghost + ghost (danger text)
|                                             |
| Advanced                                    |
| Engine threads                     [−] 4 [+]|
| Hash                          [ 256 MB  ▾ ] |
| Depth cap                            22     |
| ─────────────────●───────────────────────   |
| Debug log level              [ Info    ▾ ]  |
| [ Export timing log ]                       |
| [ Reset all settings ]                      |  ghost danger
|                                             |
| sliced v2.0.0 · build 1a2b3c                |  footer, tertiary
+---------------------------------------------+
```

Annotations:
- Every row is `control.md` tall minimum; label left, control right; descriptions under the row in `body` `text.secondary`, max 2 lines.
- Section headers are `title` with `space.8` above and `space.3` below; a hairline sits above each section except the first. No numbering, no uppercase.
- Slider value bubbles show the human label (e.g. "Club 1200") while dragging and the numeric at rest on the right of the row.
- Timing preset chips: the detected time control is pre-selected and marked "detected"; changing to another preset shows "Overrides detection for this game".
- "Manual only" on: the auto-play toggle in Live view becomes locked with tooltip "Turn off Manual only in Settings › Timing to enable".
- Account › License: masked; the eye reveals for 10 s then re-masks.

### 4.7 View 6 — Engine and diagnostics

```
+---------------------------------------------+
| (mark) sliced   {thinking · d18}  Game Set Eng|
|---------------------------------------------|
| Engine                                      |
| Stockfish 17 · NNUE loaded            {ok}  |  status row, success pill
| Threads 4 · Hash 256 MB                     |
| 1.42 Mn/s                           depth 18|  live nps numeral-sm + depth
| ▁▂▃▅▆▇▇▆▅▆▇█▇▆▅▆▇▇█▇                        |  nps sparkline, 60 s window, mono blocks
|                                             |
| Executor                                    |
| Debugger                    Attached  {✓}   |
| Target        chess.com · tab 3 · frame 0   |
| Input mode                  Drag · Natural  |
| Last action    Nf3 · 3.9s · verified        |
| [ Detach ]                    [ Reattach ]  |
|                                             |
| Timing model                                |  rationale log
| +---------------------------------------+   |
| | 12:04:31  plan  base 2.8s (blitz 3+2) |   |  mono-xs, sunken surface,
| |           +1.1s variance (σ .6)       |   |  scrollable, newest at bottom
| |           +0.3s complexity (3 cands)  |   |
| |           = 4.2s · drag · no premove  |   |
| | 12:04:35  exec  drag g1→f3 118ms      |   |
| | 12:04:35  verify board matches        |   |
| +---------------------------------------+   |
| [ Copy log ]  [ Export ]        [ Clear ]   |
|                                             |
| Session                                     |
| 6 games · 84% vs target · 3.1s avg move     |
| [ Reset session ]                           |
+---------------------------------------------+
```

- Everything here is `body`/`mono`; the only numerals in the display face are nps and depth.
- The rationale log is the one place in the product where the timing model explains itself. Each entry has a fixed 8ch timestamp column and a 5ch kind column (`plan`, `exec`, `verify`, `warn`).
- "Detach" is a ghost button; "Reattach" is primary only while detached.

### 4.8 View 7 — Update available

```
+---------------------------------------------+
| (mark) sliced        {idle}     Game Set Eng|
|---------------------------------------------|
|                                             |
|                  (mark)                     |
|                                             |
|        sliced 2.1 is ready                  |  title
|   Auto-play now verifies each move on       |  body, 3 lines max, from release notes
|   lichess. Timing presets for bullet were   |
|   retuned.                                  |
|                                             |
|   [        Restart and update           ]   |  primary
|   [               Later                 ]   |  ghost
|                                             |
|   Updating restarts the extension. A game   |  label, tertiary
|   in progress is not affected.              |
|                                             |
+---------------------------------------------+
```

- "Later" returns to the previous view and leaves a one-line banner under the top bar: "sliced 2.1 is ready · [Update]". It never re-interrupts.
- If a game is live, the interrupt does not appear until the game ends; only the banner shows.

### 4.9 View 8 — License expired or invalid

```
+---------------------------------------------+
| (mark) sliced        {locked}          [≡]  |  view switch reduced to Settings
|---------------------------------------------|
|                                             |
|                (lock icon)                  |
|                                             |
|        Your license expired                 |  title
|   sliced stopped assisting on 12 Aug 2026.  |  body
|   Renew to pick up where you left off —     |
|   your settings are kept.                   |
|                                             |
|   [           Renew at sliced.gg ↗      ]   |  primary
|   [        Enter a different key        ]   |  ghost → Login view
|                                             |
|   Signed in as owen · SL-7F3K-••••-••••     |  label, tertiary
|                                             |
+---------------------------------------------+
```

Invalid (revoked) variant: title "This key is no longer valid", body "It may have been revoked or replaced. Check your sliced.gg account." Same buttons.

### 4.10 Easter egg

The 2023 "cat facts" page survives as a hidden view: seven clicks on the mark within 3 s opens it as a popover with one fact and a "Another" button. It uses the same tokens; no special styling. It is not in the navigation.

---

## 5. Component inventory

Naming: BEM under the `.sl-` prefix. Block `.sl-button`, element `.sl-button__label`, modifier `.sl-button--danger`, state via `is-*` classes or ARIA (`aria-pressed`, `aria-disabled`, `data-state`). States listed are exhaustive for each component.

### 5.1 Button — `.sl-button`

Anatomy: `.sl-button__icon` (optional, leading) · `.sl-button__label` · `.sl-button__kbd` (optional, trailing kbd chip) · `.sl-button__ring` (only on the play button when armed).

| Variant | Background | Text | Border | Use |
|---|---|---|---|---|
| `--primary` | `brand` | `text-on-brand` | none | One per view. Play move, Continue, Renew. |
| `--danger` | `danger` | `text-on-danger` | none | Confirmations that act on the account: Reset all settings confirm, Sign out confirm. |
| `--ghost` | transparent | `text-primary` | `border-default` | Everything else. |
| `--ghost.--danger-text` | transparent | `danger-text` | `border-default` | Sign out, Clear log. |

Sizes: `--sm` 28px, `--md` 36px (default), `--lg` 44px. Horizontal padding `space.4` (`space.3` for sm). Radius `radius.sm` for sm/md, `radius.md` for lg. Icon gap `space.2`. Full-width when `--block`.

States:
- hover: primary → `brand-text` background (lighter); ghost → `surface-hover`; `duration.1-5` `easing.standard`.
- active: `transform: scale(0.98)` `duration.1`; primary → `brand-pressed`.
- focus-visible: 2px `focus` ring at 2px offset (`box-shadow: 0 0 0 2px canvas, 0 0 0 4px focus`).
- disabled: `aria-disabled`, opacity via `text-disabled`, no hover, cursor default.
- loading: label swaps to spinner + verb ("Checking key…"); width is locked to pre-loading width.
- armed (play button only): background `danger-tint-strong`, text `danger-text`, ring visible, label "Auto-playing in 4.2s"; hover swaps label to "Cancel" (§6.2).

`kbd` chip: `mono` xs, `surface-sunken` on ghost / `black a24` on primary, `radius.xs`, padding `0 space.1`, height 20px (`leading.sm`).

### 5.2 Toggle — `.sl-toggle`

Anatomy: `.sl-toggle__track` (36×20, `radius.full`) · `.sl-toggle__thumb` (16px) · `.sl-toggle__icon` (optional, before label) · `.sl-toggle__label` · `.sl-toggle__hint` (optional, after, `label` tier).

States:
- off: track `charcoal.600`, thumb `charcoal.200`.
- on: track `brand`, thumb `canvas`. Thumb travels 16px over `duration.1-5` `easing.emphasized`.
- `--armed` (auto-play only): track `danger`, thumb `white`, label `danger-text`, a 1px `danger` outer ring at `a48` that pulses opacity 0.48→0.16 every 2 s (static at 0.32 under reduced motion). Label reads "Auto-play on".
- `--arming` (during hold): track fills left→right with `danger` over the hold duration; see §6.1.
- locked: lock icon replaces thumb glyph, `text-disabled`, tooltip explains why.
- disabled: as locked without lock icon.
- focus-visible: ring as button.
- Keyboard: Space toggles; for `--armed` semantics see §6.1.

### 5.3 Slider with value bubble — `.sl-slider`

Anatomy: `.sl-slider__track` (4px, `radius.full`, `charcoal.600`) · `.sl-slider__fill` (`brand`) · `.sl-slider__thumb` (16px, `charcoal.100`, `shadow.raise`; 20px hit area grows to 44px touch via padding) · `.sl-slider__bubble` (above thumb, `surface-raised`, `radius.sm`, `label`, `shadow.overlay`, caret) · `.sl-slider__scale` (optional marks row under the track, `label` `text-tertiary`) · `.sl-slider__value` (resting numeric on the row's right).

States:
- rest: bubble hidden; value shown right.
- hover: thumb scales 1.1; bubble fades in with the human label ("Club 1200", "Natural", "1/9").
- drag/active: bubble stays; fill and thumb follow; value on the right updates live.
- focus-visible: ring around thumb; arrow keys step; Shift+arrow ×10; Home/End.
- disabled: track `a32`, no thumb shadow.
- Danger zone (strength ≥ 2600 or blunder rate 0): fill turns `warn` beyond the threshold and a `label` line under the slider reads "Very high ratings draw attention. Keep it plausible for your account." No modal.

Sound: `slider_slide.mp3` on thumb release only (not on every tick), gated by UI sounds.

### 5.4 Keybind capture — `.sl-keybind`

Anatomy: `.sl-keybind__label` · `.sl-keybind__key` (kbd chip, mono, min width 6ch) · `.sl-keybind__clear` (×, appears on hover when set).

States:
- set: chip shows the key ("Space", "A", "Ctrl+Shift+P").
- empty: chip reads "Not set" in `text-tertiary`.
- capturing: chip border `brand`, background `brand-tint`, text "Press a key…", the whole row is `aria-live="polite"`. Esc cancels, Backspace clears. See §6.4.
- conflict: chip border `warn`, hint under row "Already used for Speak move".
- global-scope unsupported combo: hint "Global shortcuts need Ctrl or Alt."

### 5.5 Eval bar — `.sl-evalbar`

Anatomy: `.sl-evalbar__track` (8px wide, `radius.full`, background `eval-black`) · `.sl-evalbar__white` (fill from bottom or top per orientation, `eval-white`) · `.sl-evalbar__divider` (1px `eval-divider` at the 50% mark, always visible) · `.sl-evalbar__mate` (label at the winning end when mate, `label`, `text-primary`).

Behaviour: height = the span between the two player rows. Fill = win-probability mapped 0–100% (not raw cp) so ±3 is not pinned at the edge. Transition `duration.6` `easing.standard` on height; jumps > 30% (blunders) use `duration.4` so they register. `role="meter"`, `aria-valuemin=0`, `aria-valuemax=100`, `aria-valuenow`, `aria-valuetext="White +1.34, 71% win, 22% draw"`.

States: neutral (waiting, both halves `a48`) · live · mate (single colour + label) · stale (engine idle > 5 s: fill opacity `a64`).

### 5.6 Move card — `.sl-move`

Anatomy: `.sl-move__header` (label row: "Your move · white") · `.sl-move__san` (display face) · `.sl-move__uci` (mono from→to) · `.sl-move__plan` (timing plan line + `.sl-ring`) · `.sl-move__action` (`.sl-button--primary --block --lg`) · `.sl-move__note` (optional line: "Book move", "Only move", "Mate in 3").

Sizes: comfortable → SAN `move-lg`, padding `space.4`, radius `radius.lg`; compact → SAN `move-sm`, padding `space.3`, radius `radius.md`. Inner elements use `radius.sm` (concentric rule).

States:
- your-move: as drawn.
- opponent-to-move: header "Opponent to move", SAN shows expected reply in `text-secondary` at `move-sm`, action hidden, card background `surface-sunken` (recedes).
- thinking (no move yet): SAN replaced by a 3-dot loader in `text-tertiary` sized to `move-lg` line box so the card does not jump; header "Thinking…".
- new-move (transient, 480 ms): see §6.3.
- played (transient): card border flashes `brand` a24 → 0 over `duration.4`.
- armed: `.sl-move__plan` visible, action in armed state, a 1px `danger` `a24` inner ring on the card.
- disabled (assistant off): whole card at `text-disabled` opacity with header "Assistant off · press D to resume".

### 5.7 PV line row — `.sl-pv`

Anatomy: `.sl-pv__stripe` (2px, left, colour by index) · `.sl-pv__score` (mono, 6ch, right-aligned) · `.sl-pv__moves` (mono, single line, right-edge fade mask 24px) · `.sl-pv__depth` (optional `label`, e.g. "d18", shown ≥420px).

Height `control.sm` (28px). Row gap `space.1`. Indices: 1 = `brand`, 2 = `line.500`, 3 = `line.600`, 4–5 = `charcoal.500`.

States: rest · hover (background `surface-hover`, arrow preview on board) · pinned (`aria-pressed=true`, stripe widens to 4px, background `brand-tint` for row 1 or `line` tint) · stale (opacity `a64`) · focus-visible ring.

### 5.8 Status pill — `.sl-pill`

Anatomy: `.sl-pill__icon` · `.sl-pill__text`. Height 24px (`leading.md`), padding `0 space.2`, `radius.full`, `label` tier.

Variants: `--idle` (`surface-sunken`, `text-secondary`, "Idle") · `--thinking` (`brand-tint`, `brand-text`, spinner icon, "Thinking · d18") · `--ok` (`success-tint`) · `--warn` (`warn-tint`) · `--danger` (`danger-tint`) · `--locked` (`surface-sunken`, lock icon). Text change animates with a `duration.1-5` crossfade; width animates with `easing.standard`.

Executor pill uses the same block: "Attached" / "Detached" / "Not started", icon from `status.*`.

### 5.9 Clock — `.sl-clock`

Anatomy: `.sl-clock__time` (display `numeral-sm`, tabular) · `.sl-clock__tenths` (optional, `label`, shown under 10 s). Format `mm:ss`, `h:mm:ss` over an hour, `ss.t` under 10 s.

States: active (`text-primary`) · inactive (`text-secondary`) · low (<20 s active: `danger-text`) · paused/unknown (`text-tertiary`, "—:—"). Never blinks. Mirrors the site's clock; if the site clock cannot be read, the row shows "clock unavailable" in `label` and the timing model falls back to preset base speed.

### 5.10 Countdown ring — `.sl-ring`

Anatomy: SVG 20px (`leading.sm`) in the plan line, or 24px inside the play button: `.sl-ring__track` (stroke `border-default`, 2px) · `.sl-ring__progress` (stroke `danger`, 2px, round caps, `stroke-dashoffset` driven).

Behaviour: full at plan start, drains clockwise to empty at execution. Uses `linear` timing because it represents real time (the one legitimate use of linear in this system). Hover on the button pauses draining visually only if cancel-on-hover is enabled (default on); the underlying plan keeps time and re-syncs on mouse-out. Reduced motion: ring replaced by the numeric countdown text only ("in 3.1s"). `aria-hidden`; the button label carries the countdown for screen readers via `aria-live="polite"` throttled to whole seconds.

### 5.11 Toast — `.sl-toast`

Anatomy: `.sl-toast__icon` · `.sl-toast__text` · `.sl-toast__action` (optional ghost sm). Width = panel width − 2×`space.4`, bottom inset `space.4`, `surface-raised`, `radius.md`, `shadow.overlay`, padding `space.3`.

Variants: `--success` ("Played Nf3 · 3.9s · drag") · `--info` ("Settings saved") · `--warn` ("Move not verified — board differs from expected") · `--danger` ("Couldn't play the move. Auto-play turned off."). Duration 2.4 s (success/info), 6 s (warn/danger, with action). Enter: rise `space.2` + fade `duration.4` `easing.emphasized`; exit: fade `duration.2-5` `easing.exit`. Max one visible; a newer one replaces. `role="status"` (success/info) or `role="alert"` (warn/danger).

### 5.12 Popover — `.sl-popover`

Anatomy: `.sl-popover__arrow` · `.sl-popover__header` (title + close) · `.sl-popover__body` · `.sl-popover__footer` (hint or actions). `surface-raised`, `radius.md`, `shadow.overlay`, padding `space.4`, max width = panel width − 2×`space.4`, `z.popover`. Anchored to its trigger; flips vertically if no room.

Used for: strength quick-adjust (slider + persona chips + "Applies from next move"), PV count stepper, tooltips (the `--tooltip` variant: `label` text, `space.2` padding, no header, 300 ms hover delay, instant on focus).

States: opening (scale 0.96→1 + fade, `duration.2-5`, `easing.emphasized`, transform-origin at the anchor) · open (focus trapped, Esc closes, click outside closes) · closing (`duration.1-5`, `easing.exit`).

### 5.13 Section header — `.sl-section`

Anatomy: `.sl-section__title` (`title` tier) · `.sl-section__meta` (optional right slot: count chip, action) · `.sl-section__rule` (hairline above, omitted on the first section). Spacing: `space.8` above the rule, `space.3` below the title. In Settings the jump chips scroll-spy to these headers. No numbering, no uppercase, no icons in section headers.

### 5.14 Empty state — `.sl-empty`

Anatomy: `.sl-empty__icon` (`icon.lg` scaled ×2 = 38px, `text-tertiary`) · `.sl-empty__title` (`title`) · `.sl-empty__body` (`body`, `text-secondary`, ≤3 lines, centred, max 32ch) · `.sl-empty__actions` (1–2 buttons) · `.sl-empty__note` (`label`, `text-tertiary`). Vertically centred in the content area with a slight upward bias (44% from top). Used by views 2, 3, 7, 8 and the Lines section when the engine has not produced a line yet ("No lines yet").

### 5.15 Chip / segmented control — `.sl-chip`, `.sl-segment`

Chip: height `control.sm`, `radius.full`, `label` tier, `surface-sunken` rest, `brand-tint` + `brand-text` selected, check icon when selected in single-select groups. Segmented control (view switch, Drag/Click): a `surface-sunken` track with `radius.sm`, the active segment is a `surface-raised` pill that slides between segments (`duration.2-5`, `easing.emphasized`).

### 5.16 Input — `.sl-input`

Height `control.lg` for the license key (only text input in the product), `control.md` elsewhere. `surface-sunken`, `border-default`, `radius.sm`, `shadow.inset`. Focus: border `brand` + focus ring. Invalid: border `danger`, hint `danger-text`, `aria-invalid`. Trailing slot for the reveal icon button.

### 5.17 Banner — `.sl-banner`

Full-width, under the top bar, pushes content. Padding `space.3`, `label`/`body` mix, icon leading, up to two ghost sm actions trailing. Variants `--warn`, `--danger`, `--info` (update). Enter/exit: height + fade, `duration.4`. Only one banner at a time; danger outranks warn outranks info.

---

## 6. Micro-interaction specs

### 6.1 Arming auto-play: press-and-hold, 600 ms

Decision: **press-and-hold for 600 ms** to arm; **single click** to disarm. Not double-tap, not a confirm dialog.

Why: arming is the one action that takes moves on the user's account. Double-tap collides with habitual double-clicking and is invisible to keyboard users; a confirm dialog interrupts every game start and trains users to click through. A hold is a continuous, visibly cancellable gesture, works identically for pointer (hold) and keyboard (hold Space/Enter on the focused toggle), and the 600 ms duration is long enough that a stray click never arms, short enough that it does not feel like a chore before a bullet game. Disarming must be the fast direction, so it is one click or one keypress.

Sequence:
1. Pointer down / key down on the auto-play toggle (state off): toggle enters `--arming`. The track fills left→right with `danger` over 600 ms `linear`. The label reads "Hold to turn on". Sound: none.
2. Release before 600 ms: fill drains back over `duration.2-5` `easing.exit`; a tooltip shows "Hold for a moment to turn on auto-play" once per session.
3. Hold reaches 600 ms: state → `--armed`. Thumb snaps with `easing.spring` `duration.4`. Label → "Auto-play on". A `--warn` banner appears once per session: the debugger infobar explanation (§7.6). The move card gains its inner danger ring; the play button switches to its armed state and the ring starts on the next plan. Sound (if on): `click_heavy.wav`.
4. Click / Space while armed: instant disarm. Label → "Auto-play off". Any running countdown cancels and the toast "Auto-play off · Nf3 not played" appears. Sound: `click_heavy_disable.wav`.
5. Keybind "Toggle auto-play" (default A): when off, pressing it starts a 1 s pre-arm shown as a toast "Turning on auto-play… press A again to cancel" with a ring; a second press within 1 s cancels; otherwise it arms as in step 3. When armed, one press disarms instantly. This keeps the safety asymmetry without a hold on a key that may be pressed mid-game.
6. Auto-disarm: game ends, tab navigates away, debugger detaches, "Manual only" is turned on, or the assistant is disabled with D. Each shows the reason in a toast.

### 6.2 The countdown

When a plan is produced while armed:
1. The plan line appears: "thinking 4.2s · drag" (the number is the planned think time; the second word is the input method; "· premove" is appended when the plan is a premove). The ring at the end of the line starts full.
2. The play button label becomes "Auto-playing in 4.2s" and counts down in tenths until 1.0 s, then whole seconds; the ring inside the button mirrors the plan-line ring (one ring per breakpoint — button ring ≥360px, plan-line ring <360px).
3. Hover on the button: label swaps to "Cancel this move" with `action.cancel` icon; the ring visually pauses. Click cancels: the move is skipped, auto-play stays armed, toast "Skipped Nf3 · auto-play stays on". Mouse-out resumes (ring re-syncs to real time with a `duration.1-5` catch-up).
4. Esc anywhere in the panel cancels the current move the same way. Pressing the play keybind (Space) during a countdown plays immediately ("Play now"); the plan is abandoned and the log records `exec now (user)`.
5. At zero: the executor runs; button label "Playing…" with a spinner for the execution duration (~100–400 ms); then §6.3.
6. If the position changes before zero (opponent moved unexpectedly, premove failed), the countdown cancels silently, the card shows "Thinking…", and a new plan starts.

### 6.3 New move and "played" (restrained)

New move arrives (any mode):
- The old SAN exits upward 8px (`space.2`) with fade over `duration.2-5` `easing.exit`; the new SAN enters from 8px below with `easing.spring` over `duration.6`. Only the SAN moves; the card does not resize during this unless the plan line appears/disappears (which uses `easing.emphasized`, `duration.4`, and is staggered 80 ms after the SAN).
- Eval numeral crossfades (`duration.2-5`); the rail eases (`duration.6`).
- No sound for new recommendations (it would fire every move).

Played (by auto-play or by the Play button/keybind):
- Card border flashes `brand` a24 → 0 over `duration.4`.
- Toast `--success`: "Played Nf3 · 3.9s · drag". If verification is on and passes, a check icon; if it fails, the toast is `--warn`: "Played Nf3 but the board looks different. Auto-play turned off." and auto-play disarms.
- Sound (if on): `make_move.wav`. Never `slam_*` here; the slam sounds are reserved for the assistant being disabled with D (`slam_low.wav`) and re-enabled (`gui_open.mp3`).
- The card then shows the opponent-to-move state.

Reduced motion: SAN crossfade only; no spring; border flash kept (it is opacity-only).

### 6.4 Keybind capture flow

1. Click the key chip: it enters capturing ("Press a key…"), the panel takes keyboard focus, other keybinds are suspended.
2. First key down (modifiers alone do not complete): chip shows the combo live ("Ctrl+Shift+…"). Key up completes.
3. Validation: Esc cancels (keeps old). Backspace/Delete clears ("Not set"). Conflict with another sliced keybind → chip enters `conflict`, hint "Already used for Speak move — press another key, or Enter to swap", Enter swaps them. Global scope requires a modifier; without one the hint reads "Global shortcuts need Ctrl or Alt" and the chip stays capturing.
4. Saved: chip pulses `brand-tint` `duration.4`, toast `--info` "Play move is now Space". Sound (if on): `tick_light.mp3`.
5. Scope switch (In page / Global): switching to Global re-validates all four and flags any without modifiers.

### 6.5 Error and warning banners

- Banners are reserved for conditions the user must resolve; everything else is a toast.
- Warn (debugger detached): "Auto-play paused. Chrome's debugging session was closed. [Reattach] [Dismiss]". Reattach re-attaches and, if it succeeds, the banner exits and auto-play returns to its previous armed state with toast "Auto-play back on".
- Danger (executor failure ×2 in a game): "Auto-play turned off after two failed moves. Check Engine for details. [Open Engine]".
- Danger (engine crashed): "The engine stopped. [Restart engine]". Recommendations pause; card shows "Engine stopped".
- Info (update): "sliced 2.1 is ready · [Update]".
- Banners enter with height + fade `duration.4` `easing.emphasized`; exit `duration.2-5` `easing.exit`. They never stack.

### 6.6 Everything else

- Hover on any row: background `surface-hover` at `duration.1` (fast, near-instant). No transforms on hover except the slider thumb.
- Press on any button: scale 0.98, `duration.1`.
- Panel open: no entrance animation on content; the eval rail growth (§3.2) is the only orchestrated moment and it plays only when a live game is first detected.
- Sounds: all gated by Display › UI sounds (default off). Mapping: toggles on `click_light.wav` / off `click_light_disable.wav`; auto-play arm `click_heavy.wav` / disarm `click_heavy_disable.wav`; slider release `slider_slide.mp3`; stepper `small_slide.mp3`; keybind saved `tick_light.mp3`; move played `make_move.wav`; assistant disabled `slam_low.wav`; assistant enabled `gui_open.mp3`. `slam_light.wav`, `slam_heavy.wav`, `gui_disable.wav` are retired.

---

## 7. Copy guidelines

### 7.1 Tone

- Crisp, plain verbs, sentence case. No emojis anywhere. No exclamation marks.
- The product is an "assistant"; it produces a "recommendation"; the feature that moves pieces is "auto-play"; the engine "thinks"; a plan "plays" a move. Never "cheat", "hack", "bot", "undetectable", "bypass", "safe from bans". Warnings about attention refer to "plausibility" and "attention", not detection.
- Buttons name the outcome: "Play move", "Continue", "Reattach", "Restart and update". Not "OK", "Submit", "Go".
- Errors say what happened and what to do, in that order, in one or two sentences. No apologies.
- Numbers are specific: "4.2s", "d18", "1.42 Mn/s". Units are lowercase and attached ("4.2s", "256 MB").
- The keybind hint is the key name as printed on a keyboard: "Space", "A", "Ctrl+Shift+P".

### 7.2 Microcopy by view

| Where | Copy |
|---|---|
| Login title | sliced |
| Login subtitle | Chess assistant for chess.com and lichess |
| Login field label | License key |
| Login hint (default) | Keys look like SL-XXXX-XXXX-XXXX. |
| Login button | Continue |
| Login loading | Checking key… |
| Login invalid | That key isn't valid. Check for typos, or copy it from your sliced.gg account. |
| Login device limit | This key is already active on 2 devices. Sign out on one of them, or manage devices at sliced.gg. |
| Login offline | Can't reach sliced.gg. Check your connection and try again. |
| Login expired | This key expired on 12 Aug 2026. |
| Login link | Don't have a key? Get one at sliced.gg |
| Unsupported site title | Open a game to get started |
| Unsupported site body | sliced works on chess.com and lichess. Open one of them in this tab and the panel will follow along. |
| Unsupported site note | Auto-play stays off until a game starts. |
| Non-game page title | This page isn't a game. |
| Non-game page body | Start or join a game and the panel will pick it up. |
| Waiting title | Waiting for a game |
| Waiting meta | On lichess · engine ready |
| Waiting status | Watching this tab / Reading the board… |
| Waiting auto-play tooltip | Turns on when a game starts |
| Waiting pre-armed label | Armed for next game |
| Move card header (yours) | Your move · white |
| Move card header (theirs) | Opponent to move |
| Move card thinking | Thinking… |
| Move card notes | Book move / Only move / Mate in 3 / Forced |
| Move card disabled | Assistant off · press D to resume |
| Plan line | thinking 4.2s · drag / thinking 1.1s · click · premove |
| Play button | Play move |
| Play button armed | Auto-playing in 4.2s |
| Play button hover armed | Cancel this move |
| Play button executing | Playing… |
| Lines header | Lines |
| Lines empty | No lines yet |
| Strength card | 1200 Club · Balanced |
| Strength popover footer | Applies from next move |
| Toggle labels | Auto-play / Highlight / Auto-queue |
| Toggle arming | Hold to turn on |
| Toggle armed | Auto-play on |
| Toggle arm tooltip | Hold for a moment to turn on auto-play |
| Session strip | 6 games · 84% vs target · 3.1s avg move |
| Executor pill | Attached / Detached / Not started |
| Engine pill | Idle / Thinking · d18 / Locked / Stopped |
| Toast played | Played Nf3 · 3.9s · drag |
| Toast skipped | Skipped Nf3 · auto-play stays on |
| Toast disarmed | Auto-play off · Nf3 not played |
| Toast verify failed | Played Nf3 but the board looks different. Auto-play turned off. |
| Toast play failed | Couldn't play the move. Auto-play turned off. |
| Toast keybind | Play move is now Space |
| Toast pre-arm | Turning on auto-play… press A again to cancel |
| Toast reattached | Auto-play back on |
| Banner detached | Auto-play paused. Chrome's debugging session was closed. |
| Banner failures | Auto-play turned off after two failed moves. Check Engine for details. |
| Banner engine | The engine stopped. |
| Banner update | sliced 2.1 is ready |
| Update title | sliced 2.1 is ready |
| Update buttons | Restart and update / Later |
| Update note | Updating restarts the extension. A game in progress is not affected. |
| Expired title | Your license expired |
| Expired body | sliced stopped assisting on 12 Aug 2026. Renew to pick up where you left off — your settings are kept. |
| Expired buttons | Renew at sliced.gg / Enter a different key |
| Revoked title | This key is no longer valid |
| Revoked body | It may have been revoked or replaced. Check your sliced.gg account. |
| Strength labels | 400–799 Casual · 800–1399 Club · 1400–1999 Expert · 2000–2599 Master · 2600+ Elite |
| Strength warning | Very high ratings draw attention. Keep it plausible for your account. |
| Persona descriptions | Cautious: prefers solid moves and longer thinks. Balanced: plays like a typical club player. Aggressive: favours sharp lines and faster replies. Blitz-demon: fast, confident, occasionally reckless. |
| Timing preset note | Detected: blitz 3+2 / Overrides detection for this game |
| Manual only description | Never auto-plays; shows recommendations only. |
| Execution debugger description | Chrome shows a "sliced is debugging this browser" bar while auto-play is on. Don't click Cancel — that closes the session and pauses auto-play. |
| Verify description | After each move, checks the board matches the expected position. |
| Keybind capturing | Press a key… |
| Keybind conflict | Already used for Speak move — press another key, or Enter to swap |
| Keybind global | Global shortcuts need Ctrl or Alt. |
| Account rows | License / Plan / This device |
| Sign out confirm | Sign out on this device? Your settings stay. [Sign out] [Cancel] |
| Reset confirm | Reset all settings to defaults? Keybinds and strength included. [Reset] [Cancel] |
| Engine rows | Stockfish 17 · NNUE loaded / Threads 4 · Hash 256 MB |
| Timing log kinds | plan / exec / verify / warn |
| Footer | sliced v2.0.0 · build 1a2b3c |

### 7.3 The debugger infobar

Shown once per session as a warn banner when auto-play is first armed, and permanently as the description under Execution › Keep debugger attached:

"Chrome shows a 'sliced is debugging this browser' bar while auto-play is on. Don't click Cancel — that closes the session and pauses auto-play. You can hide the bar by keeping the debugger attached between games."

Banner version (shorter): "Chrome will show a 'sliced is debugging this browser' bar. Don't click Cancel. [Got it]"

### 7.4 Accessibility copy

- Eval bar `aria-valuetext`: "White +1.34, 71% win, 22% draw, 7% loss" / "Mate in 5 for Black".
- Move card `aria-live="polite"` region announces: "Recommended: knight f3, g1 to f3" (SAN spelled out via a lookup: N→knight, B→bishop, R→rook, Q→queen, K→king, x→takes, +→check, #→checkmate, O-O→castles kingside).
- Play button when armed: `aria-label="Auto-playing knight f3 in 4 seconds. Activate to cancel."` updated per whole second.
- Toggles: `role="switch"`, `aria-checked`; auto-play adds `aria-describedby` pointing at the hold hint.
- Status pill: `role="status"`.

---

## 8. Responsive and height rules

### 8.1 Width breakpoints

| Range | Name | Rules |
|---|---|---|
| 320–359 | compact | Wordmark hidden (mark only). View switch icons only. Eval numeral inline in the opponent row at `numeral-md`; WDL to tooltip. Ratings hidden. Move card `move-sm`, padding `space.3`, ring in the plan line. Play button `control.md`, label "Play". PV max 2, depth column hidden. Toggles icon-only. Session strip hidden. Settings rows wrap label above control when the label exceeds 16ch. |
| 360–419 | standard | Wordmark shown. View switch icons only. Eval numeral `numeral-lg` on its own row with WDL. Move card `move-lg`. PV rows up to the setting (max 5), depth column hidden. Toggles icon + label. Session strip shown. |
| 420–480 | comfortable | View switch shows labels. Ratings shown. PV depth column shown. Move card SAN and from→to on one baseline with `space.6` gap. Settings rows keep label/control on one line always. Popovers max width 400px. |
| >480 | comfortable, capped | Content column max width 480px, centred; extra space goes to margins. Nothing scales up further; the panel is not a dashboard. |

Horizontal padding: `space.4` at ≥360, `space.3` at <360. The eval rail sits inside the padding, `space.3` from the left edge; content to its right starts after `size.rail` + `space.3`.

### 8.2 Height strategy

The panel scrolls vertically as a whole (top bar sticky). The Live view must fit without scrolling at 720px height in the standard breakpoint. Budget at 360×720:

| Block | Height |
|---|---|
| Top bar | 44 |
| Opponent row | 32 |
| Eval row | 48 |
| Move card (your move, armed) | 168 |
| Your row | 32 |
| Lines header + 3 rows | 28 + 84 |
| Strength card | 44 |
| Toggles row | 44 |
| Session strip | 36 |
| Vertical gaps (`space.4` × 6) | 96 |
| Total | 656 |

Collapse order when the available height (viewport − top bar − banner) is smaller than the live layout, evaluated in this order until it fits:

1. Session strip → hidden (stats remain in Engine view). Saves 36 + 16.
2. PV rows → 3 → 2 → 1 (never 0 while a line exists). Saves 28 each.
3. WDL row → folds into the eval numeral's tooltip; eval numeral drops to `numeral-md` inline with the opponent row. Saves 48 + 16.
4. Strength card → one-line chip inside the toggles row ("1200 · Balanced"). Saves 44 + 16.
5. Move card → `move-sm`, `space.3` padding, plan line merges into the button label. Saves ~56.
6. Below 480px available height the view scrolls; the move card is scroll-pinned at the top of the content so the hero and the play button are always visible.

Each collapse is a discrete state (no fluid scaling), so the layout is stable while the user drags the panel edge. Transitions between states are `duration.2-5` opacity crossfades; no layout animation.

### 8.3 Interaction targets and density

- Minimum hit target 44×44 for everything in the Live view (`size.touch`); Settings rows use 36px controls but the whole row is the hit area for toggles.
- Minimum 8px (`space.2`) between adjacent hit areas.
- The panel is mouse-first but must be fully usable by keyboard: Tab order is top bar → banner → content top-to-bottom → toast action. `Alt+1/2/3` switch tabs; `Esc` cancels a countdown, closes a popover, or cancels a capture, in that priority.

### 8.4 Reduced motion and forced colours

- `prefers-reduced-motion: reduce`: all transforms removed; crossfades only at `duration.2-5`; ring replaced by text; spinner static; armed pulse static at `a32`.
- `forced-colors: active`: eval bar draws with `CanvasText`/`Canvas` and a 1px `CanvasText` divider; the armed state relies on the label text ("Auto-play on") and a 2px `Highlight` outline; brand fills become `ButtonFace` with `ButtonText`.
- `prefers-contrast: more`: text-secondary maps to `charcoal.300`; borders use `border-strong`.

---

## 9. Open questions for engineering

1. Chrome side panel minimum width is enforced by Chrome at ~320px; confirm the maximum users can drag to on macOS/Windows so the >480 cap is tested.
2. Global keybinds via `chrome.commands` are limited to four; the product has exactly four. Adding a fifth would require the in-page scope only.
3. The eval rail's mapping from cp to win probability should use the same model that produces WDL so the rail and the WDL numbers never disagree.
4. Font vendoring: Geist, Geist Mono and the chosen display face (Bricolage Grotesque or Archivo) as variable woff2, subset to Latin + chess symbols (`×`, `→`, `½`, `−`). Budget ≈ 260 KB total.
5. Font Awesome Free: vendor only the solid, regular and brands subsets referenced in §2.6; strip the rest to keep the extension under review-friendly size.


# Appendix G — Humanized CDP input and chessboard interaction

> Decision note (Part I §9.1): "Tier 3" (untrusted events) and "Tier 4" (site API) in this appendix are rejected and must not be implemented; the executor is CDP-only in v2.0 with the native backend as the forward-proof successor (§9.8). Everything else here (CDP semantics, chessground internals, path generation, motor defaults) is normative for Tasks 17–19.


Date: 2026-09-03. Scope: replacing the four-command click-click executor (`chrome.debugger` + `Input.dispatchMouseEvent` at exact square centres, zero timing) with a humanized, verifiable drag-and-drop executor for chess.com and lichess.org in an MV3 extension.

Every "verified" claim below was checked against the linked source on 2026-09-03. Claims marked **[verify at impl]** come from community scripts or memory and should be confirmed with a 5-minute DevTools session before code depends on them.

---

## 0. Executive summary

- CDP `Input.dispatchMouseEvent` injects events into the browser-side input pipeline (`RenderWidgetHost`), so the page receives them as **trusted** (`isTrusted: true`) pointer/mouse events with correct `clientX/Y`, `screenX/Y`, hover/`mouseover` side effects, and `buttons` state. This is the same path Puppeteer/Playwright use. Coordinates are CSS px relative to the main-frame viewport; Chromium scales them by device-scale/zoom internally.
- Puppeteer/Playwright interpolate **linearly** with `steps` (default 1) and **no inter-step delay**. That signature (straight line, constant velocity, zero acceleration) is exactly what mouse-dynamics bot detectors flag (BeCAPTCHA-Mouse). Humans show a bell-shaped velocity profile (minimum-jerk), curved paths, and 0–2 corrective sub-movements near the target.
- The two proven humanizers are **WindMouse** (SRL, BenLand100: gravity + random wind, velocity clipping, damping near target) and **Bezier + Fitts's law** (ghost-cursor: cubic Bezier with anchors on the normals, step count from Fitts's ID, overshoot past 500 px). Both are ported to TypeScript below; the recommended design uses a Bezier path shaped by a minimum-jerk time profile with Fitts-derived duration, plus optional WindMouse as a second "style" for variety.
- **Chessground (lichess) rejects untrusted events**: `drag.start` returns unless `s.trustAllEvents || e.isTrusted`, and lila does not set `trustAllEvents`. So Tier 3 (untrusted `dispatchEvent`) is dead on lichess. Chess.com's `wc-chess-board` accepts untrusted pointer events (chesshook works that way) but the site flags such moves (`didUseCheatMouse` per chesshook's README). CDP is the only path that yields trusted events from an extension.
- Chessground needs `mousedown` on the board + `mousemove`/`mouseup` on `document`, drag threshold `draggable.distance = 3` px (dropping to 0 after the first drag when `autoDistance` is true), and resolves the drop square by `getKeyAtDomPos(clientX, clientY)` — the release point must be inside the target square. Chess.com listens to pointer events on `wc-chess-board`.
- `chrome.debugger` in MV3: `"debugger"` permission, attach only to tabs with a committed http(s) URL (Chrome 86+ uses the last committed URL), infobar on attach (suppressed only by `--silent-debugger-extension-api` or, reportedly, force-installed enterprise extensions), `onDetach` with `canceled_by_user` when the user clicks Cancel or opens DevTools. Timers in the SW are fine while you keep calling `sendCommand`; use a drift-corrected `performance.now()` scheduler.

---

## 1. CDP `Input.dispatchMouseEvent` — exact semantics

Source: [Chrome DevTools Protocol, Input domain (tip-of-tree)](https://chromedevtools.github.io/devtools-protocol/tot/Input/). Implementation: [content/browser/devtools/protocol/input_handler.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/input_handler.cc).

| Param | Type | Semantics (quoted/paraphrased from the protocol doc) |
|---|---|---|
| `type` | enum | `mousePressed`, `mouseReleased`, `mouseMoved`, `mouseWheel` |
| `x`, `y` | number | "X coordinate of the event relative to the main frame's viewport in CSS pixels." "0 refers to the top of the viewport and Y increases … towards the bottom." Chromium's `InputHandler` multiplies by the device scale factor (`ScaleFloatPoint`, accounting for browser zoom, CSS zoom and pinch) and adds the widget's screen offset to fill `screenX/Y`. So: pass `getBoundingClientRect()`-space values as-is. |
| `modifiers` | int | Bit field: Alt=1, Ctrl=2, Meta/Command=4, Shift=8 (default 0). Never set Shift/Ctrl for chess: Shift/right-button triggers drawing in chessground; Ctrl+drop disables lichess auto-queen. |
| `timestamp` | TimeSinceEpoch (s) | "Time at which the event occurred." Default: now. Chromium converts via `GetEventTimeTicks()` (anchors wall-clock to `TimeTicks`). It feeds `event.timeStamp` and Blink's click/double-click timing. **Recommendation: omit it.** Our events are dispatched with real wall-clock gaps, so the default timestamp is automatically consistent. Supplying fabricated timestamps that disagree with actual dispatch time is the only way to make this field look wrong. |
| `button` | `none|left|middle|right|back|forward` | Default `none`. Validated by `GetMouseEventButton()`. |
| `buttons` | int | "Left=1, Right=2, Middle=4, Back=8, Forward=16, None=0" — the pressed-buttons bitmask. **Must be 1 on every `mouseMoved` during a left drag**, otherwise the page sees `pointermove` with `buttons=0` and chessground's `e.buttons` check and chess.com's drag tracking behave as if the button was released. |
| `clickCount` | int | Default 0. Maps straight to `WebMouseEvent.click_count` → `MouseEvent.detail`. Use 1 for press/release, 0 for moves. Using 1 for both clicks of a click-click move is fine (Blink does not synthesise `dblclick` from two CDP clicks with `clickCount:1`). |
| `force` | 0–1 | Pressure; leave 0 for mouse. |
| `pointerType` | `mouse|pen` | Default `mouse`. |
| `deltaX/Y` | number | Wheel only. |
| `tangentialPressure`, `tiltX/Y`, `twist` | | Pen only. |

**Ack semantics (verified in `input_handler.cc`)**: the command's callback is invoked after the renderer acknowledges the event ("GetRenderWidgetHostAtPointAsynchronously … callback is invoked after the renderer acknowledges the event"). So `await sendCommand(...)` is a natural back-pressure mechanism: each `mouseMoved` resolves after Blink has hit-tested and dispatched it. Widget must exist and be visible (`!widget_host … return internal error`); events are dropped while `ignore_input_events_` is set (e.g. a modal dialog).

**Trustedness**: the event is built as a `blink::WebMouseEvent` and forwarded through `RenderWidgetHost` — the same route as OS input — so Blink fires `pointerdown/mousedown/pointermove/mousemove/pointerup/mouseup/click` with `isTrusted: true`. Puppeteer's, Playwright's and ghost-cursor's entire click/hover machinery rely on this; ghost-cursor literally does `cdpClient.send('Input.dispatchMouseEvent', {type:'mouseMoved', x, y})` per point ([spoof.ts](https://raw.githubusercontent.com/Xetera/ghost-cursor/master/src/spoof.ts)).

**Derived fields in the page**:
- `clientX/Y` = the CSS px you passed (minus any iframe offset if the hit target is in a child frame — not the case here).
- `screenX/Y` = clientX/Y + window screen offset (Chromium's `ConvertWidgetPointToScreenPoint`).
- `movementX/Y` = Blink computes these from the delta to the previous mouse position when the platform event carries no raw movement (the "consolidated movement" path in `PointerEventFactory`/`MouseEventManager`). Puppeteer users report them as populated. **[verify at impl]**: log `movementX` in a MAIN-world `pointermove` listener during a CDP drag; expect small deltas equal to your path steps (and a large first delta if the real cursor was elsewhere — see §4).
- Hover: each `mouseMoved` is hit-tested, so `mouseover/mouseenter/mouseleave` and `:hover` follow the synthetic cursor.

**`Input.dispatchDragEvent` / `Input.setInterceptDrags`** (verified in the doc): `setInterceptDrags(enabled)` "Prevents default drag and drop behavior and instead emits `Input.dragIntercepted` events"; `dispatchDragEvent` takes `dragEnter|dragOver|drop|dragCancel` plus `DragData`. These exist only for **HTML5 native drag-and-drop** (`draggable=true` elements, `dragstart/dragover/drop`). Puppeteer's `Mouse.drag()` uses them because `mousedown+mousemove` on a `draggable` element starts a native OS drag that swallows subsequent mouse events. Neither chessground nor `wc-chess-board` uses HTML5 DnD: chessground moves the piece with `transform: translate()` on `mousemove`; chess.com tracks `pointermove`. Pieces are plain `<piece>`/`<div class="piece">` elements with no `draggable` attribute. **So do not enable `setInterceptDrags` and do not send drag events** — a plain `mousePressed → N×mouseMoved(buttons:1) → mouseReleased` sequence is the correct and complete drag.

### Reference sequence (drag)

```
mousePressed  {x:px, y:py, button:'left', buttons:1, clickCount:1}
mouseMoved    {x, y, button:'left', buttons:1}          × N (≥ 3 px total before the page treats it as a drag)
mouseReleased {x:dx, y:dy, button:'left', buttons:0, clickCount:1}
```

Playwright's `Mouse.move` sends `button: this._lastButton` and `buttons: <bitmask>` on every move ([input.ts](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/input.ts)); Puppeteer's `CdpMouse` sends `button` derived from its pressed-button flags plus the `buttons` bitmask ([cdp/Input.ts](https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/cdp/Input.ts)). Match that: `button:'left'` on moves while dragging.

---

## 2. What Puppeteer/Playwright do, why it is detectable, and what humanizers do

### 2.1 Puppeteer / Playwright (verified in source)

```ts
// puppeteer-core/src/cdp/Input.ts (CdpMouse.move)
for (let i = 1; i <= steps; i++) {
  position: { x: from.x + (to.x - from.x) * (i / steps),
              y: from.y + (to.y - from.y) * (i / steps) }
}
// playwright-core/src/server/input.ts (Mouse.move)
const { steps = 1 } = options;
for (let i = 1; i <= steps; i++) {
  const middleX = fromX + (x - fromX) * (i / steps);
  const middleY = fromY + (y - fromY) * (i / steps);
```

- Default `steps = 1`: the cursor teleports. With `steps = n`, points are equally spaced on a perfectly straight line and dispatched back-to-back (only the CDP ack latency separates them, typically 1–16 ms, so the page sees constant velocity ≈ `D/n` px per frame).
- `Mouse.click` = `move` → `down` → optional `delay` → `up`. `Mouse.drag/dragAndDrop` = down, move, then HTML5 `dragEnter/dragOver/drop` via `Input.dispatchDragEvent`.

### 2.2 Why that is detectable

[BeCAPTCHA-Mouse (Acien et al., arXiv 2005.00890)](https://arxiv.org/pdf/2005.00890) benchmarks exactly these synthetic profiles ("constant velocity", "acceleration", "initial acceleration with final deceleration") against human trajectories. Their and Castle.io's findings ([Bot or not](https://blog.castle.io/bot-or-not-can-you-spot-the-automated-mouse-movements/)):

1. Bots: straight segments, constant speed, acceleration ≈ 0 except at direction changes.
2. Humans: initial acceleration → peak → final deceleration (bell-shaped speed), curvature, and a fine correction phase near the target. The classic model is minimum-jerk ([Flash & Hogan 1985](https://journals.physiology.org/doi/full/10.1152/jn.1998.80.2.696) discussion) with 1–2 corrective sub-movements (Meyer et al. optimized-initial-impulse).
3. Bezier-curve bots are "harder to differentiate", but still fail on combined metrics (timing regularity, absence of overshoot, always-centre landing, no idle micro-movement).

Our old executor is worse than Puppeteer: no moves at all, four events in < 5 ms, exact centres, zero variance. Anything time-stamped by the page (`event.timeStamp` deltas between `pointerdown`/`pointerup`/next `pointerdown`) looks machine-generated.

### 2.3 WindMouse (SRL-5, BenLand100) — verified source

Original Pascal from [SRL-5/SRL/core/mouse.simba](https://github.com/SRL/SRL-5/blob/master/SRL/core/mouse.simba):

```pascal
procedure WindMouse(xs, ys, xe, ye, gravity, wind, minWait, maxWait, maxStep, targetArea: extended);
...
    while hypot(xs - xe, ys - ye) > 1 do
    begin
      dist:= hypot(xs - xe, ys - ye);
      wind:= minE(wind, dist);
      if dist >= targetArea then
      begin
        windX:= windX / sqrt3 + (random(round(wind) * 2 + 1) - wind) / sqrt5;
        windY:= windY / sqrt3 + (random(round(wind) * 2 + 1) - wind) / sqrt5;
      end else
      begin
        windX:= windX / sqrt2;
        windY:= windY / sqrt2;
        if (maxStep < 3) then maxStep:= random(3) + 3.0
        else maxStep:= maxStep / sqrt5;
      end;
      veloX:= veloX + windX;  veloY:= veloY + windY;
      veloX:= veloX + gravity * (xe - xs) / dist;
      veloY:= veloY + gravity * (ye - ys) / dist;
      if hypot(veloX, veloY) > maxStep then
      begin
        randomDist:= maxStep / 2.0 + random(round(maxStep) div 2);
        veloMag:= sqrt(veloX * veloX + veloY * veloY);
        veloX:= (veloX / veloMag) * randomDist;  veloY:= (veloY / veloMag) * randomDist;
      end;
      lastX:= Round(xs); lastY:= Round(ys);
      xs:= xs + veloX;  ys:= ys + veloY;
      if (lastX <> Round(xs)) or (lastY <> Round(ys)) then MoveMouse(Round(xs), Round(ys));
      step:= hypot(xs - lastX, ys - lastY);
      wait(round((maxWait - minWait) * (step / maxStep) + minWait));
    end;
```

SRL's `MMouse` derives the parameters from a global `MouseSpeed` (typical 13–20):

```pascal
randSpeed := (random(MouseSpeed) / 2.0 + MouseSpeed) / 10.0;
WindMouse(cx, cy, nx, ny, 11.0, 8.0, 10.0/randSpeed, 12.0/randSpeed, 10.0*randSpeed, 10.0*randSpeed);
//                        gravity wind  minWait        maxWait        maxStep         targetArea
```

Ben Land's Python re-derivation ([ben.land, 2021](https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/)) uses `G_0=9, W_0=3, M_0=15, D_0=12` and explains the physics: gravity is a constant force toward the target, wind is a random force that is low-pass filtered (`/√3`) so it changes smoothly, velocity is clipped to `M_0` (and randomised on clip), and inside `D_0` the wind is damped and the max step shrinks by `√5` per iteration so the cursor decelerates and can overshoot-and-correct.

TypeScript port (returns `{x,y,dtMs}` points; the wait formula preserved):

```ts
export interface WindMouseParams {
  gravity: number;   // 9–11
  wind: number;      // 3–8
  minWaitMs: number; // ~5–10
  maxWaitMs: number; // ~10–15
  maxStep: number;   // px per tick, 10–15 (scales with speed)
  targetArea: number;// px radius where damping starts, 8–12
}

export function windMousePath(
  x0: number, y0: number, x1: number, y1: number,
  p: WindMouseParams, rnd: () => number = Math.random,
): PathPoint[] {
  const out: PathPoint[] = [];
  const S2 = Math.SQRT2, S3 = Math.sqrt(3), S5 = Math.sqrt(5);
  let xs = x0, ys = y0, vx = 0, vy = 0, wx = 0, wy = 0;
  let wind = p.wind, maxStep = p.maxStep;
  let lastX = Math.round(xs), lastY = Math.round(ys);
  let guard = 0;
  while (Math.hypot(xs - x1, ys - y1) > 1 && guard++ < 2000) {
    const dist = Math.hypot(xs - x1, ys - y1);
    wind = Math.min(wind, dist);
    if (dist >= p.targetArea) {
      wx = wx / S3 + (rnd() * (wind * 2 + 1) - wind) / S5;
      wy = wy / S3 + (rnd() * (wind * 2 + 1) - wind) / S5;
    } else {
      wx /= S2; wy /= S2;
      maxStep = maxStep < 3 ? rnd() * 3 + 3 : maxStep / S5;
    }
    vx += wx + p.gravity * (x1 - xs) / dist;
    vy += wy + p.gravity * (y1 - ys) / dist;
    const vmag = Math.hypot(vx, vy);
    if (vmag > maxStep) {
      const clip = maxStep / 2 + rnd() * maxStep / 2;
      vx = vx / vmag * clip; vy = vy / vmag * clip;
    }
    xs += vx; ys += vy;
    const step = Math.hypot(xs - lastX, ys - lastY);
    const dt = (p.maxWaitMs - p.minWaitMs) * Math.min(1, step / p.maxStep) + p.minWaitMs;
    const rx = Math.round(xs), ry = Math.round(ys);
    if (rx !== lastX || ry !== lastY) { out.push({ x: rx, y: ry, dtMs: dt }); lastX = rx; lastY = ry; }
  }
  if (lastX !== Math.round(x1) || lastY !== Math.round(y1)) out.push({ x: x1, y: y1, dtMs: p.minWaitMs });
  return out;
}
```

Strengths: emergent overshoot/correction, smooth-but-noisy curvature, deceleration. Weaknesses: acceleration phase is abrupt (velocity ramps in a few ticks) and total duration is only indirectly controlled — hence the Fitts-timed Bezier as default, WindMouse as an alternate style.

### 2.4 ghost-cursor (Bezier + Fitts) — verified source

From [spoof.ts](https://raw.githubusercontent.com/Xetera/ghost-cursor/master/src/spoof.ts) and [math.ts](https://raw.githubusercontent.com/Xetera/ghost-cursor/master/src/math.ts):

```ts
const fitts = (distance: number, width: number): number => {
  const a = 0; const b = 2;
  const id = Math.log2(distance / width + 1);
  return a + b * id;
};
// points along the curve:
const steps = Math.ceil((Math.log2(fitts(length, width) + 1) + baseTime) * 3);
// bezierCurve: "spread defaults to the distance between endpoints, constrained between 2 and 200 px";
// two control anchors placed on random points of lines *normal* to the start→end segment (generateBezierAnchors).
// overshoot: if distance > overshootThreshold (500) first move to overshoot(dest, OVERSHOOT_RADIUS=120) then to dest.
// OVERSHOOT_SPREAD = 10; moveDelay randomised (randomizeMoveDelay: true); optional trapezoidal-rule timestamps.
```

Note ghost-cursor's `a/b` are not seconds — they only size the point count. It spaces points uniformly in Bezier parameter `t`, which produces a roughly bell-shaped *spatial* density only as a side effect of the control-point geometry; there is no explicit velocity profile unless `useTimestamps` is on. We do better by assigning time explicitly (below).

### 2.5 Recommended default: Bezier path × minimum-jerk time × Fitts duration

**Duration** (Fitts, Shannon form; MacKenzie): `MT = a + b·log2(D/W + 1)`.
Literature values (all from the yorku.ca/mack corpus, [Soukoreff & MacKenzie 2004 review](https://www.yorku.ca/mack/hhci2018.html), [MacKenzie, Sellen & Buxton 1991](https://www.billbuxton.com/fitts91.html)):

- Mouse throughput in ISO 9241-9 studies: **3.7–4.9 bits/s** (so raw `b ≈ 0.2–0.27 s/bit`).
- MacKenzie/Sellen/Buxton 1991, mouse **pointing**: `MT ≈ −107 + 223·ID` ms; mouse **dragging**: `MT ≈ 135 + 249·ID` ms (dragging is slower and has a positive intercept). **[from memory of that paper; verify]**
- Card, English & Burr 1978 mouse: `a ≈ 1.03 s` (includes homing), `b ≈ 0.096 s/bit`.
- Intercepts in the -200…+800 ms range are considered normal regression outcomes.

For a chess move: `D` = 80–600 px, `W` = square size (≈ 60–100 px at usual board sizes) → ID ≈ 1–3.1 bits. Lab dragging numbers give 400–900 ms per drag; practiced blitz players who already know the destination move faster than lab subjects (no decision component, low accuracy demand because the drop only needs to be *inside* the square). So use persona-scaled constants around `a = 80 ms, b = 120 ms/bit` (≈ 200–450 ms per drag) for blitz, `a = 150, b = 200` for rapid/classical, and add the reaction/"think" delay separately (§8).

**Velocity profile**: minimum-jerk position along the path, `s(τ) = 10τ³ − 15τ⁴ + 6τ⁵` (τ = t/MT ∈ [0,1]); speed is bell-shaped with peak = 1.875·D/MT. Sampling the Bezier at arc-length fraction `s(τ)` every 8 ms gives a natural spatial density (dense at both ends, sparse mid-flight).

**Corrective sub-movement / overshoot**: with probability `overshootProb` (≈ 8–15 %, rising with distance), aim the primary movement at a point `dest + u·(0.05–0.15)·D` beyond the target along the approach direction (or a random point 6–20 px past it), then execute a second, slower minimum-jerk segment (`MT₂ ≈ 120–250 ms`) back into the target rectangle. With probability `hesitationProb`, insert a 60–200 ms near-stationary "settle" (1–2 px drift) before release.

**Jitter**: add per-point Gaussian noise σ ≈ 0.8–1.5 px, low-pass filtered (AR(1) with ρ ≈ 0.6) so consecutive samples correlate like a real hand tremor rather than white noise; quantise to integers (real mice report integer counts).

---

## 3. Chessboard interaction specifics

### 3.1 Lichess / chessground (verified in source)

Sources: [events.ts](https://raw.githubusercontent.com/lichess-org/chessground/master/src/events.ts), [drag.ts](https://raw.githubusercontent.com/lichess-org/chessground/master/src/drag.ts), [board.ts](https://raw.githubusercontent.com/lichess-org/chessground/master/src/board.ts), [state.ts](https://raw.githubusercontent.com/lichess-org/chessground/master/src/state.ts), [lila ui/round/src/ground.ts](https://raw.githubusercontent.com/lichess-org/lila/master/ui/round/src/ground.ts), [lila ui/lib/src/game/promotion.ts](https://raw.githubusercontent.com/lichess-org/lila/master/ui/lib/src/game/promotion.ts).

**Listeners**: on the board element (`cg-board`): `mousedown` and `touchstart` (`{passive:false}`), `contextmenu`. On `document`: `mousemove`, `touchmove`, `mouseup`, `touchend`. No pointer events — mouse events only. Because move/up are on `document`, the cursor may leave the board during the drag; only the release point matters.

**`drag.start(s, e)`** (quoted):
```ts
if (!(s.trustAllEvents || e.isTrusted)) return;   // untrusted events are ignored
if (e.buttons !== undefined && e.buttons > 1) return; // only left button (buttons==1) or 0
if (e.touches && e.touches.length > 1) return;
```
then it hit-tests the square with `getKeyAtDomPos(eventPosition(e))`, and either selects (click-click) or begins a drag with `cur.started = false`.

**Click-vs-drag**: `processDrag` (rAF loop) sets `cur.started = true` once `distanceSq(cur.pos, cur.origPos) >= draggable.distance²`. Defaults (state.ts): `draggable.distance: 3`, `draggable.autoDistance: true` ("lets chessground set distance to zero when the user drags pieces" — after the first real drag the threshold is 0 for the session). `draggable.enabled = pref.moveEvent !== Click`, `selectable.enabled = pref.moveEvent !== Drag` (lila round config); default user pref is "either", so both work. lila does **not** set `trustAllEvents`.

**`drag.end`**: `dest = getKeyAtDomPos(eventPosition(e), whitePov, bounds)` → `file = floor(8·(x − bounds.left)/bounds.width)` etc. If `dest && cur.started && cur.orig !== dest` → `userMove(orig, dest)`; else it is treated as a click (select/unselect). **The release must land inside the destination square's bounds** (no snapping in the drag path; `getSnappedKeyAtDomPos` is used only for drawing shapes).

**Click-click**: first `mousedown` on the piece selects it (`selectSquare`); the *second* `mousedown` on a legal destination executes `userMove` immediately in `drag.start` → `board.selectSquare` (the move happens on mousedown, not mouseup). Still send the `mouseReleased` to keep button state coherent.

**Premove**: same input. `userMove` → if `canMove` fails and `canPremove` succeeds → `setPremove` (squares get `.current-premove`); it is played via `chessground.playPremove()` after the opponent's move (lila `ctrl.ts`). `premovable.enabled = pref.enablePremove`.

**Promotion** (lila `promotion.ts`): after the move, if the pawn reaches the last rank and auto-queen is not applicable (`AutoQueen.Always`, or `OnPremove` for premoves), lila renders `div#promotion-choice.top|.bottom` overlaying the destination file, containing four `<square>` children in order **queen, knight, rook, bishop**, each positioned in successive ranks starting from the destination square; clicking a `square` calls `finish(role)`, clicking elsewhere on the overlay cancels. Ctrl held at drop forces the dialog even with auto-queen. Click target: `#promotion-choice square:nth-child(k)` → compute its `getBoundingClientRect()` in the content script and click a random interior point. Note the hit area extends to the square edge (lila issue #13545 mentions accidental knight picks), so bias toward centre.

**Success verification** (lichess): chessground moves the piece and sets `state.lastMove = [orig,dest]` synchronously on user move, so within one frame: `cg-board square.last-move` exists at dest, and a `<piece>` with the moved role has `transform` equal to the dest translation. For a premove: `square.current-premove` at orig and dest. The move list (`rm6 > l4x > kwdb`, active `.a1t`; **[verify — lila uses deliberately odd tag names that have changed before; the current replay.ts must be read]**) updates when the server echoes the move (~50–200 ms). Verify board state first (fast, local), then optionally the move list within 1 s.

### 3.2 Chess.com (`wc-chess-board`) — mostly [verify at impl]

Chess.com's board is closed-source. What is established from community scripts ([chesshook](https://github.com/0mlml/chesshook), greasyfork "Chess.com Bot/Cheat"):

- Board element: `document.querySelector('wc-chess-board')` (older: `chess-board`). It exposes `board.game` in the page world: `game.move({from,to,promotion,animate,userGenerated})` / `game.move('e4')`, `getFEN()`, `getLegalMoves()`, `getPlayingAs()` (1 = white, 2 = black), `markings.addOne/removeAll`. Pieces are `.piece.<color><type>.square-<file><rank>` (e.g. `.piece.wp.square-52`), board `.flipped` when black is at bottom.
- **Input model: Pointer Events on the board element.** chesshook plays moves by dispatching `new PointerEvent('pointerdown', {clientX,clientY,bubbles:true,cancelable:true,view:window})` on `wc-chess-board` at the from-square and `pointerup` at the to-square — i.e. the board interprets down-at-A / up-at-B as a drag even with no `pointermove` in between (it hit-tests down and up independently). Untrusted events are accepted, but chesshook's README says the site records such moves under **`didUseCheatMouse`** — so the board evidently inspects `isTrusted` (or the pointer/mouse path). CDP-injected events are trusted and avoid that flag.
- Drag threshold: unknown; chess.com starts following the piece from the first `pointermove` with the button held. Our drags always exceed any plausible threshold. Drop resolution is by pointer position at `pointerup` → must be inside the target square. **[verify]** whether it uses `setPointerCapture` (irrelevant for CDP; capture only affects target routing).
- Click-click: `pointerdown/up` on the piece square selects (square gets a highlight), `pointerdown/up` on a legal destination moves. Premove while not our turn: same input; the squares get a red-tinted premove highlight (chess.com help centre). Promotion: after the drop a `.promotion-window` overlay appears over the destination file with four `.promotion-piece.<color><role>` elements (`wq wn wr wb` / `bq …`) and a close button **[verify selectors]**; auto-queen is a user setting. If the promotion overlay fails to appear or is unmatched, fall back to `game.move({...promotion:'q'})` (Tier 4) only if the user has opted in.
- Success verification: a `.piece` element whose class contains `square-<dest>` and the moved-type class appears within a frame (the board updates optimistically); `.highlight` squares move to orig/dest; move list `wc-simple-move-list .node` / `.main-line-row` gains a node **[verify]**. Premove: `.highlight` with the premove colour on both squares.

### 3.3 Common rules

1. Press point inside the **from** square, biased toward the piece image (piece sprites occupy roughly the central 80–90 % of the square; pawns less). Sample from a truncated 2-D Gaussian centred on the square centre, σ = 0.18·squareSize, clipped to the inner 70 % of the square (§7 `samplePointInRect`).
2. Release point inside the **to** square, same sampler but σ = 0.22·squareSize, clipped to the inner 80 % (humans are sloppier on release; still safely inside).
3. Never release outside the board (chessground `deleteOnDropOff` is false in play, but the move is lost and the piece snaps back — wasted time).
4. Before `mouseReleased`, confirm the last dispatched point is still inside the target rect (the overshoot/jitter stages must clamp).
5. After success, keep the synthetic cursor where it was released; the next move's path starts there unless a fresher real-cursor sample exists.

---

## 4. Where should the cursor start?

Extensions cannot read the OS cursor position. Options, in priority order:

1. **Last real position** from a content-script listener (ISOLATED world, `document.addEventListener('pointermove', h, {passive:true, capture:true})`, plus `pointerdown/up`). Store `{x,y,t: performance.now(), screenX, screenY}`; expose via `chrome.runtime` message on demand (do not stream every move to the SW — one request per execution is enough). Treat as valid if age < ~5 s and the tab has been visible since.
2. **Last synthetic release point** (our previous drop) — a human's hand tends to stay where it dropped the piece, especially between moves in blitz.
3. **Plausible fallback**: a random point in a band around the board: 60 % on a random square of the user's own half, 25 % near the player's clock/move list, 15 % just off the board edge. Never start exactly at the from-square (that means the first event is a press with no approach).

**Teleport concern**: after our synthetic drag the *real* cursor is still where the user left it. The next real `pointermove` will carry a large `movementX/Y` (and a jump in `clientX/Y`). The page does not care — this is the same thing that happens after tab switches, window focus changes, `pointerlock` exit, or a laptop trackpad lift-and-replace. `movementX` is only meaningful under pointer lock. It matters very little for behavioural analysis because pages cannot distinguish "hand lifted from mouse and put back elsewhere" from a teleport; the only weak tell is that the jump is exactly from our drop point. Mitigation: after the drop, if the real position is known, optionally play a slow, low-effort "return" path 30–50 % of the way toward the real cursor (or nowhere — humans rest on the piece they just moved). Also, if the user physically moves the mouse *during* our drag, the page will see interleaved trusted moves from two positions; the content script should signal "user active" and the executor should abort/retry (press was ours, but a real `pointerup` from the user would drop the piece wherever their cursor is — on chessground that would be `mouseup` on `document` at the user's position). Practically: block execution while a real pointer event occurred in the last ~150 ms and warn in the panel.

**Hover states**: CDP `mouseMoved` updates hover, so the board's `:hover` and `mouseenter/leave` fire naturally as the path enters the board. When the real cursor moves next, hover reverts — harmless. Start the path outside or at the board edge often enough that `mouseenter` on `cg-board` is observed sometimes.

---

## 5. `chrome.debugger` ergonomics in MV3

Verified against [chrome.debugger reference](https://developer.chrome.com/docs/extensions/reference/api/debugger) and the [Chrome 86 attach change notice](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/avq_G6bVmaE):

- Manifest: `"permissions": ["debugger"]`. `attach({tabId}, "1.3")` — the version must be `"1.3"`/`"1.2"` (major match, minor ≥). `sendCommand({tabId}, method, params)` returns a Promise in MV3.
- Attach validates against the **last committed URL** (Chrome ≥ 86): wait for `tabs.onUpdated status === 'complete'` (or `webNavigation.onCommitted`) before attaching. Cannot attach to `chrome://`, `chrome-extension://` (other extensions), the Web Store, or pages blocked by policy (`Cannot attach to this target` / policy errors).
- **Infobar**: on attach Chrome shows "<Extension> started debugging this browser" across all tabs of the window. It cannot be suppressed by the extension. The `--silent-debugger-extension-api` command-line switch removes it (the doc also notes attaching to extension background pages is only possible with that switch); community reports say force-installed (`ExtensionInstallForcelist`) enterprise extensions also skip it **[unverified]**. Document for power users: `open -a "Google Chrome" --args --silent-debugger-extension-api` (macOS) / add to the shortcut (Windows); requires a full restart. The `DeveloperToolsAvailability` policy only *restricts* DevTools (0 default, 1 allow everywhere, 2 disallow) — value 2 would make attach fail; no value hides the infobar.
- **`onDetach(source, reason)`**: `reason ∈ {"target_closed", "canceled_by_user"}`. `canceled_by_user` fires when the user clicks Cancel on the infobar or opens DevTools on the tab. Handle by marking the session detached, showing a panel notice ("Chrome closed the automation session; the next move will re-attach"), and re-attaching lazily on the next execution request. Also handle `onDetach` for `target_closed` on navigation (chess.com navigates between games as an SPA, lichess `/round` pages are full loads → re-attach after `onUpdated complete`).
- **Lifecycle policy**: attach lazily on first execution in a game; keep attached through the game (each attach re-shows the infobar, so re-attaching per move is worse UX); detach on game end, tab navigation away from a game URL, or after N (e.g. 10) minutes without an execution. Only one debugger client per tab: if the user opens DevTools on that tab, attach fails/detaches — surface that.
- **Focus/visibility**: Chromium's `InputHandler` requires the target widget to be visible. A tab that is not the active tab of its window has a hidden `RenderWidgetHost` → events fail or stall (Puppeteer issues #3156, #5201 describe background-tab stalls). The side panel taking keyboard focus is fine: the tab is still active and visible; `document.hasFocus()` is false but neither board checks focus for pointer input. Recommended pre-flight: `chrome.tabs.update(tabId, {active:true})` if not active (or CDP `Page.bringToFront`), then dispatch. `Emulation.setFocusEmulationEnabled({enabled:true})` is an optional extra that makes the page believe it is focused (useful only if a site pauses input on `blur`; chess sites don't). Don't rely on `Page.bringToFront` for a minimised/occluded window — Chrome throttles rendering; the events are still delivered but frame-aligned timing degrades.
- **Service-worker lifetime**: every `chrome.debugger.sendCommand` call resets the SW idle timer, so the worker stays alive for the duration of a drag. Attach state should be recorded in `chrome.storage.session` so a restarted SW knows to check `chrome.debugger.getTargets()` rather than assuming detached.

---

## 6. Alternatives without the debugger, and the tiered strategy

| Method | lichess | chess.com | Fidelity | Notes |
|---|---|---|---|---|
| **T1 CDP humanized drag** | works | works | highest (trusted, moved, timed) | needs `debugger`, infobar |
| **T2 CDP click-click** (with humanized approach paths to both squares) | works | works | high | fewer events; use as retry when a drag fails verification |
| **T3 Untrusted `PointerEvent`/`MouseEvent` from MAIN world** | **fails** — `drag.start` requires `isTrusted` (`trustAllEvents` unset in lila) | works, but flagged (`didUseCheatMouse`) | low | zero permissions; only as last-resort on chess.com with user opt-in |
| **T4 Site API** — chess.com `board.game.move({from,to,promotion,animate:true,userGenerated:true})`; lichess none (round controller is not global; chessground instance lives in closure — only reachable by monkey-patching `Chessground` before lila boots) | not available | works | lowest (no input events at all; server sees a legal move but client telemetry sees no pointer) | opt-in only |

Ranking by reliability: T4 (deterministic API) > T1 ≈ T2 > T3. Ranking by fidelity: T1 > T2 > T3 > T4. Default order T1 → T2 → (T3 chess.com only) → T4 (opt-in). Each tier is attempted only after `verifyMove` fails for the previous one, and after confirming the board state has not already changed (avoid double-moving).

`chrome.scripting.executeScript` with `world: 'MAIN'` is the vehicle for T3/T4 (needs host permissions for the site, which the content scripts already have).

Per-site capability matrix (constants in the adapter):

```ts
export const SITE_CAPS = {
  lichess: { drag: true, clickClick: true, untrustedEvents: false, api: false,
             dragDistancePx: 3, moveOnSecondMouseDown: true,
             promotionSelector: '#promotion-choice square', promotionOrder: ['q','n','r','b'] },
  chesscom: { drag: true, clickClick: true, untrustedEvents: true /* flagged */, api: true,
              dragDistancePx: 0, moveOnSecondMouseDown: false /* verify */,
              promotionSelector: '.promotion-window .promotion-piece', promotionOrder: null /* by class wq/wn/wr/wb */ },
} as const;
```

---

## 7. TypeScript design

### 7.1 Types

```ts
export interface Pt { x: number; y: number }
export interface Rect { left: number; top: number; width: number; height: number }
export interface PathPoint { x: number; y: number; dtMs: number }   // dtMs: delay BEFORE dispatching this point

export interface MotorProfile {
  reactionMs: [number, number];        // lognormal-ish range sampled per move (time before the hand starts)
  fittsA: number; fittsB: number;      // seconds, seconds/bit
  travelSpeedScale: number;            // 1.0 = model; blitz 0.75, classical 1.3
  peakSpeedCapPxPerS: number;          // clamp on peak velocity (e.g. 3500)
  jitterPx: number;                    // σ of low-pass tremor
  overshootProb: number;               // 0.08–0.15
  hesitationProb: number;              // 0.10–0.20 (pause before release)
  microCorrectionProb: number;         // 0.30 (second small sub-movement inside target)
  pressHoldMs: [number, number];       // for clicks: 40–120
  grabDelayMs: [number, number];       // press → first move on drag: 30–90
  releaseSettleMs: [number, number];   // last move → release: 20–80
  sampleIntervalMs: number;            // 8 (125 Hz mouse); Chrome coalesces to frames anyway
  styleMix: { bezier: number; wind: number }; // probabilities
}

export interface ExecutionPlan {
  tabId: number;
  site: 'lichess' | 'chesscom';
  from: { x: number; y: number; rect: Rect };  // square centre + bounds (viewport CSS px)
  to:   { x: number; y: number; rect: Rect };
  promotion?: 'q' | 'r' | 'b' | 'n';
  style: 'drag' | 'click';
  motor: MotorProfile;
  startPoint?: Pt;                             // last known cursor
  expected: { san?: string; uci: string; premove: boolean };
  timeoutMs?: number;
}

export interface ExecutionResult {
  ok: boolean;
  tier: 1 | 2 | 3 | 4;
  attempts: number;
  endPoint: Pt;              // where the synthetic cursor ended
  elapsedMs: number;
  error?: string;
}

export interface MoveExecutor { execute(plan: ExecutionPlan): Promise<ExecutionResult> }
```

### 7.2 Random helpers and press-point sampling

```ts
const rand = (a: number, b: number) => a + Math.random() * (b - a);
function gauss(): number {           // Box–Muller
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function truncGauss(mean: number, sigma: number, lo: number, hi: number): number {
  for (let i = 0; i < 8; i++) { const v = mean + gauss() * sigma; if (v >= lo && v <= hi) return v; }
  return Math.min(hi, Math.max(lo, mean));
}
/** Random point inside `rect`, Gaussian around centre, clipped to the inner `innerFrac` of the square. */
export function samplePointInRect(rect: Rect, sigmaFrac = 0.18, innerFrac = 0.7): Pt {
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const hw = rect.width * innerFrac / 2, hh = rect.height * innerFrac / 2;
  return { x: truncGauss(cx, rect.width * sigmaFrac, cx - hw, cx + hw),
           y: truncGauss(cy, rect.height * sigmaFrac, cy - hh, cy + hh) };
}
const inRect = (p: Pt, r: Rect, pad = 2) =>
  p.x >= r.left + pad && p.x <= r.left + r.width - pad && p.y >= r.top + pad && p.y <= r.top + r.height - pad;
```

Press point: `samplePointInRect(from.rect, 0.18, 0.7)` (piece sprite ≈ inner 80–90 %; 70 % keeps us on the image even for pawns). Release point: `samplePointInRect(to.rect, 0.22, 0.8)`.

### 7.3 Path generator (Bezier × minimum-jerk × Fitts, with overshoot and micro-correction)

```ts
const minJerk = (t: number) => t * t * t * (10 + t * (-15 + 6 * t));     // s(τ), τ∈[0,1]

function cubicBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Control points on the normals of the chord (ghost-cursor style), spread ∝ distance. */
function bezierAnchors(a: Pt, b: Pt): [Pt, Pt] {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  const nx = -dy / d, ny = dx / d;
  const spread = Math.min(200, Math.max(2, d)) * rand(0.05, 0.25);   // ghost-cursor clamps spread to 2..200
  const side = Math.random() < 0.5 ? -1 : 1;                          // whole curve bows one way
  const t1 = rand(0.2, 0.4), t2 = rand(0.6, 0.8);
  const s1 = side * spread * rand(0.4, 1), s2 = side * spread * rand(0.2, 0.8);
  return [{ x: a.x + dx * t1 + nx * s1, y: a.y + dy * t1 + ny * s1 },
          { x: a.x + dx * t2 + nx * s2, y: a.y + dy * t2 + ny * s2 }];
}

/** Arc-length lookup so we can sample the curve at equal *distance* fractions. */
function arcTable(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n = 64): { t: number; s: number }[] {
  const tab = [{ t: 0, s: 0 }]; let prev = p0, acc = 0;
  for (let i = 1; i <= n; i++) { const t = i / n, p = cubicBezier(p0, p1, p2, p3, t);
    acc += Math.hypot(p.x - prev.x, p.y - prev.y); tab.push({ t, s: acc }); prev = p; }
  return tab.map(e => ({ t: e.t, s: e.s / acc }));
}
function tAtArc(tab: { t: number; s: number }[], frac: number): number {
  let lo = 0, hi = tab.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tab[m].s < frac) lo = m + 1; else hi = m; }
  if (lo === 0) return 0;
  const a = tab[lo - 1], b = tab[lo]; const k = (frac - a.s) / ((b.s - a.s) || 1);
  return a.t + (b.t - a.t) * k;
}

function fittsMs(distPx: number, widthPx: number, m: MotorProfile): number {
  const id = Math.log2(distPx / Math.max(8, widthPx) + 1);
  const mt = (m.fittsA + m.fittsB * id) * 1000 * m.travelSpeedScale;
  const floor = (1.875 * distPx / m.peakSpeedCapPxPerS) * 1000;        // cannot exceed peak-speed cap
  return Math.max(mt * rand(0.85, 1.2), floor, 60);
}

/** One ballistic sub-movement from a to b lasting `durMs`, sampled every `dt` ms. */
function segment(a: Pt, b: Pt, durMs: number, m: MotorProfile, out: PathPoint[]) {
  const [c1, c2] = bezierAnchors(a, b);
  const tab = arcTable(a, c1, c2, b);
  const n = Math.max(2, Math.round(durMs / m.sampleIntervalMs));
  let jx = 0, jy = 0;                                                    // AR(1) tremor state
  for (let i = 1; i <= n; i++) {
    const tau = i / n;
    const p = cubicBezier(a, c1, c2, b, tAtArc(tab, minJerk(tau)));
    const env = Math.sin(Math.PI * tau);                                 // no jitter at the exact ends
    jx = 0.6 * jx + gauss() * m.jitterPx; jy = 0.6 * jy + gauss() * m.jitterPx;
    out.push({ x: Math.round(p.x + jx * env), y: Math.round(p.y + jy * env), dtMs: m.sampleIntervalMs });
  }
  const last = out[out.length - 1]; last.x = Math.round(b.x); last.y = Math.round(b.y); // land exactly
}

export function generatePath(from: Pt, to: Pt, targetRect: Rect, m: MotorProfile): PathPoint[] {
  const out: PathPoint[] = [];
  const D = Math.hypot(to.x - from.x, to.y - from.y);
  if (D < 1) return out;
  const W = Math.min(targetRect.width, targetRect.height);
  const dirx = (to.x - from.x) / D, diry = (to.y - from.y) / D;

  const overshoot = Math.random() < m.overshootProb * Math.min(2, D / 250);
  if (overshoot) {
    const over = rand(0.04, 0.12) * D + rand(4, 10);
    const o = { x: to.x + dirx * over + gauss() * 3, y: to.y + diry * over + gauss() * 3 };
    segment(from, o, fittsMs(D + over, W * 1.5, m), m, out);
    out[out.length - 1].dtMs += rand(30, 90);                            // brief pause at the reversal
    segment(o, to, rand(120, 250), m, out);                              // corrective sub-movement
  } else {
    segment(from, to, fittsMs(D, W, m), m, out);
  }
  if (Math.random() < m.microCorrectionProb) {                           // tiny in-target adjustment
    const cur = out[out.length - 1];
    const adj = { x: cur.x + gauss() * 2.5, y: cur.y + gauss() * 2.5 };
    if (inRect(adj, targetRect, 4)) { out[out.length - 1].dtMs += rand(20, 60); segment(cur, adj, rand(60, 120), m, out); }
  }
  // Safety: every point after the final approach must remain inside the target square.
  const last = out[out.length - 1];
  if (!inRect(last, targetRect)) { last.x = Math.round(to.x); last.y = Math.round(to.y); }
  return out;
}

/** Small "grab" wobble right after mousePressed, before the real travel begins. */
export function grabWobble(p: Pt, m: MotorProfile): PathPoint[] {
  const n = 2 + Math.floor(Math.random() * 3), pts: PathPoint[] = [];
  let x = p.x, y = p.y;
  for (let i = 0; i < n; i++) { x += gauss() * 0.8; y += gauss() * 0.8;
    pts.push({ x: Math.round(x), y: Math.round(y), dtMs: rand(8, 22) }); }
  return pts;
}
```

Style selection: with probability `styleMix.wind`, replace `segment(from, to, …)` with `windMousePath(...)` (§2.3), scaling `maxStep` so that `Σdt ≈ fittsMs`. Never use the same style two moves in a row with identical parameters — sample the profile per move (see §8).

### 7.4 CDP dispatcher with precise timing

Timing facts: extension service workers are not subject to the background-tab 1 s timer clamp (that applies to page contexts); `setTimeout` resolution is ~1 ms with the usual 4 ms clamp after nested timers. Real mice report at 125 Hz (8 ms) or higher and Chrome coalesces `mousemove` into per-frame `pointermove` (rAF-aligned, `getCoalescedEvents()` carries the rest). So dispatching at 8 ms cadence and letting Chrome coalesce is indistinguishable from a real mouse; drift correction matters more than sub-ms precision. Each `sendCommand` resolves after renderer ack (1–16 ms), which is why we schedule against absolute targets, not fixed sleeps. Running in the SW is fine because `sendCommand` traffic keeps it alive; an offscreen document gains nothing for timing (same timer semantics) and adds a message hop.

```ts
type Cdp = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const sleep = (ms: number) => new Promise<void>(r => (ms <= 0 ? r() : setTimeout(r, ms)));

export class CdpMouse {
  private pos: Pt;
  private buttons = 0;
  constructor(private cdp: Cdp, start: Pt) { this.pos = start; }
  get position() { return this.pos; }

  private async dispatch(type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', p: Pt, extra: Record<string, unknown> = {}) {
    await this.cdp('Input.dispatchMouseEvent', {
      type, x: p.x, y: p.y, pointerType: 'mouse', modifiers: 0,
      button: this.buttons & 1 || type !== 'mouseMoved' ? 'left' : 'none',
      buttons: this.buttons, ...extra,
    });
    this.pos = p;
  }
  async press(p: Pt) { this.buttons |= 1; await this.dispatch('mousePressed', p, { clickCount: 1 }); }
  async release(p: Pt) { this.buttons &= ~1; await this.dispatch('mouseReleased', p, { button: 'left', clickCount: 1 }); }

  /** Dispatch a path honouring dtMs with drift correction against performance.now(). */
  async travel(path: PathPoint[], abort?: AbortSignal) {
    let due = performance.now();
    for (const pt of path) {
      if (abort?.aborted) throw new Error('aborted');
      due += pt.dtMs;
      const wait = due - performance.now();
      if (wait > 1) await sleep(wait);                      // if we're late (slow ack), skip sleeping
      await this.dispatch('mouseMoved', pt);
      if (performance.now() - due > 40) due = performance.now(); // resync after a stall (GC, throttling)
    }
  }
}
```

Note the `button` field: while `buttons===1` every `mouseMoved` carries `button:'left'` (as Playwright/Puppeteer do); free moves carry `button:'none', buttons:0`.

### 7.5 Executor (Tier 1 drag, Tier 2 click-click, verification, fallbacks)

```ts
export interface SiteAdapter {
  /** Runs in the content script; returns viewport-relative rects for squares and promotion targets. */
  squareRect(tabId: number, sq: string): Promise<Rect>;
  boardRect(tabId: number): Promise<Rect>;
  lastCursor(tabId: number): Promise<{ p: Pt; ageMs: number } | null>;
  userActiveWithin(tabId: number, ms: number): Promise<boolean>;
  promotionTarget(tabId: number, piece: 'q'|'r'|'b'|'n', timeoutMs: number): Promise<Rect | null>;
  /** Resolves true when the board/movelist shows `expected` (or the premove highlight). */
  observeMove(tabId: number, expected: ExecutionPlan['expected'], timeoutMs: number): Promise<boolean>;
  /** Tier 3/4 hooks (MAIN world). */
  untrustedMove?(tabId: number, from: Pt, to: Pt): Promise<void>;
  apiMove?(tabId: number, uci: string): Promise<boolean>;
}

export class CdpMoveExecutor implements MoveExecutor {
  constructor(private adapter: SiteAdapter, private session: DebuggerSession) {}

  async execute(plan: ExecutionPlan): Promise<ExecutionResult> {
    const t0 = performance.now();
    const cdp = await this.session.ensureAttached(plan.tabId);        // lazy attach; infobar appears here
    await this.session.ensureVisible(plan.tabId);                      // tabs.update({active:true}) if needed
    if (await this.adapter.userActiveWithin(plan.tabId, 150)) return fail('user-active');

    const start = plan.startPoint ?? (await this.adapter.lastCursor(plan.tabId))?.p
                ?? this.session.lastSyntheticPoint(plan.tabId) ?? plausibleStart(await this.adapter.boardRect(plan.tabId));
    const mouse = new CdpMouse(cdp, start);
    const m = plan.motor;
    await sleep(rand(...m.reactionMs));                                // "reaction"/decision latency

    let attempts = 0;
    for (const tier of plan.style === 'drag' ? [1, 2] : [2, 1] as const) {
      attempts++;
      try {
        if (tier === 1) await this.drag(mouse, plan); else await this.clickClick(mouse, plan);
        if (plan.promotion) await this.promote(mouse, plan);
        if (await this.adapter.observeMove(plan.tabId, plan.expected, plan.timeoutMs ?? 400))
          return this.done(plan, tier, attempts, mouse, t0);
      } catch (e) { if (String(e).includes('aborted')) return fail('aborted'); }
      // Recover: if a piece is still selected/dragging, click an empty own square or press Escape-equivalent
      await sleep(rand(120, 260));
    }
    // Tier 3 (chess.com only, opt-in) and Tier 4 (opt-in)
    if (this.adapter.untrustedMove && SITE_CAPS[plan.site].untrustedEvents && plan.motor && optIn('untrusted')) { /* … */ }
    if (this.adapter.apiMove && optIn('api') && await this.adapter.apiMove(plan.tabId, plan.expected.uci))
      return this.done(plan, 4, attempts + 1, mouse, t0);
    return fail('unverified');
  }

  private async drag(mouse: CdpMouse, plan: ExecutionPlan) {
    const m = plan.motor;
    const press = samplePointInRect(plan.from.rect, 0.18, 0.7);
    const drop  = samplePointInRect(plan.to.rect, 0.22, 0.8);
    await mouse.travel(generatePath(mouse.position, press, plan.from.rect, m));   // approach the piece
    await sleep(rand(20, 70));
    await mouse.press(press);
    await sleep(rand(...m.grabDelayMs));
    await mouse.travel(grabWobble(press, m));                                        // buttons=1 from here
    await mouse.travel(generatePath(mouse.position, drop, plan.to.rect, m));
    if (Math.random() < m.hesitationProb) await mouse.travel(grabWobble(mouse.position, m).map(p => ({ ...p, dtMs: rand(40, 90) })));
    await sleep(rand(...m.releaseSettleMs));
    if (!inRect(mouse.position, plan.to.rect)) await mouse.travel([{ x: drop.x, y: drop.y, dtMs: 12 }]);
    await mouse.release(mouse.position);
  }

  private async clickClick(mouse: CdpMouse, plan: ExecutionPlan) {
    const m = plan.motor;
    for (const sq of [plan.from, plan.to]) {
      const p = samplePointInRect(sq.rect, 0.18, 0.7);
      await mouse.travel(generatePath(mouse.position, p, sq.rect, m));
      await sleep(rand(15, 60));
      await mouse.press(p);
      await sleep(rand(...m.pressHoldMs));
      await mouse.release(mouse.position);
      await sleep(rand(90, 220));                                                    // inter-click gap
    }
  }

  private async promote(mouse: CdpMouse, plan: ExecutionPlan) {
    const rect = await this.adapter.promotionTarget(plan.tabId, plan.promotion!, 1500);
    if (!rect) return;                                                  // auto-queen pref handled it
    const p = samplePointInRect(rect, 0.2, 0.7);
    await sleep(rand(150, 400));                                        // humans look before choosing
    await mouse.travel(generatePath(mouse.position, p, rect, plan.motor));
    await sleep(rand(10, 40)); await mouse.press(p);
    await sleep(rand(...plan.motor.pressHoldMs)); await mouse.release(mouse.position);
  }
}
```

**`verifyMove` (content script side)**: `observeMove` installs a `MutationObserver` on the board (`cg-board` / `wc-chess-board`) and the move list, resolves `true` as soon as (a) a piece element occupies the destination square, or `.last-move`/`.highlight` covers orig+dest, or (b) for premoves the premove highlight appears; times out at `timeoutMs` (300–400 ms is enough since both boards update optimistically; the move list is a secondary confirmation with a 1.5 s budget). Also return `false` early if the board shows the piece back on the origin square with no selection, meaning the drop was rejected.

**Abort**: the content script forwards any real trusted `pointerdown/pointermove/pointerup` during execution (`e.isTrusted && !ourWindow`) — distinguish ours from the user's by timing: the executor tells the content script the expected next dispatch window; any pointer event outside a scheduled dispatch ±20 ms (or with `screenX/Y` inconsistent with our path) is treated as the user and triggers `AbortSignal`. If aborted mid-drag, immediately `mouseReleased` at the current position (drop back) so no stuck button state remains.

---

## 8. Default human motor profile and persona modulation

Defaults (per move, sampled with ±15–25 % lognormal noise so no two moves share parameters):

| Parameter | Default | Basis |
|---|---|---|
| `reactionMs` | 150–350 (blitz), 250–600 (rapid+) | simple visual RT ≈ 200–250 ms; this is "hand starts moving after decision", not think time (think time belongs to the timing model) |
| `fittsA`, `fittsB` | 0.08 s, 0.12 s/bit (blitz) · 0.15 s, 0.20 s/bit (classical) | lab mouse dragging ≈ 135 + 249·ID ms (MacKenzie/Sellen/Buxton 1991); practised gamers faster; throughput 3.7–4.9 bits/s for lab pointing |
| `peakSpeedCapPxPerS` | 3000–4000 | mid-flight peak of large moves is a few thousand px/s; mean speed 800–1500 px/s |
| `jitterPx` | σ 1.2 (AR(1) ρ 0.6) | hand tremor at 125 Hz sampling; BeCAPTCHA notes real trajectories are not smooth at pixel scale |
| `overshootProb` | 0.08 base, ×(D/250) up to 0.2 | ghost-cursor overshoots only beyond 500 px; Fitts literature: 1–2 corrective submovements common for ID > 3 |
| `microCorrectionProb` | 0.3 | Meyer et al. optimized initial impulse: secondary submovement when primary lands off-target |
| `hesitationProb` | 0.12 | pause with the piece held before dropping |
| `pressHoldMs` | 40–120 (click) | typical click dwell 60–100 ms |
| `grabDelayMs` | 30–90 | press → movement onset |
| `releaseSettleMs` | 20–80 | deceleration → button release |
| `sampleIntervalMs` | 8 | 125 Hz USB mouse; Chrome frame-coalesces |
| `styleMix` | bezier 0.7 / wind 0.3 | variety |

Persona modulation (driven by the existing timing model's Elo / time-control persona):

- **Time control**: bullet/blitz `travelSpeedScale 0.7–0.8`, reaction 120–260 ms, hold 35–80 ms, hesitation 0.05, overshoot slightly higher (fast = sloppier). Rapid 1.0. Classical 1.2–1.4 with hesitation 0.2 and longer release settle.
- **Elo**: higher-rated personas move more decisively (lower `fittsA`, lower jitter, fewer hesitations) but not faster in transit; lower-rated personas hover, hesitate and micro-correct more. Keep the mapping mild — Elo affects think time far more than motor time.
- **Move type**: premoves are fast (already planned): scale 0.7. Captures/recaptures in blitz: scale 0.8. Promotions add the 150–400 ms "look" before the picker click. Castling by dragging the king two squares is a short D → cheap.
- **Fatigue/consistency**: per-game random offsets (±10 %) applied to every parameter so the session has a stable "hand", plus per-move noise on top; a human is consistent-with-variance, not i.i.d.
- **Style choice per game**: some users are drag-only, some click-click-only, most mixed. Choose a per-game dominant style (70/30) rather than per-move coin flips.

---

## 9. Things the old executor got wrong (checklist for the plan)

1. No `mouseMoved` at all → no hover, no approach, `movementX` never seen, cursor teleports. Fix: full paths (§7.3).
2. Four events within microseconds → `event.timeStamp` deltas near zero. Fix: drift-corrected schedule with reaction, hold, and settle delays.
3. Always the square centre → identical `clientX/Y` for the same square across games. Fix: truncated-Gaussian sampling.
4. `buttons` not set on any move (none sent) → dragging was impossible. Fix: `buttons:1`, `button:'left'` during travel.
5. Promotion as a fifth instant click with no wait for the overlay. Fix: wait for the picker rect, pause, humanized click.
6. No verification / retry. Fix: `observeMove` with tiered fallback and double-move guard.
7. Attach per move (infobar spam) and no `onDetach` handling. Fix: attach per game, detach on idle, re-attach on `canceled_by_user`.

---

## Sources

- CDP Input domain: https://chromedevtools.github.io/devtools-protocol/tot/Input/
- Chromium `InputHandler` (timestamp conversion, scaling, ack): https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/input_handler.cc
- Puppeteer `CdpMouse`: https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer-core/src/cdp/Input.ts
- Playwright `Mouse`: https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/input.ts
- WindMouse original (SRL-5): https://github.com/SRL/SRL-5/blob/master/SRL/core/mouse.simba ; Ben Land's write-up: https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/
- ghost-cursor: https://github.com/Xetera/ghost-cursor (spoof.ts, math.ts)
- BeCAPTCHA-Mouse: https://arxiv.org/pdf/2005.00890 ; Castle "Bot or not": https://blog.castle.io/bot-or-not-can-you-spot-the-automated-mouse-movements/
- Fitts's law: https://www.yorku.ca/mack/hhci2018.html ; MacKenzie, Sellen & Buxton 1991 (pointing vs dragging): https://www.billbuxton.com/fitts91.html ; Wikipedia summary: https://en.wikipedia.org/wiki/Fitts%27s_law
- Minimum-jerk: Flash & Hogan 1985 via https://journals.physiology.org/doi/full/10.1152/jn.1998.80.2.696
- chessground: events.ts, drag.ts, board.ts, state.ts, util.ts, config.ts at https://github.com/lichess-org/chessground
- lila round: ui/round/src/ground.ts, ui/round/src/ctrl.ts, ui/lib/src/game/promotion.ts, ui/round/src/view/replay.ts at https://github.com/lichess-org/lila
- chess.com community scripts: https://github.com/0mlml/chesshook (pointer-event simulation, `board.game.move`, `didUseCheatMouse` note); chess.com blog on cheat tooling: https://www.chess.com/blog/Jordi641/undetectable-by-design-the-code-behind-the-cheaters
- chrome.debugger: https://developer.chrome.com/docs/extensions/reference/api/debugger ; Chrome 86 attach change: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/avq_G6bVmaE ; `--silent-debugger-extension-api` discussion: https://github.com/anthropics/claude-code/issues/69287 , https://issues.chromium.org/issues/40815062
- DeveloperToolsAvailability policy: https://chromeenterprise.google/policies/developer-tools-availability/
- Puppeteer background-tab issues: https://github.com/puppeteer/puppeteer/issues/3156 , https://github.com/puppeteer/puppeteer/issues/5201
- MV3 service-worker lifecycle/timers: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle


# Appendix H — Patterns reused from `tranquill-dev` (reference implementation)

The owner pointed at `~/Documents/tranquill-dev/apps/extension` as architecture inspiration. The following files were read in full and their patterns are adopted (renamed `tranquill` → `sliced`, `__tranquill::` → `sl::`). Copy semantics, not code verbatim, except where a task says "port".

## H.1 Typed message router (`src/service/message-router.ts`) — ported as `src/core/messaging/router.ts` (Task 4)

```ts
/**
 * Typed registry for `chrome.runtime.onMessage` handlers.
 *
 * Replaces the dual `handleMainMessage` + `handleAuthMessage` switch dispatch
 * that previously lived in `service-worker.ts`. Handlers register against a
 * specific message type and the router routes based on `message.type`.
 *
 * Each registered handler returns one of:
 *   - `Promise<TResponse>` — the router awaits, calls `sendResponse`, and
 *     returns `true` from the onMessage listener so Chrome keeps the response
 *     channel open.
 *   - `TResponse` value — the router calls `sendResponse` synchronously and
 *     the onMessage listener returns `false`.
 *   - `undefined` — the router does nothing; treated as "handler chose not to
 *     handle" (rare; mostly used for fire-and-forget broadcasts).
 *
 * Errors (sync throws and rejected Promises) are caught: `sendResponse` is
 * called with `{ success: false, error }` and the error is logged, so the
 * caller never hangs waiting for a response.
 */
import { log } from "@core/logger";
import type { ExtensionMessage, MessageResponseMap } from "../types/messages";

type MessageType = keyof MessageResponseMap;

type MessageOfType<T extends MessageType> = Extract<ExtensionMessage, { type: T }>;

export type MessageHandler<T extends MessageType> = (
	msg: MessageOfType<T>,
	sender: chrome.runtime.MessageSender
) => MessageResponseMap[T] | Promise<MessageResponseMap[T]> | undefined;

export interface MessageRouter {
	/** Register a handler for a specific message type. Last writer wins. */
	on<T extends MessageType>(type: T, handler: MessageHandler<T>): void;
	/** Wire the registered handlers to `chrome.runtime.onMessage`. Idempotent guard via flag. */
	install(): void;
	/**
	 * Drive the dispatcher manually. Exposed for tests; production code uses
	 * `install()` to wire it to `chrome.runtime.onMessage`.
	 */
	_dispatch(
		message: Record<string, unknown> | null,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void
	): boolean | undefined;
}

export function installMessageRouter(): MessageRouter {
	const handlers = new Map<string, MessageHandler<MessageType>>();
	let installed = false;

	function dispatch(
		message: Record<string, unknown> | null,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void
	): boolean | undefined {
		if (!message || typeof message !== "object") return false;

		// Legacy messages used `action` instead of `type`. Coerce so handlers
		// registered against the canonical type still match.
		const msgType = (message.type ?? message.action) as string | undefined;
		if (!msgType) return false;

		const handler = handlers.get(msgType);
		if (!handler) {
			log.debug("message-router: unhandled message type", { type: msgType });
			return undefined;
		}

		const normalized = (message.action && !message.type
			? { ...message, type: message.action }
			: message) as unknown as MessageOfType<MessageType>;

		log.debug("message-router: dispatching", {
			type: msgType,
			tabId: sender?.tab?.id ?? null,
		});

		let result: ReturnType<MessageHandler<MessageType>>;
		try {
			result = handler(normalized, sender);
		} catch (error) {
			log.warn("message-router: handler threw", { type: msgType, error });
			try {
				sendResponse({
					success: false,
					error: (error as Error)?.message || String(error),
				});
			} catch {
				// ignore — channel may be closed
			}
			return false;
		}

		if (result === undefined) {
			// Handler chose not to respond — broadcast / fire-and-forget path.
			return false;
		}

		if (typeof (result as Promise<unknown>)?.then === "function") {
			(result as Promise<unknown>)
				.then((value) => {
					try {
						sendResponse(value);
					} catch {
						// ignore — channel may be closed
					}
				})
				.catch((error: unknown) => {
					log.warn("message-router: async handler rejected", { type: msgType, error });
					try {
						sendResponse({
							success: false,
							error: (error as Error)?.message || String(error),
						});
					} catch {
						// ignore
					}
				});
			return true;
		}

		try {
			sendResponse(result);
		} catch {
			// ignore — channel may be closed
		}
		return false;
	}

	return {
		on<T extends MessageType>(type: T, handler: MessageHandler<T>): void {
			if (handlers.has(type as string)) {
				// Silent overwrites mask refactor regressions where the same
				// message type is mistakenly registered from two registration
				// functions. Warn loudly but don't throw — production startup
				// should never abort over a registry mistake.
				log.warn("[MessageRouter] handler for type already registered; overwriting", {
					type,
				});
			}
			handlers.set(type as string, handler as unknown as MessageHandler<MessageType>);
		},
		install(): void {
			if (installed) return;
			installed = true;
			chrome.runtime.onMessage.addListener(dispatch);
		},
		_dispatch: dispatch,
	};
}
```

## H.2 Port wiring in the SW (`src/service/ports.ts`) — pattern for `acceptPorts` (Task 4) and the log stream (Task 26)

```ts
/**
 * SW <-> page port wiring.
 *
 * Two ports are accepted:
 *  - frame-pump: pushes a tick every TIMINGS.framePumpIntervalMs ms so the
 *    visibility-shield can satisfy `requestAnimationFrame` callbacks even when
 *    the host page is detected as background. The SW's setInterval is NOT
 *    subject to background-tab throttling, unlike a page-side timer.
 *  - tranquill-log-stream: panel-side subscriber forwarded into log-bridge.
 *    setLogLevel / setDebug control messages are routed through the bridge's
 *    applyLevel.
 */

import { PORT_NAMES } from "@core/ports";
import { TIMINGS } from "@core/timings";
import type { LogBridge } from "./log-bridge";

export interface ServicePortsDeps {
	logBridge: LogBridge;
}

export function wireServicePorts(deps: ServicePortsDeps): void {
	const { logBridge } = deps;

	chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
		if (!port) return;

		if (port.name === PORT_NAMES.framePump) {
			const intervalId = setInterval(() => {
				try {
					port.postMessage(0);
				} catch {
					clearInterval(intervalId);
				}
			}, TIMINGS.framePumpIntervalMs);
			port.onDisconnect.addListener(() => {
				void chrome.runtime.lastError; // consume to suppress bfcache error
				clearInterval(intervalId);
			});
			return;
		}

		if (port.name !== PORT_NAMES.logStream) return;
		logBridge.addSubscriber(port);
		port.onDisconnect.addListener(() => {
			void chrome.runtime.lastError; // consume to suppress bfcache error
			logBridge.removeSubscriber(port);
		});
		port.onMessage.addListener((msg: Record<string, unknown>) => {
			if (!msg || typeof msg !== "object") return;

			if (msg.type === "setLogLevel") {
				const result = logBridge.applyLevel(msg.level as string);
				if (result?.changed) {
					logBridge.emit("info", [`log level set to "${result.next}" via popup`]);
				}
				return;
			}

			if (msg.type === "setDebug" && typeof msg.enabled === "boolean") {
				const desiredLevel = msg.enabled ? "debug" : "silent";
				const result = logBridge.applyLevel(desiredLevel);
				if (result?.changed) {
					logBridge.emit("info", [`log level set to "${result.next}" via popup toggle`]);
				}
			}
		});
	});
}
```

## H.3 Logger routed through the SW bridge (`src/core/logger.ts`) — ported as `src/core/logger.ts` (Task 3)

```ts
/**
 * Structured logging for cross-context transport.
 *
 * Logs are routed through the SW bridge (port + chrome.runtime.sendMessage)
 * rather than the host-page or panel console — that prevents accidental leaks
 * to inspected pages and lets the panel devtools subscribe via a single port.
 *
 * Serialization helpers (`toSerializable` / `fromSerializable`) live in
 * `@core/serialization` and are re-exported here for backwards compatibility
 * with existing call sites.
 */
import {
	fromSerializable,
	type SerializedKind,
	type SerializedValue,
	toSerializable,
} from "@core/serialization";

export type { SerializedKind, SerializedValue };
export { fromSerializable, toSerializable };

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS = new Set<string>(["debug", "info", "warn", "error"]);
const ACTION = "tranquillLog";
const PREFIX = "[tranquill]";

const globalScope: typeof globalThis = typeof globalThis !== "undefined" ? globalThis : self;

const isServiceWorker =
	typeof globalScope !== "undefined" &&
	typeof (globalScope as unknown as { importScripts?: unknown }).importScripts === "function" &&
	typeof (globalScope as unknown as { document?: unknown }).document === "undefined";

function detectSource(): string {
	try {
		if (isServiceWorker) return "service-worker";
		if (typeof globalScope.location?.href === "string") return globalScope.location.href;
		if (typeof document !== "undefined" && typeof document.location?.href === "string")
			return document.location.href;
	} catch {
		// noop
	}
	return "unknown";
}

// Intentionally a no-op. Extension logs must never leak to the
// host-page console or the extension-panel console. All log
// routing goes through the service-worker bridge.
const fallbackConsole = (): void => {};

function postToBackground(
	level: string,
	args: SerializedValue[],
	meta: Record<string, unknown>
): void {
	if (isServiceWorker) {
		const direct = (globalScope as unknown as Record<string, unknown>).__tranquillDirectLog as
			| ((level: string, args: unknown[], meta: Record<string, unknown>) => void)
			| undefined;
		if (typeof direct === "function") {
			try {
				direct(level, args.map(fromSerializable), meta);
				return;
			} catch (_err: unknown) {
				fallbackConsole();
			}
		}
		fallbackConsole();
		return;
	}

	if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== "function") {
		fallbackConsole();
		return;
	}

	try {
		chrome.runtime.sendMessage(
			{
				action: ACTION,
				level,
				args,
				meta,
			},
			() => void chrome.runtime?.lastError
		);
	} catch {
		// silently ignore — no console output
	}
}

function logImpl(level: string, values: unknown[]): void {
	const normalizedLevel = LEVELS.has(level) ? level : "log";
	const serializableArgs = values.map(toSerializable);
	const meta = { source: detectSource(), timestamp: Date.now() };
	postToBackground(normalizedLevel, serializableArgs, meta);
}

export class Logger {
	debug(...values: unknown[]): void {
		logImpl("debug", values);
	}

	info(...values: unknown[]): void {
		logImpl("info", values);
	}

	warn(...values: unknown[]): void {
		logImpl("warn", values);
	}

	error(...values: unknown[]): void {
		logImpl("error", values);
	}
}

export const log = new Logger();
export default log;

export { PREFIX };
```

## H.4 Constants registries (`storage-keys.ts`, `alarms.ts`, `ports.ts`, `timings.ts`, `constants.ts`) — the model for `src/core/constants/*` (Task 2)

```ts
/**
 * Canonical registry of every chrome.storage key the extension reads or writes.
 *
 * Adding a new key? Add it here, not as a string literal in a feature module.
 * The `__tranquill::` prefix denotes extension-owned namespacing; legacy keys
 * (`savedText`, `typingSettings`, `typingProgress`, `typingProgressSignature`)
 * predate the convention and remain unprefixed for backwards compatibility
 * with installed extensions whose users have queued text in storage.
 */
export const LOCAL_KEYS = {
	apiToken: "__tranquill::api-token",
	analyticsSession: "__tranquill::analytics-session",
	eventQueue: "__tranquill::event-queue",
	authExpiredReason: "__tranquill::auth-expired-reason",
	updateAvailable: "__tranquill::update-available",
	pendingPortalLogin: "__tranquill::pending-portal-login",
	pendingPortalLogout: "__tranquill::pending-portal-logout",
	migrationToken: "__tranquill::migration-token",
	geoCache: "__tranquill::geo-cache",
	versionAnchor: "__tranquill::version-anchor",
	manifestTamper: "__tranquill::manifest-tamper",
	savedText: "savedText",
	typingSettings: "typingSettings",
	typingProgress: "typingProgress",
	typingProgressSignature: "typingProgressSignature",
} as const;

/** Cleared on service-worker restart — only ephemeral coordination flags. */
export const SESSION_KEYS = {
	authTab: "__tranquill::auth-tab",
	authHandled: "__tranquill::auth-handled",
} as const;

export type LocalKey = (typeof LOCAL_KEYS)[keyof typeof LOCAL_KEYS];
export type SessionKey = (typeof SESSION_KEYS)[keyof typeof SESSION_KEYS];
/**
 * Names + cadences for chrome.alarms entries.
 *
 * Alarm cadences are in MINUTES per the Chrome API; constants are stored
 * in MINUTES here and converted at the call site if MS are needed.
 */
export const ALARM_NAMES = {
	eventFlush: "tranquill-event-flush-alarm",
	heartbeat: "tranquill-heartbeat-alarm",
	/**
	 * Re-fires every 30s while keep-awake is supposed to be active. Any
	 * alarm event re-spawns the SW (if evicted), so this is what keeps the
	 * power assertion held across MV3's idle-eviction. See KEEP_AWAKE_GUIDE.md
	 * §3 ("the keepalive pattern").
	 */
	keepAwakeKeepalive: "tranquill-keepawake-alarm",
} as const;

export const ALARM_CADENCE_MINUTES = {
	eventFlush: 0.5,
	heartbeat: 2,
	keepAwakeKeepalive: 0.5,
} as const;

export type AlarmName = (typeof ALARM_NAMES)[keyof typeof ALARM_NAMES];
/**
 * chrome.runtime.connect port names for SW <-> page channels.
 *
 * - framePump: 16 ms ticks the SW pushes to phantom.ts so the visibility
 *   shield can satisfy `requestAnimationFrame` callbacks even when the page
 *   is detected as background by the browser.
 * - logStream: panel-side log subscriber receiving SW logs.
 */
export const PORT_NAMES = {
	framePump: "frame-pump",
	logStream: "tranquill-log-stream",
} as const;

export type PortName = (typeof PORT_NAMES)[keyof typeof PORT_NAMES];
/**
 * Cross-module timing constants. Intentionally separate from
 * panel/animation-manager (UI-level) and content/{phantom,visibility-shield}/tuning
 * (content-script-only) — these are values used by the SW + analytics stack.
 */
export const TIMINGS = {
	/** Idle threshold reported to chrome.idle.queryState (seconds, per API). */
	idleThresholdSec: 300,
	/** Frame-pump tick cadence (matches monitor refresh; ms). */
	framePumpIntervalMs: 16,
	/** Auth-flow timeout from tab open → callback received (ms). */
	authFlowTimeoutMs: 5 * 60 * 1000,
	/** Geolocation cache TTL (ms). */
	geoCacheTtlMs: 60 * 60 * 1000,
	/** Portal token freshness (rejected if older; ms). */
	portalTokenFreshnessMs: 30 * 1000,
} as const;
```

## H.5 Service-worker orchestration (`service-worker.ts`, `bootstrap.ts`, `lifecycle.ts`) — model for Task 9

```ts
/**
 * Service worker entry point (Webpack bundle root).
 *
 * Pure orchestration layer: installs the log bridge + ports, bootstraps
 * the singleton systems, registers every domain handler against the
 * MessageRouter, and delegates Chrome lifecycle wiring to lifecycle.ts.
 */

import { bootstrapServiceSystems } from "@service/bootstrap";
import { registerAnalyticsHandlers } from "@service/handlers/analytics";
import { registerAuthHandlers } from "@service/handlers/auth";
import { registerLogHandlers } from "@service/handlers/log";
import { registerPhantomHandlers } from "@service/handlers/phantom";
import { registerTextHandlers } from "@service/handlers/text";
import { registerTypingHandlers } from "@service/handlers/typing";
import { installKeepAwake } from "@service/keep-awake";
import { wireServiceLifecycle } from "@service/lifecycle";
import { installLogBridge } from "@service/log-bridge";
import { installMessageRouter } from "@service/message-router";
import { installPersistentAuthListener } from "@service/persistent-auth";
import { wireServicePorts } from "@service/ports";

const logBridge = installLogBridge();
const systems = bootstrapServiceSystems();

wireServicePorts({ logBridge });

if (systems.apiClient) {
	installPersistentAuthListener({ apiClient: systems.apiClient });
}

wireServiceLifecycle({ systems, logBridge });

const router = installMessageRouter();

registerAuthHandlers(router, systems);
registerAnalyticsHandlers(router, systems);
const { instances } = registerTypingHandlers(router, systems);
registerTextHandlers(router, instances);
registerPhantomHandlers(router, systems, instances);
registerLogHandlers(router, logBridge);

router.install();

// Keep-awake controller — owns its own SW lifecycle hooks (storage change,
// idle, alarm, runtime ping). Boot reconcile reads the user setting and
// asserts the wake lock if it's enabled (and not gated to typing-only).
installKeepAwake();

if (chrome?.sidePanel?.setPanelBehavior) {
	chrome.sidePanel
		.setPanelBehavior({ openPanelOnActionClick: true })
		.catch((err: unknown) => logBridge.emit("warn", ["sidePanel.setPanelBehavior failed", err]));
}
/**
 * Service-systems bootstrap.
 *
 * Constructs and wires the singleton stack the SW depends on:
 * ApiClient, EventQueue, SessionManager, AuthManager, StateMachine.
 * Cached at module level so repeat calls — from event listeners, alarm
 * handlers, message handlers — return the same instances. The cache is
 * hot from the first SW boot; nothing here is async.
 *
 * The verifier helper used by EventQueue / SessionManager to recover
 * from `device_not_verified` is wrapped in `dedupeAsync` so concurrent
 * callers share a single in-flight validate→sign→verify round trip.
 */

import { EventQueue } from "@core/analytics/event-queue";
import { SessionManager } from "@core/analytics/session-manager";
import { ApiClient } from "@core/auth/api-client";
import { AuthManager } from "@core/auth/auth-manager";
import { ensureDeviceKeyPair, signChallenge } from "@core/auth/device-key";
import { setReason } from "@core/auth/expired-reason";
import { log } from "@core/logger";
import { StateMachine } from "@core/state/state-machine";
import { TransitionEvents } from "@core/state/transitions";
import { dedupeAsync } from "@core/util/dedupe-async";

export interface ServiceSystems {
	apiClient: ApiClient | null;
	authManager: AuthManager | null;
	eventQueue: EventQueue | null;
	session: SessionManager | null;
	stateMachine: StateMachine;
}

let cached: ServiceSystems | null = null;

function createApiClient(): ApiClient {
	return new ApiClient({ chrome });
}

function createDeviceVerifier(apiClient: ApiClient): () => Promise<boolean> {
	return dedupeAsync(async () => {
		const valResp = await apiClient.validateToken();
		const nonce = (valResp.data as Record<string, unknown> | undefined)?.nonce as string | undefined;
		if (!nonce) return false;
		const sig = await signChallenge(nonce);
		const vResp = await apiClient.verifyDevice(nonce, sig);
		return vResp.ok === true;
	});
}

function createEventQueue(
	apiClient: ApiClient,
	deviceVerifier: () => Promise<boolean>
): EventQueue {
	return new EventQueue({
		chrome,
		apiClient,
		deviceVerifier,
	});
}

function createSessionManager(
	apiClient: ApiClient,
	eventQueue: EventQueue,
	deviceVerifier: () => Promise<boolean>
): SessionManager {
	return new SessionManager({
		chrome,
		apiClient,
		eventQueue,
		deviceVerifier,
	});
}

function createAuthManager(apiClient: ApiClient): AuthManager {
	return new AuthManager({
		chrome,
		apiClient,
		deviceKeyResolver: () => ensureDeviceKeyPair(),
	});
}

function createStateMachine(): StateMachine {
	return new StateMachine();
}

function wireCallbacks(systems: ServiceSystems): void {
	const { apiClient, eventQueue, session, stateMachine } = systems;
	if (!apiClient) return;

	// onAuthExpired: stop heartbeat + auto-flush, persist reason for the panel router.
	apiClient.setOnAuthExpired((reason: string) => {
		log.warn("auth expired", { reason });

		stateMachine.send(TransitionEvents.AUTH_EXPIRED, {
			reason: reason || "token_expired",
		});

		if (session) {
			session.stopHeartbeat();
			session.save(session.getEmptySession());
		}
		if (eventQueue) {
			eventQueue.stopAutoFlush();
		}
		void setReason(reason || "token_expired").catch(() => {});
	});

	// onSubscriptionExpired (heartbeat-discovered subscription denial).
	if (session?.setOnSubscriptionExpired) {
		session.setOnSubscriptionExpired((reason: string) => {
			const effectiveReason = reason || "subscription_expired";
			log.warn("subscription issue detected via heartbeat", { reason: effectiveReason });
			if (eventQueue) {
				eventQueue.stopAutoFlush();
			}
			void setReason(effectiveReason).catch(() => {});
		});
	}

	// Wire session manager into event queue for session_id injection.
	// The two-phase wiring is unavoidable here: EventQueue must be constructed
	// BEFORE SessionManager (SessionManager depends on it), and SessionManager
	// needs an EventQueue reference for event injection.
	if (eventQueue && session) {
		eventQueue.setSessionManager(session);
	}
}

/**
 * Test-only escape hatch: clear the singleton cache so the next
 * `bootstrapServiceSystems()` call constructs a fresh set of systems
 * against whatever `globalThis.chrome` is current at call time.
 *
 * Never call this in production code.
 */
export function __resetServiceSystemsCache(): void {
	cached = null;
}

export function bootstrapServiceSystems(): ServiceSystems {
	if (cached) return cached;

	const stateMachine = createStateMachine();
	const apiClient = createApiClient();
	const deviceVerifier = createDeviceVerifier(apiClient);
	const eventQueue = createEventQueue(apiClient, deviceVerifier);
	const session = createSessionManager(apiClient, eventQueue, deviceVerifier);
	const authManager = createAuthManager(apiClient);

	const systems: ServiceSystems = {
		apiClient,
		authManager,
		eventQueue,
		session,
		stateMachine,
	};

	wireCallbacks(systems);

	// Start event queue auto-flush
	eventQueue.startAutoFlush();

	log.debug("service systems bootstrapped");

	cached = systems;
	return systems;
}
```

## H.6 Panel SPA router and view contract (`src/panel/router.ts`, `view.ts`, `actions.ts`) — model for Task 22

```ts
/**
 * SPA shell view contract.
 *
 * Each view is a module that exposes a `View` object with a `mount`
 * function. The router calls `mount` with a ViewContext; mount returns
 * a cleanup function that tears down event listeners and pending work
 * before the next view mounts.
 */

export type ViewName = "login" | "main" | "expired" | "settings" | "update";

export type Transition = "fade" | "scale";

export interface Router {
	/** Mount the named view, optionally with an entry-transition. */
	switch(name: ViewName, options?: { transition?: Transition }): Promise<void>;
	/** Re-evaluate auth state and pick the correct initial view. */
	resolve(): Promise<void>;
	/** Currently-mounted view name (or null before first resolve). */
	readonly current: ViewName | null;
}

export interface ViewContext {
	router: Router;
	container: HTMLElement;
	/** Aborted when the view is unmounted. Views should honor this for async work. */
	signal: AbortSignal;
}

export type Cleanup = () => void;

export interface View {
	mount(ctx: ViewContext): Cleanup | Promise<Cleanup>;
}
/**
 * SPA router for the side panel.
 *
 * Owns view lifecycle: resolves the correct initial view based on auth
 * state and persisted error reasons, switches views in-place without
 * reloading the page, and re-routes live when external state changes
 * (logout, auth expiry, new version available).
 */

import { isLoginReason } from "@core/auth/auth-routing";
import { getReason as getStoredExpiredReason } from "@core/auth/expired-reason";
import { log } from "@core/logger";
import { chromeLocalGet } from "@core/storage/chrome-storage";
import { LOCAL_KEYS } from "@core/storage-keys";
import { type BaseResponse, sendTypedMessage } from "../types/messages";
import { animateEntryElements, animateExitElements } from "./animations";
import type { Cleanup, Router, Transition, View, ViewContext, ViewName } from "./view";

const AUTH_EXPIRED_REASON_KEY = LOCAL_KEYS.authExpiredReason;
const API_TOKEN_KEY = LOCAL_KEYS.apiToken;
const UPDATE_AVAILABLE_KEY = LOCAL_KEYS.updateAvailable;

/**
 * Global flag the login view sets while it owns the unlock flow (auth tab
 * opened from the panel's Log in button). The SW writes the api-token to
 * storage as soon as auth completes, which would normally trigger the
 * router's storage listener to switch to main — racing the login view's
 * success animation. While this flag is set, the router defers to the
 * login view to drive the transition.
 *
 * Cleared by the login view in its `flashSuccessThenSwitch` finalizer.
 */
declare global {
	// eslint-disable-next-line no-var
	var __tranquill_login_handling_unlock: boolean | undefined;
}

interface ResolveState {
	unlocked: boolean;
	reason: string | null;
}

async function readAuthState(): Promise<ResolveState> {
	try {
		const resp = await sendTypedMessage({ type: "tranquillEnsureAuth", cachedOnly: true });
		const base = resp as unknown as BaseResponse & { unlocked?: boolean; reason?: string | null };
		if (base?.success === false) {
			return { unlocked: false, reason: null };
		}
		return {
			unlocked: Boolean(base?.unlocked),
			reason: (base?.reason as string | null) ?? null,
		};
	} catch (error) {
		log.warn("router.readAuthState: ensureAuth failed", error);
		return { unlocked: false, reason: null };
	}
}

async function readStoredExpiredReason(): Promise<string | null> {
	try {
		return await getStoredExpiredReason();
	} catch {
		return null;
	}
}

async function readUpdateAvailable(): Promise<boolean> {
	try {
		return Boolean(await chromeLocalGet(LOCAL_KEYS.updateAvailable));
	} catch {
		return false;
	}
}

function pickViewForState(state: ResolveState, storedReason: string | null): ViewName {
	if (state.unlocked) return "main";

	const effectiveReason = state.reason || storedReason;
	if (effectiveReason && !isLoginReason(effectiveReason)) {
		return "expired";
	}

	return "login";
}

interface MountedView {
	name: ViewName;
	cleanup: Cleanup;
	controller: AbortController;
}

export class PanelRouter implements Router {
	private readonly container: HTMLElement;
	private readonly views: Partial<Record<ViewName, View>>;
	private mounted: MountedView | null = null;
	private storageListener:
		| ((changes: { [key: string]: chrome.storage.StorageChange }, area: string) => void)
		| null = null;

	constructor(container: HTMLElement, views: Partial<Record<ViewName, View>>) {
		this.container = container;
		this.views = views;
	}

	get current(): ViewName | null {
		return this.mounted?.name ?? null;
	}

	async resolve(): Promise<void> {
		const [updateAvailable, state, storedReason] = await Promise.all([
			readUpdateAvailable(),
			readAuthState(),
			readStoredExpiredReason(),
		]);

		if (updateAvailable) {
			log.debug("router.resolve: update available, switching to update view");
			await this.switch("update");
			return;
		}

		const target = pickViewForState(state, storedReason);
		log.debug("router.resolve", { state, storedReason, target });
		await this.switch(target);
	}

	async switch(name: ViewName, options: { transition?: Transition } = {}): Promise<void> {
		if (this.mounted?.name === name) {
			log.debug("router.switch: already mounted", { name });
			return;
		}

		const view = this.views[name];
		if (!view) {
			log.warn("router.switch: unknown view", { name });
			return;
		}

		// Transition policy:
		//   - When the caller passes `options.transition`, use it for BOTH
		//     the exit (of the leaving view) and the entry (of the arriving
		//     view). This makes intra-app navigation (gear icon → settings,
		//     back button → main) read as one coherent motion.
		//   - When omitted, the entry uses the arriving view's declared
		//     `data-animate-on-load` (so a fresh main mount still gets its
		//     scale-in moment after login), but the exit defaults to `fade`
		//     so leaving never reads as the more-dramatic scale-out.
		const exitTransition: Transition = options.transition ?? "fade";

		// Exit phase: let the leaving view animate out before we tear
		// down its DOM. Skipped on the very first mount (no prior view).
		if (this.mounted) {
			try {
				await animateExitElements(this.container, exitTransition);
			} catch (error) {
				log.warn("router.switch: exit animation threw", error);
			}
			try {
				this.mounted.cleanup();
			} catch (error) {
				log.warn("router.switch: previous cleanup threw", error);
			}
			this.mounted.controller.abort();
			this.mounted = null;
		}

		this.container.replaceChildren();

		const controller = new AbortController();
		const ctx: ViewContext = {
			router: this,
			container: this.container,
			signal: controller.signal,
		};

		let cleanup: Cleanup;
		try {
			cleanup = await view.mount(ctx);
		} catch (error) {
			log.error("router.switch: mount failed", { name, error });
			controller.abort();
			return;
		}

		this.mounted = { name, cleanup, controller };
		animateEntryElements(this.container, options.transition);
		log.info("router.switch: mounted", { name });
	}

	/**
	 * Listen for external auth-state changes so the panel can re-route
	 * live (e.g., dashboard logout, auth expired via heartbeat). Called
	 * once by the shell after initial resolve.
	 */
	installStateListeners(): void {
		if (this.storageListener) return;

		this.storageListener = (changes, area) => {
			if (area !== "local") return;

			if (Object.hasOwn(changes, AUTH_EXPIRED_REASON_KEY)) {
				const change = changes[AUTH_EXPIRED_REASON_KEY];
				const reason = (change.newValue as string | null | undefined) ?? null;
				if (reason && !isLoginReason(reason) && this.mounted?.name !== "expired") {
					log.info("router: auth-expired reason changed, switching to expired", { reason });
					this.switch("expired").catch((error) => log.warn("router: switch to expired failed", error));
				} else if (!reason && this.mounted?.name === "expired") {
					log.info("router: auth-expired reason cleared, re-resolving");
					this.resolve().catch((error) => log.warn("router: resolve after clear failed", error));
				}
			}

			if (Object.hasOwn(changes, API_TOKEN_KEY)) {
				const change = changes[API_TOKEN_KEY];
				const hasToken = Boolean(change.newValue);
				// Token lifecycle: set (portal login) or cleared (dashboard logout,
				// token expiry callback). Either edge means the view tree is stale.
				if (hasToken && this.mounted?.name !== "main") {
					if (globalThis.__tranquill_login_handling_unlock) {
						log.debug("router: api-token set, but login view owns the unlock — deferring");
					} else {
						log.info("router: api-token set externally, re-resolving");
						this.resolve().catch((error) => log.warn("router: resolve after token set failed", error));
					}
				} else if (!hasToken && this.mounted?.name === "main") {
					log.info("router: api-token cleared externally, re-resolving");
					this.resolve().catch((error) => log.warn("router: resolve after token clear failed", error));
				}
			}

			if (Object.hasOwn(changes, UPDATE_AVAILABLE_KEY)) {
				const change = changes[UPDATE_AVAILABLE_KEY];
				const nextValue = Boolean(change.newValue);
				if (nextValue && this.mounted?.name !== "update") {
					log.info("router: update-available flag set, switching to update");
					this.switch("update").catch((error) => log.warn("router: switch to update failed", error));
				} else if (!nextValue && this.mounted?.name === "update") {
					log.info("router: update-available flag cleared, re-resolving");
					this.resolve().catch((error) => log.warn("router: resolve after update clear failed", error));
				}
			}
		};
		chrome.storage.onChanged.addListener(this.storageListener);
	}
}
/**
 * Declarative click-action handlers installed on the panel root.
 *
 * Used by view templates to wire common actions without per-view
 * JavaScript. Attributes:
 *
 *   data-action="open-tab"    data-url="WEBSITE_URL"   → opens a browser tab
 *   data-action="view-switch" data-view="settings"     → switches panel view
 *                                                        (optional: data-transition="fade")
 *   data-track="event.name"                             → fires analytics event on click
 *
 * Event delegation: one listener on the panel root covers all views.
 */

import { AUTH_LOGIN_URL, DASHBOARD_URL, WEBSITE_URL } from "@core/constants";
import { log } from "@core/logger";
import { sendTypedMessage } from "../types/messages";
import type { Router, Transition, ViewName } from "./view";

const URL_MAP: Record<string, string> = {
	WEBSITE_URL,
	DASHBOARD_URL,
	AUTH_LOGIN_URL,
};

const VALID_VIEWS: ReadonlySet<ViewName> = new Set([
	"login",
	"main",
	"expired",
	"settings",
	"update",
]);

const VALID_TRANSITIONS: ReadonlySet<Transition> = new Set(["fade", "scale"]);

function resolveUrl(raw: string): string {
	return URL_MAP[raw] ?? raw;
}

function openTab(rawUrl: string): void {
	const url = resolveUrl(rawUrl);
	try {
		chrome.tabs.create({ url });
	} catch {
		window.open(url, "_blank");
	}
}

function fireAnalytics(eventType: string): void {
	sendTypedMessage({
		type: "tranquillTrackActivity",
		eventType,
		metadata: {},
	}).catch(() => {});
}

function findActionAncestor(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	return target.closest<HTMLElement>("[data-action]");
}

export function installActionHandlers(root: HTMLElement, router: Router): () => void {
	const onClick = (event: MouseEvent): void => {
		const el = findActionAncestor(event.target);
		if (!el) return;

		const action = el.dataset.action;
		if (!action) return;

		event.preventDefault();

		const trackEvent = el.dataset.track;
		if (trackEvent) fireAnalytics(trackEvent);

		switch (action) {
			case "open-tab": {
				const rawUrl = el.dataset.url;
				if (rawUrl) openTab(rawUrl);
				break;
			}
			case "view-switch": {
				const view = el.dataset.view as ViewName | undefined;
				if (!view || !VALID_VIEWS.has(view)) {
					log.warn("view-switch action missing or invalid data-view", { view });
					break;
				}
				const rawTransition = el.dataset.transition as Transition | undefined;
				const transition =
					rawTransition && VALID_TRANSITIONS.has(rawTransition) ? rawTransition : undefined;
				router.switch(view, { transition }).catch((error) => {
					log.warn("view-switch failed", error);
				});
				break;
			}
			default:
				log.warn("unknown data-action", { action });
		}
	};

	root.addEventListener("click", onClick);

	return () => {
		root.removeEventListener("click", onClick);
	};
}
```

## H.7 Debugger + CDP wrappers (`core/storage/chrome-async.ts`, `core/input/debugger-manager.ts`) — model for `src/core/chrome/debugger.ts` and `DebuggerManager` (Tasks 3, 18)

```ts
/**
 * Promise wrappers for callback-based chrome.* APIs the typing engine touches
 * on the hot path (debugger commands fire dozens of times per second).
 *
 * Per-call debug logging was removed in 2026-04 to keep flush noise bounded;
 * unrecoverable errors still log at warn so they surface in panel devtools.
 *
 * `tabsSendMessage` deliberately resolves with `{ success: false, error }`
 * instead of rejecting — the hot path treats absent content scripts as
 * non-fatal (the script may not be ready or the tab may have just closed).
 */
import { log } from "@core/logger";

export interface TabsSendMessageResult {
	success: boolean;
	response?: unknown;
	error?: string;
}

export function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
	return new Promise((resolve, reject) =>
		chrome.tabs.query(queryInfo, (tabs) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(tabs);
		})
	);
}

export function debuggerAttach(tabId: number, protocolVersion: string): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.debugger.attach({ tabId }, protocolVersion, () => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
}

export function debuggerDetach(tabId: number): Promise<void> {
	return new Promise((resolve, reject) =>
		chrome.debugger.detach({ tabId }, () => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve();
		})
	);
}

export function debuggerSend(
	tabId: number,
	method: string,
	params?: Record<string, unknown>
): Promise<unknown> {
	return new Promise((resolve, reject) =>
		chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			resolve(result);
		})
	);
}

/**
 * Send a message to a content script in `tabId`.
 *
 * Resolves (never rejects) with `{ success, response?, error? }` so the hot
 * path can treat "tab gone" / "content script not ready" as a soft failure.
 * Use the `success` discriminant; `error` carries the chrome.runtime.lastError
 * message (or the synchronous throw, if any).
 */
export function tabsSendMessage(
	tabId: number,
	message: unknown,
	options: chrome.tabs.MessageSendOptions | null = null
): Promise<TabsSendMessageResult> {
	const action =
		message && typeof message === "object"
			? ((message as Record<string, unknown>).action ?? null)
			: null;
	return new Promise((resolve) => {
		const handleResponse = (response: unknown): void => {
			const err = chrome.runtime.lastError;
			if (err) {
				log.warn("ChromeAsync.tabsSendMessage error", {
					tabId,
					action,
					error: err.message,
				});
				resolve({ success: false, error: err.message });
			} else {
				resolve({ success: true, response });
			}
		};

		try {
			if (options && typeof options === "object") {
				chrome.tabs.sendMessage(tabId, message, options, handleResponse);
			} else {
				chrome.tabs.sendMessage(tabId, message, handleResponse);
			}
		} catch (err: unknown) {
			const errMessage = err instanceof Error ? err.message : String(err);
			log.warn("ChromeAsync.tabsSendMessage threw", {
				tabId,
				action,
				error: errMessage,
			});
			resolve({ success: false, error: errMessage });
		}
	});
}
```

## H.8 Injection spoofing (`core/input/injection-spoofer.ts`) — `deriveToken` reused by pagescript `spoof.ts` (Task 6)

```ts
/**
 * Injection Spoofer — generates randomized DOM-facing identifiers so
 * websites cannot detect tranquill via static string matching.
 *
 * Two strategies:
 *  - `randomToken()` — runtime random (for CDP-injected scripts that run
 *    once and are parameterized at injection time).
 *  - `deriveToken()` — deterministic from a build-time seed + purpose
 *    string (for content scripts that must agree on the same token
 *    without direct communication).
 */

const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Runtime random CSS-safe token. Starts with a letter.
 * Uses `crypto.getRandomValues()` (available in service worker + page context).
 */
export function randomToken(length = 12): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = ALPHA[bytes[0] % ALPHA.length];
	for (let i = 1; i < length; i++) {
		out += ALPHANUM[bytes[i] % ALPHANUM.length];
	}
	return out;
}

/**
 * FNV-1a hash (32-bit) of a string → unsigned integer.
 */
function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Deterministic CSS-safe token from the build-time seed + a purpose label.
 * Both content scripts (visibility-shield + phantom) call this with the
 * same purpose string and get the same result within a build.
 */
export function deriveToken(purpose: string, length = 12): string {
	let state = fnv1a(__SPOOF_SEED__ + ":" + purpose);
	let out = ALPHA[state % ALPHA.length];
	for (let i = 1; i < length; i++) {
		// xorshift32
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		out += ALPHANUM[state % ALPHANUM.length];
	}
	return out;
}
```

## H.9 Offscreen keep-awake document (`pages/offscreen.html`, `service/keep-awake.ts`) — the offscreen-lifecycle and alarm keepalive pattern (Task 9)

```ts
/**
 * Keep-awake controller — holds a `chrome.power` display assertion while
 * the user setting allows it. See `apps/extension/KEEP_AWAKE_GUIDE.md` for
 * the OS-level mechanics.
 *
 * Three lifelines (per the guide §3):
 *   A. Re-assert on every SW restart event — `applyState()` reads settings
 *      and calls `chrome.power.requestKeepAwake('display')` again.
 *   B. A repeating alarm fires every 30 s, restoring the SW if it was evicted.
 *   C. An offscreen document holds `navigator.wakeLock('screen')` in parallel
 *      and pings the SW every 20 s (its `runtime.sendMessage` counts as an
 *      event, which extends the SW's lifetime).
 *
 * Settings are read via `getSettings()`. The "only during typing" sub-option
 * gates emission on `typingActive` — `lifecycle-hooks.ts` calls `refresh()`
 * around session start/stop.
 */

import { ALARM_CADENCE_MINUTES, ALARM_NAMES } from "@core/alarms";
import { log } from "@core/logger";
import { getSettings } from "@core/storage/settings-storage";

const OFFSCREEN_PATH = "/pages/offscreen.html";

let installed = false;
let typingActive = false;

/** Compute whether we should currently hold a wake assertion. */
async function shouldHold(): Promise<boolean> {
	let settings: Awaited<ReturnType<typeof getSettings>>;
	try {
		settings = await getSettings();
	} catch (e) {
		log.warn("keep-awake: could not read settings", e);
		return false;
	}
	if (!settings.keepAwakeEnabled) return false;
	if (settings.keepAwakeOnlyDuringTyping && !typingActive) return false;
	return true;
}

async function ensureKeepaliveAlarm(): Promise<void> {
	try {
		const existing = await chrome.alarms.get(ALARM_NAMES.keepAwakeKeepalive);
		if (existing) return;
		await chrome.alarms.create(ALARM_NAMES.keepAwakeKeepalive, {
			periodInMinutes: ALARM_CADENCE_MINUTES.keepAwakeKeepalive,
		});
	} catch (e) {
		log.warn("keep-awake: ensureKeepaliveAlarm failed", e);
	}
}

async function clearKeepaliveAlarm(): Promise<void> {
	try {
		await chrome.alarms.clear(ALARM_NAMES.keepAwakeKeepalive);
	} catch (e) {
		log.debug("keep-awake: clearKeepaliveAlarm failed", e);
	}
}

async function ensureOffscreenDoc(): Promise<void> {
	const offscreen = chrome.offscreen;
	if (!offscreen) return;
	try {
		// Chrome 116+ has hasDocument(); guard for older builds with try/catch
		// on createDocument's "already exists" path.
		if (typeof offscreen.hasDocument === "function") {
			const has = await offscreen.hasDocument();
			if (has) return;
		}
		await offscreen.createDocument({
			url: OFFSCREEN_PATH,
			reasons: [chrome.offscreen.Reason.BLOBS],
			justification:
				"Hold display wake-lock + extend service worker life while Keep Awake is enabled.",
		});
	} catch (e) {
		// Already-exists is fine. Anything else, log and move on.
		const msg = String((e as Error)?.message ?? e);
		if (!/Only a single offscreen document/.test(msg)) {
			log.warn("keep-awake: offscreen create failed", e);
		}
	}
}

async function closeOffscreenDoc(): Promise<void> {
	const offscreen = chrome.offscreen;
	if (!offscreen) return;
	try {
		if (typeof offscreen.hasDocument === "function") {
			const has = await offscreen.hasDocument();
			if (!has) return;
		}
		await offscreen.closeDocument();
	} catch (e) {
		log.debug("keep-awake: offscreen close failed", e);
	}
}

async function holdAssertion(): Promise<void> {
	try {
		await chrome.power?.requestKeepAwake?.("display");
	} catch (e) {
		log.warn("keep-awake: requestKeepAwake failed", e);
	}
	await ensureKeepaliveAlarm();
	await ensureOffscreenDoc();
}

async function releaseAssertion(): Promise<void> {
	try {
		await chrome.power?.releaseKeepAwake?.();
	} catch (e) {
		log.debug("keep-awake: releaseKeepAwake failed", e);
	}
	await clearKeepaliveAlarm();
	await closeOffscreenDoc();
}

/**
 * Single entrypoint that reconciles current state to the desired state.
 * Idempotent — safe to call from any event.
 */
export async function applyState(): Promise<void> {
	const want = await shouldHold();
	if (want) {
		await holdAssertion();
	} else {
		// Release explicitly. The OS auto-releases when SW dies, but if the
		// user toggled off while the SW is alive, we still need to drop it.
		await releaseAssertion();
	}
}

/**
 * Notify the controller that a typing session started or ended. Triggers
 * a state reconcile so the assertion follows the typing-active flag when
 * `keepAwakeOnlyDuringTyping` is set.
 */
export async function setTypingActive(active: boolean): Promise<void> {
	if (typingActive === active) return;
	typingActive = active;
	log.debug("keep-awake: typing active changed", { active });
	await applyState();
}

/**
 * Wire the SW lifecycle hooks. Call once from `service-worker.ts` boot.
 * Safe to call multiple times — listener registrations are guarded.
 */
export function installKeepAwake(): void {
	if (installed) return;
	installed = true;

	// Re-assert on settings changes.
	chrome.storage?.onChanged?.addListener?.((changes, area) => {
		if (area !== "local") return;
		if (!changes.typingSettings) return;
		void applyState();
	});

	// Re-assert on idle changes (SW may have been evicted; the listener
	// firing wakes it up). Per the guide, on ChromeOS we also call
	// `reportActivity` to defeat the lock screen.
	chrome.idle?.onStateChanged?.addListener?.((state) => {
		const power = chrome.power;
		if (
			state !== "active" &&
			power &&
			"reportActivity" in power &&
			typeof (power as { reportActivity?: () => Promise<void> }).reportActivity === "function"
		) {
			void (power as { reportActivity: () => Promise<void> }).reportActivity().catch(() => {});
		}
		void applyState();
	});

	// Keepalive alarm — also picks up after SW restart.
	chrome.alarms?.onAlarm?.addListener?.((alarm) => {
		if (alarm.name !== ALARM_NAMES.keepAwakeKeepalive) return;
		void applyState();
	});

	// Offscreen ping wakes the SW; we don't need to do anything beyond
	// receiving it (the act of receiving counts as an event).
	chrome.runtime?.onMessage?.addListener?.((message: unknown) => {
		if (
			message &&
			typeof message === "object" &&
			(message as { type?: unknown }).type === "tranquillKeepAwakePing"
		) {
			// no-op — receipt is the point
		}
		return false;
	});

	// Boot reconcile — read state and assert if needed.
	void applyState();
}
```

## H.10 Biome configuration (`biome.json`) — adopted with path changes (Task 1)

```json
{
	"$schema": "https://biomejs.dev/schemas/2.4.12/schema.json",
	"vcs": {
		"enabled": true,
		"clientKind": "git",
		"useIgnoreFile": true
	},
	"files": {
		"includes": [
			"apps/extension/src/**",
			"apps/extension/test/**",
			"apps/extension/scripts/**",
			"apps/extension/pages/**",
			"apps/extension/*.ts",
			"apps/extension/*.mjs",
			"apps/extension/*.json",
			"apps/web/js/**",
			"apps/web/dashboard/src/**",
			"apps/web/dashboard/*.ts",
			"apps/web/dashboard/*.json",
			"apps/web/marketing/src/**",
			"apps/web/marketing/*.ts",
			"apps/web/marketing/*.json",
			"packages/**",
			"scripts/**",
			"*.json",
			"*.ts",
			"*.mjs",
			"!**/node_modules",
			"!**/dist",
			"!apps/web/cdn",
			"!apps/web/assets",
			"!apps/web/database",
			"!apps/extension/scripts/vendor",
			"!apps/extension/assets/json",
			"!apps/extension/src/core/input/injected",
			"!apps/web/dashboard/dist",
			"!apps/web/marketing/dist",
			"!apps/web/dist",
			"!**/*.vue"
		]
	},
	"formatter": {
		"enabled": true,
		"formatWithErrors": false,
		"indentStyle": "tab",
		"indentWidth": 1,
		"lineWidth": 100,
		"lineEnding": "lf"
	},
	"javascript": {
		"formatter": {
			"quoteStyle": "double",
			"semicolons": "always",
			"trailingCommas": "es5",
			"arrowParentheses": "always"
		}
	},
	"json": {
		"formatter": {
			"indentStyle": "tab",
			"trailingCommas": "none"
		}
	},
	"linter": {
		"enabled": true,
		"rules": {
			"recommended": true,
			"correctness": {
				"noUnusedVariables": "warn",
				"noUnusedImports": "warn",
				"noUnusedFunctionParameters": "warn",
				"noInnerDeclarations": "warn",
				"noUnknownTypeSelector": "warn",
				"noVoidTypeReturn": "warn"
			},
			"style": {
				"useConst": "warn",
				"useTemplate": "off",
				"noNonNullAssertion": "off",
				"noParameterAssign": "warn"
			},
			"suspicious": {
				"noExplicitAny": "off",
				"noConsole": "off",
				"noAssignInExpressions": "warn",
				"useIterableCallbackReturn": "warn"
			},
			"complexity": {
				"noForEach": "off",
				"noUselessTypeConstraint": "warn",
				"noBannedTypes": "warn",
				"noStaticOnlyClass": "warn"
			}
		}
	},
	"overrides": [
		{
			"includes": ["apps/extension/test/**"],
			"linter": {
				"rules": {
					"correctness": {
						"noUnusedVariables": "off"
					},
					"style": {
						"noNonNullAssertion": "off"
					}
				}
			}
		},
		{
			"includes": ["apps/web/js/**"],
			"javascript": {
				"formatter": {
					"quoteStyle": "double"
				}
			}
		}
	]
}
```

## H.11 Test simulator layout (`test/sim/`) — ported in Task 8

```
test/sim/assumptions.md
test/sim/bridges/cdp-input.test.ts
test/sim/bridges/cdp-input.ts
test/sim/chrome/alarms.test.ts
test/sim/chrome/alarms.ts
test/sim/chrome/commands.ts
test/sim/chrome/debugger.ts
test/sim/chrome/misc.test.ts
test/sim/chrome/runtime.test.ts
test/sim/chrome/runtime.ts
test/sim/chrome/scripting.ts
test/sim/chrome/sidepanel.ts
test/sim/chrome/storage.test.ts
test/sim/chrome/storage.ts
test/sim/chrome/tabs.test.ts
test/sim/chrome/tabs.ts
test/sim/chrome/windows.ts
test/sim/contexts/bus.ts
test/sim/contexts/content-context.ts
test/sim/contexts/panel-context.test.ts
test/sim/contexts/panel-context.ts
test/sim/contexts/slices.test.ts
test/sim/contexts/slices.ts
test/sim/contexts/sw-context.test.ts
test/sim/contexts/sw-context.ts
test/sim/dom/tab-dom.test.ts
test/sim/dom/tab-dom.ts
test/sim/index.test.ts
test/sim/index.ts
test/sim/integration-smoke.test.ts
test/sim/time/time-controller.test.ts
test/sim/time/time-controller.ts
test/sim/types.ts
```

```ts
// test/setup.ts
/**
 * Bun test preload — installs the simulator's chrome global and the
 * compile-time define constants that vitest.config.ts used to inject.
 */

import { createSimulator } from "@test/sim";
import buildConfig from "../build.config.json" with { type: "json" };

const sim = createSimulator();

// Seed a default active tab so tests that rely on chrome.tabs.query returning
// a non-empty list (e.g. debugger-manager, chrome-async) continue to work as
// they did with the legacy mock's hardcoded tab.
sim.tabs.api.create({ url: "https://example.com", active: true });

(globalThis as Record<string, unknown>).chrome = sim.chrome;
(globalThis as Record<string, unknown>).__tranquill_test_simulator__ = sim;

if (typeof globalThis.navigator === "undefined") {
	(globalThis as Record<string, unknown>).navigator = {
		platform: "TestPlatform",
		language: "en-US",
		languages: ["en-US", "en"],
		hardwareConcurrency: 4,
		userAgent: "test-agent",
	};
}

(globalThis as Record<string, unknown>).__TRANQUILL_DOMAIN__ = buildConfig.domain;
(globalThis as Record<string, unknown>).__REMOTE_MANIFEST_URL__ = buildConfig.remoteManifestUrl;
(globalThis as Record<string, unknown>).__ASSETS_BASE_URL__ = buildConfig.assetsUrl;
(globalThis as Record<string, unknown>).__MANIFEST_DIGEST__ = "test-digest";
(globalThis as Record<string, unknown>).__SPOOF_SEED__ = "deadbeef01234567deadbeef01234567";
(globalThis as Record<string, unknown>).__BRAND_ELECTRIC__ = "rgba(67, 132, 255, 1)";
(globalThis as Record<string, unknown>).__PHANTOM_CONTENT_SCRIPT_PATH__ = "js/content/phantom.js";
```

## H.12 Code-organisation rules adopted verbatim from tranquill `CLAUDE.md`

- No inline HTML in `.ts` files; templates in `views/templates/*.html` imported as text.
- All animation timings live in one animation manager and mirror CSS custom properties (here: generated from `tokens.ts`, so they cannot drift).
- Panel views own their cleanup: every `mount` returns a function that removes listeners, timers, RAFs, observers.
- Every `chrome.storage` key lives in a registry; every alarm/port name likewise.
- Chrome API calls go through Promise wrappers that check `chrome.runtime.lastError`.
- Top-level, named event listeners in the SW (MV3 dedupes only stable references across boots).
- Offline tolerance: network errors never clear auth; only explicit server verdicts do.


# Appendix I — ChessTelemetry corpus (empirical basis for §13)

Reproduced from `~/Documents/ChessTelemetry/` (report dated September 2026; live JS inspection 2026-09-04). Included: the executive summary and the two client-telemetry documents in full, plus the chess.com detection overview. The remaining documents in the corpus (Proctor, Irwin/Kaladin architecture, Regan IPR, statistical limitations, transparency comparison, case studies) were read in full while writing §13 and are summarised there; they describe server-side statistics and governance rather than client mechanisms.

## I.SUMMARY

##### Chess Anti-Cheat Detection — Executive Summary

#### Lichess: Transparent, Open-Source

**Irwin & Kaladin ML Systems**
- Lichess uses two named, publicly-auditable ML models to flag suspicious play.
- **Irwin:** Siamese neural network trained on 10-feature move tensors. Compares a player's recent moves to Stockfish at varying depths across a dataset of 1M+ analyzed games. Flags consistency anomalies (move-variance, ELO-correlation deviation).
- **Kaladin:** CNN-based anomaly detector operating on 52-pipeline insights (hand-crafted features: eval gain per move, second-best-move penalty, time-pressure sensitivity, etc.). Orthogonal to Irwin — catches patterns Irwin might miss.
- Both systems are **open-source** in the Lichess `lila` repository (GitHub). Any researcher can read the code, understand thresholds, retrain on independent data, and publish critiques.
- **Decision tree:** 8 Boolean flags (move consistency, draw-offer patterns, sandbagging, etc.); weighted scoring with multipliers; manual moderator review for gray cases.
- **Transparency win:** A player banned by Lichess can demand to know exactly which flag triggered review. The architecture is auditable.

**Client-Side Telemetry**
- Blur events (focus/blur) captured per move via `window` listeners.
- Move hold times, lag, socket integrity checks.
- Extension fingerprinting (136 DOM selectors for chess-engine browser addons).
- All this data is logged but **does not trigger automated bans alone** — Lichess relies primarily on the ML models + move statistics.

---

#### Chess.com: Opaque, Proprietary Multi-Layer

**Strength Score & Fair Play**
- Chess.com's core metric is the **Strength Score** (0–150 scale), measuring how closely a player's moves match engine recommendations at various depths.
- Above that, Chess.com claims 100+ additional "factors" in a proprietary system, but names only a few publicly:
  - Engine-move correlation (similar to Regan's approach)
  - Draw-offer patterns
  - Sandbagging (intentional losing to lower rating)
  - Blitz/rapid inconsistency (different play styles at different time controls)
  - **Toggling between windows/tabs** (verified from live JS: explicit `DidToggle` field attached to each move)
  - **Move timing anomalies** (explicit fields: `MoveHoldTime`, `LastFocusToMoveTime`, `MoveToFirstBlurTime`)
- Autoban rate: **~85%** of flagged accounts (Q1 2025 data).
- Appeal grant rate: **~0.2%** (nearly all bans are upheld).

**Proctor (Mandatory for Prize Events)**
- Real-time monitoring client required for prize tournaments, Titled Tuesday (mandatory since Sept 2025), and other high-stakes events.
- Monitors: computer screen (screen-sharing), running processes, video camera, audio input/output.
- Requires two-camera setups and "computer inspection" before play.
- **Does NOT apply to casual/free-play games** — confusion about this is common.
- Effective, because it's synchronous and can pause a game if suspicious behavior is detected in real-time.

**Client-Side Telemetry & Extensions**
- Full blur/focus event tracking (same as Lichess, but Chess.com's JS explicitly implements it and labels it `FairPlay`).
- Move timing captured per move (hold time, first-to-move, blur-to-move intervals).
- Automated detection of chess-engine browser extensions: 22 known signatures (base64-encoded DOM selectors), including:
  - Stockfish.js (WASM-based, embedded in extensions)
  - Lichess board (by extension)
  - Chess.com-branded analysis tools (ironically)
  - All major third-party analysis extensions
- Cloudflare Turnstile CAPTCHA for bot-screening (standard, not chess-specific).
- **Kount fraud-fingerprinting system** tied to payments (device ID, IP, browser fingerprint), confirmed from live JS; not proven tied directly to cheat detection but present in the infrastructure.

**Server-Side Automation**
- Synthetic click/keystroke detection via `Event.isTrusted` filtering.
- Cross-tab engine detection (checking `localStorage` and `sessionStorage` for known engine-indicator patterns).
- Real-time metrics emission to gRPC `FairPlayService` on every move (protobuf descriptors present in shipped JS).

---

#### Ken Regan's Model: Academic Foundation, Statistical Limits

**Intrinsic Performance Rating (IPR)**
- Regan's core innovation: compare a player's moves to multiple chess engines (Stockfish, Komodo, Houdini, etc.) at *varying depths*.
- A "cheap" move (high engine eval but player played something worse) → deviation from the engine.
- Aggregate deviation across a game, convert to z-score: **z = 4.5** is FIDE's threshold (~1-in-300,000 occurrence under random play).
- Well-peer-reviewed (AAAI 2011, multiple follow-ups). The most rigorous methodology in the academic literature.

**What Regan Catches**
- Gross, sustained engine-match play (80%+ of moves matching top engine variation).
- Tournament-level classical games (more moves = more statistical power).
- Games where a player's preparation/style suddenly diverges from their training set.

**What Regan Misses**
- **One move per game.** If a player plays 99% of moves humanly and 1% engine-perfectly, Regan's z-score may not flag it (statistical power too low). This is acknowledged in Regan's own papers.
- **Blitz/bullet.** Fewer moves per game = less statistical power. A 3-minute blitz game has only ~10 moves; statistical deviation is hard to detect.
- **Rapid/classical only.** Blitz and bullet are harder to analyze (time-pressure effects confound engine-correlation).
- **Move non-independence.** Regan's model assumes each move's deviation is independent; actually, a single position opened up by one move affects the next move's deviation. This violates the z-score model's underlying assumption, inflating false-positive risk. Regan acknowledges this in his papers.
- **Multiple comparisons problem (look-elsewhere effect).** If you run Regan's test on 10,000 games at threshold z=4.5, you expect ~3 false positives just by chance, even with all players playing fairly. FIDE and Regan are aware of this but apply the threshold anyway; applied correctly, it requires additional context (prior suspicion, off-board evidence) to justify investigation.

**False-Positive Rate**
- FIDE's public statistics are thin, but case history (Kramnik, Niemann) suggests false positives are *real and consequential*.
- Regan's own statement: "I cannot definitively accuse anyone of cheating based on statistics alone; numbers provide context for further investigation."

---

#### Controversial Cases: Real-World Impact

**Niemann 2020 Online (100+ Games)**
- Chess.com alleged 100+ online games (2020) involved engine assistance.
- Independent analysis (50+ titles, including GMs, coaches): Niemann's play was statistically very strong but not impossible for a rapidly improving young prodigy.
- **In-person/classical:** 32 games (2020–2022). Regan's z-score analysis: no evidence of engine use (z-scores within normal range for a strong GM).
- Settlement (March 2024): Chess.com and Niemann reached undisclosed settlement; Chess.com's statement uses phrase "no determinative evidence" — implying the 100 online allegations did not meet their own autoban standard upon further review.

**Kramnik vs. Nakamura/Naroditsky (2024–2025)**
- Kramnik accused Nakamura and Naroditsky of cheating in 2024, sparking debate.
- FIDE Ethics Commission ruled (July 2025, Case 12-2025): Kramnik's accusations were false. Ken Regan analyzed games and found **no evidence of cheating by Nakamura or Naroditsky**.
- **Consequence:** Kramnik received a 2-year ban from FIDE events for making false accusations (malicious slander).
- Lesson: top-level accusations can fail despite appearing plausible to community observers.

**Petrosian (2020)**
- Lifetime ban from Chess.com.
- Prize forfeiture ($20k, PRO Chess League 2020).
- No public Regan analysis of this case; Chess.com's reasoning not fully disclosed.
- Remains one of the highest-profile lifetime bans.

**Community Response**
- Forums and social media discuss detection methods, but Chess.com actively forbids technical discussion of how their systems work (forum moderation observed).
- Lichess's open approach means its detection can be debated openly; Chess.com's opacity means allegations often rest on *inference* from behavior and community suspicion rather than technical knowledge.
- Unresolved: exactly how heavily Chess.com weights toggling vs. engine-correlation vs. move timing. The evidence suggests all three are in play, but their relative importance is unknown.

---

#### Mobile Platforms: Permissions & Trackers

**Android (2021–2022 builds, Exodus Privacy archive)**
- 20 trackers identified (Google Analytics, Google CrashLytics, AppsFlyer, Adjust, Kount, others).
- 20 permissions requested: location, contacts, camera, audio, and various device-level accesses.
- **Notably absent:** `QUERY_ALL_PACKAGES` (required to enumerate installed apps), `SYSTEM_ALERT_WINDOW` (overlay detection).
  - This suggests Chess.com mobile does NOT check for installed chess engines on Android (unlike the browser extension fingerprinting).
  - Inference: engine detection on mobile is trickier (isolated app sandbox, no shared storage visibility).
- Google Play Data Safety declared: device IDs, location, crash logs, app activity.

**iOS (App Store Privacy Label)**
- Narrower permission surface than Android (no location, contacts, or camera access declared by default).
- Apple's privacy model is more restrictive; Chess.com's iOS app collects less metadata than the Android build.

**Proctor on Mobile**
- Proctor's two-camera and screen-share requirements make sense only on desktop (monitor + laptop/phone for external angle).
- Mobile players in prize events likely must use a desktop setup with Proctor, or mobile play is disallowed for prize tournaments.
- Real-time monitoring is the differentiator here — Proctor pauses the clock if it detects cheating in progress.

---

#### Systems Comparison: Transparency vs. Opacity

| Dimension | Lichess | Chess.com |
|-----------|---------|-----------|
| **Open-Source Detection Code** | Yes (GitHub, auditable) | No (proprietary) |
| **Named ML Models** | Yes (Irwin, Kaladin) | No ("100+ factors," unnamed) |
| **Ban Reasoning Disclosure** | Yes (player can see which flags triggered review) | Partial (general policy, not per-account) |
| **Appeal Success Rate** | Not published | ~0.2% (2025 data) |
| **Client Telemetry Disclosed** | Yes, blur events and move timing logged | Implied by TIME reporting; confirmed via live JS inspection |
| **Extension Fingerprinting** | Yes, 136 DOM selectors (GitHub) | Yes, 22 signatures (reverse-engineered from live JS) |
| **Proctor / Real-Time Monitoring** | No equivalent | Yes, mandatory for prize events since Sept 2025 |
| **Statistical Model Basis** | ML-based (Irwin/Kaladin are empirical, not formula-driven) | Hybrid (Strength Score + client signals + undisclosed factors) |
| **Academic Peer Review** | Lichess papers presented at ML conferences; community can reproduce | No peer-reviewed publication of Chess.com's methodology |
| **User Privacy Control** | High (no account login required for casual play; data minimization) | Moderate (account required; Proctor is opt-in for events but mandatory for prize tournaments) |

**Why Transparency Matters:**
- Lichess's open code allows academic researchers to audit, critique, and propose improvements.
- Chess.com's opacity means disputes (Niemann, Kramnik) cannot be resolved via technical inspection — only via settlement or FIDE Ethics rulings, which are slow and political.
- Proctor (real-time, synchronous monitoring) is effective *precisely because* it's transparent: if the monitor detects cheating, the clock pauses immediately. No appeals needed; the cheating is prevented in real time.

---

#### Effectiveness & Tradeoffs

**Lichess Approach**
- **Strength:** Auditable, accurate (false-positive risk is lower because the community can inspect the model).
- **Weakness:** Relies on ML models, which have a baseline false-positive rate. However, because code is open, researchers can measure this rate independently.
- **Ban Appeal:** Moderators can review cases; transparency means appeals can reference exact code/thresholds.

**Chess.com Approach**
- **Strength:** Multiple independent signals (engine-correlation + blur/focus + move timing + extension fingerprinting) increase specificity. Proctor is nearly cheat-proof for prize events.
- **Weakness:** Opacity means the community cannot verify the model's false-positive rate. High autoban rate (85%) + very low appeal rate (0.2%) suggests either (a) the system is near-perfect, or (b) most appeals are frivolous, or (c) Chess.com is risk-averse and accepts some false positives to maximize real-cheat detection. We cannot know which without seeing the code.
- **Ban Appeal:** Users can appeal, but Chess.com's reasoning is opaque. Appeal decisions seem largely rubber-stamped.

**Regan Model**
- **Strength:** Peer-reviewed, math-grounded, widely accepted by FIDE and academic community.
- **Weakness:** Cannot catch 1 move/game; false-positive risk from multiple comparisons; assumes move independence (violated in practice).
- **Application:** FIDE uses z≥4.5 as a filter for *investigation*, not as proof. Regan himself is clear on this distinction.

---

#### Privacy & Data Collection

**Lichess**
- Minimal telemetry logged (blur events, move times) but not sold or shared beyond moderation team.
- No mandatory video/audio monitoring (optional in tournaments).
- No device fingerprinting beyond session ID.

**Chess.com**
- Blur/focus events, move timing, keystroke/click event-trust status all logged per move.
- Extension fingerprinting (browser environment inspection).
- Kount device fingerprinting (IP, device ID, browser metadata) for fraud/payment verification.
- **Proctor adds:** Full screen capture, process list, camera/audio streams, real-time submission to Chess.com servers.
- Proctor storage: "up to 30 days," per Chess.com's policy — data retained for review.

**Consent & Disclosure**
- Lichess: explicit about blur tracking, users aware it's monitored.
- Chess.com: Fair Play policy names "100+ factors" but doesn't detail blur/focus/timing; Proctor is explicitly opt-in (required for prize events, but not for casual play).
- Neither platform is as invasive as, e.g., anti-cheat systems in competitive gaming (Valorant's Vanguard kernel-mode driver, which inspects all running processes and drivers). But Proctor comes close for paid events.

---

#### Recommendations for Readers

**If you're interested in:** 
- **"How do I know I'm safe from false bans?"** → Read `cases/01-niemann-100-online.md` and `statistical-models/03-statistical-limitations.md`. Understand that any system has false positives; Lichess's transparency is your best protection.
- **"Should I use Proctor?"** → Read `chess-com/02-proctor-mandatory-proctoring.md`. It's real, intrusive, but effective. If you're playing in a prize tournament, you must use it; if you're playing casual, you don't.
- **"Is Lichess safer than Chess.com?"** → Neither is inherently "safer." Lichess is more transparent; Chess.com has Proctor. Depends on what risk you're minimizing.
- **"Can I evade detection?"** → Read `chess-com/03-client-side-telemetry.md` and `chess-com/04-toggling-and-automation.md`. Both platforms detect window-switching, synthetic clicks, and extension usage. Evading is technically hard and morally problematic. Don't do it.
- **"What if I'm wrongly banned?"** → Understand the appeal process (Lichess: technical appeal with moderator review; Chess.com: email appeal with ~0.2% grant rate). False positives happen but are rare if you play fairly.

---

**Report Date:** September 2026  
**Methodology:** Source code inspection, academic paper review, primary document retrieval, live-site verification, community discussion synthesis.  
**All findings sourced and traceable to primary evidence.**

## I.03-client-side-telemetry

##### Chess.com Client-Side Telemetry & Extension Detection

#### Overview

Chess.com captures extensive client-side behavioral telemetry on every move, similar to Lichess but with more sophisticated automation detection and extension fingerprinting. This data feeds into the Fair Play backend service via gRPC.

---

#### Telemetry Pipeline: The `fps` Plugin

**Source:** Direct JavaScript inspection (Chess.com live client, 2026-09-04)  
**Type:** (a) Officially confirmed via live code

Chess.com's client defines an internal plugin (internally named `fps`, likely "Fair Play Signals") that instruments every move with the following telemetry:

##### Data Attached to Each Move

```javascript
{
  BlurCount: number,                      // How many blur events during this move?
  DidBlurOnOpponentTurn: boolean,         // Window blurred while opponent thought?
  DidBlurOnOwnTurn: boolean,              // Window blurred while player thought?
  DidFocusOnOpponentTurn: boolean,        // Focus regained during opponent's turn?
  DidFocusOnOwnTurn: boolean,             // Focus regained during player's turn?
  DidSelectMultiplePieces: boolean,       // Clicked multiple pieces in sequence (sketchy)?
  DidToggle: boolean,                     // Blur → focus on same move? (KEY INDICATOR)
  EventTrusted: boolean,                  // Human click (isTrusted=true) vs. synthetic?
  LastFocusToMoveTime: number,            // Milliseconds from regaining focus to move
  MoveHoldTime: number,                   // Time from position arrival to move completion
  MoveToFirstBlurTime: number,            // Time from move to first blur event
  PointerOffset: number,                  // Distance moved by pointer between last pos & current?
  TotalBlurTime: number,                  // Total milliseconds blurred during move
  TotalFocusTime: number,                 // Total milliseconds focused during move
}
```

##### Attachment Point

This telemetry object (serialized under a field called `ac` in the internal move representation) is attached to every move **before dispatch** to the server. The move is sent as:

```javascript
{
  type: "move",
  from: "e2",
  to: "e4",
  ac: { BlurCount: 0, DidToggle: false, EventTrusted: true, ... }  // telemetry blob
}
```

##### Server Reception

The move is received by Chess.com's backend `FairPlayService` (proven by protobuf descriptor in shipped JS) via two gRPC methods:

- **`RecordMetric(FairPlayMetric)`** — Logs the move + telemetry for per-move analysis.
- **`RecordAM(AttackMetric)`** — Logs "attack" metrics (anomalies) for aggregate session analysis.

---

#### Event Integrity Checking: `isTrusted` Filtering

**Source:** Direct JavaScript inspection  
**Type:** (a) Officially confirmed via live code

##### What It Detects

Every mouse/keyboard event in the browser has a native `Event.isTrusted` property:

- **`true`:** Event originated from a human action (mouse click, keyboard press, etc.).
- **`false`:** Event originated from a script or synthetic injection (automation).

Chess.com filters events:

```javascript
if (!event.isTrusted) {
  emit("FairPlay.UntrustedUserEvent");  // Flag it
}
```

##### Why It Matters

Engine-cheating bots often work by:
1. Running Stockfish in a hidden process.
2. Exfiltrating the position to the bot controller.
3. Receiving back the recommended move.
4. **Injecting a synthetic click** onto the board at the correct square.

This synthetic click has `isTrusted=false`, which Chess.com detects and flags.

##### Limitations

- **Legitimate synthetic events:** Some browser addons and accessibility tools generate synthetic events (accessibility features for disabled users). This might cause false positives.
- **Workaround by cheaters:** A sophisticated cheater could use a *hardware* automation device (e.g., a robotic mouse arm) instead of software injection. However, this is impractical for most cheaters.
- **Trivial to detect by Lichess too:** Both platforms use the same `isTrusted` check.

---

#### Extension Fingerprinting

**Source:** Direct JavaScript inspection; Chess.com blog (2022)  
**Type:** (a) Officially confirmed via live code

##### What's Detected

Chess.com maintains a list of **22 known chess-engine browser extensions** (reverse-engineered from live JS). The client checks for these using:

1. **DOM selectors:** Looks for HTML elements with IDs/classes specific to known extensions.
   - Example: `document.getElementById('stockfish-analysis')` — if this element exists, Stockfish.js extension is present.

2. **Global variables:** Checks `window` object for variables injected by extensions.
   - Example: `window.CHESS_ENGINES` — indicator of a chess-engine wrapper.
   - Example: `window.Stockfish` — WASM Stockfish library instance.

3. **LocalStorage/SessionStorage inspection:** Checks browser storage for engine-related keys.
   - Example: looking for keys like `"engine_depth"`, `"stockfish_analysis"`, or variations thereof.

4. **Base64-encoded selector database:** The 22 signatures are obfuscated in the shipped JS to avoid easy detection by cheating-tool developers. Decoding reveals:
   - Lichess board extension (ironically)
   - Stockfish.js and variants
   - Chess.com's own analysis tools (which should be allowed, but might be detected as a safety measure)
   - Third-party analysis extensions (Chessify, Chess.com analysis, etc.)

##### Examples of Detected Extensions

(Decoded from live JS obfuscation):
- `#stockfish-analysis` → Stockfish analysis toolbar
- `[data-engine-active]` → Generic engine-active indicator
- `window.ChessEngine_*` → Various wrapped engines
- `navigator.hardwareConcurrency` query for WASM allocation → Hint of WASM Stockfish
- `localStorage['lichess-analysis']` → Lichess analysis data

##### False Positives

- A player might have a Stockfish extension installed but not use it during games.
- Chess.com flags extension *presence*, not active *use*.
- If a player uninstalls the extension, the signal disappears (no persistence).
- A flagged extension presence feeds into the moderation pipeline as one data point, not an automatic ban.

---

#### Move Timing Analysis

**Source:** Implicit in telemetry (MoveHoldTime, LastFocusToMoveTime)  
**Type:** (a) Officially confirmed via live code

##### What's Captured

1. **MoveHoldTime:** Milliseconds from board position arrival to move completion.
   - Expected human range: 100–5000 ms (depending on position complexity and time control).
   - Engine use often correlates with consistent, low move times (immediate decisions).

2. **LastFocusToMoveTime:** Milliseconds from window regaining focus (after blur) to move completion.
   - Indicator: A player who frequently blurs (to check analysis), then immediately returns and moves is suspicious.
   - Legitimate pattern: A player who checks notifications, returns, and quickly plays a pre-calculated move (less suspicious).

3. **MoveToFirstBlurTime:** Milliseconds from move completion to first blur event.
   - Indicator: A player who always blurs immediately after making a move might be returning to analysis tools.
   - But this is ambiguous (could be notifications, legitimate multitasking).

##### Statistical Model

Chess.com likely computes per-player distributions:
- Mean move time for blitz, rapid, classical.
- Standard deviation (consistency).
- Correlation with position complexity (harder positions should take longer).
- Anomalies: A 1600-player with move times averaging 0.1s in classical is suspicious.

---

#### Blur & Focus Events (Toggling)

**Source:** Direct JavaScript inspection; Chess.com's 2022 Niemann letter  
**Type:** (a) Officially confirmed via code + primary document

##### What's Tracked

Chess.com's client listens to `window` focus/blur events:

```javascript
window.addEventListener('blur', handler);
window.addEventListener('focus', handler);
```

##### The "Toggling" Signal

The key metric: **`DidToggle`** is set to `true` when:
1. The browser window is in **blur** (window loses focus, e.g., player clicks another tab).
2. Followed by **focus** (player returns to the Chess.com tab).
3. All within the **same move window** (from board position to move submission).

##### Interpretation

- **One toggle per move:** Suggests the player briefly consulted something external (engine, analysis board, etc.) before returning to make the move.
- **Multiple toggles per move:** More suspicious (fetching multiple pieces of analysis?).
- **No toggles:** Play with singular focus (could be human or a sophisticated cheater using a second device).

##### Original 2022 Context: The Niemann Letter

From Chess.com's September 2022 letter to Niemann (Exhibit B of the Niemann Report):

> "We are prepared to present strong statistical evidence that confirm each of those cases above, as well as clear **'toggling' vs 'non-toggling' evidence, where you perform much better while toggling to a different screen during your moves.**"

This statement directly correlates high performance with toggling behavior—exactly what the `DidToggle` field now captures in live code.

##### Caveats

- **Legitimate reasons to toggle:** Notifications, browser messages, alt-tab for other work (multitasking during casual play).
- **Not deterministic alone:** Toggling is a risk factor, not proof of cheating.
- **Combined signal:** Toggling + high Strength Score + consistent move times is more suspicious than toggling alone.

---

#### Page Visibility API (for Context)

**Source:** Direct JavaScript inspection  
**Type:** (a) Officially confirmed via live code

Chess.com's client **does listen** to the `visibilitychange` event:

```javascript
document.addEventListener('visibilitychange', handler);
```

**However:** This is used **only for pausing/resuming audio** (if background music or sound is playing, it pauses when the tab is hidden). It is **not used for cheat detection** per se.

**Distinction:** `visibilitychange` (page hidden/shown) is broader than `blur`/`focus` (window hidden/shown). Community claims that "Chess.com uses the Page Visibility API to detect tab-switching" are technically imprecise — it's the `blur`/`focus` events that matter for detection, not `visibilitychange`.

---

#### Lag & Socket Integrity

**Source:** Lichess documentation (similar pattern); implied in Chess.com architecture  
**Type:** (b) Documented by peer platforms; (c) Chess.com specifics inferred

##### What's Likely Monitored

1. **Websocket latency:** Time for a move to round-trip.
2. **Socket connection stability:** Dropped/reconnected websockets.
3. **Clock desynchronization:** Does the client's clock match the server's?

##### Use Case

- Lag spikes might indicate VPN/proxying (suspicious).
- Rapid reconnects might indicate a cheating tool restarting or switching protocols.
- Clock drift might indicate a bot injecting moves out-of-sync with real time.

##### Caveats

- **No public Chess.com statement** on lag monitoring for anti-cheat (this is inferred).
- Network variations are legitimate; lag alone doesn't trigger a ban.
- Likely used as a supporting signal in aggregate analysis.

---

#### Integration with Fair Play

All telemetry flows into Chess.com's `FairPlayService`:

1. **Per-move metrics:** Every move's telemetry (blur, timing, event trust, etc.) is logged.
2. **Aggregate anomaly detection:** Server-side ML analyzes patterns over a game or series of games.
3. **Scoring:** Moves are scored for suspicion; games/players are scored for aggregate suspicion.
4. **Threshold crossing:** If a player's aggregate suspicion score exceeds a threshold, they're flagged for autoban or manual review.

**Exact weighting:** Unknown (proprietary). But the available signals are: Strength Score (engine-correlation) + blur/toggling + move timing + event trust + extensions + lag/socket.

---

#### Comparison with Lichess

| Signal | Lichess | Chess.com |
|--------|---------|-----------|
| **Blur events** | Yes, documented | Yes, reverse-engineered (exact fields known) |
| **Move hold times** | Yes, documented | Yes, captured as MoveHoldTime + LastFocusToMoveTime |
| **Toggling** | Implicit (blur tracking) | Explicit (`DidToggle` field) |
| **Event trust** | Not mentioned | Yes, isTrusted filtering |
| **Extension fingerprinting** | Yes, 136 selectors | Yes, 22 signatures |
| **Page Visibility API** | Not for anti-cheat | Not for anti-cheat (audio pausing only) |
| **Lag/socket** | Implied | Likely yes, not confirmed |

**Key difference:** Chess.com explicitly computes and tracks `DidToggle`, making the "toggling detection" claim verifiable from code. Lichess's implementation is implicit in blur tracking but not named as explicitly.

---

#### Privacy Implications

- **All telemetry is logged server-side:** Every move's data is stored, at least temporarily.
- **Retention:** Chess.com's privacy policy doesn't specify how long telemetry is kept (likely >30 days for investigation, possibly indefinitely for aggregate analysis).
- **Use:** Telemetry is used for cheat detection and player investigations. Not stated to be used for marketing/analytics (but possible).
- **Transparency:** Chess.com doesn't disclose to users that these specific fields (BlurCount, DidToggle, etc.) are captured, though the Fair Play policy implies "behavioral signals" are logged.

---

#### Summary

Chess.com's client-side telemetry is:
- **Comprehensive:** Captures 13+ data points per move (blur, timing, event trust, pointer activity).
- **Automated:** No manual review needed for collection; all users contribute data.
- **Opaque:** Users are not told the specific fields collected, though it's implied.
- **Integrated:** Flows into gRPC backend for server-side aggregation and scoring.
- **Not deterministic:** Individual fields don't auto-ban; thresholds and weighting are proprietary.

The strongest finding: **`DidToggle` is explicitly computed and tracked**, directly validating Chess.com's 2022 claim about "toggling detection."

---

**Primary Sources:**
- Direct JavaScript inspection: https://www.chess.com/r2/client-packages/play-computer/2026.9.1/play-computer.js (2026-09-04)
- Chess.com Niemann Report, Exhibit B: https://archive.org/details/hans-niemann-report
- Chess.com Fair Play policy: https://www.chess.com/legal/fair-play
- TIME interview with Danny Rensch: https://time.com/6227677/magnus-carlsen-hans-niemann-kenneth-regan-chess-scandal/

## I.02-client-telemetry

##### Lichess Client-Side Telemetry

#### Overview

Beyond the ML detection systems (Irwin/Kaladin), Lichess captures client-side behavioral telemetry on every move. This data feeds into the moderation pipeline but does **not trigger automated bans alone** — it's part of the holistic picture moderators review.

---

#### Blur Events: Focus/Blur Tracking

**Source:** `ui/round/src/blur.ts` (lila repository)  
**Type:** (a) Officially confirmed via open-source code

##### What's Tracked

Lichess listens for `window` focus/blur events during gameplay:

```javascript
window.addEventListener('blur', handler);
window.addEventListener('focus', handler);
```

For each move, the client records:
- **Did the player's browser window blur during their turn?**
- **How many times?**
- **For how long?**
- **Did it blur again after they moved?**

##### Storage

This data is stored as a **bitfield** (compact binary representation) in the game object:

**Source:** `modules/game/src/main/Game.scala`  
**Type:** (a) Officially confirmed via open-source code

- Each game stores a `blurs` bitmap.
- Each bit represents one move: `1` = player blurred during that move, `0` = no blur.
- Compact representation: a 40-move game is stored in ~5 bytes, not 40+ bytes.

##### Why It Matters

- A player who **constantly tabs away** during games might be consulting an engine.
- A player who **never blurs** plays with singular focus (more human-like than engine use, which is immediate and doesn't require consulting external sources).
- **Pattern:** Engine users often tab away to check analysis, then return to the board to make the move.

##### What It Does NOT Capture

- Whether the player was checking an engine on the *same machine* (e.g., a second browser tab with Stockfish running in a WASM sandbox).
- Whether they were looking at the monitor but the browser wasn't in focus (e.g., phone call, second monitor).
- **Legitimate reasons to blur:** Browser notifications, system messages, multitasking during casual play.

##### How Lichess Uses It

1. Blur data feeds into the 8-flag decision tree.
2. A player with unusual blur patterns (e.g., blurs 30% of moves) might trigger a flag.
3. But blur alone is not convicting — many humans blur (notifications, multitasking).
4. Blur is **part of the mosaic** of telemetry; combined with move consistency or sudden rating improvements, it becomes more suspicious.

---

#### Move Hold Times

**Source:** Lichess client-side move timer (internal tracking)  
**Type:** (a) Officially confirmed; mentioned in Lichess blog and Kaladin feature documentation

##### What's Tracked

- **Time from position appearance to player's move completion:** How long did the player think before moving?
- **Variance over a series of games:** Is thinking time consistent or erratic?

##### Statistical Features Derived

Lichess computes, per player per time control:
- Mean move time
- Standard deviation (consistency)
- Extreme outliers (unusually long or short moves)

##### Why It Matters

- **Engines move instantly** (once the depth is reached). Humans take variable time depending on position complexity.
- A player with **zero variance in move time** (always moving in exactly 3 seconds) is suspicious.
- **Time pressure sensitivity:** Humans play worse under time pressure; engines don't. If a player's move quality *improves* as time decreases, that's a red flag.
- Kaladin's feature set includes explicit time-management fields (move-time standard deviation, time-pressure sensitivity).

##### Limitations

- Time variance can be legitimate:
  - **Premoves:** A player pre-moves on increment time controls (e.g., 3+0). Move appears instant because it was pre-planned.
  - **Lag:** Network latency means the move timestamp might be off.
  - **Muscle memory:** A player might make familiar moves (opens, endgame techniques) very quickly, without thinking.
- Conversely, some engine users deliberately add artificial delays to look human.

---

#### Lag & Socket Integrity Checks

**Source:** Lichess websocket infrastructure (internal, not fully open-source but described in blog posts)  
**Type:** (b) Documented by Lichess team; (c) some community reverse-engineering

##### What's Checked

1. **Ping / latency:** How long does a move take to round-trip to the server?
   - Legitimate variation: network conditions.
   - Anomaly: if a player's ping suddenly jumps from 50ms to 2000ms between games, might indicate routing issues, VPN, or proxying (less suspicious) or intentional delays to obscure cheating (more suspicious).

2. **Socket health:** Is the websocket connection stable?
   - Dropped connections might indicate:
     - Network instability (legitimate)
     - Rapidly switching between connections (suspicious for cheating)
     - Intentional disconnection to avoid move timeout (suspicious)

3. **Clock desynchronization:** Does the client's clock match the server's?
   - If a client sends moves with timestamps that don't align with the game clock, that's suspicious.
   - Might indicate a cheating tool injecting moves at non-human times.

##### How Lichess Uses It

- Lag/socket data is logged but rarely alone triggers a flag.
- Useful for moderator review: if a banned player has suspiciously erratic lag patterns, it supports a conviction.

---

#### Extension Fingerprinting

**Source:** Lichess client JavaScript (frontend code, partially open-source)  
**Type:** (a) Officially confirmed via GitHub and community posts

##### What's Detected

Lichess probes for known chess-engine browser extensions:

- **136 DOM selectors** for known extensions (similar approach to Chess.com, but the exact list differs).
- Checks for global variables injected by extensions (e.g., a Stockfish.js extension might create `window.Stockfish` or `window.CHESS_ENGINE`).
- Inspects `localStorage` and `sessionStorage` for engine-related keys (e.g., `"engine_depth"`, `"stockfish_variation"`).
- Attempts to detect WASM Stockfish running in a tab (if possible, but sandboxing limits this).

##### Examples of Detected Extensions

- **Lichess board extension** (ironically, by Lichess itself for analysis; flagged during rated play).
- **Stockfish JS wrapper extensions** (e.g., various chess-analysis packages bundled as Chrome extensions).
- **Chess.com's own analysis extension** (can be used while playing on Lichess).
- **Third-party analysis tools** that inject into the page.

##### Limitations

- **Does not detect:** Stockfish on a *different machine* (e.g., another computer, phone, or CLI).
- **Does not detect:** Stockfish in a separate browser tab on the *same machine* (unless Lichess can find cross-tab communication signals, which are limited by browser sandboxing).
- **Does not detect:** Closing the extension before playing (if an extension is uninstalled, the signal disappears).

##### False Positives

- A chess analyst might have a Stockfish extension installed but not use it during games.
- Lichess flags the extension's *presence*, not its active *use*.
- So a flag here doesn't auto-ban; it's another data point for moderators.

---

#### Integration with Kaladin

The 52-feature feature set used by Kaladin includes several client-side signals:

- **Move time standard deviation** (from hold times)
- **Blur rate** (% of moves with blur events)
- **Connection stability** (do they disconnect frequently?)
- **Extension presence** (boolean: detected engine extension?)
- **Time pressure sensitivity** (do they play worse when time is low?)

These are combined with server-side engine-correlation scores to produce a multi-signal assessment.

---

#### Transparency & User Awareness

**Source:** Lichess Fair Play policy  
**Type:** (a) Officially confirmed

Lichess is **transparent** about what it logs:
- The Fair Play page states clearly: "We log move times, blur events, and other behavioral signals."
- Players are **aware** they're being monitored for unusual patterns.
- This is **not hidden telemetry** — it's disclosed in the privacy policy and fair-play guidelines.

---

#### Comparison with Chess.com

| Signal | Lichess | Chess.com |
|--------|---------|-----------|
| Blur events | Yes, disclosed | Yes, reverse-engineered (not officially documented) |
| Move hold times | Yes, disclosed | Yes, reverse-engineered (not officially documented) |
| Lag/socket integrity | Yes, internal | Likely yes, internal (not confirmed) |
| Extension fingerprinting | Yes, disclosed (136 selectors) | Yes, reverse-engineered (22 signatures) |
| Page Visibility API | Unlikely for anti-cheat | Checked (but not for anti-cheat, just audio pausing) |
| Cross-tab communication detection | Limited by browser sandbox | Likely more sophisticated (Chess.com has more resources) |

---

#### Summary

Lichess's client-side telemetry is:
- **Transparent:** Users know what's logged.
- **Open-source:** The blur-tracking code is in the repository.
- **Comprehensive:** Covers blur, timing, lag, and extension presence.
- **Not deterministic:** No single signal auto-bans; all signals feed into moderator review.

The biggest advantage: **Because Lichess discloses what it logs, players can understand why they might be flagged and can prepare their case for appeal.**

---

**Primary Sources:**
- https://github.com/lichess-org/lila/blob/master/ui/round/src/blur.ts
- https://github.com/lichess-org/lila/blob/master/modules/game/src/main/Game.scala
- https://lichess.org/page/fair-play
- https://blog.lichess.org (various anti-cheat transparency posts)

## I.01-strength-score-fair-play

##### Chess.com Strength Score & Fair Play Detection

#### Overview

Chess.com operates a **proprietary, multi-layer detection system** with no published academic methodology. The company claims over 100 factors, but publicly names only a few. The core metric is the **Strength Score** (0–150 scale), which measures engine-move correlation.

---

#### Strength Score: The Core Metric

**Source:** Chess.com's Fair Play policy and Niemann Report  
**Type:** (a) Officially confirmed via Chess.com policies

##### What It Measures

The Strength Score is a **normalized correlation** between:
1. The player's move
2. The best move(s) recommended by chess engines (Stockfish, typically at depth 30+)
3. The player's current rating and historical performance

##### Scale: 0–150

- **0–30:** Play that would be expected from a much lower-rated player.
- **30–70:** Normal play for the player's rating.
- **70–100:** Suspiciously strong (higher than their rating explains).
- **100–150:** Extremely suspicious (engine-level accuracy).

**Key caveat:** Strength Score is not the same as **engine-move percentage** (e.g., "80% of moves match engine"). Instead, it's a **normalized metric** accounting for position difficulty, move alternatives, and the player's historical performance.

##### Examples

- A 1600-rated player with Strength Score 25 in a game: normal (weaker than their rating, but happens).
- A 1600-rated player with Strength Score 120 in a single game: anomalous (played at 2500+ level).
- A 1600-rated player with Strength Score 100 in **every game for 10 games**: very suspicious (sustained anomaly).

##### Important Limitation

Strength Score **cannot catch 1 move/game cheating** effectively. A game with 40 moves where 39 are human and 1 is engine-perfect might yield a Strength Score of 50–60 (slightly elevated but not conclusive). This is a known limitation acknowledged in the Niemann Report.

---

#### The "100+ Factors" System

**Source:** Chess.com Fair Play policy  
**Type:** (a) Officially confirmed via policy; (b) partially documented via third-party research

Chess.com states publicly:

> "Our cheat detection system that we've developed and maintained for more than 10 years detects suspicious play based on over 100 gameplay factors... Naturally, our methods are highly confidential as revealing specific detection methods only makes it easier for cheaters to avoid detection."

The company **does not publish the list of 100+ factors**. However, the Niemann Report and TIME magazine interviews reveal some:

##### Named/Inferred Factors

1. **Strength Score** (primary, engine-correlation based)
2. **Draw-offer patterns** (when does the player offer draws? At what position evaluation?)
3. **Sandbagging** (intentional losses to lower rating for later smurfing)
4. **Time-control inconsistency** (is play quality very different between blitz and rapid?)
5. **Toggling between windows/tabs** (verified from live JS; see section below)
6. **Move timing anomalies** (time-pressure sensitivity, move-hold variance)
7. **Rating improvement trajectory** (did rating jump unnaturally fast?)
8. **Opponent pool analysis** (are they only beating certain types of players?)
9. **Opening preparation depth** (do they only play known prep lines?)
10. **Endgame accuracy** (do they play endgames differently than midgames?)

Plus 90+ others not publicly named.

##### Autoban Rate & Appeal Process

**Source:** Chess.com Q1 2025 Fair Play statistics  
**Type:** (a) Officially confirmed via Chess.com blog

- **~85% of flagged accounts are automatically banned** (no manual review before autoban).
- **~0.2% of appeals are granted** (Chess.com upholds 99.8% of its own bans upon appeal).
- This suggests either:
  - The system is near-perfect (false positives are extremely rare), or
  - Most appeals are frivolous (cheaters denying guilt), or
  - Chess.com is structurally risk-averse (accepts some false positives to catch cheaters).
  
We cannot know which without seeing the code, which is why the Niemann case (settled) and Kramnik case (FIDE ruling) matter — they show that false positives do happen, even at high levels.

---

#### Verification: Live JavaScript Inspection

**Source:** Direct fetch of Chess.com's production JavaScript bundles (2026-09-04)  
**Type:** (a) Officially confirmed via my own live-site inspection

I retrieved Chess.com's live game client and analyzed the shipped JavaScript. Key findings:

##### Bundle: `play.js` (v2026.9.3, 143 KB)

- **22 chess-engine extension signatures** encoded as base64-obfuscated DOM selectors.
- Examples of detected extensions (decoded from obfuscation):
  - `#stockfish-analysis` (Lichess analysis toolbar)
  - `[data-engine-active]` (various third-party extensions)
  - `window.CHESS_ENGINES` (global variable check)
  - And 19 others

##### Bundle: `fair-play.a7081516.DODGjsmdVo.chunk.js` (2 KB)

- **Protobuf descriptor** for a gRPC `FairPlayService` with two RPC methods:
  - `RecordMetric(FairPlayMetric)` — sends per-move telemetry
  - `RecordAM(AttackMetric)` — sends attack/anomaly metrics

This proves that **Chess.com transmits telemetry on every move** to a backend service called `FairPlayService`.

##### Bundle: `shared.eager.BEUpLqBN2F.chunk.js` (2.6 MB)

- **isTrusted event filtering:** Detects synthetic mouse/keyboard events (automation detection).
- **FairPlay.UntrustedUserEvent emission:** Flags moves made by scripted clicks (not human-input events).
- **Blur/focus event listeners:** `window.addEventListener('blur', ...)`, `window.addEventListener('focus', ...)`
- **Page Visibility API listeners:** (But used only for audio pausing, not cheat detection.)

---

#### Client-Side Telemetry: The `fps` Plugin

**Source:** Direct JavaScript inspection  
**Type:** (a) Officially confirmed via live JS

Chess.com's client defines a plugin named **`fps`** (internally called "FairPlay Signals" or similar) that instruments every move:

##### Data Captured Per Move

A telemetry object is constructed with these fields:

```javascript
{
  BlurCount: number,              // How many blur events during this move?
  DidBlurOnOpponentTurn: boolean, // Blurred while opponent was thinking?
  DidBlurOnOwnTurn: boolean,      // Blurred while player was thinking?
  DidFocusOnOpponentTurn: boolean,
  DidFocusOnOwnTurn: boolean,
  DidSelectMultiplePieces: boolean, // Clicked multiple pieces in sequence?
  DidToggle: boolean,             // Blur followed by focus on same turn? (TOGGLING!)
  EventTrusted: boolean,          // Was this a human click (isTrusted=true)?
  LastFocusToMoveTime: number,    // Time from regaining focus to making move
  MoveHoldTime: number,           // Time from position to move completion
  MoveToFirstBlurTime: number,    // Time from move to first blur
  PointerOffset: number,          // Distance from last pointer position?
  TotalBlurTime: number,          // Total duration of blur during move
  TotalFocusTime: number,         // Total duration of focus during move
}
```

This object is attached to every move (under a field called `ac` in the internal move representation) **before the move is dispatched** to the server.

##### What This Proves

1. **Toggling is real and verifiable.** The field `DidToggle` exists and is explicitly computed. When a blur is followed by a focus during the same move window, `DidToggle = true`.
2. **Move timing is captured.** `MoveHoldTime`, `LastFocusToMoveTime`, `MoveToFirstBlurTime` are all explicit fields.
3. **Automation detection is built-in.** `EventTrusted` checks whether the click was from a real human input or a script.
4. **This data is sent to the server.** The telemetry object is serialized and sent alongside each move to the `FairPlayService` RPC endpoints.

##### Comparison with Chess.com's 2022 Niemann Letter

Recall from the Niemann Report (Exhibit B, Chess.com's September 2022 letter):

> "We are prepared to present strong statistical evidence that confirm each of those cases above, as well as clear **'toggling' vs 'non-toggling' evidence, where you perform much better while toggling to a different screen during your moves.**"

**This JavaScript finding directly validates that claim.** Chess.com literally implements a `DidToggle` boolean on every move.

---

#### Ken Regan's Model (Mentioned, Not Adopted)

**Source:** Chess.com Fair Play policy; Niemann Report  
**Type:** (a) Officially confirmed via policy

Chess.com has cited Ken Regan's IPR/z-score model as a reference point but **does not exclusively use it**. The company states:

> "Our detection system requires robust methodologies beyond simply looking at best moves, player rating, and centipawn loss."

This implies Chess.com's system is **more comprehensive** than Regan's engine-correlation model alone. Indeed, the Strength Score (0–150) is a proprietary variant, and the 100+ factors include non-statistical signals (toggling, time management, etc.).

---

#### Cloudflare & Bot Management

**Source:** Direct HTTP header inspection (2026-09-04)  
**Type:** (a) Officially confirmed via live response headers

Chess.com's servers respond with:

```
cf-ray: 8c9d7e5f3a2b1c0d-LAX (Cloudflare ray ID)
x-chesscom-version: 2026.9.3
x-chesscom-server-pool: k8s-prod-fpm-catch-all
```

This indicates **Cloudflare's "Bot Management" module** is active:
- **Turnstile CAPTCHA** challenges suspicious traffic (JavaScript puzzle).
- **Behavioral analysis** of requests (click patterns, mouse movement, timing).
- **Device fingerprinting** (browser user-agent, TLS fingerprint, IP reputation).

**Clarity:** This is **not specific to cheat detection**. Cloudflare's Bot Management is standard anti-abuse infrastructure. It helps prevent:
- Automated account creation
- Brute-force login attempts
- DDoS attacks
- Bulk data scraping

It **does** feed into the security perimeter, but is not the anti-cheat system itself.

---

#### Kount Fraud Fingerprinting

**Source:** Direct JavaScript inspection; Kount's own documentation  
**Type:** (a) Officially confirmed via JS; (b) documented via Kount case studies

Chess.com uses **Kount's fraud-detection SDK** (visible in the live JS bundle). Kount fingerprints users by:

- **Device ID** (derived from hardware/OS characteristics)
- **IP address** (geolocation, ASN, reputation)
- **Browser metadata** (user-agent, canvas fingerprint, WebGL data)
- **Payment history** (if applicable)

**Current evidence:** Kount is tied to Chess.com's **payment and premium subscription systems**, not proven tied to cheat detection per se.

**But:** Given that Kount is in the codebase and Chess.com has abundant data (IP, device ID, browser fingerprinting), it's plausible that Kount data *could* be queried during cheat investigations (e.g., "Is this a known cheater's device?"). However, **I cannot confirm this from the JS alone** — the integration point is not visible in the shipped JS.

---

#### Summary: What We Know vs. Don't Know

##### Know (Confirmed)
- **Strength Score** is the primary metric (0–150 scale, engine-correlation based).
- **100+ factors** exist but are not publicly named.
- **Toggling detection** is real and implemented (proven by JavaScript).
- **Move timing** is captured (MoveHoldTime, etc.).
- **Automation detection** is real (isTrusted filtering).
- **Extension fingerprinting** is real (22 signatures).
- **Autoban rate** is ~85%; **appeal success rate** is ~0.2%.

##### Don't Know (Opacity)
- The exact weighting of the 100+ factors.
- How Strength Score is combined with other factors.
- The precise statistical thresholds for each factor.
- Whether server-side analysis happens post-move or on aggregate.
- How much weight toggling/timing get vs. engine-correlation.
- The false-positive rate (could be 1%, could be 10%).

**This opacity is the key difference from Lichess**, where the code is open and the community can audit decisions.

---

**Primary Sources:**
- https://www.chess.com/legal/fair-play (official Fair Play policy)
- https://www.chess.com/cheating (official anti-cheat overview)
- https://www.chess.com/blog/CHESScom/hans-niemann-report (Niemann Report with Exhibit B letter)
- https://support.chess.com/en/articles/8568369-what-do-i-need-to-know-about-fair-play-on-chess-com (help center)
- https://www.chess.com/r2/client-packages/play-computer/2026.9.1/play-computer.js (live JS inspection, 2026-09-04)
- https://time.com/6227677/magnus-carlsen-hans-niemann-kenneth-regan-chess-scandal/ (TIME interview with Danny Rensch)



# Appendix J — Pretrained human move-timing models (verified 2026-09-04)


Verified 2026-09-04 against GitHub, arXiv, and Hugging Face (file trees, LFS pointers, and source files were fetched directly; nothing below is from memory).

## Summary table

| Candidate | Predicts move time? | Output form | Inputs | Params | Public weights | Licence | Browser feasible? |
|---|---|---|---|---|---|---|---|
| A. ALLIE (Zhang et al., ICLR 2025) | Yes, dedicated time head | Scalar regression (standardised seconds, MSE), clamped 0-60 s | Elo x2, blitz time-control token, full UCI move sequence; no clocks | 355M (GPT-2 medium) | Yes, HF dataset `yimingzhang/allie-models`, raw `.pt` 1.0-8.5 GB | MIT | No (too large; 100 ms budget impossible in WASM) |
| B. ChessMimic (Johnson, arXiv 2606.04473, 2026) | Yes, dedicated clock model | 30-bucket categorical distribution over seconds | FEN, last 12 UCI moves, rating, own clock, opp clock, increment | ~9M per band x 14 bands | Yes, Git LFS in `thomasj02/1e4_ai`, Lightning `.ckpt` 107.5 MB each (~36 MB weights-only) | PolyForm Noncommercial 1.0.0 (source AND weights) | Technically yes (standard ops, ~30-80 ms est.), legally only if non-commercial |
| C. Maia-2 / Maia-3 | No | policy + value/WDL only | board, both Elos | 5M/23M/79M (Maia-3) | Yes | MIT (Maia-2) / AGPL-3.0 (Maia-3) | n/a |
| D. Others (CNN-LSTM RatingNet, Temple time-management NN, Chessformer, HF sweep) | No usable time predictor | see below | | | | | |

---

## A. ALLIE — "Human-Aligned Chess With a Bit of Search"

Sources: paper https://arxiv.org/abs/2410.03893 (HTML: https://arxiv.org/html/2410.03893); repo https://github.com/ippolito-cmu/allie; weights https://huggingface.co/datasets/yimingzhang/allie-models; data https://huggingface.co/datasets/yimingzhang/allie-data.

1. **Predicts move time: yes.** `CausalLMWithRegressionHead` in `src/modeling/model.py` adds two heads on the last hidden state: `value_head = Linear(n_embd,1) -> Tanh` and `time_head = Linear(n_embd,1)` (no activation). Loss is plain `F.mse_loss` on standardised seconds, masked where label = -100. Output is a **point estimate** (one scalar per position), not a distribution. Note a quirk in `model.py`: the time loss is added with `self.value_loss_coef`, not `time_loss_coef`.

2. **Inputs** (from `src/modeling/data.py`): token sequence = `[white_elo_token, black_elo_token, time_control_token, move_1, move_2, ...]`. Elo is a "soft control token" (`CausalLMWithControlToken` interpolates a 2-row embedding between 500 and 3000 Elo; values are clamped to that range). Time control is one of **24 hard-coded blitz tokens** (`180+0, 300+0, 180+2, 300+3, 300+2, 420+0, 240+0, 180+1, 180+3, 300+1, 360+0, 300+4, 420+1, 240+2, 180+5, 120+2, 120+3, 240+3, 240+1, 360+2, 60+3, 60+5, 240+4, 240+5`), otherwise `<unk>`. Move vocabulary is UCI (paper says 1968 tokens; `moves.py` ships a 4672-entry superset list). **Remaining clock time is NOT an input**: the per-move seconds are packed into bits 16-31 of each training token, then stripped (`input_ids = data & 0x3FFF`) and used only as `time_labels` for the regression head. So ALLIE predicts think time from moves + Elo + TC only, blind to the actual clocks. Max length 512 tokens (`pretrain_config/medium.yaml`; default tokenizer arg is 128). The label attached to token *i* is the seconds spent on move *i+1*, so `time_logits[0,-1]` is the predicted think time for the move about to be played (`src/evaluation/decode.py` lines 211-212).

3. **Architecture:** decoder-only GPT-2 medium initialised from pretrained `gpt2-medium` weights (24 layers, d=1024, 16 heads), **355M parameters** per the paper. Ablations: small (half params), large (double), short (context), half (data).

4. **Checkpoints** (HF dataset repo, verified via `/api/datasets/yimingzhang/allie-models/tree`): `medium/best.pt` and `medium/last.pt` **3,665,220,334 bytes (3.66 GB)** each; `ablations/large/best.pt` 8.55 GB; `ablations/small/best.pt` 1.05 GB; `ablations/short`, `ablations/half` 3.66 GB. Format: raw PyTorch `.pt` (training checkpoints, evidently including optimiser state — fp32 weights alone would be ~1.4 GB for 355M). Plus `config.yaml`, `log.txt`, `debug.txt`. Licence: repo README says "MIT - see LICENSE".

5. **Training data / metrics:** all Lichess 2022 blitz games, 91M games (downsampled to equal counts per 100-Elo bin), 6.6B tokens, 2M steps, 8xA6000 for 2 weeks. Time normalisation constants `TIME_MEAN = 4.64001`, `TIME_STDEV = 6.16533` s. Seconds are clamped to [0, 60] (`data.py` line 162-167). Reported timing metric: **Pearson r = 0.697** between predicted and actual think time on 884k test positions after dropping the first 5 moves and moves with < 30 s on the clock. Paper notes it "tends to predict lower pondering times than humans do" because most blitz moves are < 5 s.

6. **ONNX / browser:** nobody has exported it (no ONNX, TorchScript, or web artefacts in the repo; HF search shows no derivative). Export itself would be routine (GPT-2 with two extra Linear heads, standard `torch.onnx.export` with past-KV). But 355M params = ~1.4 GB fp32 / ~710 MB fp16 / ~360 MB int8. In onnxruntime-web WASM (SIMD+threads) a GPT-2-medium incremental decode step is on the order of 150-400 ms on a laptop CPU, and a cold full-sequence pass is seconds; shipping a 360-700 MB blob in a Chrome extension is not practical. Only a distillation of its time head is realistic in-browser.

7. **Sampling:** point estimate only; you would have to add your own noise model (e.g. log-normal around the prediction) to get human-like variance. ALLIE's own bot uses the value only to scale MCTS rollouts (`convert_time_to_sims`, `decode.py` line 503), not to sleep.

8. **Limitations for us:** blind to the clock state (cannot model time pressure or opponent flagging), blitz-only vocabulary (bullet/rapid/untimed collapse to `<unk>`), Elo clamped to 500-3000, 60 s clamp, systematically underpredicts long thinks, enormous model.

---

## B. ChessMimic — "Per-Rating Transformer Models for Human Move, Clock, and Outcome Prediction in Online Blitz Chess"

Sources: paper https://arxiv.org/abs/2606.04473 (HTML: https://arxiv.org/html/2606.04473v1), author Thomas Johnson, 3 June 2026; code + weights https://github.com/thomasj02/1e4_ai (default branch `master`); demo https://1e4.ai.

1. **Predicts move time: yes**, a separate "clock model" (`ClockPatzerModel` in `Training/ClockTrainer.py`, inference in `backend/clock_inference.py`). Output: **30-bucket categorical distribution** over think time. Bucket boundaries (from `backend/models/clock_model/1500_1600_brier/clock_buckets.json`): 1-second buckets [0,1), [1,2), ..., [26,27), then [27,32), [32,40), [40,inf). Loss: `MaskedBrierLoss` (sum of squared prob errors over buckets) with a bucket-validity mask during training (buckets beyond `player_clock + increment` are masked out, bucket 0 always valid; `Training/ClockDataset.py` lines 97-108). The `clock_buckets.json` also ships the empirical prior over buckets (e.g. 4.1% at 0 s, 17.2% at 1 s, 19.8% at 2 s, ...).

2. **Inputs:** `input_ids = [12 recent UCI move tokens][FEN tokens]` (FEN tokeniser derived from google-deepmind/searchless_chess, 78 tokens incl. side-to-move, castling, ep, halfmove and fullmove counters), a scalar standardised rating of the side to move, and a 3-vector `[log(player_clock+1), log(opponent_clock+1), log(increment+1)]` each standardised with per-band means/stds in `scalers.pkl`. Rating and clock vectors are each projected to one token; the sequence is `[moves, rating, clock, board]` (~92 tokens) with a learned positional embedding; the last token is read out (`forward`, `ClockTrainer.py`).

3. **Architecture:** 8 pre-LN blocks of `nn.MultiheadAttention` (8 heads) + SwiGLU MLP (`MlpBlock`: LayerNorm, two bias-free Linear 256->1024, SiLU gate, Linear 1024->256), d_model 256, final LayerNorm, `time_classifier = Linear(256, 30)`. Paper: **~9M parameters per band**, 14 bands ([0,1000), [1000,1100), ..., [2100,2200), [2200,3500)), 42 checkpoints total for the three task models.

4. **Checkpoints:** `backend/models/clock_model/<band>_brier/{model.ckpt, scalers.pkl, clock_buckets.json}` for all 14 bands, stored in Git LFS. LFS pointer for `1500_1600_brier/model.ckpt`: `size 107535521` (107.5 MB). That is a Lightning training checkpoint (`checkpoint.get('state_dict', checkpoint)` in `clock_inference.py`); 9M params fp32 = ~36 MB weights + 2x36 MB Adam moments = 108 MB, so weights-only is ~36 MB fp32 / ~18 MB fp16 / ~9 MB int8 per band. **Licence: PolyForm Noncommercial 1.0.0** ("The non-commercial restriction applies to the included trained artifacts as well as the source code" — README; `LICENSE` header `SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0`, copyright 2026 Thomas Johnson). The paper's HTML says CC BY-NC-SA 4.0 for the paper itself. The repo accepts no issues/PRs.

5. **Training data / metrics:** Lichess "Rated Blitz game" dumps 2024-09 to 2025-08 (~450M games total; 10-40M per band), positions seen > 1000 times skipped, games without `%clk` skipped, moves with 0 s or > 3600 s skipped. Reported clock metrics (ALLIE-style filter: drop first 5 full moves and moves under 30 s remaining, n = 89,299): **Pearson r = 0.41, Spearman rho = 0.50, MAE = 4.10 s**; per-band r 0.38-0.46 with no Elo trend. The author attributes the gap to ALLIE's r = 0.70 to the bucketed Brier objective vs. scalar MSE, and to each band seeing only 100 Elo of variance. Per-position softmax is "diffuse" (normalised entropy ~0.3-0.4).

6. **ONNX / browser:** no export in the repo (no `.onnx`, TorchScript, or JS inference; the frontend calls a FastAPI backend). But every op is stock PyTorch (`nn.Embedding`, `nn.Linear`, `nn.LayerNorm`, `nn.MultiheadAttention`, `nn.SiLU`, cat/add/softmax) so `torch.onnx.export` at opset 14+ works with no custom ops. Cost estimate: ~92 tokens x 8 layers x d=256 -> roughly 2 x 9M x 92 = ~1.7 GFLOP per query; onnxruntime-web WASM SIMD+threads on a laptop typically delivers 20-60 GFLOP/s, so **~30-80 ms per move**, within the 100 ms budget but with little margin on slow machines; fp16/int8 quantisation would help. Loading one 18-36 MB band file (or several) in an offscreen document is fine. Preprocessing needed in TS: the searchless_chess FEN tokeniser, UCI move vocabulary (1968 entries), and the per-band scaler constants (unpickle `scalers.pkl` offline and embed as JSON).

7. **Sampling:** it gives a full distribution. The shipped `sample_thinking_time` draws a bucket from the softmax (`np.random.choice`, optional `min_probability` filter) and then samples a continuous value within the bucket from an empirical per-bucket distribution (`sample_from_bucket_empirical`); the paper's point estimate is the bucket-centre expectation. Note `predict_bucket` applies **no clock mask at inference** ("NO MASKING!" comment) and only flags `would_forfeit` afterwards, so a client should mask buckets above `player_clock + increment` itself. This is exactly the distributional behaviour we want.

8. **Limitations for us:** trained on blitz only (3-10 min total time, bullet and rapid excluded, untimed games excluded by construction), 14 separate 36 MB weight sets if you want per-rating fidelity (or ship 1-3 bands), rating below 1000 is one coarse band, correlation with real times is modest (r 0.41), and above all the **non-commercial licence** forbids use in anything commercial (weights and code alike).

---

## C. Maia-2 and Maia-3

Sources: https://github.com/CSSLab/maia2 (MIT), https://github.com/CSSLab/maia3 (AGPL-3.0), Chessformer paper https://arxiv.org/html/2605.19091v1 (CC BY 4.0), HF collection https://huggingface.co/collections/UofTCSSLab/maia3 (`Maia3-5M`, `Maia3-23M`, `Maia3-79M`).

**Neither predicts move time.** Maia-2 exposes a move-policy head and a White-expected-score value head; inputs are FEN plus both players' Elo, no clock features (games lacking `%clk` are merely excluded from training, the clocks are not used). Maia-3 / Chessformer has exactly two heads, value (WDL) and policy (source-destination), inputs are the current and 7 previous board tensors plus two skill embeddings; "no clock or time information" as input, no time output. Original Maia-1 likewise. Nothing in the Maia line can be reused for timing without adding and training a new head.

---

## D. Other artefacts

- **CNN-LSTM rating estimation (Omori & Tadepalli, arXiv 2409.11506, CG 2024)** — code/weights at https://github.com/AstroBoy1/RatingNet (MIT, `model_55.pth` via Google Drive). It **consumes** clock times as inputs to predict rating (MAE 182 Elo). It cannot be "inverted" into a time predictor; there is no time head.
- **"Time Management in a Chess Game through Machine Learning" (Burduli & Wu, Temple University)** — https://cis.temple.edu/~wu/research/publications/Publication_files/Paper_Guga.pdf. A per-player 5-hidden-layer MLP (512,512,256,256,128 neurons, 8 hand-crafted input features such as legal-move count, material, ratings, remaining time) trained on games scraped from chess.com via its public API, plus a segmented-least-squares baseline. **No code or weights are released** and it is fitted per individual player; not reusable.
- **Chessformer (nsarrazin/chessformer on HF)** — 231M GPT-2 next-move model, MIT; no time output.
- **Hugging Face sweep** (`/api/models?search=chess`, 1000 results, filtered on time/clock/ponder/think in id or tags): nothing relevant — hits are Qwen "thinking" fine-tunes and piece-detection vision models. No `maia`, `allie`, or `chessmimic` *model* repos exist; ALLIE weights live in a *dataset* repo.
- ALLIE's Lichess bot post (https://lichess.org/@/yimingz3/blog/play-against-alliethechessbot-yet-another-human-like-chess-bot/woUkVeHy) and CMU blog give no additional timing mechanism.

Conclusion for D: apart from ALLIE and ChessMimic there is **no public pretrained human move-time model**.

---

## Recommendation

Ranked options against the criteria (no training vs. effort, realism, browser feasibility, licence):

**(ii) Reuse ChessMimic clock weights — best technical fit, blocked by licence.** It is the only released model that (a) takes both clocks and the increment as inputs, (b) outputs a 30-bucket distribution you can sample from, (c) exports to ONNX with zero custom ops and (d) at ~9M params fits the 100 ms browser budget (est. 30-80 ms in WASM, 18-36 MB per band). If the extension is strictly non-commercial and you can live with PolyForm-NC, do this: strip the optimiser state from `model.ckpt`, `torch.onnx.export` at fp16, port the searchless_chess FEN tokeniser + scaler constants to TypeScript, apply the `player_clock + increment` bucket mask client-side, sample bucket then uniform/empirical within bucket. If there is any commercial use, do **not** use it.

**(i) ALLIE time head as-is — reject.** 355M params, 1.4 GB fp32 raw checkpoint, no clock inputs, point estimate only. It cannot meet the size or latency constraints in onnxruntime-web, and even distilled it would teach a clock-blind predictor.

**(iii) Distil into a tiny network — viable, but only ChessMimic is a sensible teacher, and distillation of PolyForm-NC outputs inherits the licence risk; ALLIE is MIT but clock-blind and needs a GPU to run as teacher over enough positions.** Given that Lichess `%clk` data is free and plentiful, distillation buys nothing over direct training on ground truth.

**(iv) Train our own small bucketed head on Lichess `%clk` data — recommended.** Reasons: MIT-clean, exactly matches our inputs (both clocks, increment, rating, move number, position/move features), trivially browser-sized, and the two published systems tell us what works. Concretely, borrow from ChessMimic: the 30-bucket scheme (1 s buckets to 27 s, then 27-32, 32-40, 40+), `log(clock+1)` standardised clock features, the `player_clock + increment` validity mask, Brier or cross-entropy with class weights, and sample-bucket-then-within-bucket decoding. Borrow from ALLIE the evaluation protocol (Pearson r after dropping first 5 moves and < 30 s positions) so results are comparable: ChessMimic reports r = 0.41 with a 9M transformer on a position encoding, so a 15k-param MLP on 28 hand-crafted features (our Appendix-D plan) landing around r 0.3-0.4 would be in line with the literature; the biggest gains in both papers come from the clock inputs, which our plan already includes. Two additions worth making given the findings: include time-control category and total-time features so one model covers bullet/blitz/rapid (both published models are blitz-only), and add a cheap position-complexity proxy (legal-move count, captures/checks available, material) since ChessMimic's attention analysis and the Temple paper both find these drive long thinks.

Net: reuse nothing at runtime; reuse ChessMimic's design and ALLIE's evaluation recipe, and train the small bucketed head. Only if the project is unambiguously non-commercial does exporting ChessMimic's clock model to ONNX become the faster path.

## URLs used

- https://github.com/ippolito-cmu/allie
- https://arxiv.org/abs/2410.03893 / https://arxiv.org/html/2410.03893
- https://huggingface.co/datasets/yimingzhang/allie-models (tree via https://huggingface.co/api/datasets/yimingzhang/allie-models/tree/main?recursive=true)
- https://huggingface.co/datasets/yimingzhang/allie-data
- https://arxiv.org/abs/2606.04473 / https://arxiv.org/html/2606.04473v1
- https://github.com/thomasj02/1e4_ai (files: `LICENSE`, `README.md`, `backend/clock_inference.py`, `Training/ClockTrainer.py`, `Training/ClockDataset.py`, `Training/clock_bucket_utils.py`, `Training/specs/clock_model.md`, `backend/models/clock_model/*/`)
- https://1e4.ai
- https://github.com/CSSLab/maia2 , https://github.com/CSSLab/maia3 , https://huggingface.co/collections/UofTCSSLab/maia3
- https://arxiv.org/html/2605.19091v1 (Chessformer / Maia-3)
- https://arxiv.org/abs/2409.11506 , https://github.com/AstroBoy1/RatingNet
- https://cis.temple.edu/~wu/research/publications/Publication_files/Paper_Guga.pdf
- https://huggingface.co/nsarrazin/chessformer
- https://lichess.org/@/yimingz3/blog/play-against-alliethechessbot-yet-another-human-like-chess-bot/woUkVeHy
