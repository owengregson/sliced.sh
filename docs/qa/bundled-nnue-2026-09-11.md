# Bundled full NNUE — 2026-09-11

The installed extension now contains all three Stockfish networks. Above the product's 3200
small-network cutoff, switching to the full engine reads local extension bytes. The selectable
3800 endpoint requests unlimited engine strength; the bundled engine still advertises native
`UCI_Elo` 1320–3190, so 3800 is not a calibrated human rating.

The big net is 108,919,594 bytes, exceeding GitHub's 100 MiB file limit. Its deterministic gzip
source is 72,754,416 bytes and is checked in alongside the raw 3,519,630-byte companion. Build
verifies decoded network hashes, emits canonical raw `.nnue` files, and excludes the compressed
source from the extension. No runtime decompression is required. Missing package assets retain
the verified OPFS/IndexedDB and download-relay fallback for older installations.

Upstream network names and engine base were checked against the
[Stockfish web build](https://github.com/lichess-org/stockfish-web/blob/main/README.md).
The source representation fits [GitHub's file-size limit](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
Exact raw and source hashes are generated in [third-party.md](../third-party.md) by
`bun run vendor:engine`; vendoring validated all three existing sources without fetching a network.

Validation:

- 64 targeted tests passed across NNUE storage, source packaging, vendoring, loader, engine
  controller, and options. They cover repeated local strength switches, cache migration,
  missing/corrupt source rejection, and the 3800 maximum configuration.
- `bun test test/integration/full-engine.test.ts` passed with real full Stockfish WASM. It
  materialized the checked-in sources in a temporary package directory, used the production
  NNUE store with no cache and a disabled download relay, loaded both full networks, and found
  a legal depth-8 best move. Preparation, boot, and search completed in 1.04 seconds on this
  machine with no engine stderr. This is a runtime smoke check, not an Elo benchmark.
- Release build and ZIP inspection are performed separately by the release task.
