// scripts/package.ts — build step 11 (§11.2): zip `dist/` into `release/sliced-<version>.zip`.
//
// The zip is the distribution artifact (§12.2: no `update_url`, so the extension ships as a zip
// plus the unpacked folder). Entries are written at the archive root — `manifest.json` must be
// the first thing Chrome finds, not `dist/manifest.json`.
//
// `verify-dist` checks the directory; this checks that the archive is that directory. Every file
// the walker found must appear as an archive entry, so a file the archiver silently skips (an
// unreadable mode, a symlink, a race with a concurrent build) fails the build instead of
// shipping a package that is missing a bundle.

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { walkFiles } from "./verify-dist.ts";

export interface PackageResult {
	/** Absolute path of the written zip. */
	file: string;
	bytes: number;
	/** Archive entry names (dist-relative, posix), sorted. */
	entries: string[];
}

export function releaseZipName(version: string): string {
	return `sliced-${version}.zip`;
}

/** Files present on disk but absent from the archive. */
export function missingEntries(onDisk: readonly string[], archived: readonly string[]): string[] {
	const present = new Set(archived);
	return onDisk.filter((f) => !present.has(f));
}

export async function packageDist(
	dist: string,
	version: string,
	outDir = path.resolve(import.meta.dir, "..", "release")
): Promise<PackageResult> {
	await mkdir(outDir, { recursive: true });
	const file = path.join(outDir, releaseZipName(version));
	const out = createWriteStream(file);
	const archive = archiver("zip", { zlib: { level: 9 } });
	const entries: string[] = [];

	const done = new Promise<number>((resolve, reject) => {
		out.on("close", () => resolve(archive.pointer()));
		out.on("error", reject);
		archive.on("warning", reject);
		archive.on("error", reject);
	});
	// Zip directory entries always end in "/", and `EntryData` does not expose the runtime's
	// `type`, so the trailing slash is what separates them from files.
	archive.on("entry", (entry) => {
		const name = entry.name.split(path.sep).join("/");
		if (!name.endsWith("/")) entries.push(name);
	});

	archive.pipe(out);
	archive.directory(dist, false);
	await archive.finalize();
	const bytes = await done;

	entries.sort();
	const missing = missingEntries(walkFiles(dist), entries);
	if (missing.length > 0)
		throw new Error(
			`package: ${missing.length} file(s) in ${dist} did not reach the archive\n  - ${missing.join("\n  - ")}`
		);

	const shown = path.relative(process.cwd(), file);
	console.log(
		`package: ${shown.startsWith("..") ? file : shown} — ${entries.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`
	);
	return { file, bytes, entries };
}
