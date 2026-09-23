// scripts/verify-dist/checks.ts — the registry of independent package checks.
//
// Each check reads the built tree through one shared `DistContext` and returns its problems;
// `verifyDist` runs them in registry order and concatenates the lists, so the order here is
// the order problems are reported in.

import { checkBudgets, checkBundleContent, type SizeRow } from "./bundles";
import { checkManifestText } from "./manifest";
import { checkPackagedModels, checkPackedModels, type PackagedModel } from "./models";
import { checkReferenceGraph } from "./references";
import { checkEngineDir, checkJunkFiles, checkSourceMaps } from "./tree";

/** Everything a check may know about the tree under test. */
export interface DistContext {
	/** Every file, dist-relative posix, sorted. */
	files: readonly string[];
	present: ReadonlySet<string>;
	/** Text of a dist-relative file, or `null` when it does not exist. */
	read(file: string): string | null;
	readBytes(file: string): Uint8Array;
	sizeOf(file: string): number;
	dev: boolean;
	/** Version the stamped manifest must carry. */
	version: string;
	/** Hosts derived from the constants registry (plus the licence endpoint's). */
	hosts: readonly string[];
	/** Whole model files the package must carry. */
	models: readonly PackagedModel[];
	/** Exactly what `assets/engine/` must hold, dist-relative. */
	engineFiles: readonly string[];
	/** Every shipped script (`js/**.js`). */
	scripts: readonly string[];
	/** The size report's rows, one per shipped script. */
	sizes: readonly SizeRow[];
}

export interface DistCheck {
	name: string;
	run(ctx: DistContext): string[];
}

export const DIST_CHECKS: readonly DistCheck[] = [
	{
		name: "manifest",
		run: (ctx) => checkManifestText(ctx.read("manifest.json"), ctx.files, ctx.version),
	},
	{
		name: "references",
		run: (ctx) =>
			checkReferenceGraph(
				ctx.files.filter((f) => f.endsWith(".html")),
				ctx.read
			),
	},
	{ name: "budgets", run: (ctx) => checkBudgets(ctx.sizes, ctx.present, ctx.dev) },
	{
		name: "bundle-content",
		run: (ctx) => checkBundleContent(ctx.scripts, ctx.read, { dev: ctx.dev, hosts: ctx.hosts }),
	},
	{ name: "source-maps", run: (ctx) => checkSourceMaps(ctx.files, ctx.dev) },
	{
		name: "packaged-models",
		run: (ctx) => [
			...checkPackagedModels(ctx.files, ctx.sizeOf, ctx.models),
			...checkPackedModels(ctx.files, ctx.readBytes, ctx.models),
		],
	},
	{ name: "junk-files", run: (ctx) => checkJunkFiles(ctx.files) },
	{ name: "engine-dir", run: (ctx) => checkEngineDir(ctx.files, ctx.engineFiles) },
];

/** Run `checks` in order; their problems, concatenated. */
export function runChecks(ctx: DistContext, checks: readonly DistCheck[] = DIST_CHECKS): string[] {
	return checks.flatMap((check) => check.run(ctx));
}
