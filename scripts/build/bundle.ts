// scripts/build/bundle.ts — build step `bundle`: the four entry bundles under `dist/js/`.

import path from "node:path";
import config from "../../build.config.json" with { type: "json" };
import pkg from "../../package.json" with { type: "json" };
import { DIST, ROOT } from "../lib/paths";
import type { BuildEnv } from "./options";

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

/**
 * Explicit per-entry output names: two entrypoints are both `index.ts`, so a
 * shared `[name].js` pattern would collide. §11.2 fixes these filenames.
 */
export const ESM_ENTRIES: ReadonlyArray<readonly [string, string]> = [
	["src/service/service-worker.ts", "service-worker.js"],
	["src/offscreen/index.ts", "offscreen.js"],
	["src/panel/index.ts", "panel.js"],
];

/** The ISOLATED-world content script is a classic script, so it is the one IIFE bundle. */
export const IIFE_ENTRY = ["src/content/index.ts", "content.js"] as const;

/** The compile-time `__SL_*` constants every bundle is built with. */
export function bundleDefines(o: BuildEnv): Record<string, string> {
	return {
		__SL_VERSION__: JSON.stringify(pkg.version),
		__SL_BUILD__: JSON.stringify(o.buildStamp),
		__SL_SPOOF_SEED__: JSON.stringify(o.spoofSeed),
		__SL_LICENSE_URL__: JSON.stringify(config.licenseUrl),
		__SL_LICENSE_ENFORCE__: JSON.stringify(config.licenseEnforce === true),
		__SL_DEBUG__: JSON.stringify(o.dev),
	};
}

export async function bundle(o: BuildEnv): Promise<void> {
	const common = {
		root: ROOT,
		target: "browser" as const,
		define: bundleDefines(o),
		minify: !o.dev,
		sourcemap: o.dev ? ("linked" as const) : ("none" as const),
		splitting: false,
		loader: { ".html": "text" as const },
		plugins: [rawHtmlPlugin],
	};
	const esm = await Promise.all(
		ESM_ENTRIES.map(([entrypoint, naming]) =>
			Bun.build({
				...common,
				format: "esm",
				entrypoints: [entrypoint],
				outdir: path.join(DIST, "js"),
				naming,
			})
		)
	);
	const [iifeEntry, iifeNaming] = IIFE_ENTRY;
	const iife = await Bun.build({
		...common,
		format: "iife",
		entrypoints: [iifeEntry],
		outdir: path.join(DIST, "js"),
		naming: iifeNaming,
	});
	for (const r of [...esm, iife])
		if (!r.success) {
			for (const l of r.logs) console.error(l);
			throw new Error("bundle failed");
		}
}
