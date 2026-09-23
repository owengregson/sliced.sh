// scripts/verify-dist.ts — build step 10 (§11.2): the packaged tree is loadable and clean.
//
// Ten rules, all against `dist/` as it will be zipped, each an independent check in
// `verify-dist/checks.ts` (`DIST_CHECKS`):
//
//   1. every path the stamped manifest declares exists (globs in
//      `web_accessible_resources` must match at least one file);
//   2. the manifest exposes nothing to the page. `web_accessible_resources` must be absent, or
//      every entry must carry `use_dynamic_url: true`. The manifest pins `key`, so the extension
//      id is fixed and knowable: any script on a matched site could `fetch()` a web-accessible
//      path and read success as a definitive "sliced is installed" — the strongest presence
//      signal §13.3 exists to prevent, and stronger than any inlined string. `use_dynamic_url`
//      rotates the token per session, which is the only form that is safe to reintroduce;
//   3. every same-origin reference reachable from the extension's HTML resolves —
//      `src`/`href` in the pages, then `url(…)` and `@import` transitively through the CSS,
//      so a missing font or an unstamped stylesheet fails the build instead of the panel;
//   4. bundle sizes are reported and the two budgeted entries are capped
//      (`js/panel.js` 400 KB, `js/content.js` 250 KB — §11.2);
//   5. no `console.` survives in a production bundle (`@core/logger` is the only sanctioned
//      console use and reaches it through a computed member, `console[level]`, so a literal
//      `console.` in a shipped bundle is always a stray call);
//   6. **host ownership**: every host that appears in the constants registry may appear only in
//      the bundles `HOST_OWNERS` names, and a host that is not in that table fails the build —
//      so adding a URL forces a decision about which realms may see it, instead of a bundler
//      quietly inlining an object literal into `content.js` (§13.3 rule 2);
//   7. a production build ships no `.js.map`. Dev maps embed `sourcesContent`, i.e. the original
//      TypeScript including comments that name the licence endpoint, so they are checked for
//      absence rather than scanned;
//   8. **packaged models**: every registered Maia and ChessMimic asset is present, restores
//      the canonical ONNX hash, and has no raw duplicate or source part in the package;
//   9. **no junk files**: a `.DS_Store` / `Thumbs.db` / AppleDouble `._*` anywhere in the tree
//      fails (three `.DS_Store`s shipped in the 2026-09-13 zip);
//  10. **the engine directory is exactly the registry**: `assets/engine/` holds every file in
//      `PACKAGED_ENGINE_FILES` and nothing else — a stale program (the plain-SIMD builds dropped
//      on 2026-09-13) or a stray net is dead weight nobody loads.
//
// Every rule is a pure function over strings (or a file list) so
// `test/scripts/verify-dist.test.ts` can exercise them without a real build. This file is the
// public entry (the rules are re-exported), the `verifyDist` build step and the CLI.

// The registry reads bundler defines at module scope; this must be evaluated before it.
import "./registry-defines";

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import config from "../build.config.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { cliFlags } from "./lib/cli";
import { walkFiles } from "./lib/fs";
import { DIST } from "./lib/paths";
import { bulletList, formatBytes } from "./lib/report";
import { readRegistry, registryHosts, type SizeRow, sizeRows } from "./verify-dist/bundles";
import { type DistContext, runChecks } from "./verify-dist/checks";
import { type PackagedModel, packagedModels } from "./verify-dist/models";
import { packagedEngineFiles } from "./verify-dist/tree";

