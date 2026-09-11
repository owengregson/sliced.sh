import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

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

/** Copy assets once, excluding network source files which are verified and materialized below. */
export async function copyBundledAssets(root: string, dist: string): Promise<void> {
	// Plain Bun build scripts do not have bundler defines until their dynamic registry import.
	const g = globalThis as Record<string, unknown>;
	g.__SL_LICENSE_ENFORCE__ ??= false;
	g.__SL_LICENSE_URL__ ??= "";
	const { ENGINE_DIR, ENGINE_NNUE_SOURCES } = await import("../src/core/constants/engine-files");
	const engineDir = path.join(root, ENGINE_DIR);
	const sources = new Set(ENGINE_NNUE_SOURCES.map((spec) => path.join(engineDir, spec.source)));
	await cp(path.join(root, "assets"), path.join(dist, "assets"), {
		recursive: true,
		filter: (source) => !sources.has(source),
	});
	await writeBundledNnue(engineDir, path.join(dist, ENGINE_DIR), ENGINE_NNUE_SOURCES);
}
