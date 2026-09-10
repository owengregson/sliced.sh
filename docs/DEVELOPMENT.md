# Development

Everything you need to build, load, test and ship sliced.gg, plus the licence obligations that
attach the moment a build leaves your machine.

---

## 1. Setup

Bun ≥ 1.3 is the runtime, bundler and test runner. There is no npm/webpack/Vite path, and no
Node-only tooling in any script.

```sh
bun install
bun run check          # must exit 0 before every commit
bun run build --dev    # writes dist/
```

`bun run check` also needs **`python3` on `PATH`** — `tools/telemetry-conformance/` has a
threshold-drift test that shells out to `report.py`.

Some generated files are git-ignored and are produced by the pipeline, so a fresh clone has to
build (or at least `bun run gen:tokens && bun run gen:pagescript`) before `tsc` will pass:
`css/tokens.css`, `src/design/tokens.generated.ts`, `src/page/generated/`.

**Pushing a fresh clone** that carries the ONNX bands and the wasm runtimes (~70 MB in one push)
can fail with `the remote end hung up unexpectedly`. Raise the buffer once:
`git config http.postBuffer 524288000`.

---

## 2. Loading it in Chrome

1. `bun run build --dev`
2. `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.
3. The extension appears as **sliced.gg (dev)** with `version_name` `<version>-dev+<timestamp>`;
   a release build has neither, which is how you tell two side-by-side installs apart.
4. Open a game on chess.com and open the side panel from the toolbar icon.

The extension ID is pinned by the `key` in `manifest.json` and is the same ID v1 used, so a 1.x
install upgrades in place (and `src/service/lifecycle.ts` migrates its eleven flat storage keys on
the first run). Never change or drop that `key`; `verify-dist` fails the build if it goes missing.

After editing source, re-run `bun run build --dev` and press the reload button on the extension
card. `bun run dev` accepts `--watch` but does not yet implement a watch loop, so it is the same
thing as one `--dev` build.

Useful surfaces while debugging:

- **Service worker** — `chrome://extensions` → the extension's "service worker" link. All
  `log.*` output from every context ends up in this console, because the logger forwards.
- **Side panel** — right-click inside the panel → Inspect.
- **Offscreen document** — `chrome://extensions` → "Inspect views: offscreen.html" once the
  engine has booted.
- **Log level** — Settings › Advanced, or the Engine view's level control.

---

## 3. The build pipeline

`scripts/build.ts` is eleven ordered steps, each an independently testable function
(§11.2): `clean` → `gen-tokens` → `gen-icons` → `gen-pagescript` → `check-constants` →
`check-css` → `typecheck` (skipped with `--fast`/`--dev`) → `bundle` → `copy` → `manifest` →
`verify-dist` → `package` (release only).

| Flag | Effect |
|---|---|
| `--dev` | No minification, `sourcemap: "linked"`, `__SL_DEBUG__ = true`, typecheck skipped, manifest marked `(dev)`, no zip. |
| `--fast` | Skip the typecheck only. |
| `--watch` | Parsed, not implemented. |

Build-time defines (`__SL_VERSION__`, `__SL_BUILD__`, `__SL_SPOOF_SEED__`, `__SL_LICENSE_URL__`,
`__SL_LICENSE_ENFORCE__`, `__SL_DEBUG__`) are declared in `src/types/chrome-ext.d.ts` and mirrored
by `test/setup.ts`. `__SL_SPOOF_SEED__` is fresh per build and shared with the emitted page
programs, so the MAIN-world identifiers differ between builds; set `SL_SPOOF_SEED` in the
environment to reproduce one.

`build.config.json` holds the product name, the website, the licence endpoint and
`licenseEnforce`.

### `verify-dist` (step 10)

Run as part of the build, or on its own with `bun run verify:dist`. It fails the build on:

- a path declared in the manifest that is not in `dist/` (icons, side panel, service worker,
  content scripts; `web_accessible_resources` patterns must match at least one file);
- a `web_accessible_resources` block without `use_dynamic_url: true` on every entry — with `key`
  pinned, a web-accessible path is a presence probe for any script on a matched site (§13.3), so
  v2 declares none at all;
- an unresolvable same-package reference reachable from the HTML — `src`/`href`, then `url()`
  and `@import` transitively through the CSS, so a missing font or stylesheet fails here;
