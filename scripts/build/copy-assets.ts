// scripts/build/copy-assets.ts — build step `copy`, part 1: `assets/` → `dist/assets/`.
//
// Ordinary assets are copied verbatim; everything with a canonical form is materialised
// instead — NNUE nets decoded from their gzip sources, Maia models joined from their parts,
// ChessMimic bands checked — and packed where the registry says so, each verified before write.

import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { packagedModelName } from "../../src/core/constants/model-packing";
import { installRegistryDefines } from "../lib/defines";
import { sha256Hex } from "../lib/hash";
import { JUNK_FILE_RE } from "../lib/junk-files";
import { maiaSourceFiles, writeBundledMaia } from "../maia-assets";
import { bundledModelBytes } from "../model-packing";
import { writeBundledNnue } from "../nnue-assets/codec";

export interface BundledAssetFilterOptions {
	/** Absolute paths of source files the build materialises itself (never copied verbatim). */
	sources: ReadonlySet<string>;
	/** Absolute path of the engine directory; only `engineFiles` are copied out of it. */
	engineDir: string;
	/** Bare file names allowed out of `engineDir` (the programs and the licence; nets are written). */
	engineFiles: ReadonlySet<string>;
}

/**
 * The `cp` filter for `assets/` → `dist/assets/`: drops Finder/Explorer droppings (`JUNK_FILE_RE`
 * — three `.DS_Store`s shipped in the 2026-09-13 zip), the sources the build materialises, and —
 * by allowlist — anything in `assets/engine/` the registry does not ship, so a build that stopped
 * being vendored (the plain-SIMD programs) cannot ride along just because it is still on disk.
 * Directories pass; `cp` recurses into them and filters their files one by one.
 */
export function bundledAssetFilter(
	options: BundledAssetFilterOptions
): (source: string) => boolean {
	const engineDir = path.resolve(options.engineDir);
	return (source) => {
		const name = path.basename(source);
		if (JUNK_FILE_RE.test(name)) return false;
		if (options.sources.has(source)) return false;
		if (path.dirname(path.resolve(source)) === engineDir) return options.engineFiles.has(name);
		return true;
	};
}

/** Copy ordinary assets and write verified NNUE/model packages from canonical source files. */
export async function copyBundledAssets(root: string, dist: string): Promise<void> {
	// Plain Bun build scripts do not have bundler defines until their dynamic registry import.
	installRegistryDefines();
	const [
		{ ENGINE_DIR, ENGINE_LICENSE_FILE, ENGINE_NNUE_SOURCES, ENGINE_PROGRAM_FILES },
		{ MAIA_DIR, MAIA_FILES, MAIA_MODEL_FILES, MAIA_SIZES },
		{ MODELS_DIR, CHESSMIMIC_BAND_FILES, CHESSMIMIC_BANDS, chessMimicBandFile },
	] = await Promise.all([
		import("../../src/core/constants/engine-files"),
		import("../../src/core/constants/maia"),
		import("../../src/core/constants/models"),
	]);
	const engineDir = path.join(root, ENGINE_DIR);
	const maiaDir = path.join(root, MAIA_DIR);
	const maiaSpecs = MAIA_SIZES.map((size) => MAIA_MODEL_FILES[size]);
	const timingSpecs = CHESSMIMIC_BANDS.filter((band) => CHESSMIMIC_BAND_FILES[band].bundled).map(
		(band) => ({ ...CHESSMIMIC_BAND_FILES[band], file: chessMimicBandFile(band) })
	);
	const sources = new Set([
		path.join(root, "assets/sounds/best_v2.mp3"),
		...ENGINE_NNUE_SOURCES.map((spec) => path.join(engineDir, spec.source)),
		...maiaSourceFiles(maiaSpecs, MAIA_FILES).map((name) => path.join(maiaDir, name)),
		...timingSpecs.map((spec) => path.join(root, MODELS_DIR, spec.file)),
	]);
	await cp(path.join(root, "assets"), path.join(dist, "assets"), {
		recursive: true,
		filter: bundledAssetFilter({
			sources,
			engineDir,
			engineFiles: new Set([...ENGINE_PROGRAM_FILES, ENGINE_LICENSE_FILE]),
		}),
	});
	await writeBundledNnue(engineDir, path.join(dist, ENGINE_DIR), ENGINE_NNUE_SOURCES);
	await writeBundledMaia(maiaDir, path.join(dist, MAIA_DIR), maiaSpecs, MAIA_FILES);
	for (const spec of timingSpecs) {
		const data = await readFile(path.join(root, MODELS_DIR, spec.file));
		if (data.length !== spec.bytes || sha256Hex(data) !== spec.sha256)
			throw new Error(`${spec.file}: source model checksum mismatch`);
		await writeFile(
			path.join(dist, MODELS_DIR, packagedModelName(spec.file, spec.packed)),
			bundledModelBytes(data, spec)
		);
	}
}
