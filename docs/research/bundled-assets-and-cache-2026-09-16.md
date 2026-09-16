# Bundled assets, package size and cache feasibility — 2026-09-16

This audit found **no substantial validated reduction of the first-install package** while
preserving the current models. The implemented lossless changes save 0.29%; that is useful
cleanup, not a solution to the ~300 MiB download. Keeping the current bundle, training smaller
models, distributing an offline model pack, and remote delivery remain distinct choices. Remote
delivery is not inevitable and would move the model transfer to setup rather than eliminate it.

The follow-up is read-only feasibility work. No CDN endpoint, runtime loader, model precision,
permission, download page or update-pack exporter was added. A remote-delivery implementation
requires the parent to choose the distribution contract first. No native Chrome or existing
user browser tab was used for this review; installed-extension behavior remains unverified.

## Measured before and after

The starting artifact was the existing Stockfish 19 `release/sliced-2.0.0.zip`, SHA-256
`0012970f0356e6475faebb855cff42714b2916fb4bbf7a7a1769883428503664`. Its own contents were extracted
to an isolated temporary directory, optimized, independently verified, and repackaged with the
repository's `packageDist`. This comparison isolates packaging from the other agents' runtime
and UI changes. The shared `dist/` and `release/` were not overwritten by this lane.

| Metric | Before | After | Saved |
|---|---:|---:|---:|
| Actual ZIP bytes | 316,394,763 | 315,472,109 | **922,654 (0.29%)** |
| ZIP MiB | 301.74 | 300.86 | 0.88 |
| Installed file bytes | 354,149,462 | 353,144,778 | 1,004,684 |
| Files, excluding directory records | 90 | 84 | 6 obsolete sounds |

The resulting archive is a packaging comparison artifact, not a fresh build of the concurrently
changing application. The parent should run the final integrated build and report its final
size. These changes are automatically applied by `scripts/build.ts` on subsequent builds.

## Implemented changes

1. Release builds recompress the existing lossless `SLM1` model representation using filtered
   deflate level 4 and keep it only when it is smaller. Level 9 is not guaranteed to be smallest
   for floating-point weights; here filtered level 4 beat it. Both the original and candidate
   restore to the canonical length and SHA-256 before replacement. Processing stays sequential
   to avoid seven simultaneous model allocations. Dev builds skip this extra optimization.
2. Both build modes keep only audio files named by `SOUNDS`, `MOVE_RATING_SOUNDS` and
   `FORCED_MATE_SOUNDS`. Every required name must exist before pruning starts. Source recordings
   remain untouched, retained clips are byte-identical, and text/license files are preserved.
   This removes `forced_1.mp3` through `forced_6.mp3` from generated packages; the runtime has
   used only `forced.mp3` since the existing September 15 migration. Subsequently, the parent
   preserved the unused source variants in ignored
   `.scratch/archived-assets/forced-sound-variants-20260916/`; the measurements below precede
   that source relocation and the build still guards against accidentally packaging them.

The seven compressed assets save **672,524 installed bytes**. The removed recordings save
**332,160 installed bytes / 245,976 ZIP payload bytes**. The rest of the ZIP change comes from
recompressing the new gzip payloads and removing archive entry headers. All 77 other retained
files were compared by SHA-256 and are unchanged. One omitted recording (`forced_3.mp3`) was an
exact duplicate of the active `forced.mp3`; the active recording remains. The only remaining
duplicate pair discovered was the two required Geist license notices; both remain.

| Model | Previous packed bytes | Optimized packed bytes |
|---|---:|---:|
| Maia 79M | 132,335,519 | 131,931,819 |
| ChessMimic 0–1000 | 15,316,344 | 15,268,242 |
| ChessMimic 1200–1300 | 15,318,153 | 15,268,116 |
| ChessMimic 1500–1600 | 16,302,363 | 16,276,886 |
| ChessMimic 1800–1900 | 15,321,643 | 15,271,678 |
| ChessMimic 2000–2100 | 15,319,764 | 15,272,301 |
| ChessMimic 2200–3500 | 15,315,465 | 15,267,685 |

No numerical inference experiment is needed to establish equality of these encodings: the
restored ONNX bytes match the existing canonical SHA-256 exactly. This is not a new precision
format or a smaller model.

