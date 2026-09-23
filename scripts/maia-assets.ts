// Maia source parts join to canonical ONNX bytes; packed releases restore those exact bytes.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { packagedModelName } from "../src/core/constants/model-packing";
import { sha256Hex } from "./lib/hash";
import { bundledModelBytes } from "./model-packing";

/** The registry entry the build needs (`MaiaModelFile` minus the provenance). */
export interface MaiaSourceSpec {
	file: string;
	bytes: number;
	sha256: string;
	parts: number;
	packed?: boolean;
}

/** `MAIA_FILES`'s split layout. */
export interface MaiaPartLayout {
	partSuffix: string;
	partBytes: number;
}

/** `<file>.part<i>`. */
export function maiaPartName(file: string, index: number, layout: MaiaPartLayout): string {
	return `${file}${layout.partSuffix}${index}`;
}

/** The names a spec is stored under in the source tree: the whole file, or its parts. */
export function maiaSourceNames(spec: MaiaSourceSpec, layout: MaiaPartLayout): string[] {
	if (spec.parts <= 1) return [spec.file];
	return Array.from({ length: spec.parts }, (_, i) => maiaPartName(spec.file, i, layout));
}

/**
 * Every source-tree name the build must not copy verbatim: the parts of a split file *and* the
 * whole file names, so a stray whole copy next to its parts cannot bypass verification.
 */
export function maiaSourceFiles(
	specs: readonly MaiaSourceSpec[],
	layout: MaiaPartLayout
): string[] {
	const out = new Set<string>();
	for (const spec of specs) {
		out.add(spec.file);
		for (const name of maiaSourceNames(spec, layout)) out.add(name);
	}
	return [...out];
}

/** Number of parts a file of `bytes` is split into at `partBytes` per part (never 0). */
export function maiaPartCount(bytes: number, partBytes: number): number {
	if (!Number.isInteger(partBytes) || partBytes <= 0)
		throw new Error(`partBytes must be a positive integer, got ${partBytes}`);
	return Math.max(1, Math.ceil(bytes / partBytes));
}

/**
 * Consecutive slices of exactly `partBytes` then the remainder. An exact multiple yields no
 * empty tail; a buffer at or under `partBytes` is one part. The slices are views, not copies.
 */
export function splitMaiaSource(data: Uint8Array, partBytes: number): Uint8Array[] {
	const count = maiaPartCount(data.length, partBytes);
	const parts: Uint8Array[] = [];
	for (let i = 0; i < count; i += 1)
		parts.push(data.subarray(i * partBytes, Math.min(data.length, (i + 1) * partBytes)));
	return parts;
}

/** The inverse of `splitMaiaSource`: one contiguous buffer. */
export function joinMaiaParts(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** Throws unless `data` is byte-for-byte the registered file. */
export function verifyMaiaBytes(data: Uint8Array, spec: MaiaSourceSpec): void {
	if (data.length !== spec.bytes)
		throw new Error(`${spec.file}: ${data.length} bytes, registry says ${spec.bytes}`);
	const sha = sha256Hex(data);
	if (sha !== spec.sha256) throw new Error(`${spec.file}: sha256 ${sha} != registry ${spec.sha256}`);
}

/**
 * Read a model from the source tree (whole, or joined from its parts) and verify it. Every part
 * but the last must be exactly `partBytes` long — the layout is part of the contract, so a
 * re-split at a different size is reported as such instead of as a hash mismatch.
 */
export async function readMaiaSource(
	dir: string,
	spec: MaiaSourceSpec,
	layout: MaiaPartLayout
): Promise<Uint8Array> {
	const names = maiaSourceNames(spec, layout);
	const parts: Uint8Array[] = [];
	for (let i = 0; i < names.length; i += 1) {
		const name = names[i] ?? "";
		const part = new Uint8Array(await readFile(path.join(dir, name)));
		if (names.length > 1 && i < names.length - 1 && part.length !== layout.partBytes)
			throw new Error(
				`${name}: ${part.length} bytes, every part but the last must be ${layout.partBytes}`
			);
		parts.push(part);
	}
	const data = parts.length === 1 ? (parts[0] ?? new Uint8Array()) : joinMaiaParts(parts);
	verifyMaiaBytes(data, spec);
	return data;
}

/** Write the source tree's form of a verified model: whole, or split per the layout. */
export async function writeMaiaSource(
	dir: string,
	spec: MaiaSourceSpec,
	layout: MaiaPartLayout,
	data: Uint8Array
): Promise<string[]> {
	verifyMaiaBytes(data, spec);
	const names = maiaSourceNames(spec, layout);
	const parts = names.length === 1 ? [data] : splitMaiaSource(data, layout.partBytes);
	if (parts.length !== names.length)
		throw new Error(
			`${spec.file}: ${data.length} bytes split into ${parts.length} parts at ${layout.partBytes}, registry says ${spec.parts}`
		);
	await mkdir(dir, { recursive: true });
	for (let i = 0; i < names.length; i += 1)
		await writeFile(path.join(dir, names[i] ?? ""), parts[i] ?? new Uint8Array());
	return names;
}

/** Write verified package files, compressing models whose registry enables packing. */
export async function writeBundledMaia(
	sourceDir: string,
	destDir: string,
	specs: readonly MaiaSourceSpec[],
	layout: MaiaPartLayout
): Promise<void> {
	await mkdir(destDir, { recursive: true });
	for (const spec of specs) {
		const data = await readMaiaSource(sourceDir, spec, layout);
		await writeFile(
			path.join(destDir, packagedModelName(spec.file, spec.packed)),
			bundledModelBytes(data, spec)
		);
	}
}