- `js/panel.js` over 400 KB or `js/content.js` over 250 KB (every bundle's size is printed);
- a literal `console.` in a production bundle (the logger's own use is `console[level]`, a
  computed member, so any literal one is a stray call);
- a host from the constants registry appearing in a bundle `HOST_OWNERS` does not allow — the
  licence host outside the service worker, or *any* registry host in `content.js` or a
  `js/page/*.js` — and a registry host that `HOST_OWNERS` does not classify at all;
- a `.js.map` in a release package (dev maps embed the original TypeScript, so they are checked
  for absence rather than scanned).

Those size ceilings are a specification, not a knob. If a build breaches one, the finding is the
size — report it and shrink the bundle.

### Packaging

`bun run build` writes `release/sliced-<version>.zip` with the tree at the archive root
(`manifest.json` first, not `dist/manifest.json`). The zip is ~63 MB because the ChessMimic bands
(3 × 18 MB) and the engine (16 MB) ship inside it. That is well over the Chrome Web Store's 
limit, which does not apply here: §12.2 distributes a zip plus the unpacked folder, there is no
`update_url`, and "update available" is a version poll (`src/service/update-check.ts`) with a
manual download.

---

## 4. Testing

```sh
bun run test              # every file, one process each
bun test test/foo.test.ts # one file
bun test --watch          # while iterating
```

`scripts/test-runner.sh` runs one Bun process per file because Bun leaks `mock.module` state
across files in a single process. It also picks up `tools/**/*.test.ts`.

Three tiers:

- **Unit** — pure functions, under 5 ms each. The bulk of `test/core/**`.
- **Behavioural** — the simulator in `test/sim/`: a fake `chrome` (storage, ports, alarms, tabs,
  commands, debugger, offscreen, side panel, tts), a controllable clock, a happy-dom tab, and the
  `ac` telemetry shadow that reconstructs what chess.com's `fps` plugin would have recorded.
- **Integration** — `test/integration/`, including a real Stockfish boot.

Rules that matter more than the tiers: never weaken an existing assertion to make new code pass
(a newly failing assertion is a finding to diagnose), and the §13 telemetry assertions are
release gates, not style preferences.

Things the automated suite structurally cannot answer — real focus behaviour, cross-origin
isolation, live site DOM, in-browser latency — live in `docs/qa-checklist.md` and
`docs/qa/focus-discipline.md`.

---

## 5. Licensing obligations

**Read this before giving anyone a build.**

The extension bundles third-party code and weights under copyleft and source-available licences.
`docs/third-party.md` is the notice file, and it is **generated by `scripts/vendor-engine.ts`** —
regenerate it with `bun run vendor:engine`; never hand-edit it.

### 5.1 Stockfish (GPL-3.0-or-later) and stockfish-web (AGPL-3.0-or-later)

`assets/engine/` holds unmodified copies of the published `@lichess-org/stockfish-web` files:
Emscripten glue and build patches under **AGPL-3.0-or-later**, wrapping **Stockfish 18** under
**GPL-3.0-or-later**. sliced.gg's own code is not derived from Stockfish — it drives the engine
over UCI through the package's public API — but the engine still ships inside the package.

**Distributing a build to anyone (a zip, a shared `dist/`, a hosted download) triggers the
written offer of corresponding source under GPL-3.0 §6 / AGPL-3.0 §6.** In practice that means:

1. The full AGPL text ships as `assets/engine/LICENSE` and is inside every zip.
2. `docs/third-party.md` names the exact upstream sources — the stockfish-web repository at the
   vendored npm version, and the Stockfish commit behind tag `sf_18` — and states that the
   maintainers will supply those sources on request, on a durable medium.
3. That offer must remain honourable for as long as builds are distributed, and the contact route
   it points at (https://sliced.sh) must actually reach someone. **Confirm the contact route
   before the first public release** — it is the one part of the notice that no script can check.
4. If you ever modify the vendored engine files, the "unmodified copies" wording in the notice
   stops being true and you must publish the modified sources yourself.

### 5.2 ChessMimic timing weights (PolyForm Noncommercial 1.0.0)

`assets/models/chessmimic/*.onnx` are derived from ChessMimic's published checkpoints (Thomas
Johnson, 2026). Both the code and the **trained weights** are under the **PolyForm Noncommercial
License 1.0.0**, so they may be used only for non-commercial purposes. That is a condition on the
product, not just on the files: **selling sliced.gg, or any commercial distribution, would breach
this licence while these bands ship.** The required copyright notice is reproduced in
`docs/third-party.md`; the FEN tokeniser underneath is Apache-2.0 (google-deepmind), transcribed
in `src/core/timing/chessmimic-tokeniser.ts`.

If the product ever needs to be commercial, the timing head has to be retrained or replaced — the
v1 head in `src/core/timing/v1-head.ts` is the licence-clean fallback and already runs whenever
inference is unavailable.

### 5.3 Fonts and Font Awesome

`assets/fonts/` ships Geist, Geist Mono and Bricolage Grotesque with their licence files
alongside; Font Awesome Free is vendored under `assets/vendor/fontawesome/`. Nothing is loaded
from a CDN — the extension CSP forbids remote script and the panel must work offline.

### 5.4 The licence gate is currently forced open

`LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__`, and `build.config.json` ships
`licenseEnforce: false`. Every key therefore validates as `valid` regardless of what the endpoint
says; the endpoint's real verdict is preserved in `LicenseState.rawStatus` for diagnostics and is
what the Engine view shows. This is deliberate and inherited from v1 (whose gate was
`if (reply.includes('"valid"') || true)`): there are no locks right now, by intent. Leave the
flag, the gate and the login view's force-valid path alone.

---

## 6. Releasing

1. Bump `version` in `package.json` (the manifest's version is stamped from it — do not edit
   `manifest.json`'s `version` by hand).
2. `bun run check` → green.
3. `bun run build` → `release/sliced-<version>.zip`, with `verify-dist` passing and the size
   report in the build log.
4. Work through `docs/qa-checklist.md` on a real browser and a real chess.com game; record the
   results.

5. Publish the zip, and update the `version` in the manifest served at `URLS.websiteManifest` —
   that file is what every installed copy polls to decide whether an update exists.
6. Note the Chrome version and OS you tested on in the release notes.