export { walkFiles } from "./lib/fs";
export { JUNK_FILE_RE } from "./lib/junk-files";
export {
	checkBudgets,
	checkBundleContent,
	hostNeedle,
	licenseHost,
	readRegistry,
	registryHosts,
	type ScanOptions,
	type SizeRow,
	scanBundle,
	sizeRows,
	unclassifiedHosts,
} from "./verify-dist/bundles";
export { DIST_CHECKS, type DistCheck, type DistContext, runChecks } from "./verify-dist/checks";
export {
	checkManifest,
	checkManifestText,
	checkWebAccessibleResources,
	type DeclaredPath,
	globToRegExp,
	manifestPaths,
} from "./verify-dist/manifest";
export {
	checkPackagedModels,
	checkPackedModels,
	MODEL_PART_RE,
	type PackagedModel,
	packagedModels,
} from "./verify-dist/models";
export {
	BUNDLE_BUDGETS,
	BUNDLES,
	FORBIDDEN_MANIFEST_KEYS,
	HOST_OWNERS,
	LICENSE_BUNDLE,
	REGISTRY_DIR,
} from "./verify-dist/policy";
export {
	checkReferenceGraph,
	cssRefs,
	htmlRefs,
	isExternalRef,
	resolveRef,
} from "./verify-dist/references";
export {
	checkEngineDir,
	checkJunkFiles,
	checkSourceMaps,
	packagedEngineFiles,
} from "./verify-dist/tree";

export interface VerifyOptions {
	/** Dev builds keep `console.` (the `--dev` bundle is not minified and is never shipped). */
	dev?: boolean;
	/** Version the stamped manifest must carry (default: `package.json`). */
	version?: string;
	/** Licence endpoint whose host is bundle-restricted (default: `build.config.json`). */
	licenseUrl?: string;
	/** Hosts to police (default: derived from `REGISTRY_DIR` + `licenseUrl`); injectable for tests. */
	hosts?: readonly string[];
	/** Whole model files the package must carry (default: `packagedModels()`); injectable for tests. */
	models?: readonly PackagedModel[];
	/**
	 * Exactly what `assets/engine/` must hold, dist-relative (default: `packagedEngineFiles()`);
	 * injectable for tests.
	 */
	engineFiles?: readonly string[];
}

export interface VerifyReport {
	sizes: SizeRow[];
	totalBytes: number;
	problems: string[];
}

/** Read the tree under `dist` once into the context every check shares. */
function distContext(dist: string, options: VerifyOptions): DistContext & { sizes: SizeRow[] } {
	const hosts =
		options.hosts ?? registryHosts(readRegistry(), options.licenseUrl ?? config.licenseUrl);
	const files = walkFiles(dist).sort();
	const present = new Set(files);
	const sizeOf = (file: string): number => statSync(path.join(dist, file)).size;
	// Every shipped script; source maps are dev-only and not part of the budget.
	const scripts = files.filter((f) => f.startsWith("js/") && f.endsWith(".js"));
	return {
		files,
		present,
		read: (file) => (present.has(file) ? readFileSync(path.join(dist, file), "utf8") : null),
		readBytes: (file) => readFileSync(path.join(dist, file)),
		sizeOf,
		dev: options.dev === true,
		version: options.version ?? pkg.version,
		hosts,
		models: options.models ?? packagedModels(),
		engineFiles: options.engineFiles ?? packagedEngineFiles(),
		scripts,
		sizes: sizeRows(scripts, sizeOf),
	};
}

function printSizeReport(ctx: DistContext, sizes: readonly SizeRow[]): number {
	const totalBytes = ctx.files.reduce((sum, f) => sum + ctx.sizeOf(f), 0);
	const width = Math.max(...sizes.map((r) => r.file.length), 20);
	console.log(`verify-dist: ${ctx.files.length} files, ${formatBytes(totalBytes)} unpacked`);
	for (const row of sizes)
		console.log(
			`  ${row.file.padEnd(width)}  ${formatBytes(row.bytes).padStart(10)}${
				row.budget === null ? "" : ` / ${formatBytes(row.budget)}`
			}`
		);
	return totalBytes;
}

/**
 * Verify the built tree. Prints the size report, then throws with every problem listed —
 * the build must not produce a zip nobody can load.
 */
export function verifyDist(dist: string, options: VerifyOptions = {}): VerifyReport {
	const ctx = distContext(dist, options);
	const problems = runChecks(ctx);
	const totalBytes = printSizeReport(ctx, ctx.sizes);
	if (problems.length > 0)
		throw new Error(`verify-dist: ${problems.length} problem(s) in ${dist}${bulletList(problems)}`);
	return { sizes: ctx.sizes, totalBytes, problems };
}

if (import.meta.main) verifyDist(DIST, { dev: cliFlags().has("--dev") });
