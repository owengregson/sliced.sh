import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { packagedModelName } from "../src/core/constants/model-packing";
import { maiaSourceFiles, writeBundledMaia } from "./maia-assets";
import { packModel, verifyPackedModel } from "./model-packing";
import { JUNK_FILE_RE } from "./verify-dist";

const decompress = promisify(gunzip);
const compress = promisify(gzip);
const NNUE_NAME_RE = /^nn-([0-9a-f]{12})\.nnue$/;
const HASH_PREFIX_LEN = 12;

export interface NnueSource {
	name: string;
	source: string;
}

export function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function nnueHashPrefix(name: string): string | undefined {
	return NNUE_NAME_RE.exec(name)?.[1];
}

export function verifyNnueHash(data: Uint8Array, name: string): boolean {
	const expected = nnueHashPrefix(name);
	return expected !== undefined && sha256Hex(data).slice(0, HASH_PREFIX_LEN) === expected;
}

/** Deterministic gzip (no timestamp or original filename), only for the source repository. */
export async function encodeNnueSource(data: Uint8Array, spec: NnueSource): Promise<Uint8Array> {
	if (!verifyNnueHash(data, spec.name)) throw new Error(`${spec.name}: NNUE checksum mismatch`);
	return spec.source.endsWith(".gz") ? compress(data, { level: 9 }) : data;
}

/** Verify decoded bytes, so a corrupted gzip or a valid gzip of the wrong net cannot ship. */
export async function readNnueSource(dir: string, spec: NnueSource): Promise<Uint8Array> {
	const source = await readFile(path.join(dir, spec.source));
	const data = spec.source.endsWith(".gz") ? await decompress(source) : source;
	if (!verifyNnueHash(data, spec.name)) throw new Error(`${spec.name}: NNUE checksum mismatch`);
	return data;
}

/** Writes only canonical raw .nnue files. Runtime never pays decompression or remote I/O. */
export async function writeBundledNnue(
	sourceDir: string,
	destDir: string,
	specs: readonly NnueSource[]
): Promise<void> {
	await mkdir(destDir, { recursive: true });
	for (const spec of specs) {
		const data = await readNnueSource(sourceDir, spec);
		await writeFile(path.join(destDir, spec.name), data);
	}
}

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
	const g = globalThis as Record<string, unknown>;
	g.__SL_LICENSE_ENFORCE__ ??= false;
	g.__SL_LICENSE_URL__ ??= "";
	const [
		{ ENGINE_DIR, ENGINE_LICENSE_FILE, ENGINE_NNUE_SOURCES, ENGINE_PROGRAM_FILES },
		{ MAIA_DIR, MAIA_FILES, MAIA_MODEL_FILES, MAIA_SIZES },
		{ MODELS_DIR, CHESSMIMIC_BAND_FILES, CHESSMIMIC_BANDS, chessMimicBandFile },
	] = await Promise.all([
		import("../src/core/constants/engine-files"),
		import("../src/core/constants/maia"),
		import("../src/core/constants/models"),
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
		const bundled = spec.packed ? packModel(data) : data;
		if (spec.packed) verifyPackedModel(bundled, spec.bytes, spec.sha256);
		await writeFile(path.join(dist, MODELS_DIR, packagedModelName(spec.file, spec.packed)), bundled);
	}
}
