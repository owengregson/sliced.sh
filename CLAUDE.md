# CLAUDE.md — sliced.gg (v2)

Manifest V3 chess assistant for chess.com and lichess. Read this before touching anything;
`docs/ARCHITECTURE.md` has the shape of the system, `docs/DEVELOPMENT.md` the workflow and the
licensing obligations, `docs/qa-checklist.md` everything that only a real browser can answer.

The plan this was built from is `docs/superpowers/plans/2026-09-03-sliced-v2-implementation-guide-v2.md`
(Part I is the binding spec, appendices A–J are research). Section references below (§3.6, §11.2,
Appendix F §4.8, …) point into it.

---

## Commands

| Command | What it does |
|---|---|
| `bun install` | Dependencies. Bun ≥ 1.3; there is no npm/webpack/Vite path. |
| `bun run check` | The gate. `gen:tokens` → `gen:pagescript` → `check-constants` → `lint` → `typecheck` → `test`. Must exit 0 before every commit. |
| `bun run build --dev` | Unminified build with source maps into `dist/`, manifest marked `(dev)`. This is what you load unpacked. |
| `bun run build` | Minified release build, then `release/sliced-<version>.zip`. |
| `bun run test` | `scripts/test-runner.sh` — one Bun process per test file (Bun leaks `mock.module` state across files). |
| `bun test <file>` | A single file, fast. |
| `bun run lint` / `lint:fix` | Biome: tabs, double quotes, semicolons, width 100. |
| `bun run typecheck` | `tsc --noEmit`, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. |
| `bun run verify:dist` | Run the packaging checks against an existing `dist/` on their own. |
| `bun run vendor:engine` | Re-vendor Stockfish + onnxruntime and **regenerate `docs/third-party.md`**. |

`bun run check` needs `python3` on `PATH` (the telemetry-conformance threshold test in
`tools/telemetry-conformance/report.py`).

`bun run dev` currently runs the pipeline once — `--watch` is parsed but there is no watch loop.
Re-run `bun run build --dev` and hit reload on `chrome://extensions`.

---

## Architecture in one screen

Five runtime contexts, each with one entry point:

| Context | Entry → bundle | Owns | Never |
|---|---|---|---|
| Service worker | `src/service/service-worker.ts` → `js/service-worker.js` | `GameSession` per tab, the recommendation pipeline, `MoveExecutor` (CDP), debugger lifecycle, licence gate, alarms, side-panel policy, TTS | DOM, engine compute |
| Offscreen doc | `src/offscreen/index.ts` (`pages/offscreen.html`) | Stockfish (pthreads + SharedArrayBuffer), NNUE storage, analysis cache, ONNX timing inference | `chrome.storage`, tab APIs, UI |
| Side panel | `src/panel/index.ts` (`pages/panel.html`) | Views, router, store hydrated from SW snapshots | Engine or DOM access — it is a pure client of the SW |
| Content (ISOLATED) | `src/content/index.ts` → `js/content.js` | Site detection, `SiteAdapter` DOM observers, highlights, keybinds, cursor tracking | Engine, timing decisions, CDP |
| Page bridge (MAIN) | `src/page/*.ts` → `dist/js/page/*.js` | `wc-chess-board.game` / chessground internals, relayed over `window.postMessage` with a per-build token | `chrome.*` (unavailable), any business logic |

Per position: `adapter.positionChanged` → SW `GameSession.onPosition` → engine analysis (cached)
→ `MoveSelector.choose` → `TimingModel.planMove` → panel snapshot + board highlight → if armed,
`MoveExecutor` drives a humanised CDP drag at the planned time and verifies it landed.

Ports: `sl-panel` (SW ↔ panel), `sl-engine` (SW ↔ offscreen), `sl-game` (SW ↔ content).

---

## Conventions

These are the plan's §1.3 global constraints, numbered so briefs and reviews can cite them.
Most are machine-enforced, and the entries that are name what enforces them. Do not assume an
entry is enforced because it is written here: treat any entry without an `*Enforced by:*` line,
and any individual claim inside an entry that names no checker, as resting on review. The ones
verified to have no checker today are "templates live in `*.html`, imported `?raw`" (C3); "every
module that owns listeners or timers exposes a dispose" (C6); and both halves of C5 — the brand
assets being byte-unchanged (the v1 `cmp` was a one-off manual step) and "all user-facing strings
live once in `src/panel/copy.ts` — never a literal in a view" (`scripts/check-css.ts` polices CSS
values, not view literals). C4 *is* enforced, animation mirror included
(`test/panel/animation-manager.test.ts:41`).

