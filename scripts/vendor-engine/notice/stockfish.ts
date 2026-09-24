// scripts/vendor-engine/notice/stockfish.ts — the Stockfish section: components, the written
// source offer (GPL-3.0 §6 / AGPL-3.0 §6), network integrity and the vendored-file tables.

import type { VendoredFile } from "../../lib/fs";
import type { EngineRegistry } from "../registry";
import {
	LICENSE_FILE,
	PACKAGE_NAME,
	PACKAGE_REPO,
	STOCKFISH_BASE_COMMIT,
	STOCKFISH_REPO,
	STOCKFISH_TAG,
	TYPES_FILE,
} from "../upstream";
import { fileRow } from "./table";

export interface StockfishNotice {
	version: string;
	registry: EngineRegistry;
	engineFiles: VendoredFile[];
	/** Decoded networks shipped by build, including any compressed repository source. */
	networks: VendoredFile[];
	typesFile: VendoredFile;
}

/** From the section heading through the types-only line (no trailing newline). */
export function renderStockfishSection(n: StockfishNotice): string {
	const { ENGINE_DIR, ENGINE_FILES, nnueMirror, website } = n.registry;
	const fullNets = ENGINE_FILES.full.nnue;
	// `ENGINE_NNUE_SOURCES` gzips exactly the first full net, so that is the one the prose names.
	const [big] = fullNets;
	return `## Stockfish 19 — \`${PACKAGE_NAME}\` ${n.version}

sliced.sh bundles a WebAssembly build of the Stockfish chess engine under \`${ENGINE_DIR}\` and
drives it over UCI from an offscreen document. The engine is a separate program: sliced.sh's own
code is not derived from Stockfish and talks to it only through the package's public API
(\`uci\`, \`setNnueBuffer\`, \`listen\`, \`onError\`).

| Component | Version | License | Source |
|---|---|---|---|
| \`${PACKAGE_NAME}\` (build scripts, patches, Emscripten glue) | ${n.version} | AGPL-3.0-or-later | ${PACKAGE_REPO} |
| Stockfish | 19 (tag \`${STOCKFISH_TAG}\`, base \`${STOCKFISH_BASE_COMMIT.slice(0, 8)}\`) | GPL-3.0-or-later | ${STOCKFISH_REPO} |
| NNUE network \`${ENGINE_FILES.smallnet.nnue}\` (smallnet weights) | — | distributed by the Stockfish project | ${nnueMirror}${ENGINE_FILES.smallnet.nnue} |
${fullNets.map((name) => `| NNUE network \`${name}\` (full-build weights) | — | distributed by the Stockfish project | ${nnueMirror}${name} |`).join("\n")}

Targets vendored: \`sf_19_smallnet_relaxed-simd\` (Stockfish 19 with the sscg13/size-optimize-nnue
patch) and \`sf_19_relaxed-simd\` (the full build). Only the relaxed-SIMD variants ship:
relaxed SIMD has been in Chrome since 114 and the manifest's \`minimum_chrome_version\` is 128,
so the package's plain-SIMD \`sf_19\` / \`sf_19_smallnet\` programs are not vendored (2026-09-13).
Stockfish 19 retired the secondary network that sat inside the full build, so that build now loads
a single network, \`${big}\`, bundled alongside the smallnet's own. Switching to full
strength loads installed extension bytes without downloading networks. The repository stores
the full net as \`${big}.gz\` using deterministic gzip (level 9, no timestamp or filename) to keep
the checked-in file small. Build verifies and expands it to \`${big}\` and excludes the
compressed source from the extension; runtime does not decompress it.

### Source offer

Engine programs in \`${ENGINE_DIR}\` are unmodified copies of the npm package's published files;
network bytes come from the Stockfish project's mirror above. The complete corresponding source is:

- the build scripts, patches and glue at ${PACKAGE_REPO} (npm version ${n.version});
- the Stockfish sources at ${STOCKFISH_REPO}/commit/${STOCKFISH_BASE_COMMIT} (tag \`${STOCKFISH_TAG}\`).

The full AGPL-3.0 text ships with the extension as \`${ENGINE_DIR}${LICENSE_FILE}\`. On request,
the sliced.sh maintainers will also provide these sources on a durable medium, as required by
GPL-3.0 §6 / AGPL-3.0 §6; contact details are at ${website}. The same written offer covers the
corresponding source of every other GPL/AGPL component in this document — the Maia-3 models in
their own section below included.

### Network integrity

A Stockfish net is named \`nn-<first 12 hex digits of its SHA-256>.nnue\`. All decoded network bytes
are verified against their names both when vendored and when built. Cached or downloaded fallback
copies for older installations are verified before use. Build never needs a network connection
when the checked-in sources are present.

### Networks shipped in the extension (raw bytes)

| File | Bytes | SHA-256 |
|---|---|---|
${n.networks.map(fileRow).join("\n")}

### Vendored files (\`${ENGINE_DIR}\`)

| File | Bytes | SHA-256 |
|---|---|---|
${n.engineFiles.map(fileRow).join("\n")}

Types only (not shipped): \`src/types/stockfish-web.d.ts\` copied from the package's
\`${TYPES_FILE}\` (${n.typesFile.bytes} bytes, SHA-256 \`${n.typesFile.sha256}\`).`;
}
