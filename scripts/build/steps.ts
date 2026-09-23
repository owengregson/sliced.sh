// scripts/build/steps.ts — the build pipeline (§11.2) as an ordered list of named steps.
//
// Each step is one job over the resolved `BuildEnv`. The generators and lints are imported
// lazily, when their step runs: several install bundler-define placeholders before they load
// the registry, and a step that is skipped never pays for its imports.

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import config from "../../build.config.json" with { type: "json" };
import pkg from "../../package.json" with { type: "json" };
import { DIST, ROOT } from "../lib/paths";
import { bundle } from "./bundle";
import type { BuildEnv } from "./options";
import { prunePackagedSounds } from "./sounds";

export type Step = { name: string; run: (o: BuildEnv) => Promise<void> };

async function clean(): Promise<void> {
	await rm(DIST, { recursive: true, force: true });
	await mkdir(DIST, { recursive: true });
}

async function typecheck(o: BuildEnv): Promise<void> {
	if (o.fast) return;
	const p = Bun.spawn(["bun", "x", "tsc", "--noEmit"], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await p.exited) !== 0) throw new Error("typecheck failed");
}

/** Assets (materialised and verified), the sound allowlist, model recompression, CSS and pages. */
async function copy(o: BuildEnv): Promise<void> {
	await (await import("./copy-assets.ts")).copyBundledAssets(ROOT, DIST);
	const omittedSounds = await prunePackagedSounds(DIST);
	if (omittedSounds.length > 0)
		console.log(`sounds: omitted ${omittedSounds.length} unregistered clips from the package`);
	if (!o.dev) {
		const savings = await (await import("../optimize-model-packages.ts")).optimizeModelPackages(DIST);
		const saved = savings.reduce((sum, model) => sum + model.before - model.after, 0);
		console.log(`models: lossless recompression saved ${saved.toLocaleString("en-US")} bytes`);
	}
	for (const d of ["css", "pages"])
		await cp(path.join(ROOT, d), path.join(DIST, d), { recursive: true });
}

export const steps: Step[] = [
	{ name: "clean", run: clean },
	{ name: "gen-tokens", run: async () => (await import("../gen-tokens.ts")).generateTokens() },
	{ name: "gen-icons", run: async () => (await import("../gen-icons.ts")).verifyIcons() },
	{
		name: "gen-pagescript",
		run: async (o) =>
			(await import("../gen-pagescript.ts")).generatePagescript(DIST, { seed: o.spoofSeed }),
	},
	{
		name: "check-constants",
		run: async () => (await import("../check-constants.ts")).checkConstants(),
	},
	{ name: "check-css", run: async () => (await import("../check-css.ts")).checkCss() },
	{ name: "typecheck", run: typecheck },
	{ name: "bundle", run: bundle },
	{ name: "copy", run: copy },
	{
		name: "manifest",
		run: async (o) =>
			(await import("../stamp-manifest.ts")).stampManifest(DIST, {
				dev: o.dev,
				version: pkg.version,
				build: o.buildStamp,
			}),
	},
	{
		name: "verify",
		run: async (o) =>
			void (await import("../verify-dist.ts")).verifyDist(DIST, {
				dev: o.dev,
				version: pkg.version,
				licenseUrl: config.licenseUrl,
			}),
	},
	{
		name: "package",
		run: async (o) => {
			if (!o.dev) await (await import("../package.ts")).packageDist(DIST, pkg.version);
		},
	},
];

/** Run `list` in order over one env, logging each step's wall time. */
export async function runSteps(list: readonly Step[], env: BuildEnv): Promise<void> {
	for (const s of list) {
		const t = performance.now();
		await s.run(env);
		console.log(`✓ ${s.name} ${(performance.now() - t).toFixed(0)}ms`);
	}
}