**C1 — one definition per constant.** Every storage key, alarm name, port name, message type,
URL, limit, timing and selector lives in a registry: `src/core/constants/*.ts`,
`src/design/tokens.ts`, `src/design/icons.ts`, `src/content/adapters/selectors.ts`.
`bun scripts/check-constants.ts` fails on a registered `sl::`/`sl-`/`__sl_` literal re-declared
elsewhere, and on a numeric literal marked `// const: <Name>` outside a registry.
*Enforced by:* `check-constants`, `test/core/constants/registry.test.ts`.

**C2 — no page-realm JavaScript strings.** Code that runs in the page's MAIN world is authored
as a pagescript AST (`src/pagescript/builders.ts`) and emitted by `bun run gen:pagescript`;
`src/page/*.ts` are program definitions, not scripts. The emitted programs are scanned for
product words (`sliced`, `engine`, `stockfish`, `eval`, `bestmove`, `fen`, `analysis`) and every
file under `src/content/**` and `src/page/**` is scanned for forbidden page APIs
(`localStorage`, `dispatchEvent`, `new MouseEvent`, `speechSynthesis`, `chrome.tabs.create`, …)
— comments included, so the words must not appear there at all.
*Enforced by:* `check-constants` (§13.3 rules 2 and 5), `test/scripts/check-constants.test.ts`.

**C3 — no numbers or colours in CSS.** All CSS lives in `css/`; every value is a `var(--sl-*)`
token, except `0`, `1px` borders, `100%` and `auto`. No inline HTML in `.ts` either: panel
templates are `src/panel/views/templates/*.html` imported with `?raw`.
*Enforced by:* `scripts/check-css.ts`, `test/scripts/check-css.test.ts`.

**C4 — one source for design.** `src/design/tokens.ts` generates both `css/tokens.css` and
`src/design/tokens.generated.ts` (both git-ignored — run `bun run gen:tokens`). Icons exist only
as `ICONS` names in `src/design/icons.ts`; `gen-icons` fails on an unknown Font Awesome class.
Animation timings mirror the CSS custom properties, so they cannot drift.

**C5 — brand assets are byte-unchanged.** The logo (`assets/images/sliced_*.png`) and the 13
sounds in `assets/sounds/` are the v1 files, copied bit for bit. Product name `sliced.gg`, short
name `sliced`, accent `#ffa71f`, dark-first. All user-facing strings live once in
`src/panel/copy.ts` — never a literal in a view.

**C6 — every `chrome.*` call goes through `src/core/chrome/*`.** Promise wrappers that check
`chrome.runtime.lastError`, so core modules run against the simulator in `test/sim/` instead of
a browser. Every module that owns a listener, timer, RAF or observer returns a
cleanup/dispose function, and panel views return theirs from `mount()`.
No `any` (outside `*.d.ts` shims), no non-null `!` in `src/**` (both allowed under `test/**`),
no `console.*` outside `src/core/logger.ts`
— use `log` from `@core/logger`.
*Enforced by:* `biome.json`'s `src/**` override (`noExplicitAny` and `noNonNullAssertion` are
errors there and off elsewhere, because scripts and tests legitimately use both), `noConsole`,
and `verify-dist`'s `console.` scan of the built bundles.

**C7 — the telemetry contract (§13) applies to every change.** No untrusted input events, no
focus changes, no page storage, no DOM or global signatures, rate-controlled preview selections,
a continuous pointer owned by the hand, human timing. This is the reason for most of the
apparent over-engineering in the executor and the timing model.
*Enforced by:* `tools/telemetry-conformance/`, `test/behavioral/telemetry/*`, and the `ac`-shadow
assertions that run inside the simulator on every `bun run check`.

Tests: pure-logic tests under 5 ms each; anything behavioural drives the simulator in
`test/sim/` (a fake `chrome`, a controllable clock, a happy-dom tab). Never weaken an existing
assertion to make new code pass — a newly failing assertion is a finding.

---

## Gotchas

**COEP blocks fetches in the offscreen document.** The manifest sets
`cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin` so the
offscreen document is cross-origin isolated and Stockfish can use `SharedArrayBuffer` + pthreads.
The price is that the offscreen document cannot fetch anything cross-origin that lacks CORP. Big
assets (NNUE nets, ChessMimic bands) are therefore fetched **by the service worker** and streamed
back over the `sl-engine` port in `LIMITS.nnueChunkBytes` slices —
`src/service/handlers/engine/download-relay.ts`. Chunks are base64 **text**: `chrome.runtime`
ports JSON-serialise their payloads, so an `ArrayBuffer` would arrive as `{}`.