### Smallest validated compatible archive experiment

An additional isolated archive experiment stores the seven `.onnx.pack.gz` files with ZIP
method `STORE`, retaining normal deflate for other files. It removes **60,168 bytes** of
redundant compression overhead from the optimized archive:

- **315,411,941 bytes / 300.80 MiB**, or 982,822 bytes (0.31%) below the original artifact.
- SHA-256: `1aec82655c6d3c600b17e256b8a6ee52fc84cf3143d6e7acb740c4c370bb6f36`.
- ZIP CRCs passed; all 84 extracted files are byte-identical to the implemented optimized
  artifact. No runtime decoder or inference changes are involved.

This is the smallest measured and validated candidate among these compatible archive
experiments, not a theoretical lower bound or a newly built application. The experiment did
not change `scripts/package.ts`; adopting it is a separate small packaging change for the
parent. The implemented optimized archive's SHA-256 is
`4a15b8e9f83083fea854f4872a3f71dce53b9219530a484689b4c76549b81796`.

### Exact remaining model components

These are the **315,472,109-byte implemented optimized archive**, before the optional ZIP
`STORE` experiment. Canonical bytes are the restored bytes consumed by ONNX Runtime or
Stockfish; installed bytes are the files extracted from the extension ZIP. All values are bytes.

| Asset filename | Canonical | Installed | ZIP payload |
|---|---:|---:|---:|
| `maia3-79m.onnx.pack.gz` | 156,212,736 | 131,931,819 | 131,969,603 |
| `0_1000.onnx.pack.gz` | 18,200,481 | 15,268,242 | 15,272,285 |
| `1200_1300.onnx.pack.gz` | 18,200,481 | 15,268,116 | 15,271,757 |
| `1500_1600.onnx.pack.gz` | 19,247,529 | 16,276,886 | 16,280,755 |
| `1800_1900.onnx.pack.gz` | 18,200,481 | 15,271,678 | 15,275,478 |
| `2000_2100.onnx.pack.gz` | 18,200,481 | 15,272,301 | 15,275,822 |
| `2200_3500.onnx.pack.gz` | 18,200,481 | 15,267,685 | 15,271,195 |
| `nn-1a298aa575a0.nnue` | 98,511,183 | 98,511,183 | 78,470,190 |
| `nn-61e7af4bb97d.nnue` | 1,166,381 | 1,166,381 | 966,946 |
| **All nine** | **366,140,234** | **324,234,291** | **304,054,031** |

The six timing models contribute 92,647,292 ZIP bytes; both SF19 networks contribute
79,437,136. Models now account for **96.38%** of the archive. Everything else, including ZIP
headers, occupies 11,418,078 bytes (10.89 MiB). There is no validated smaller neural network
replacement in this audit; the current canonical models remain the quality-preserving choice.

## What actually occupies the starting ZIP

| Group | ZIP payload bytes | Finding |
|---|---:|---|
| Maia 79M | 132,373,728 | One model, already fp16 weights and losslessly shuffled/gzipped |
| Six ChessMimic models | 92,918,981 | Distinct learned parameters, mostly fp16 |
| Full SF19 network | 78,470,190 | Raw size 98,511,183; used for full-strength review |
| Small SF19 network | 966,946 | Raw size 1,166,381; small enough that removal barely helps |
| Opening books | About 5.6 MB | Actual game/theory coverage, not duplicate engine data |
| ONNX Runtime WASM | 3,597,771 | One vendored WASM variant, not the full npm distribution |

The policy/timing models plus two NNUEs alone account for **96.3%** of the starting ZIP. There
are no leftover Stockfish 18 programs or source `.part` files in it. Splitting Maia into Git-safe
source parts is not the cause of release growth: the build joins them and ships one packed file.

Direct ONNX initializer inspection with the existing Python environment found:

- Maia: 155,691,008 bytes of fp16 weights, 14,348 bytes of fp32 weights, 160 initializers.
- Six timing models together: 106,136,576 bytes of fp16 weights and 2,540,240 bytes of fp32
  weights; 99 initializers per model. Some fp32 projections are intentional precision repairs.
