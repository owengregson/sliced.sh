// scripts/stamp-manifest.ts — build step 9 (§11.2): copy the source manifest into `dist/`,
// stamping the version from `package.json` so the two can never drift, and marking dev builds.
//
// §11.2 asks for "a `debug` flag in dev". `debug` is not an MV3 manifest key: Chrome would load
// the extension but flag "Unrecognized manifest key" on `chrome://extensions`, which is exactly
// the surface a manual QA pass reads for real warnings. The same intent is carried by two keys
// Chrome does understand — `version_name` (shown verbatim in the extensions list) and a `(dev)`
// suffix on `name` — so a dev build is unmistakable and warning-free. See docs/DEVELOPMENT.md.

import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface StampOptions {
	dev: boolean;
	version: string;
	/** Build stamp mirrored into `version_name` for dev builds (default: none). */
	build?: string;
}

export const DEV_NAME_SUFFIX = " (dev)";

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure form of the stamp: source manifest object in, `dist/manifest.json` object out. */
export function stampedManifest(source: unknown, options: StampOptions): Record<string, unknown> {
	if (!isRecord(source)) throw new Error("stampManifest: manifest.json is not an object");
	const out: Record<string, unknown> = { ...source, version: options.version };
	if (options.dev) {
		const name = typeof source.name === "string" ? source.name : "";
		out.name = `${name}${DEV_NAME_SUFFIX}`;
		out.version_name = options.build
			? `${options.version}-dev+${options.build}`
			: `${options.version}-dev`;
	}
	return out;
}

/** Read `<root>/manifest.json`, stamp it, write `<dist>/manifest.json`. */
export async function stampManifest(dist: string, options: StampOptions): Promise<void> {
	const root = path.resolve(import.meta.dir, "..");
	const source: unknown = await Bun.file(path.join(root, "manifest.json")).json();
	const stamped = stampedManifest(source, options);
	await writeFile(path.join(dist, "manifest.json"), `${JSON.stringify(stamped, null, "\t")}\n`);
}
