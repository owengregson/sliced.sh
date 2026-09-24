// scripts/vendor-engine.ts — vendor Stockfish 19 (`@lichess-org/stockfish-web`) and the
// all NNUE variants into `assets/engine/` (Task 10, §6.1–6.2).
//
// 1. Copies the files named by `ENGINE_FILES` (+ the AGPL `LICENSE`) from the installed npm
//    package into `assets/engine/`, and `stockfishWeb.d.ts` into `src/types/stockfish-web.d.ts`.
// 2. Downloads registered nets from `URLS.nnueMirror` unless verified sources already exist.
//    A net's file name is its SHA-256 prefix, checked before writing. The large net is stored
//    as deterministic gzip to fit the Git host's file limit; build emits verified raw bytes.
// 3. Writes `docs/third-party.md`: versions, the source offer and the SHA-256 of every file —
//    including the opening books in `assets/books/` (Task 15; built by
//    `scripts/build-club-book.py`, described here, never downloaded) and the vendored UI fonts
//    section (Task 27; `FONT_FAMILIES`, `renderFontsSection`).
// 4. Task 34: vendors onnxruntime-web (`ORT_FILES` from the pinned npm package + the MIT text
//    from the onnxruntime repository at the same tag) into `assets/vendor/onnxruntime/`, checks
//    the exported ChessMimic bands in `assets/models/chessmimic/` against the registry
//    (`CHESSMIMIC_BAND_FILES`) and renders both notices (PolyForm Noncommercial 1.0.0 beside the
//    Stockfish AGPL notice; MIT for onnxruntime-web).
// 5. Maia-3 (2026-09-11): checks the exported policy models in `assets/models/maia3/` against
//    the registry (`MAIA_MODEL_FILES`; the 79M file is joined from its `.part<i>` slices first)
//    and renders the AGPL-3.0-or-later notice with the per-size Hugging Face provenance and the
//    source offer (`renderMaiaSection`).
//
// The step is three stages, each its own module under `vendor-engine/`:
//   fetch.ts         — the only writes into the repository and the only network access;
//   verify.ts        — reads what is vendored and checks it against the registry and manifests;
//   notice/*.ts      — pure renderers from those descriptions to `docs/third-party.md`.
// This file is the public entry (everything below is re-exported) and the CLI.
//
// Run: `bun run vendor:engine` (re-runnable; idempotent when nothing changed).

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeFiles } from "./lib/fs";
import { ROOT } from "./lib/paths";
import { bulletList } from "./lib/report";
import {
	copyPackageFiles,
	packageVersion,
	vendorNetworks,
	vendorOnnxRuntime,
} from "./vendor-engine/fetch";
import { describeFonts } from "./vendor-engine/fonts";
import type { TheoryBookManifest } from "./vendor-engine/manifests";
import { renderThirdParty } from "./vendor-engine/notice/third-party";
import { loadRegistry } from "./vendor-engine/registry";
import { DOCS_DEST, PACKAGE_NAME, TYPES_DEST } from "./vendor-engine/upstream";
import {
	describeMaia,
	describeModels,
	packageFiles,
	readBookManifests,
	staleEngineFiles,
} from "./vendor-engine/verify";

export type { VendoredFile } from "./lib/fs";
export { ROOT } from "./lib/paths";
export { nnueHashPrefix, sha256Hex, verifyNnueHash } from "./nnue-assets";
export { vendorOnnxRuntime } from "./vendor-engine/fetch";
export {
	describeFonts,
	FONT_BUDGET_BYTES,
	FONT_FAMILIES,
	FONT_UNICODE_RANGE_CSS,
	FONT_UNICODES,
	FONTS_DIR,
	type FontFamilyNotice,
	type VendoredFont,
} from "./vendor-engine/fonts";
export type {
	BookManifest,
	MaiaManifest,
	MaiaNotice,
	ModelsManifest,
	ModelsNotice,
	TheoryBookManifest,
} from "./vendor-engine/manifests";
export { bookCommand, theoryBookCommand } from "./vendor-engine/notice/books";
export { renderFontsSection } from "./vendor-engine/notice/fonts";
export { renderMaiaSection } from "./vendor-engine/notice/maia";
export { renderModelsSection } from "./vendor-engine/notice/models";
export { renderOnnxRuntimeSection } from "./vendor-engine/notice/onnxruntime";
export { renderThirdParty, type ThirdPartyNotice } from "./vendor-engine/notice/third-party";
export type {
	BookRegistry,
	EngineRegistry,
	MaiaRegistry,
	ModelsRegistry,
} from "./vendor-engine/registry";
export { PACKAGE_NAME } from "./vendor-engine/upstream";
export {
	describeMaia,
	describeModels,
	packageFiles,
	readBookManifests,
	staleEngineFiles,
} from "./vendor-engine/verify";

export async function vendorEngine(): Promise<void> {
	const registry = await loadRegistry();
	const { ENGINE_DIR, ENGINE_FILES, ENGINE_NNUE_SOURCES, nnueMirror } = registry;
	const destDir = path.join(ROOT, ENGINE_DIR);
	await mkdir(destDir, { recursive: true });

	// fetch: the Stockfish package's programs and licence, then the nets
	const version = await packageVersion();
	const copied = packageFiles(ENGINE_FILES);
	await copyPackageFiles(copied, destDir);
	console.log(`copied ${copied.length} files from ${PACKAGE_NAME}@${version} to ${ENGINE_DIR}`);
	const networks = await vendorNetworks(nnueMirror, ENGINE_NNUE_SOURCES, destDir);

	// verify + describe (the onnxruntime copy runs here, in its historical order)
	const engineFiles = await describeFiles(destDir, [
		...copied,
		...ENGINE_NNUE_SOURCES.map((spec) => spec.source),
	]);
	const stale = staleEngineFiles(await readdir(destDir), ENGINE_FILES, ENGINE_NNUE_SOURCES);
	if (stale.length > 0)
		console.warn(
			`${ENGINE_DIR}: ${stale.length} file(s) the registry no longer ships — delete them:${bulletList(stale)}`
		);
	const [typesFile] = await describeFiles(path.dirname(TYPES_DEST), [path.basename(TYPES_DEST)]);
	if (!typesFile) throw new Error("types file missing after copy");
	const { BOOKS } = registry;
	const books = await readBookManifests(path.join(ROOT, BOOKS.dir), [BOOKS.gm2600, BOOKS.club]);
	const [theoryBook] = await readBookManifests<TheoryBookManifest>(path.join(ROOT, BOOKS.dir), [
		BOOKS.theory,
	]);
	const fonts = await describeFonts();
	const onnxruntime = await vendorOnnxRuntime(registry);
	const models = await describeModels(registry);
	const maia = await describeMaia(registry.maia);

	// notice
	await writeFile(
		DOCS_DEST,
		renderThirdParty({
			version,
			registry,
			engineFiles,
			networks,
			typesFile,
			books,
			...(theoryBook ? { theoryBook } : {}),
			fonts,
			models,
			onnxruntime,
			maia,
		})
	);
	console.log(`wrote ${path.relative(ROOT, DOCS_DEST)}`);
}

if (import.meta.main) await vendorEngine();
