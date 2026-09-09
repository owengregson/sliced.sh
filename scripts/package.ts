// scripts/package.ts — build step 11 (§11.2): zip `dist/` into `release/sliced-<version>.zip`.
//
// The zip is the distribution artifact (§12.2: no `update_url`, so the extension ships as a zip
// plus the unpacked folder). Entries are written at the archive root — `manifest.json` must be
// the first thing Chrome finds, not `dist/manifest.json`.

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";

export interface PackageResult {
	/** Absolute path of the written zip. */
	file: string;
	bytes: number;
}

export function releaseZipName(version: string): string {
	return `sliced-${version}.zip`;
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

	const done = new Promise<number>((resolve, reject) => {
		out.on("close", () => resolve(archive.pointer()));
		out.on("error", reject);
		archive.on("warning", reject);
		archive.on("error", reject);
	});

	archive.pipe(out);
	archive.directory(dist, false);
	await archive.finalize();
	const bytes = await done;
	console.log(
		`package: ${path.relative(process.cwd(), file)} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`
	);
	return { file, bytes };
}
