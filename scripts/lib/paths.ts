// scripts/lib/paths.ts — the repository locations every build script resolves against.

import path from "node:path";

/** The repository root (this file lives at `scripts/lib/`). */
export const ROOT = path.resolve(import.meta.dir, "..", "..");

/** The unpacked extension the build writes and `verify-dist` checks. */
export const DIST = path.join(ROOT, "dist");

/** Where `package.ts` writes `sliced-<version>.zip`. */
export const RELEASE_DIR = path.join(ROOT, "release");

/** `abs` relative to `base`, with posix separators (dist- and repo-relative keys). */
export function posixRelative(base: string, abs: string): string {
	return path.relative(base, abs).split(path.sep).join("/");
}
