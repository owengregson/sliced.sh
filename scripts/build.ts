// scripts/build.ts
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import config from "../build.config.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

export interface BuildOptions {
	dev: boolean;
	fast: boolean;
	watch: boolean;
}
export const ROOT = path.resolve(import.meta.dir, "..");
export const DIST = path.join(ROOT, "dist");

export type Step = { name: string; run: (o: BuildOptions) => Promise<void> };
export const steps: Step[] = [
	{
		name: "clean",
		run: async () => {
			await rm(DIST, { recursive: true, force: true });
			await mkdir(DIST, { recursive: true });
		},
	},
	{ name: "gen-tokens", run: async () => (await import("./gen-tokens.ts")).generateTokens() },
	{ name: "gen-icons", run: async () => (await import("./gen-icons.ts")).verifyIcons() },
	{
		name: "gen-pagescript",
		run: async () => (await import("./gen-pagescript.ts")).generatePagescript(DIST),
	},
	{
		name: "check-constants",
		run: async () => (await import("./check-constants.ts")).checkConstants(),
	},
	{ name: "check-css", run: async () => (await import("./check-css.ts")).checkCss() },
	{
		name: "typecheck",
		run: async (o) => {
			if (o.fast) return;
			const p = Bun.spawn(["bun", "x", "tsc", "--noEmit"], {
				stdout: "inherit",
				stderr: "inherit",
			});
			if ((await p.exited) !== 0) throw new Error("typecheck failed");
		},
	},
	{ name: "bundle", run: bundle },
	{
		name: "copy",
		run: async () => {
			for (const d of ["assets", "css", "pages"])
				await cp(path.join(ROOT, d), path.join(DIST, d), { recursive: true });
		},
	},
	{
		name: "manifest",
		run: async (o) =>
			(await import("./stamp-manifest.ts")).stampManifest(DIST, {
				dev: o.dev,
				version: pkg.version,
			}),
	},
	{ name: "verify", run: async () => (await import("./verify-dist.ts")).verifyDist(DIST) },
	{
		name: "package",
		run: async (o) => {
			if (!o.dev) await (await import("./package.ts")).packageDist(DIST, pkg.version);
		},
	},
];

/**
 * `import html from "./x.html?raw"` — the `?raw` suffix disambiguates the TypeScript declaration
 * (see `src/types/chrome-ext.d.ts`); the bundler strips it and loads the file as text, mirroring
 * `test/raw-loader.ts`.
 */
const rawHtmlPlugin: import("bun").BunPlugin = {
	name: "raw-html",
	setup(build) {
		build.onResolve({ filter: /\.html\?raw$/ }, (args) => ({
			path: path.resolve(path.dirname(args.importer), args.path.replace(/\?raw$/, "")),
			namespace: "raw-html",
		}));
		build.onLoad({ filter: /.*/, namespace: "raw-html" }, async (args) => ({
			contents: await Bun.file(args.path).text(),
			loader: "text",
		}));
	},
};

async function bundle(o: BuildOptions): Promise<void> {
	const define = {
		__SL_VERSION__: JSON.stringify(pkg.version),
		__SL_BUILD__: JSON.stringify(new Date().toISOString()),
		__SL_SPOOF_SEED__: JSON.stringify(crypto.randomUUID().replaceAll("-", "")),
		__SL_LICENSE_URL__: JSON.stringify(config.licenseUrl),
		__SL_LICENSE_ENFORCE__: JSON.stringify(config.licenseEnforce === true),
		__SL_DEBUG__: JSON.stringify(o.dev),
	};
	const common = {
		root: ROOT,
		target: "browser" as const,
		define,
		minify: !o.dev,
		sourcemap: o.dev ? ("linked" as const) : ("none" as const),
		splitting: false,
		loader: { ".html": "text" as const },
		plugins: [rawHtmlPlugin],
	};
	// Explicit per-entry output names: two entrypoints are both `index.ts`, so a
	// shared `[name].js` pattern would collide. §11.2 fixes these filenames.
	const esmEntries: ReadonlyArray<readonly [string, string]> = [
		["src/service/service-worker.ts", "service-worker.js"],
		["src/offscreen/index.ts", "offscreen.js"],
		["src/panel/index.ts", "panel.js"],
	];
	const esm = await Promise.all(
		esmEntries.map(([entrypoint, naming]) =>
			Bun.build({
				...common,
				format: "esm",
				entrypoints: [entrypoint],
				outdir: path.join(DIST, "js"),
				naming,
			})
		)
	);
	const iife = await Bun.build({
		...common,
		format: "iife",
		entrypoints: ["src/content/index.ts"],
		outdir: path.join(DIST, "js"),
		naming: "content.js",
	});
	for (const r of [...esm, iife])
		if (!r.success) {
			for (const l of r.logs) console.error(l);
			throw new Error("bundle failed");
		}
}

export async function runBuild(o: BuildOptions): Promise<void> {
	for (const s of steps) {
		const t = performance.now();
		await s.run(o);
		console.log(`✓ ${s.name} ${(performance.now() - t).toFixed(0)}ms`);
	}
}
if (import.meta.main) {
	const args = new Set(process.argv.slice(2));
	await runBuild({
		dev: args.has("--dev"),
		fast: args.has("--fast") || args.has("--dev"),
		watch: args.has("--watch"),
	});
}
