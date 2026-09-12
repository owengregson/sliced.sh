# Model coverage, precision and lossless packaging — 2026-09-14

The extension now bundles **six ChessMimic bands plus Maia-3 79M**. The new `0_1000` checkpoint
covers novice targets previously sent to the 1200–1300 model. Its 0–2 second first bucket is
wider than the other bands' 0–1 second bucket, so timing decoding must use per-band metadata.
The five existing bands' scaler and bucket metadata are unchanged.

No model was trained. The original `1500_1600` checkpoint was re-exported with its eight
attention output projections retained in fp32: the new 1,000-position fixture exposed 0.00225
probability error with those matrices in fp16, exceeding the fixed 0.002 gate. The new layout
reduces this to 0.00151 and adds 1,047,048 canonical bytes. Its source hash intentionally changed.
The other four existing timing models and Maia are byte-identical to their previous exports.

## Package format

Every canonical ONNX file is packed losslessly as `.onnx.pack.gz`. `scripts/model-packing.ts`
writes gzip containing an 8-byte header: ASCII `SLM1`, then canonical length as uint32
little-endian. Each subsequent block of at most 1 MiB groups even-indexed source bytes before
odd-indexed bytes. Grouping float16 exponent bytes improves compression; graph bytes and odd
final blocks are restored exactly without parsing ONNX.

`src/offscreen/model-unpack.ts` uses native gzip decompression and restores blocks directly into
the final ONNX allocation, with at most 1 MiB of explicit scratch. It rejects unsupported
headers, wrong lengths, truncation, excess bytes and invalid gzip. The stores verify the
canonical SHA-256 before inference. `verify-dist` independently restores and hashes all seven
packages and rejects raw duplicates, unknown models and split source parts. Source exports,
source parts, checkpoint pins and model manifests remain canonical artifacts.

The [Compression Streams API](https://developer.chrome.com/blog/compression-streams-api/) is
available from Chromium 80, below the extension's Chrome 128 minimum. No extra codec library,
server dependency or extension permission is required.

## Size

Measured with Bun 1.3.11 on macOS using gzip/ZIP deflate level 9. ZIP values are compressed entry
payloads without archive headers. Different zlib builds may produce different compressed bytes.

| Model | Current canonical bytes | Packed installed bytes | Canonical ZIP payload | Packed ZIP payload |
|---|---:|---:|---:|---:|
| maia3-79m | 156,212,736 | 132,335,519 | 143,388,657 | 132,373,728 |
| 0_1000 | 18,200,481 | 15,316,344 | 16,567,128 | 15,320,566 |
| 1200_1300 | 18,200,481 | 15,318,153 | 16,566,006 | 15,322,296 |
| 1500_1600 | 19,247,529 | 16,302,363 | 17,552,389 | 16,306,830 |
| 1800_1900 | 18,200,481 | 15,321,643 | 16,568,483 | 15,325,790 |
| 2000_2100 | 18,200,481 | 15,319,764 | 16,568,255 | 15,323,923 |
| 2200_3500 | 18,200,481 | 15,315,465 | 16,564,068 | 15,319,576 |
| Total | 266,462,670 | 225,229,251 | 243,774,986 | 225,292,709 |

For the same seven models, packing saves **41,233,419 B installed** and **18,482,277 B in ZIP
payloads**. Relative to the task's original six-model baseline (247,215,141 B canonical,
226,228,562 B zipped payload), the final package is **21,985,890 B / 20.97 MiB smaller installed**
and **935,853 B smaller in ZIP payloads**, while adding the novice model and improving the
1500-band export precision. These are model totals; the root build measures the complete ZIP.

## Cold load and memory

The isolated native Chrome 152 inference run decoded timing bands in 52–76 ms and Maia in
418 ms. Sessions then reused the decoded model; warm queries perform no decompression or fetch.
This is headless Chrome against localhost files, not an installed extension under engine load.

