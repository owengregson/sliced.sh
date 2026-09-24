// scripts/lib/fs.ts — tree walking and file description shared by the build, verify and vendor steps.

import { readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./hash";
import { posixRelative } from "./paths";

/** Every file under `dir`, as `base`-relative posix paths (directory order, unsorted). */
export function walkFiles(dir: string, base = dir, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) walkFiles(full, base, acc);
		else acc.push(posixRelative(base, full));
	}
	return acc;
}

/** Name, size and SHA-256 of one file — the row every notice table renders. */
export interface VendoredFile {
	name: string;
	bytes: number;
	sha256: string;
}

/** Describe `names` under `dir`, in the order given. */
export async function describeFiles(
	dir: string,
	names: readonly string[]
): Promise<VendoredFile[]> {
	const out: VendoredFile[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		out.push({
			name,
			bytes: (await stat(file)).size,
			sha256: sha256Hex(new Uint8Array(await readFile(file))),
		});
	}
	return out;
}

/** Parse a JSON file as `T` (the caller owns the shape; the scripts read their own manifests). */
export async function readJson<T>(file: string): Promise<T> {
	return JSON.parse(await readFile(file, "utf8")) as T;
}
