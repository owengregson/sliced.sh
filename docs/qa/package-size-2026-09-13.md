# Package size — 2026-09-13

Owner: "figure out other ways to optimize the size of the extension zip, without requiring
external downloads when using it. it should be ready out of the box."

> **Partly superseded on 2026-09-15** by the move to Stockfish 19: the full build's second net
> (`nn-37f18f62d772.nnue`, 3.5 MB) no longer exists, and the vendored programs are now `sf_19_*`.
> Every per-entry size below is the 2026-09-13 archive as measured under Stockfish 18 and stands
> as that record; re-measure before citing any of it as current.

Baseline: `release/sliced-2.0.0.zip` built 2026-09-13 18:24 — **335,544,879 B (320.0 MiB)**,
102 entries, 414,978,231 B (395.8 MiB) unpacked. Every number below is the archive's own
per-entry size (`unzip -lv`), so the "after" totals are computed, not rebuilt: the owner runs
`bun run build`. The zip is deflate level 9 already (`scripts/package.ts`); `memLevel: 9` was
measured on the smallnet and made it 12 KB *larger*, so the settings stay.

## What the package is

| Asset | Raw | In zip | Verdict |
|---|---:|---:|---|
| `assets/models/maia3/maia3-79m.onnx` | 156,212,736 | 143,388,657 | stays (fp16 already; the policy model) |
| `assets/models/maia3/maia3-23m.onnx` | 45,887,562 | 41,782,760 | **removed** — other lane (Maia 5M/23M drop) |
| `assets/models/maia3/maia3-5m.onnx` | 10,868,016 | 9,579,467 | **removed** — other lane |
| `assets/engine/nn-c288c895ea92.nnue` (full big net) | 108,919,594 | 71,594,714 | stays — the max-strength verdicts need it |
| `assets/models/chessmimic/*.onnx` × 3 | 54,601,443 | 49,707,582 | stay — already fp16 (see below) |
| `assets/engine/nn-4ca89e4b3abf.nnue` (smallnet net) | 15,054,352 | 10,277,934 | stays — loaded by the smallnet build (see below) |
| `assets/vendor/onnxruntime/ort-wasm-simd-threaded.wasm` | 13,961,845 | 3,597,771 | stays — the only ORT variant vendored; the loader picks exactly it |
| `assets/engine/nn-37f18f62d772.nnue` (full small net) | 3,519,630 | 2,864,424 | stays — the full build's second net |
| `assets/engine/sf_18_*relaxed-simd.{js,wasm}` × 2 | 1,255,689 | 443,816 | stay — the engine |
| `assets/engine/sf_18.{js,wasm}`, `sf_18_smallnet.{js,wasm}` (plain SIMD) | 1,255,051 | 442,828 | **removed** — this lane |
| `assets/sounds/` (13 files) | 1,143,878 | 660,650 | untouchable (C5) |
| `js/` (5 bundles) | 934,757 | 314,860 | stay |
| `assets/vendor/fontawesome/` | 356,351 | 283,201 | stay (follow-up below) |
| `assets/books/` | 456 KB | — | stay |
| `assets/fonts/` | 148 KB | 127 KB | stay (already subset, woff2) |
| `.DS_Store` × 3 (`assets/`, `assets/models/`, `assets/vendor/`) | 18,444 | 660 | **removed** — this lane |
| `.js.map` | 0 | 0 | none in a release (`verify-dist` rule 7) |

## Before / after

| | Raw (unpacked) | Zip |
|---|---:|---:|
| Baseline (2026-09-13 18:24) | 414,978,231 B — 395.8 MiB | 335,544,879 B — 320.0 MiB |
| This lane alone (plain-SIMD builds + junk) | 413,704,736 B — 394.5 MiB | 335,101,391 B — 319.6 MiB |
| With the Maia 5M/23M drop (other lane) | 356,949,158 B — 340.4 MiB | 283,739,164 B — 270.6 MiB |

Honest summary: this lane removes 1.27 MB raw / 0.44 MB zipped. The package is models and nets,
and every one of them is loaded by something the product does offline. The list below says what
each remaining item would cost to cut.

## Findings by item

### a. Which nets are loaded by which build — nothing to drop

