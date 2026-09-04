/**
 * Bun test plugin — mirrors the production bundler's `.html` text loader so
 * test code can import the same raw-string templates that shipped code does.
 *
 * Panel view templates live in `src/panel/views/templates/*.html` and are
 * imported with an explicit `?raw` query suffix (the `?raw` is for TypeScript
 * declaration disambiguation against bun-types' default `*.html` HTMLBundle
 * declaration; the bundler's text loader ignores the query).
 */

import { readFileSync } from "node:fs";
import { plugin } from "bun";

plugin({
	name: "raw-asset-bridge",
	setup(build) {
		build.onLoad({ filter: /[\\/]src[\\/]panel[\\/]views[\\/]templates[\\/].*\.html$/ }, (args) => {
			const content = readFileSync(args.path, "utf-8");
			return {
				contents: `export default ${JSON.stringify(content)};`,
				loader: "js",
			};
		});
	},
});
