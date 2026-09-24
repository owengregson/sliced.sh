// scripts/nnue-assets/codec.ts — a Stockfish net's repository source (raw, or deterministic gzip)
// to and from its canonical bytes, verified against the SHA-256 prefix in its name.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { sha256Hex } from "../lib/hash";

const decompress = promisify(gunzip);
const compress = promisify(gzip);
const NNUE_NAME_RE = /^nn-([0-9a-f]{12})\.nnue$/;
export const HASH_PREFIX_LEN = 12;

export interface NnueSource {
	name: string;
	source: string;
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