Separate Bun processes measured 509–860 ms for Maia and 73–135 ms for timing bands across runs
with different machine contention. Raw local reads were 22 ms and 4 ms respectively. Packing
therefore adds a cold-load cost. Session prewarm keeps that cost off normal move timing;
recreating an offscreen document mid-game can exceed the existing inference deadline and must
fall back safely.

Sampled Bun RSS grew by 329–338 MB for packed Maia versus 158 MB raw, and 65–76 MB for timing
bands versus 19.5 MB raw. These include Bun's stream buffers and allocation behavior, not only
explicit decoder scratch. Installed Chrome process peaks under Stockfish load were not measured.
Gzip reduces disk usage; ORT still expands stored fp16 into fp32 working weights.

## Numerical and runtime validation

The six-band export's full 1,000-position fp32 reference passed the unchanged 0.002 tolerance.
The largest export error was 0.00151 for the higher-precision 1500-band layout. The exporter now
rejects an fp16 export above that tolerance before writing its final manifest.

Actual package stores and vendored WASM inference under Bun passed 200 timing positions across
all six bands (maximum probability error 0.000561, query p50 31.6 ms / p95 34.5 ms). Maia passed
60/60 fp32-reference argmax and top-five sets, maximum probability difference 0.000599.

An isolated native Chrome 152 profile additionally restored and hashed every packed model,
created real WASM sessions and ran:

- Ten positions per timing band, including novice: 60 total, maximum probability difference
  0.000700; per-band warm query medians 32.1–36.5 ms.
- All 60 Maia positions: 60/60 argmax and top-five sets, maximum probability difference 0.000599;
  warm query p50 176.6 ms / p95 179.2 ms.

These are functional and numerical checks, not a speed-comparison experiment. Neither the source
probability tolerance nor the move-policy acceptance criteria were loosened.

For a fresh release build:

```sh
SLICED_PACKAGED_ROOT="$PWD/dist" bun test test/integration/chessmimic-onnx.test.ts test/integration/maia-onnx.test.ts
bun test test/offscreen/model-unpack.test.ts test/offscreen/model-store.test.ts test/offscreen/maia-store.test.ts test/scripts/chessmimic-assets.test.ts test/scripts/maia-assets.test.ts test/scripts/verify-dist.test.ts
```

The integration environment flag makes unreadable package models fail rather than silently skip.
Streaming unit checks cover one-byte input chunks, odd tails, multiple blocks, wrong versions,
wrong lengths, gzip corruption, truncation and excess output. Store checks verify canonical
hashes after decompression and preserve shared in-flight loads.

## Full-engine runtime check

A subsequent full check reported `call_indirect to a signature that does not match` in the
full Stockfish test's Emscripten pthread trampoline under Bun 1.3.11. Three immediate focused
reruns passed unchanged, but the same failure recurred in another full check. Its exact Bun
runtime cause was not established.

The previous fixture used npm's plain-SIMD program because Bun cannot run the shipped relaxed
SIMD. The revised fixture always runs in a Node/V8 subprocess and exercises the shipped
relaxed-SIMD JS/WASM, including the production feature probe, loader and NNUE store. Fresh raw
NNUE files still pass the package writer's checksum checks, and all eight existing assertions
remain, with two added checks for the Node runtime and registered module. Program paths are
adapted to Node's Worker constructor; production code and engine assets are unchanged.

A missing Node runtime, unsupported SIMD, crash, timeout or missing report fails directly;
there are no retries or conditional skips. This tests the deployed engine variant more
faithfully but does not diagnose or claim to fix Bun's plain-SIMD failure. Browser-specific
cross-origin isolation and extension lifecycle still require native Chrome validation.

The revised fixture passed twice under Node 25.6.1 (1.20 and 1.16 seconds), with all ten
assertions. Separate deliberate missing-runtime and exit-17 checks confirmed that these
conditions fail the Bun test and preserve the subprocess diagnostic.