**Offscreen documents have no `chrome.storage`.** Every setting the engine host needs arrives
over the port as a `configure` message; anything it must persist goes to OPFS, with IndexedDB
(`NNUE_DB`, `MODEL_DB`) as the fallback. Do not reach for `chrome.storage` in `src/offscreen/**`.

**An idle port does not keep the service worker alive; messages do.** On Chrome 114+ the
connection alone is not a lifeline — each message resets the idle timer. Anything that must
survive a quiet stretch (a live game, an attached debugger) takes a `Keepalive.hold(reason)`,
which arms a 30 s alarm whose only job is to wake the worker. Related MV3 rule: every listener
must be registered synchronously at the top level of `service-worker.ts`, because a listener
added in a later turn misses the event that woke the worker.

**The debugger infobar.** Attaching `chrome.debugger` puts a "… is debugging this browser" bar
above the page. Two consequences: clicking **Cancel** detaches and pauses auto-play
(`onDetach` with `canceled_by_user`), and the bar's appearance/disappearance **shifts the page
layout**. That is why the debugger attaches once, from the waiting view before the game
(`src/service/debugger-manager.ts`, `src/panel/views/waiting.ts`) — never inside a move window,
where the layout shift would land in the same window as the move.

**Hands-off mode is not a UI preference.** While a game is live the panel is display-only
(§13.4): a click in the side panel moves focus out of the game tab, and chess.com counts every
`blur` per move. In-game controls are `chrome.commands` shortcuts and in-page keybinds only. See
`docs/qa/focus-discipline.md` — the rows that would justify relaxing this have not been recorded
on real Chrome yet.

**The vendored engine is copyleft, and `docs/third-party.md` is generated.** Stockfish 18 is
GPL-3.0-or-later, the `@lichess-org/stockfish-web` glue is AGPL-3.0-or-later, and the ChessMimic
timing weights are PolyForm Noncommercial 1.0.0 (non-commercial use only — that is a condition on
the product, not just the file). Shipping a build to anyone triggers a written offer of the
corresponding source. Regenerate the notice with `bun run vendor:engine`; **never hand-edit
`docs/third-party.md`**. Details in `docs/DEVELOPMENT.md`.

**The licence gate is forced open.** `LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__` and
`build.config.json` sets `licenseEnforce: false`, so every key validates as `valid` while the
real verdict is kept in `rawStatus` for diagnostics. There are no locks right now and that is
deliberate: leave the flag, `src/service/license-gate.ts` and the login view's force-valid path
alone unless the owner asks otherwise.

**A bundler inlines an object literal whole, and that is a §13.3 problem.** Importing one member
of `URLS` shipped *every* URL in it — including `sliced.sh`, which names the product — into
whatever bundle did the importing. `LICENSE_ENDPOINT` and `SITE_MATCHES` are therefore separate
top-level exports, so the page-realm bundles carry only the two match patterns they need.
`verify-dist` polices this: `HOST_OWNERS` says which bundles may carry each host in the registry,
and a host it does not classify fails the build.

**The manifest must expose nothing to the page.** `key` is pinned, so the extension id is fixed
and knowable; a `web_accessible_resources` entry would let any script on chess.com or lichess
`fetch("chrome-extension://<id>/…")` and read success as a definitive "sliced is installed".
v2 declares none — the engine assets load in the offscreen document and the sounds in the side
panel, both extension pages — and `verify-dist` fails the build if the block returns without
`use_dynamic_url: true`.

---

## Repository layout

```
src/core/        constants registry, chrome wrappers, chess, engine client, motor,
                 strength, timing, storage, messaging, logger — no chrome-context assumptions
src/service/     service worker: sessions, executor, handlers, licence gate, lifecycle
src/offscreen/   Stockfish host, NNUE/model stores, ONNX timing inference
src/panel/       side panel: shell, router, views, components, copy
src/content/     ISOLATED content script: adapters, highlights, keybinds, cursor
src/page/        MAIN-world program definitions (compiled by gen-pagescript)
src/pagescript/  the AST, builders and emitter behind C2
src/design/      Lattice tokens and the icon registry
css/             the only stylesheets; tokens.css is generated
assets/          engine, models, fonts, sounds, images, vendored Font Awesome + onnxruntime
scripts/         build pipeline and lints
test/            unit, behavioural (simulator), integration; test/sim is the fake Chrome
tools/           data pipeline, telemetry conformance, one-off dev utilities
docs/            architecture, development, QA, third-party notices, model notes
```