`getRecommendedNnue(i)` is asked at boot (`src/offscreen/stockfish-loader.ts`) and every name it
returns is fed with `setNnueBuffer`:

- `sf_18_smallnet_relaxed-simd` → `nn-4ca89e4b3abf.nnue` (15 MB). The smallnet build is what
  runs at every target Elo up to `LIMITS.nnueSmallEloMax` (3200) with `nnue: "auto"` — the whole
  human range — and it is the crash fallback for the full build (`EngineHost.fallBackIfRepeated`,
  after the 2026-09-12 pthread faults). Not an alternate big net: it is the only net that build
  reads.
- `sf_18_relaxed-simd` → `nn-c288c895ea92.nnue` (109 MB, big) + `nn-37f18f62d772.nnue` (3.5 MB,
  small). Selected above 3200 or with the `big` preference. The big net is the max-strength
  verdict; it stays.

The one engine-side lever left is to stop shipping the smallnet build and run the full build at
every Elo: −15.7 MB raw / −10.5 MB zipped. Costs: the 109 MB net resident in wasm memory for
every game (`LIMITS.engineMemoryInitialPages` starts at 160 MiB), a slower nps at the low Elos
that `UCI_LimitStrength` caps anyway, and no fallback build when the full one faults. That is a
behaviour change, so it was not made; it needs the owner's call.

### b. Build variants — plain-SIMD Stockfish dropped; ORT already single-variant

`manifest.json` requires Chrome 128; relaxed SIMD shipped in 114. The plain-SIMD `sf_18` and
`sf_18_smallnet` programs were reachable only through the loader's fallback branch, which no
supported Chrome takes. Changes:

- `ENGINE_FILES` (`src/core/constants/engine-files.ts`) names only the relaxed-SIMD programs;
  `ENGINE_PROGRAM_FILES`, `ENGINE_LICENSE_FILE` and `PACKAGED_ENGINE_FILES` say exactly what
  `assets/engine/` holds in the package.
- `chooseModule(variant)` no longer takes a probe result; the probe (`RELAXED_SIMD_PROBE`) is now
  a guard — `bootEngineDetailed` throws `RELAXED_SIMD_ERROR` where it fails, which the host
  reports as a crash instead of silently loading a build that is not there.
- `scripts/vendor-engine.ts` copies four programs plus the licence and warns about anything else
  left in `assets/engine/`; the notice text names the relaxed targets only.
- `copyBundledAssets` copies `assets/engine/` by allowlist, so a stale file on disk never ships;
  `verify-dist` rule 10 fails the build if the directory is not exactly the registry.

onnxruntime-web: only `ort-wasm-simd-threaded.wasm` is vendored (`ORT_FILES`); the `.jsep`,
`.asyncify` and `.jspi` variants in the npm package were never copied. Nothing to remove.

Bun's JavaScriptCore rejects the relaxed-SIMD wasm (`WebAssembly.validate` false for both shipped
builds, true for the plain ones), so the three real-wasm integration tests now run the package's
plain-SIMD glue from `node_modules` through `test/integration/engine-under-bun.ts` — same
Stockfish 18 sources and nets, a different instruction set — rather than skipping.

### c. ChessMimic bands — already fp16; int8 is the follow-up

`assets/models/chessmimic/models.json`: `precision: "fp16"`, each band "44 float16 initializers
behind Cast", `fp32Bytes: 36,059,775` → 18,200,481 on disk. The halving the brief asks about has
already happened (this is the same `Cast`-fold layout `09_export_maia3.py` uses), and fp16 bytes
deflate 9%, which is why the three bands cost 49.7 MB in the zip.

The next step is `tools/data/08_export_chessmimic.py --precision int8` (onnxruntime dynamic
quantisation; the flag exists). Expected: ≈ 9.2 MB per band (fp32 ÷ 4 plus the graph) → about
−27 MB raw and, since int8 weights barely deflate either, about −25 MB zipped. Not done here
(no torch in this environment). Parity gate before it ships:

1. the export's own torch-fp32 vs ONNX check on its random-position fixture (currently
   max |Δprob| 1.46e-3 at fp16; the script's tolerance is 2e-3 — an int8 export that exceeds it
   must not be registered);