- **Zero duplicate initializer payload bytes**, both across the timing models and within Maia.
  A content-addressed shared tensor store would not reduce the present learned weights.

## Alternatives investigated or worth pursuing

These are separate options, not promises of equivalent model behavior.

| Option | Evidence / likely benefit | Decision |
|---|---|---|
| Better ordinary gzip settings | Measured above; ~0.67 MB for all seven models | Implemented, with keep-smaller and canonical-hash checks |
| ZIP `STORE` for `.pack.gz` entries | Measured 60,168 bytes smaller after the implemented gzip changes; 315,411,941-byte archive has identical extracted files | Validated isolated candidate, not adopted in `scripts/package.ts`; no runtime change |
| More aggressive byte/bit transforms | A 1 MiB, 16-bit-plane prototype gave Maia 140,546,504 B with Python filtered-gzip level 4, worse than current 132,335,519 B | Rejected this prototype; does not rule out tensor-aware variants |
| Brotli | `brotli -q 5` on the existing shuffled Maia representation gave 131,803,724 B, only 128,095 B below the adopted gzip | Too little measured gain to add a new decoder/format and browser compatibility work |
| Deduplicate common weights | Actual initializer hashes found none | Not applicable to current exports |
| Reduced-operator ORT build | ORT's entire WASM contributes only 3.60 MB zipped | Possible smaller win; must retain all model operators and validate real Chrome inference |
| Subset unused icon-font glyphs | Brand font is ~115 KB zipped and the registry uses little of it | Useful polish, not a model-size solution; source/license and visual validation required |
| Selective int8 with sensitive layers retained | Can reduce more weight storage than gzip; existing broad dynamic-int8 attempts failed quality gates | Research only; requires held-out probability and timing-tail validation plus WASM benchmarks |
| Shared timing backbone with Elo-conditioned adapters | Six separate models are ~93 MB zipped; a jointly trained shared model could amortize most parameters | New training/distillation project. Current tensors cannot simply be shared or averaged |
| Distill Maia to a smaller policy | Could save many tens of MB | Must measure human move agreement and distribution quality at each Elo, not just engine strength; no unvalidated 5M/23M substitution |
| Full first-install ZIP plus small offline update packs | Code-only updates can omit unchanged model blobs and verify the already installed asset hashes | Improves repeat transfers only; initial installation still needs the full payload. No exporter requested or implemented in this follow-up |
| Separate user-owned offline model pack | A stable file can be reused between extension versions/reinstalls | Requires an explicit import/folder-selection workflow; not automatic origin-cache persistence |

