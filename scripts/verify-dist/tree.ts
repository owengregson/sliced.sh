// scripts/verify-dist/tree.ts — rules 7, 9 and 10 over the file list alone: no source maps in a
// release, no junk files, and an engine directory that is exactly the registry.

// The registry reads bundler defines at module scope; this must be evaluated before it.
import "../registry-defines";

import path from "node:path";
import { ENGINE_DIR, PACKAGED_ENGINE_FILES } from "../../src/core/constants/engine-files";
import { JUNK_FILE_RE } from "../lib/junk-files";

/**
 * Source maps must never reach a release package. Dev maps embed `sourcesContent`, i.e. the
 * original TypeScript including comments that name the licence endpoint, so they are checked
 * for absence rather than scanned.
 */
const SOURCE_MAP_RE = /\.js\.map$/;

/** Rule 7: a production build ships no `.js.map`. */
export function checkSourceMaps(files: readonly string[], dev: boolean): string[] {
	if (dev) return [];
	return files
		.filter((f) => SOURCE_MAP_RE.test(f))
		.map((file) => `${file}: a production build must ship no source map`);
}

/** Rule 9: junk files anywhere in the tree. */
export function checkJunkFiles(files: readonly string[]): string[] {
	return files
		.filter((file) => JUNK_FILE_RE.test(path.posix.basename(file)))
		.map((file) => `${file}: a junk file shipped — the copy step must drop it`);
}

/** The engine directory's contents as the registry says the built package carries them. */
export function packagedEngineFiles(): string[] {
	return PACKAGED_ENGINE_FILES.map((name) => `${ENGINE_DIR}${name}`);
}

/**
 * Rule 10: `assets/engine/` is exactly `expected` — every registered file present, and no file
 * the registry does not name (a program that stopped shipping, a stray net or gzip source).
 */
export function checkEngineDir(files: readonly string[], expected: readonly string[]): string[] {
	const problems: string[] = [];
	const present = new Set(files);
	const wanted = new Set(expected);
	for (const file of expected)
		if (!present.has(file)) problems.push(`${file} is missing from dist/ (ENGINE_FILES names it)`);
	for (const file of files)
		if (file.startsWith(ENGINE_DIR) && !wanted.has(file))
			problems.push(`${file}: not in the engine registry — dead weight the loader never reads`);
	return problems;
}
