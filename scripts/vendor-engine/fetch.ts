// scripts/vendor-engine/fetch.ts — the writing half of the vendor step: copy the pinned npm
// packages' files into the repository and download what is missing (the NNUE nets from the
// Stockfish mirror, the onnxruntime MIT text). Anything already present and verified is kept,
// so a re-run with complete sources touches no network.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { download } from "../lib/download";
import { describeFiles, readJson, type VendoredFile } from "../lib/fs";
import { sha256Hex } from "../lib/hash";
import { ROOT } from "../lib/paths";
import {
	encodeNnueSource,
	HASH_PREFIX_LEN,
	type NnueSource,
	readNnueSource,
	verifyNnueHash,
} from "../nnue-assets/codec";
import type { ModelsRegistry } from "./registry";
import { PACKAGE_DIR, PACKAGE_NAME, TYPES_DEST, TYPES_FILE } from "./upstream";

export async function packageVersion(): Promise<string> {
	const pkg = await readJson<{ version?: string }>(path.join(PACKAGE_DIR, "package.json"));
	if (!pkg.version) throw new Error(`${PACKAGE_NAME}: package.json has no version`);
	return pkg.version;
}

/** Copy `names` from the Stockfish package into `destDir`, and its types into `src/types/`. */
export async function copyPackageFiles(names: string[], destDir: string): Promise<void> {
	for (const name of names) {
		const src = path.join(PACKAGE_DIR, name);
		if (!existsSync(src)) throw new Error(`${PACKAGE_NAME} does not ship ${name}`);
		await copyFile(src, path.join(destDir, name));
	}
	await copyFile(path.join(PACKAGE_DIR, TYPES_FILE), TYPES_DEST);
}

async function hasVerifiedNet(dir: string, spec: NnueSource): Promise<boolean> {
	try {
		await readNnueSource(dir, spec);
		return true;
	} catch {
		return false;
	}
}

async function downloadNet(mirror: string, spec: NnueSource, destDir: string): Promise<void> {
	const { name, source } = spec;
	const url = mirror + name;
	const res = await download(url);
	const data = new Uint8Array(await res.arrayBuffer());
	if (!verifyNnueHash(data, name))
		throw new Error(`${name}: sha256 ${sha256Hex(data).slice(0, HASH_PREFIX_LEN)} != name`);
	await writeFile(path.join(destDir, source), await encodeNnueSource(data, spec));
}

/**
 * Ensure every registered net source is present and verified (downloading only the missing or
 * corrupt ones), and describe the decoded networks the build will ship.
 */
export async function vendorNetworks(
	mirror: string,
	sources: readonly NnueSource[],
	destDir: string
): Promise<VendoredFile[]> {
	const networks: VendoredFile[] = [];
	for (const spec of sources) {
		if (await hasVerifiedNet(destDir, spec)) console.log(`${spec.source}: present and verified`);
		else await downloadNet(mirror, spec, destDir);
		const data = await readNnueSource(destDir, spec);
		networks.push({ name: spec.name, bytes: data.length, sha256: sha256Hex(data) });
	}
	return networks;
}

// ── Task 34: onnxruntime-web ────────────────────────────────────────────────────────────────

const ORT_PACKAGE_DIR = (registry: ModelsRegistry): string =>
	path.join(ROOT, "node_modules", registry.ORT_PACKAGE);

/** Copy `ORT_FILES` from the pinned package and fetch the MIT text from the tagged repository. */
export async function vendorOnnxRuntime(registry: ModelsRegistry): Promise<VendoredFile[]> {
	const pkgDir = ORT_PACKAGE_DIR(registry);
	const pkg = await readJson<{ version?: string }>(path.join(pkgDir, "package.json"));
	if (pkg.version !== registry.ORT_VERSION)
		throw new Error(
			`${registry.ORT_PACKAGE}@${pkg.version} installed; registry pins ${registry.ORT_VERSION}`
		);
	const destDir = path.join(ROOT, registry.ORT_DIR);
	await mkdir(destDir, { recursive: true });
	const names = [registry.ORT_FILES.module, registry.ORT_FILES.loader, registry.ORT_FILES.wasm];
	for (const name of names) {
		const src = path.join(pkgDir, "dist", name);
		if (!existsSync(src)) throw new Error(`${registry.ORT_PACKAGE} does not ship dist/${name}`);
		await copyFile(src, path.join(destDir, name));
	}
	const licenseDest = path.join(destDir, registry.ORT_FILES.license);
	if (!existsSync(licenseDest) || !(await readFile(licenseDest, "utf8")).includes("MIT License")) {
		const url = `${registry.onnxruntimeRaw}v${registry.ORT_VERSION}/${registry.ORT_FILES.license}`;
		const text = await (await download(url)).text();
		if (!text.includes("MIT License")) throw new Error(`${url} is not the MIT licence text`);
		await writeFile(licenseDest, text);
	}
	console.log(
		`vendored ${names.length} files from ${registry.ORT_PACKAGE}@${registry.ORT_VERSION} to ${registry.ORT_DIR}`
	);
	return describeFiles(destDir, [...names, registry.ORT_FILES.license]);
}
