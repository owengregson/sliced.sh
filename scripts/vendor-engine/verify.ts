// scripts/vendor-engine/verify.ts — check what is vendored against the registry and the export
// manifests, and describe it (name, bytes, SHA-256) for the notice. Reads only; writes nothing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describeFiles, readJson, type VendoredFile } from "../lib/fs";
import { sha256Hex } from "../lib/hash";
import { ROOT } from "../lib/paths";
import { maiaSourceNames, readMaiaSource } from "../maia-assets";
import type { NnueSource } from "../nnue-assets/codec";
import type {
	BookManifest,
	MaiaManifest,
	MaiaNotice,
	ModelsManifest,
	ModelsNotice,
} from "./manifests";
import type { EngineRegistry, MaiaRegistry, ModelsRegistry } from "./registry";
import { LICENSE_FILE } from "./upstream";

/**
 * Package files copied verbatim into `ENGINE_DIR` (everything but the nets): the relaxed-SIMD
 * programs only (2026-09-13; `ENGINE_PROGRAM_FILES` lists the same four) and the AGPL text.
 */
export function packageFiles(files: EngineRegistry["ENGINE_FILES"]): string[] {
	const { smallnet, full } = files;
	return [smallnet.js, smallnet.wasm, full.js, full.wasm, LICENSE_FILE];
}

/**
 * Files in `ENGINE_DIR` that neither the registry's programs, its net sources nor the licence
 * account for — a build that stopped shipping (the plain-SIMD `sf_19*.js/.wasm`), a superseded one
 * (every `sf_18*` program and net after the 2026-09-15 move to Stockfish 19) or
 * a stray download. They never reach the package (`copyBundledAssets` copies by allowlist), but
 * they sit in the repository; the vendor step names them so they get deleted.
 */
export function staleEngineFiles(
	onDisk: readonly string[],
	files: EngineRegistry["ENGINE_FILES"],
	sources: readonly NnueSource[]
): string[] {
	const keep = new Set([...packageFiles(files), ...sources.map((spec) => spec.source)]);
	return onDisk.filter((name) => !keep.has(name) && !name.startsWith(".")).sort();
}

/** Load every `<book>.build.json` for the registry's books. */
export async function readBookManifests<M extends { sha256: string } = BookManifest>(
	dir: string,
	names: string[]
): Promise<Array<{ file: VendoredFile; manifest: M }>> {
	const files = await describeFiles(dir, names);
	const out: Array<{ file: VendoredFile; manifest: M }> = [];
	for (const file of files) {
		const manifestPath = path.join(dir, `${file.name}.build.json`);
		if (!existsSync(manifestPath))
			throw new Error(`${file.name}: missing ${path.basename(manifestPath)} (run its build script)`);
		const manifest = await readJson<M>(manifestPath);
		if (manifest.sha256 !== file.sha256)
			throw new Error(`${file.name}: manifest sha256 ${manifest.sha256} != file ${file.sha256}`);
		out.push({ file, manifest });
	}
	return out;
}

// ── Task 34: ChessMimic bands (`assets/models/chessmimic/`) ─────────────────────────────────