2. `test/scripts/chessmimic-assets.test.ts` (`precision`, bytes and SHA-256 against the registry
   — `CHESSMIMIC_BAND_FILES` and `models.json` change together);
3. `test/offscreen/timing-inference.test.ts` over `test/fixtures/chessmimic-reference.json`, the
   shipped-band reference distribution, at the same tolerance;
4. a latency check that dynamic-quantised matmuls are not slower than fp16-behind-Cast on the
   wasm CPU provider (they can be; `docs/models.md` has the fp16 numbers to beat).

### d. Zip settings

`archiver("zip", { zlib: { level: 9 } })` — maximum deflate already, one compression method
for every entry. Measured: the big NNUE deflates 34%, the smallnet 32%, the ORT wasm 74%, the
fp16 ONNX files 8–9%. `memLevel: 9` was tried on `nn-4ca89e4b3abf.nnue`: 10,290,667 vs
10,277,952 bytes, i.e. worse. No change.

### e. Everything else

- **Junk files**: three `.DS_Store`s shipped. The copy filter now drops `.DS_Store`,
  `Thumbs.db`, `desktop.ini` and AppleDouble `._*` files anywhere under `assets/`, and
  `verify-dist` rule 9 fails a tree that still has one.
- **Source maps**: none in a release; rule 7 already enforces it.
- **Fonts**: the three UI fonts are instanced, subset woff2 (121 KB) — nothing left there.
- **Font Awesome** (356 KB raw, 283 KB zipped): `all.min.css` plus four woff2 weights. `ICONS`
  uses 51 solid glyphs, 8 regular and **one brand glyph** (`social.discord`), so
  `fa-brands-400.woff2` (115 KB) ships for a single icon and `fa-v4compatibility.woff2` (4 KB)
  for none. Follow-up, not done: subset the brands face to the one glyph (`pyftsubset`, as the UI
  fonts already are) and vendor `fontawesome.min.css` + `solid.min.css` + `regular.min.css` in
  place of `all.min.css`; `verify-dist` rule 3 will insist the CSS's `url()`s still resolve.
- **Docs, fixtures, `.part` slices in `dist/`**: none — `copyBundledAssets` copies `assets/`,
  `css/` and `pages/` only, the Maia join writes whole files, rule 8 fails on a `.part`.
- **`assets/engine/LICENSE`, `assets/models/maia3/LICENSE`**: required by the notice
  (`docs/DEVELOPMENT.md` §5).

## Files to delete from the repository

The registry no longer names them, the build no longer copies them, and `bun run vendor:engine`
will warn about them until they are gone:

- `assets/engine/sf_18.js`
- `assets/engine/sf_18.wasm`
- `assets/engine/sf_18_smallnet.js`
- `assets/engine/sf_18_smallnet.wasm`

Then `bun run vendor:engine` to regenerate `docs/third-party.md` (the vendored-files table and
the "Targets vendored" paragraph change; the file is generated, never hand-edited).

## Needs a browser

- The engine defaults changed in the same batch (owner: 8 threads, 64 MB hash —
  `LIMITS.threadsDefault` / `hashMbDefault`, `optionsForSettings`): confirm on an 8+ core
  machine that the offscreen document spawns eight `em-pthread` workers after
  `setoption name Threads value 8` (the glue allocates workers on demand, there is no fixed
  `PTHREAD_POOL_SIZE`), that `info … nps` scales, and that the full build with the 109 MB net,
  64 MB hash and eight thread stacks stays inside `LIMITS.engineMemoryMaxPages` (512 MiB) —
  no "Cannot enlarge memory" on the offscreen console. On a 4-core machine the Engine view must
  read `Threads 4 · Hash 64 MB`.
- Relaxed-SIMD only: on the oldest supported Chrome (128) the engine must boot from
  `sf_18_smallnet_relaxed-simd.js` and, above 3200, `sf_18_relaxed-simd.js`; the status must
  never show `RELAXED_SIMD_ERROR`. There is no fallback build any more, so this is the row that
  proves the manifest floor is enough.
- `bun run build` → `release/sliced-2.0.0.zip`: `unzip -l` must list no `sf_18.js`,
  `sf_18.wasm`, `sf_18_smallnet.*` or `.DS_Store`, and the size report must land near the
  computed totals above.