The general bit-plane approach is described in the primary [Bitshuffle implementation](https://github.com/kiyo-masui/bitshuffle).
Our quick prototype used a different block arrangement and is only the measured candidate above.
For operator pruning, use the official [ONNX Runtime custom-build guide](https://onnxruntime.ai/docs/build/custom.html);
the theoretical maximum benefit here is bounded by the 3.60 MB of runtime already in the ZIP.

`docs/models.md` records earlier rejected dynamic-int8 experiments: Maia changed 3–5% of
probability mass and changed top-five ordering in 10–20% of tested positions; timing distributions
also shifted materially. Those are repository-recorded historical experiments, not reruns in
this audit. Current fp16 exports were verified by hashes. The primary [ONNX quantization guide](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
states that quantization is lossy, recommends comparing tensor activations and preserving
sensitive tensors, and warns that dynamic quantization adds inference overhead. The official
[float16 guide](https://onnxruntime.ai/docs/performance/model-optimizations/float16.html) likewise
requires validating accuracy after conversion. Another unconditional precision reduction is
not justified here.

Recommended gates before any new weights ship: preserve all current reference thresholds;
add a held-out, Elo-stratified human-game corpus; check legal-move probability drift, top-k and
actual human-move likelihood for Maia; compare sampled timing CDFs and fast/long tails for
ChessMimic; test the exact vendored Chrome WASM provider, cold-load memory and warm latency.
Smaller file size alone cannot justify a distribution shift in a model whose distribution is
the product's intended behavior.

## Existing endpoints: configured versus observed

The registry is `src/core/constants/urls.ts`. The read-only probes used only those configured
paths and the registered filenames. At **2026-09-16 07:44:13 UTC**, `HEAD` with redirects gave:

| Asset family | Configured route | Observed result | Runtime wiring |
|---|---|---|---|
| Full SF19 | `https://tests.stockfishchess.org/api/nn/nn-1a298aa575a0.nnue` | HTTP 200 after redirect to `https://data.stockfishchess.org/nn/nn-1a298aa575a0.nnue` | NNUE relay is attached; cache fallback exists |
| Small SF19 | `https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue` | HTTP 200 after the equivalent redirect to `data.stockfishchess.org/nn/` | Same active relay and store |
| Six ChessMimic bands | `https://sliced.sh/models/chessmimic/<band>.onnx` | All six connection attempts failed; a direct curl probe reported DNS resolution failure, also outside the sandbox | Relay exists but is **not attached** |
| Maia 79M | **No deployment URL configured** | No endpoint to test | Bundled-only store; no download/cache fallback |

The six ChessMimic bands tested were `0_1000`, `1200_1300`, `1500_1600`, `1800_1900`,
`2000_2100` and `2200_3500`. These paths expect **raw `.onnx`** files. They do not name the
bundled `.onnx.pack.gz` transport. The failure establishes unreachability from this environment,
not a 404 or proof that the assets are absent everywhere. Availability and content equivalence
remain unverified. Maia's GitHub/Hugging Face provenance links identify upstream training
checkpoints; they are not configured download URLs for this project's validated ONNX export.

Both SF19 responses advertised `application/octet-stream`, `Content-Encoding: gzip`,
`Accept-Ranges: bytes`, an ETag and `Cache-Control: public, max-age=31536000, immutable`.
`Content-Length` was 78,944,870 for the full net and 975,309 for the small net. These are the
gzip transfer sizes, not canonical decoded sizes. This probe did **not** redownload and hash
the bodies, test Range behavior, or execute the extension in Chrome.

The manifest already permits `sliced.sh`, both Stockfish hosts and `unlimitedStorage`.
The comment in `model-download.ts` saying the current band host still needs permission is
stale. A different future CDN host would need an explicit registry/manifest change. No CDN
endpoint was invented, and the current configuration does not establish working remote
delivery for all required models.

### Effect on the initial extension ZIP, if remote delivery were chosen

Subtracting the existing model payloads gives the following estimates. These are **not built
artifacts**: removing archive entries also removes small headers, and setup code would add
some bytes. All JS/WASM code, books, fonts and notices remain bundled in these estimates.

| Models omitted from the extension ZIP | Approximate remaining bytes | MiB |
|---|---:|---:|
| Full SF19 only | 237,001,919 | 226.02 |
| Maia only | 183,502,506 | 175.00 |
| Maia and all six timing models | 90,855,214 | 86.65 |
| All nine model assets | 11,418,078 | 10.89 |

These choices transfer roughly the omitted bytes during setup instead. They reduce the
extension download and repeated extension updates, not the cold user's total model transfer.
The only family with reachable configured endpoints and an active relay today is SF19;
making even that optional would still require build/verification and setup-flow changes.

## Read-only cache architecture review

| Component | Existing behavior | Relevant limit for optional onboarding |
|---|---|---|
| `src/offscreen/asset-store.ts` | Bundled file first, then OPFS, then IndexedDB, then service-worker download; validates cached/downloaded data before use; deduplicates simultaneous requests | Successful bundled reads are not copied into the cache. Settled requests leave the in-flight map; it is not a permanent raw-byte memory cache |
| `src/offscreen/model-store.ts` | Six bundled ChessMimic entries; packed bundled decoding and full canonical SHA-256; uses the shared cache | Remote path currently assumes raw ONNX bytes; packed remote transfer would need decoding support |
| `src/offscreen/nnue-store.ts` | Registered networks bundled; active fallback through the official mirror and shared cache | Cached/downloaded bytes check the 12-hex filename hash prefix. Bundled raw NNUE takes the raw branch without a runtime store hash check; build verification supplies the packaging check |
| `src/offscreen/maia-store.ts` | Bundled decoding, canonical byte count and full SHA-256; concurrent-request deduplication | No OPFS/IndexedDB persistence, remote relay or refresh path |
| `src/service/handlers/engine/download-relay.ts` | Streams 4 MiB slices as base64 port messages; reports errors; avoids buffering the whole response in the service worker | Offscreen still assembles all chunks in memory. No persisted partial download, HTTP Range resume or fetch cancellation |
| `src/service/handlers/engine/index.ts` | Registers restart/status handlers and `attachNnueDownload` | `attachModelDownload` is defined separately but not registered |
| `src/offscreen/index.ts` | Emits `nnue-progress`; constructs the timing store without a progress callback and Maia separately | No aggregate job progress for all asset families or panel setup snapshot |

Corrupt cached data is deleted from OPFS and IndexedDB before download. A checksum mismatch
allows two download attempts. OPFS writes use a writable file and close it before success;
IndexedDB is the fallback. If both persistence mechanisms fail, the current load can still
succeed in memory, so present code cannot claim that setup has established a reusable cache.

Cache keys are filenames. Model registry hash changes reject stale entries; content-named
NNUE revisions naturally use different keys, but there is no old-revision garbage collector.
There is no common asset revision manifest or completed-setup record. In-flight transfers
are lost when the offscreen/port lifecycle aborts them. Completed cached assets can be reused
while the installed extension retains its origin storage.

Existing progress is a fraction of chunks, not persisted bytes plus decode/startup phases.
When content length is unknown, the relay uses a rolling count until the final chunk. HTTP
gzip also makes the observed wire content length differ from the decoded fetch body length;
that denominator cannot support a truthful overall percentage without an explicit asset-size
contract. Active transfers use a 120-second stall budget and a separate one-hour total budget.

Inference sessions already provide the useful warm-memory cache: the policy host retains one
Maia session and the timing host retains up to two sessions. Re-reading a bundled asset after
eviction/restart is different from making a new network download. The full review engine shares
NNUE retrieval with the playing engine; the separate engine instances do not duplicate files
inside the release ZIP.

## Persistence across update versus uninstall

Extension-origin storage is appropriate for reuse during an installed extension's lifetime,
but it is **not an uninstall-surviving model cache**. Chrome documents deletion of
[`storage.local` on removal](https://developer.chrome.com/docs/extensions/reference/api/storage).
Chromium's [uninstall path](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/chrome_extension_registrar_delegate.cc)
calls the [data deleter](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/data_deleter.cc),
which clears the extension origin's storage partition as well as extension storage. OPFS,
IndexedDB and Cache Storage do not provide an exemption. Pinning the extension ID does not
change that deletion.

`unlimitedStorage` and `navigator.storage.persist()` address quota/eviction during installation;
they do not promise survival of uninstall. See Chrome's [storage and cookies guide](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).
`storage.sync` also has only about 100 KB total quota, so it cannot hold these assets.

There are honest ways to keep bytes outside the extension's deleted origin:

- A user-owned model-pack file/directory, accessed through an explicit file picker. Reinstall
  can reimport it after selection and SHA-256 validation. The old origin's file handle cannot
  be promised to survive. Chrome's [File System Access guidance](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
  requires checking/requesting permission for file access.
- A separately installed native helper can own an ordinary disk cache. This adds an installer
  and platform-specific host registration; it is not a capability a ZIP-only extension has by
  itself. See [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
- For this project's existing **Load unpacked from a user directory** workflow, the directory
  already survives removal from Chrome. The uninstall source linked above explicitly preserves
  unpacked directories outside Chrome's managed installation directory. Re-selecting that
  folder reuses its bundled model files without a network download. Chrome-managed installs
  and arbitrary caches do not have this same behavior.

A website-origin cache could outlive extension removal, but it adds a separately hosted origin,
permissions/partitioning concerns and eviction risk. An ordinary HTTP cache is also opportunistic.
Neither is a reliable guarantee that only the extension can decide when assets disappear.

## Smallest coherent first-open scope, only if remote delivery is selected

The current UI is a **side panel**, not an action popup. `SidePanelPolicy` normally enables it
on Chess.com tabs; a requirement that setup be reachable on any first toolbar click would also
need to account for that policy. The panel already rehydrates from `PANEL_GET_SNAPSHOT` on boot
and reconnection, which is a suitable way to recover setup progress after closing/reopening it.

The minimum feature crosses these boundaries; a progress bar alone cannot provide it:

1. **Asset contract and packaging.** Choose the exact hosted model set, real URLs, raw versus
   packed transport, canonical SHA-256s and byte limits, plus asset revisions independent of the
   extension version. Keep JS/WASM local. Change the affected build copy/`verify-dist` rules so
   deliberately external models are valid, while missing required bundled assets still fail.
2. **Reuse the stores and relay.** Wire the existing ChessMimic relay if those files are hosted;
   give Maia the shared verified-cache path. Decode packed transfers explicitly if selected.
   Add true per-file byte/phase status and require successful cache persistence before declaring
   reusable setup complete. There is no need for a second unrelated cache manager.
3. **One setup coordinator outside the view.** A service/offscreen job checks required assets,
   downloads absent revisions, verifies them and reports current status through
   `PanelSnapshot`/`panel-broadcaster.ts`. Closing the panel must not cancel the job. Reopening
   reads its status; a process restart rechecks completed assets and retries the incomplete
   file. This minimum can restart an interrupted file; byte-range resume is an optional further
   improvement, not a prerequisite to the first version.
4. **Setup view and routing.** Add a view/template/copy/tokens using `panel/view.ts`, `router.ts`
   and the existing shell. Gate the normal route on setup readiness. Show downloading,
   unpacking, verification and starting phases; unknown totals are indeterminate. Expose retry
   on failure. Completion falls through the existing license route, preserving today's
   intentional force-valid setting rather than introducing a new auth flow.
5. **Startup ordering and focused verification.** Coordinate `game-stack.ts`, offscreen engine
   startup and policy/timing warmups so they do not race incomplete setup. Cache all selected
   required assets, then initialize the engines and currently needed inference sessions; do
   not hold all six timing sessions concurrently. Check fresh/warm/offline starts, corrupt
   cached data, interrupted transfer, panel reopen, persistence failure and license routing
   with local tests. Native extension behavior remains unverified unless separately authorized.

No automatic uninstall-surviving cache can be promised. Optional offline import, differential
update packs, HTTP Range/ETag resume and a native helper are separate product decisions and are
not part of this minimum scope. The parent still needs to choose **whether remote delivery is
desired**, which assets it covers, and a working hosting/format contract. This report supplies
the feasibility and measured tradeoffs; no implementation was started.

## Validation and handoff

- Packaging/assets tests passed: build-sound pruning (2), model recompression (3), Maia assets
  (11), ChessMimic assets (7), package ZIP contract (3), model streaming decode (3), and
  `verify-dist` (50): **79 tests** total, each file run in its own Bun process.
- The isolated optimized full tree passed `verifyDist`; its ZIP passed CRC validation. Exactly
  seven gzip encodings changed, six obsolete recordings disappeared, and 77 retained files had
  identical SHA-256s.
- The production streaming decoder restored all seven full optimized model files to their
  registered canonical SHA-256s. Measured Bun decode-plus-hash times were 574 ms for Maia and
  63–76 ms per timing model; these are functional checks, not installed-Chrome performance QA.
- Biome passed for the four changed/new TypeScript files; `git diff --check` passed.
- Follow-up cache unit tests passed independently: Maia store (8), model store (12), NNUE
  store (13): **33 additional tests**. Existing cache behavior is tested, not a future downloader.
- The ZIP `STORE` experiment passed archive CRC and all-file equality checks. Endpoint probes
  were read-only HEAD requests; they establish neither body equivalence nor installed-browser
  behavior. No native Chrome, user tabs or live extension tests were used for the follow-up.
- Whole-tree typecheck encountered the other lane's in-progress
  `tools/timing/distribution-report.ts` `EvalLine[] | undefined` error (line 77 initially,
  line 99 on the final check as that file changed concurrently). Final integrated checks
  belong to the parent; this lane does not edit that file or run a competing shared build.

Implementation files: `scripts/build.ts`, `scripts/optimize-model-packages.ts`,
`test/scripts/build-assets.test.ts`, `test/scripts/optimize-model-packages.test.ts`.
This lane performed no commits, pushes, stashes, source-asset cleanup or `.gitignore` edits.
The parent's source-audio archival is noted above and was not undone.