/** Sizes + hashes of the exported bands and side files, checked against the registry. */
export async function describeModels(registry: ModelsRegistry): Promise<ModelsNotice> {
	const dir = path.join(ROOT, registry.MODELS_DIR);
	const manifestPath = path.join(dir, registry.CHESSMIMIC_FILES.manifest);
	if (!existsSync(manifestPath))
		throw new Error(`${registry.CHESSMIMIC_FILES.manifest} missing (run 08_export_chessmimic.py)`);
	const manifest = await readJson<ModelsManifest>(manifestPath);
	if (manifest.upstream.commit !== registry.CHESSMIMIC_UPSTREAM.commit)
		throw new Error(
			`models.json commit ${manifest.upstream.commit} != registry ${registry.CHESSMIMIC_UPSTREAM.commit}`
		);
	const bandNames = [...registry.CHESSMIMIC_BANDS].filter(
		(b) => registry.CHESSMIMIC_BAND_FILES[b]?.bundled
	);
	const bands = await describeFiles(
		dir,
		bandNames.map((b) => `${b}${registry.CHESSMIMIC_FILES.onnxSuffix}`)
	);
	for (const band of bandNames) {
		const reg = registry.CHESSMIMIC_BAND_FILES[band];
		const man = manifest.bands[band];
		const file = bands.find((f) => f.name === `${band}${registry.CHESSMIMIC_FILES.onnxSuffix}`);
		if (!reg || !man || !file) throw new Error(`${band}: missing in registry, manifest or on disk`);
		if (reg.sha256 !== file.sha256 || reg.bytes !== file.bytes)
			throw new Error(`${band}: registry ${reg.sha256} != file ${file.sha256} (update models.ts)`);
		if (man.sha256 !== file.sha256)
			throw new Error(`${band}: manifest ${man.sha256} != file ${file.sha256}`);
	}
	const f = registry.CHESSMIMIC_FILES;
	const sideFiles = await describeFiles(dir, [f.scalers, f.buckets, f.vocab, f.manifest]);
	return { manifest, bands, sideFiles };
}

// ── Maia-3 policy models (`assets/models/maia3/`) ────────────────────────────────────────────

/**
 * Sizes + hashes of the exported Maia-3 models as shipped (joined) and as stored, checked
 * against the registry and the export manifest.
 */
export async function describeMaia(registry: MaiaRegistry): Promise<MaiaNotice> {
	const dir = path.join(ROOT, registry.MAIA_DIR);
	const manifestPath = path.join(dir, registry.MAIA_FILES.manifest);
	if (!existsSync(manifestPath))
		throw new Error(`${registry.MAIA_FILES.manifest} missing (run 09_export_maia3.py)`);
	const manifest = await readJson<MaiaManifest>(manifestPath);
	if (manifest.upstream.repo !== registry.MAIA_UPSTREAM.repo)
		throw new Error(
			`maia3 models.json repo ${manifest.upstream.repo} != registry ${registry.MAIA_UPSTREAM.repo}`
		);
	if (manifest.upstream.license !== registry.MAIA_UPSTREAM.license)
		throw new Error(
			`maia3 models.json license ${manifest.upstream.license} != registry ${registry.MAIA_UPSTREAM.license}`
		);
	const models: VendoredFile[] = [];
	const sourceNames: string[] = [];
	for (const size of registry.MAIA_SIZES) {
		const reg = registry.MAIA_MODEL_FILES[size];
		const man = manifest.models[size];
		if (!reg || !man) throw new Error(`maia3 ${size}: missing in registry or manifest`);
		// Reads the whole file or joins its parts; throws unless bytes and SHA-256 match the registry.
		const data = await readMaiaSource(dir, reg, registry.MAIA_FILES);
		const file = { name: reg.file, bytes: data.length, sha256: sha256Hex(data) };
		if (man.sha256 !== file.sha256 || man.bytes !== file.bytes || man.parts !== reg.parts)
			throw new Error(`maia3 ${size}: manifest ${man.sha256} != file ${file.sha256}`);
		models.push(file);
		sourceNames.push(...maiaSourceNames(reg, registry.MAIA_FILES));
	}
	const licenseText = await readFile(path.join(dir, registry.MAIA_FILES.license), "utf8");
	if (!licenseText.includes("GNU AFFERO GENERAL PUBLIC LICENSE"))
		throw new Error(`${registry.MAIA_DIR}${registry.MAIA_FILES.license} is not the AGPL-3.0 text`);
	const sources = await describeFiles(dir, sourceNames);
	const sideFiles = await describeFiles(dir, [
		registry.MAIA_FILES.manifest,
		registry.MAIA_FILES.license,
	]);
	return { manifest, models, sources, sideFiles };
}
